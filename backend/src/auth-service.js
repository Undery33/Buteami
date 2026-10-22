import { transaction } from './db.js';
import { hashPassword, verifyPassword, randomToken, digest, validToken, PublicError } from './security.js';
import { enqueueMail } from './mail.js';

const loginFailure = () => new PublicError(401, '로그인할 수 없습니다. 입력 정보, 이메일 인증 또는 비밀번호 재설정을 확인해주세요.');
const tokenFailure = () => new PublicError(400, '인증 코드가 올바르지 않거나 만료되었습니다. 다시 요청해주세요.');
const publicUser = user => ({ username: user.id, fullName: user.name });

export function createAuthService({ pool, config }) {
  async function issueToken(connection, user, purpose) {
    const token = randomToken();
    const minutes = purpose === 'verify' ? 30 : 15;
    // A replacement invalidates prior codes. Queue delivery remains independent of the response time.
    await connection.execute('DELETE FROM auth_tokens WHERE user_id=? AND purpose=?', [user.id, purpose]);
    await connection.execute(`INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at)
      VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MINUTE))`, [digest(token), user.id, purpose, minutes]);
    const label = purpose === 'verify' ? '이메일 인증' : '비밀번호 재설정';
    const page = purpose === 'verify' ? 'verify-email' : 'reset-password';
    await enqueueMail(connection, config, { to: user.email, subject: `[부티미] ${label}`,
      text: `${label} 화면: ${config.origin}/auth/${page}.html\n\n인증 코드: ${token}\n\n${minutes}분 안에 화면에 코드를 직접 붙여넣으세요. 요청하지 않았다면 무시하세요.` });
  }
  async function withUser(id, action) {
    return transaction(pool, async connection => {
      const [rows] = await connection.execute('SELECT * FROM users WHERE id=? FOR UPDATE', [id]);
      return action(connection, rows[0]);
    });
  }
  async function useToken(token, purpose, action) {
    if (!validToken(token)) throw tokenFailure();
    const [candidates] = await pool.execute('SELECT user_id FROM auth_tokens WHERE token_hash=? AND purpose=?', [digest(token), purpose]);
    if (!candidates.length) throw tokenFailure();
    return withUser(candidates[0].user_id, async (connection, user) => {
      // Same lock ordering as login: user first, then token. Recheck validity under both locks.
      const [tokens] = await connection.execute(`SELECT token_hash FROM auth_tokens WHERE token_hash=? AND purpose=?
        AND expires_at > UTC_TIMESTAMP(3) FOR UPDATE`, [digest(token), purpose]);
      if (!user || !tokens.length) throw tokenFailure();
      return action(connection, user);
    });
  }
  return {
    async signup(data) {
      const passwordHash = await hashPassword(data.password);
      try {
        await transaction(pool, async connection => {
          await connection.execute(`INSERT INTO users (id,password_hash,birthday,email,name,account_active,failed_login_attempts,account_locked)
            VALUES (?,?,?,?,?,0,0,0)`, [data.username, passwordHash, data.birthday, data.email, data.fullName]);
          await connection.execute('INSERT INTO auth_pending_registrations (user_id) VALUES (?)', [data.username]);
          await issueToken(connection, { id: data.username, email: data.email }, 'verify');
        });
      } catch (error) { if (error.code !== 'ER_DUP_ENTRY') throw error; }
    },
    async login(data, oldToken) {
      const outcome = await withUser(data.username, async (connection, user) => {
        const matches = await verifyPassword(data.password, user?.password_hash);
        if (!user || !user.account_active || user.account_locked) return null;
        if (!matches) {
          const failures = Math.min(3, Number(user.failed_login_attempts) + 1);
          await connection.execute('UPDATE users SET failed_login_attempts=?,account_locked=? WHERE id=?', [failures, failures >= 3 ? 1 : 0, user.id]);
          if (failures >= 3) await connection.execute('DELETE FROM auth_sessions WHERE user_id=?', [user.id]);
          return null;
        }
        await connection.execute('UPDATE users SET failed_login_attempts=0 WHERE id=?', [user.id]);
        if (validToken(oldToken)) await connection.execute('DELETE FROM auth_sessions WHERE token_hash=?', [digest(oldToken)]);
        const token = randomToken();
        await connection.execute(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 8 HOUR))`, [digest(token), user.id]);
        return { user: publicUser(user), token };
      });
      // Authentication failure must be raised AFTER the counter transaction commits.
      if (!outcome) throw loginFailure();
      return outcome;
    },
    async verifyEmail({ token }) {
      await useToken(token, 'verify', async (connection, user) => {
        const [pending] = await connection.execute('SELECT user_id FROM auth_pending_registrations WHERE user_id=?', [user.id]);
        if (!pending.length || user.account_active) throw tokenFailure();
        await connection.execute('UPDATE users SET account_active=1 WHERE id=?', [user.id]);
        await connection.execute('DELETE FROM auth_pending_registrations WHERE user_id=?', [user.id]);
        await connection.execute('DELETE FROM auth_tokens WHERE user_id=?', [user.id]);
      });
    },
    async resendVerification(data) {
      await withUser(data.username, async (connection, user) => {
        if (!user || user.account_active || user.email.toLowerCase() !== data.email) return;
        const [pending] = await connection.execute('SELECT user_id FROM auth_pending_registrations WHERE user_id=?', [user.id]);
        if (pending.length) await issueToken(connection, user, 'verify');
      });
    },
    async requestPasswordReset(data) {
      await withUser(data.username, async (connection, user) => {
        if (user?.account_active && user.email.toLowerCase() === data.email) await issueToken(connection, user, 'reset');
      });
    },
    async resetPassword({ token, password }) {
      const passwordHash = await hashPassword(password);
      await useToken(token, 'reset', async (connection, user) => {
        if (!user.account_active) throw tokenFailure();
        await connection.execute('UPDATE users SET password_hash=?,failed_login_attempts=0,account_locked=0 WHERE id=?', [passwordHash, user.id]);
        await connection.execute('DELETE FROM auth_tokens WHERE user_id=?', [user.id]);
        await connection.execute('DELETE FROM auth_sessions WHERE user_id=?', [user.id]);
      });
    },
    async findId(data) {
      await transaction(pool, async connection => {
        const [users] = await connection.execute('SELECT id,email FROM users WHERE name=? AND email=? AND account_active=1', [data.fullName, data.email]);
        if (users.length) await enqueueMail(connection, config, { to: users[0].email, subject: '[부티미] 아이디 안내', text: `등록된 아이디: ${users[0].id}\n로그인: ${config.origin}/auth/login.html\n요청하지 않았다면 무시하세요.` });
      });
    },
    async me(token) {
      if (!validToken(token)) throw loginFailure();
      const [users] = await pool.execute(`SELECT u.id,u.name FROM auth_sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP(3) AND u.account_active=1 AND u.account_locked=0`, [digest(token)]);
      if (!users.length) throw loginFailure();
      return { user: publicUser(users[0]) };
    },
    async logout(token) {
      if (validToken(token)) await pool.execute('DELETE FROM auth_sessions WHERE token_hash=?', [digest(token)]);
    },
  };
}
