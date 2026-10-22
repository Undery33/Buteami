import { transaction } from './db.js';
import { hashPassword, verifyPassword, randomToken, digest, validToken, PublicError } from './security.js';

const loginFailure = () => new PublicError(401, '로그인할 수 없습니다. 입력 정보 또는 비밀번호 재설정을 확인해주세요.');
const recoveryFailure = () => new PublicError(400, '이름, 아이디, 이메일이 일치하는지 확인해주세요.');
const publicUser = user => ({ username: user.id, fullName: user.name });

export function createAuthService({ pool }) {
  async function withUser(id, action) {
    return transaction(pool, async connection => {
      const [rows] = await connection.execute('SELECT * FROM users WHERE id=? FOR UPDATE', [id]);
      return action(connection, rows[0]);
    });
  }
  return {
    async signup(data) {
      const passwordHash = await hashPassword(data.password);
      try {
        await transaction(pool, async connection => {
          await connection.execute(`INSERT INTO users (id,password_hash,birthday,email,name,account_active,failed_login_attempts,account_locked)
            VALUES (?,?,?,?,?,1,0,0)`, [data.username, passwordHash, data.birthday, data.email, data.fullName]);
        });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw new PublicError(409, '이미 사용 중인 아이디 또는 이메일입니다.');
        throw error;
      }
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
    async resetPassword({ username, fullName, email, password }) {
      const passwordHash = await hashPassword(password);
      await withUser(username, async (connection, user) => {
        // Project recovery policy: match all three fields under the same user lock.
        // This checks registration data, not possession of the email account.
        if (!user?.account_active || user.name !== fullName || user.email.toLowerCase() !== email) throw recoveryFailure();
        await connection.execute('UPDATE users SET password_hash=?,failed_login_attempts=0,account_locked=0 WHERE id=?', [passwordHash, user.id]);
        await connection.execute('DELETE FROM auth_sessions WHERE user_id=?', [user.id]);
      });
    },
    async findId(data) {
      const [users] = await pool.execute('SELECT id,name,email FROM users WHERE email=? AND account_active=1', [data.email]);
      if (!users.length || users[0].name !== data.fullName) throw new PublicError(400, '입력 정보와 일치하는 아이디를 찾을 수 없습니다.');
      return { username: users[0].id };
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
