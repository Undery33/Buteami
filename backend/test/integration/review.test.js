import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { loadConfig } from '../../src/config.js';
import { createPool, transaction } from '../../src/db.js';
import { createAuthService } from '../../src/auth-service.js';
import { createApp } from '../../src/app.js';
import { assertSchema } from '../../src/schema.js';
import { applyMigrations } from '../../src/migrate.js';
import { digest, openMail, hashPassword } from '../../src/security.js';
import { validateInput } from '../../src/validation.js';
import { limitRate } from '../../src/rate-limit.js';
import { deliverMailBatch } from '../../src/mail.js';

const enabled = process.env.DB_TEST_ENABLED === '1';

test('MariaDB authentication and HTTP security integration', { skip: !enabled }, async t => {
  // These tests change data and DDL. Refuse every production/private DB target.
  assert.equal(process.env.DB_NAME, 'buteami_test', 'Use only the dedicated buteami_test database');
  assert.ok(['127.0.0.1', 'localhost', 'db', 'mariadb'].includes(process.env.DB_HOST), 'Use only an isolated local or CI database');
  const config = loadConfig({ ...process.env, NODE_ENV: 'test',
    APP_ORIGIN: 'http://localhost:8080', COOKIE_SECURE: 'false',
    APP_SECRET: process.env.APP_SECRET || 'isolated-integration-test-secret-32-bytes-minimum',
    SMTP_HOST: process.env.SMTP_HOST || 'localhost', SMTP_FROM: 'Buteami <test@example.invalid>',
  });
  const pool = createPool(config);
  const secondPool = createPool(config);
  t.after(async () => { await secondPool.end(); await pool.end(); });
  const sql = await readFile(new URL('../../migrations/001-auth.sql', import.meta.url), 'utf8');
  const tables = ['auth_pending_registrations', 'auth_sessions', 'auth_tokens', 'auth_rate_limits', 'auth_mail_outbox', 'users'];
  // Reproduce the actual user-supplied production DDL in this disposable DB.
  // No operation here can reach the private production address because of the guards above.
  for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
  await pool.query(`CREATE TABLE users (
    id VARCHAR(50) NOT NULL PRIMARY KEY,
    password_hash VARCHAR(255) NOT NULL,
    birthday DATE DEFAULT NULL,
    email VARCHAR(254) NOT NULL,
    name VARCHAR(100) NOT NULL,
    account_active TINYINT(1) NOT NULL DEFAULT 1,
    failed_login_attempts INT(11) NOT NULL DEFAULT 0,
    account_locked TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  const legacyPassword = 'legacy6';
  const legacyHash = await hashPassword(legacyPassword);
  await pool.execute('INSERT INTO users(id,password_hash,email,name) VALUES (?,?,?,?)', ['legacy_user', legacyHash, 'legacy@example.com', '이'.repeat(100)]);
  await pool.execute(`INSERT INTO users(id,password_hash,birthday,email,name,account_active,failed_login_attempts,account_locked,created_at)
    VALUES (?,?,?,?,?,0,3,1,?)`, ['l'.repeat(50), legacyHash, '1980-01-01', 'long-id@example.com', '기존 잠금 계정', '2020-01-02 03:04:05']);
  const originalDdl = (await pool.query('SHOW CREATE TABLE users'))[0][0]['Create Table'];
  const originalRows = (await pool.query('SELECT * FROM users ORDER BY id'))[0];
  const service = createAuthService({ pool, config });
  const secondService = createAuthService({ pool: secondPool, config });
  const clear = async () => { for (const table of tables) await pool.query(`DELETE FROM ${table}`); };
  const userInput = (username, changes = {}) => ({ username, fullName: '테스트 사용자', email: `${username}@example.com`, birthday: '2000-02-29',
    password: 'original-password-2026', confirmPassword: 'original-password-2026', ...changes });
  const signup = (username, changes) => service.signup(validateInput('signup', userInput(username, changes)));
  const getUser = async username => (await pool.execute('SELECT * FROM users WHERE id=?', [username]))[0][0];
  const getToken = async (username, purpose) => {
    const [tokens] = await pool.execute('SELECT token_hash FROM auth_tokens WHERE user_id=? AND purpose=?', [username, purpose]);
    assert.equal(tokens.length, 1);
    const [rows] = await pool.query('SELECT payload FROM auth_mail_outbox');
    for (const row of rows) {
      const text = openMail(config.secret, row.payload).text;
      const token = /인증 코드: ([A-Za-z0-9_-]{43})/.exec(text)?.[1];
      if (token && digest(token) === tokens[0].token_hash) return token;
    }
    assert.fail('Current token must be available only through encrypted mail delivery');
  };
  const activeUser = async username => {
    await signup(username);
    await service.verifyEmail({ token: await getToken(username, 'verify') });
    return userInput(username);
  };
  const rejectsPublic = (promise, status = 401) => assert.rejects(promise, error => error.status === status);

  await t.test('additive migration preserves the supplied existing users DDL and every preexisting value', async () => {
    await assertSchema(pool, { usersOnly: true });
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(?:ALTER|DROP)\s+TABLE\b/i);
    for (let run = 0; run < 2; run++) {
      await applyMigrations(pool);
      await assertSchema(pool);
      assert.equal((await pool.query('SHOW CREATE TABLE users'))[0][0]['Create Table'], originalDdl);
      assert.deepEqual((await pool.query('SELECT * FROM users ORDER BY id'))[0], originalRows);
    }
    const [columns] = await pool.query(`SELECT TABLE_NAME,CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='user_id'`);
    assert.equal(columns.length, 3);
    for (const column of columns) {
      assert.equal(column.CHARACTER_MAXIMUM_LENGTH, 50);
      assert.equal(column.COLLATION_NAME, 'utf8mb4_general_ci');
    }
  });

  await t.test('an existing active account with nullable birthday and six-character password can authenticate', async () => {
    const result = await service.login(validateInput('login', { username: 'legacy_user', password: legacyPassword }));
    assert.equal(result.user.username, 'legacy_user');
    assert.equal((await getUser('legacy_user')).birthday, null);
    assert.equal(result.user.fullName.length, 100);
    assert.deepEqual(await service.me(result.token), { user: result.user });
  });

  await t.test('signup persists only a salted hash and requires single-use email ownership verification', async () => {
    await clear();
    await signup('signup_user');
    const user = await getUser('signup_user');
    assert.equal(user.account_active, 0);
    assert.equal(user.failed_login_attempts, 0);
    assert.notEqual(user.password_hash, userInput('signup_user').password);
    assert.match(user.password_hash, /^scrypt\$/);
    const token = await getToken(user.id, 'verify');
    const [rows] = await pool.query('SELECT token_hash FROM auth_tokens');
    assert.equal(rows[0].token_hash, digest(token));
    await rejectsPublic(service.login(userInput(user.id)));
    await rejectsPublic(service.resetPassword({ token, password: 'new-password-2026' }), 400);
    await service.verifyEmail({ token });
    assert.equal((await getUser(user.id)).account_active, 1);
    await rejectsPublic(service.verifyEmail({ token }), 400);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_pending_registrations'))[0][0].count, 0);
  });

  await t.test('expired verification codes fail and resending invalidates the previous code', async () => {
    await clear();
    await signup('expiry_user');
    const expired = await getToken('expiry_user', 'verify');
    await pool.query("UPDATE auth_tokens SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)");
    await rejectsPublic(service.verifyEmail({ token: expired }), 400);
    assert.equal((await getUser('expiry_user')).account_active, 0);
    await service.resendVerification(userInput('expiry_user'));
    const replacement = await getToken('expiry_user', 'verify');
    assert.notEqual(replacement, expired);
    await rejectsPublic(service.verifyEmail({ token: expired }), 400);
    await service.verifyEmail({ token: replacement });
  });

  await t.test('duplicate registration never overwrites an existing identity or password', async () => {
    await clear();
    await signup('duplicate_user');
    const initial = await getUser('duplicate_user');
    await signup('duplicate_user', { email: 'other@example.com', password: 'replacement-password-2026', confirmPassword: 'replacement-password-2026' });
    await signup('other_user', { email: initial.email });
    assert.deepEqual(await getUser('duplicate_user'), initial);
    assert.equal(await getUser('other_user'), undefined);
  });

  await t.test('successful login resets failure count, rotates supplied sessions and returns only public fields', async () => {
    await clear();
    const input = await activeUser('session_user');
    await rejectsPublic(service.login({ ...input, password: 'wrong-password' }));
    assert.equal((await getUser(input.username)).failed_login_attempts, 1);
    const first = await service.login(input);
    assert.deepEqual(first.user, { username: input.username, fullName: input.fullName });
    assert.equal((await getUser(input.username)).failed_login_attempts, 0);
    const second = await secondService.login(input, first.token);
    assert.notEqual(second.token, first.token);
    await rejectsPublic(service.me(first.token));
    assert.deepEqual(await service.me(second.token), { user: first.user });
    const [sessions] = await pool.query('SELECT token_hash FROM auth_sessions');
    assert.deepEqual(sessions.map(row => row.token_hash), [digest(second.token)]);
    await service.logout(second.token);
    await rejectsPublic(service.me(second.token));
  });

  await t.test('three concurrent failures across two pools commit exactly three attempts, lock and revoke sessions', async () => {
    await clear();
    const input = await activeUser('locked_user');
    const session = await service.login(input);
    const attempts = await Promise.allSettled([service, secondService, service].map(instance => instance.login({ ...input, password: 'wrong-password' })));
    assert.ok(attempts.every(outcome => outcome.status === 'rejected' && outcome.reason.status === 401));
    assert.equal((await getUser(input.username)).failed_login_attempts, 3);
    assert.equal((await getUser(input.username)).account_locked, 1);
    await rejectsPublic(service.login(input));
    await rejectsPublic(service.me(session.token));
    assert.equal((await getUser(input.username)).failed_login_attempts, 3);
    const failure = await service.login(input).catch(error => error);
    const missing = await service.login({ username: 'absent_user', password: input.password }).catch(error => error);
    assert.equal(failure.message, missing.message);
    assert.equal(failure.status, missing.status);
  });

  await t.test('recovery requests cannot unlock accounts; an owned, single-use reset changes password and revokes sessions', async () => {
    await clear();
    const input = await activeUser('recover_user');
    const session = await service.login(input);
    await pool.execute('UPDATE users SET account_locked=1,failed_login_attempts=3 WHERE id=?', [input.username]);
    await service.requestPasswordReset({ ...input, email: 'attacker@example.com' });
    assert.equal((await pool.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE purpose='reset'"))[0][0].count, 0);
    await service.requestPasswordReset(input);
    assert.equal((await getUser(input.username)).account_locked, 1);
    const token = await getToken(input.username, 'reset');
    await service.resetPassword({ token, password: 'changed-password-2026' });
    const updated = await getUser(input.username);
    assert.equal(updated.account_active, 1);
    assert.equal(updated.account_locked, 0);
    assert.equal(updated.failed_login_attempts, 0);
    await rejectsPublic(service.me(session.token));
    await rejectsPublic(service.resetPassword({ token, password: 'another-password-2026' }), 400);
    await rejectsPublic(service.login(input));
    await service.login({ ...input, password: 'changed-password-2026' });
  });

  await t.test('concurrent redemption permits exactly one password reset and expired reset codes never work', async () => {
    await clear();
    const input = await activeUser('redeem_user');
    await service.requestPasswordReset(input);
    const token = await getToken(input.username, 'reset');
    const outcomes = await Promise.allSettled([service, secondService].map(instance => instance.resetPassword({ token, password: 'changed-password-2026' })));
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected' && outcome.reason.status === 400).length, 1);
    await service.requestPasswordReset(input);
    const expired = await getToken(input.username, 'reset');
    await pool.query("UPDATE auth_tokens SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)");
    await rejectsPublic(service.resetPassword({ token: expired, password: 'another-password-2026' }), 400);
  });

  await t.test('legacy disabled accounts cannot be activated through resend or recovery and expired sessions fail', async () => {
    await clear();
    const input = await activeUser('disabled_user');
    const session = await service.login(input);
    await pool.execute('UPDATE users SET account_active=0 WHERE id=?', [input.username]);
    await service.requestPasswordReset(input);
    await service.resendVerification(input);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_tokens'))[0][0].count, 0);
    assert.equal((await getUser(input.username)).account_active, 0);
    await rejectsPublic(service.me(session.token));
    await pool.execute('UPDATE users SET account_active=1 WHERE id=?', [input.username]);
    await pool.query('UPDATE auth_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)');
    await rejectsPublic(service.me(session.token));
  });

  await t.test('SQL-looking names stay data, and SQL-looking recovery fields cannot broaden a query', async () => {
    await clear();
    const input = await activeUser('sql_user');
    await service.findId({ fullName: "' OR 1=1 --", email: input.email });
    await service.requestPasswordReset({ username: "' OR 1=1 --", email: input.email });
    assert.equal((await pool.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE purpose='reset'"))[0][0].count, 0);
    await signup('literal_user', { fullName: "O'Reilly; DROP TABLE users; --" });
    assert.equal((await getUser('literal_user')).name, "O'Reilly; DROP TABLE users; --");
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM users'))[0][0].count, 2);
  });

  await t.test('shared rate limits serialize concurrent pools and recover only after their database window expires', async () => {
    await clear();
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
      limitRate(index % 2 ? pool : secondPool, config.secret, 'integration', 'same-account', 3, 900)));
    assert.equal(attempts.filter(outcome => outcome.status === 'fulfilled').length, 3);
    assert.equal(attempts.filter(outcome => outcome.status === 'rejected' && outcome.reason.status === 429).length, 5);
    const [buckets] = await pool.query('SELECT bucket_hash,hits FROM auth_rate_limits');
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].hits, 3);
    assert.match(buckets[0].bucket_hash, /^[a-f0-9]{64}$/);
    await pool.query('UPDATE auth_rate_limits SET reset_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)');
    await limitRate(secondPool, config.secret, 'integration', 'same-account', 3, 900);
    assert.equal((await pool.query('SELECT hits FROM auth_rate_limits'))[0][0].hits, 1);
  });

  await t.test('transaction failures roll back both account and queued mail writes', async () => {
    await clear();
    await assert.rejects(transaction(pool, async connection => {
      await connection.execute("INSERT INTO auth_rate_limits(bucket_hash,hits,reset_at) VALUES (?,1,UTC_TIMESTAMP(3))", ['a'.repeat(64)]);
      throw new Error('synthetic failure');
    }), /synthetic failure/);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_rate_limits'))[0][0].count, 0);
    await pool.query('RENAME TABLE auth_pending_registrations TO review_hidden_pending');
    try { await assert.rejects(signup('rollback_user')); }
    finally { await pool.query('RENAME TABLE review_hidden_pending TO auth_pending_registrations'); }
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM users'))[0][0].count, 0);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_mail_outbox'))[0][0].count, 0);
  });

  await t.test('mail workers claim each queued message once across concurrent pools', async () => {
    await clear();
    await signup('mail_user');
    const messages = [];
    const transport = { sendMail: async message => { messages.push(message); } };
    await Promise.all([deliverMailBatch(pool, config, transport), deliverMailBatch(secondPool, config, transport)]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to.address, 'mail_user@example.com');
    assert.match(messages[0].text, /인증 코드: [A-Za-z0-9_-]{43}/);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_mail_outbox'))[0][0].count, 0);
  });

  await t.test('SMTP failures release leases for delayed retry without logging recovery content', async context => {
    await clear();
    await signup('retry_user');
    const logs = [];
    context.mock.method(console, 'error', (...values) => logs.push(values.join(' ')));
    const failing = { sendMail: async () => { throw new Error('sensitive SMTP recipient and token must not be logged'); } };
    assert.equal(await deliverMailBatch(pool, config, failing), true);
    const [queued] = await pool.query('SELECT attempts,lease_until,claim_hash,available_at>UTC_TIMESTAMP(3) AS deferred_send FROM auth_mail_outbox');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].attempts, 1);
    assert.equal(queued[0].lease_until, null);
    assert.equal(queued[0].claim_hash, null);
    assert.equal(queued[0].deferred_send, 1);
    assert.deepEqual(logs, ['mail_delivery_failed']);
    assert.equal(await deliverMailBatch(secondPool, config, failing), false);
    await pool.query('UPDATE auth_mail_outbox SET available_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND),lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE)');
    assert.equal(await deliverMailBatch(secondPool, config, failing), false);
    await pool.query('UPDATE auth_mail_outbox SET lease_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)');
    let sent = 0;
    await deliverMailBatch(secondPool, config, { sendMail: async () => { sent++; } });
    assert.equal(sent, 1);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_mail_outbox'))[0][0].count, 0);
  });

  await t.test('configured isolated SMTP accepts a real nodemailer delivery', { skip: process.env.SMTP_SMOKE_ENABLED !== '1' }, async () => {
    await clear();
    assert.ok(['127.0.0.1', 'localhost', 'mail'].includes(config.smtp.host), 'SMTP smoke must target an isolated sink');
    await signup('smtp_user');
    assert.equal(await deliverMailBatch(pool, config), true);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_mail_outbox'))[0][0].count, 0);
  });

  await t.test('HTTP rejects cross-origin, missing custom header, non-JSON, malformed and oversized submissions', async () => {
    await clear();
    const app = createApp({ pool, config });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const headers = { Origin: config.origin, 'X-Buteami-Request': '1', 'Content-Type': 'application/json' };
      const post = (path, body, overrides = {}) => fetch(`${base}/api/auth/${path}`, { method: 'POST', headers: { ...headers, ...overrides }, body });
      assert.equal((await post('signup', '{}', { Origin: 'https://attacker.example' })).status, 403);
      assert.equal((await post('signup', '{}', { 'X-Buteami-Request': '' })).status, 403);
      assert.equal((await post('signup', '{}', { 'Content-Type': 'text/plain' })).status, 415);
      assert.equal((await post('signup', '{')).status, 400);
      assert.equal((await post('signup', JSON.stringify({ padding: 'x'.repeat(9000) }))).status, 413);
      assert.equal((await post('login', JSON.stringify(userInput("' OR 1=1 --")))).status, 400);
      const unknown = await fetch(`${base}/api/unknown`);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.headers.get('cache-control'), 'no-store');
      assert.equal(unknown.headers.get('x-powered-by'), null);
      const created = await post('signup', JSON.stringify(userInput('http_user')));
      assert.equal(created.status, 202);
      assert.ok(!JSON.stringify(await created.json()).includes(await getToken('http_user', 'verify')));
      await service.verifyEmail({ token: await getToken('http_user', 'verify') });
      const login = await post('login', JSON.stringify(userInput('http_user')));
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.match(cookie, /Path=\//);
      assert.ok(!JSON.stringify(await login.json()).includes('token'));
      const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie.split(';')[0] } });
      assert.deepEqual(await me.json(), { user: { username: 'http_user', fullName: '테스트 사용자' } });
      const knownReset = await post('request-password-reset', JSON.stringify(userInput('http_user')));
      const absentReset = await post('request-password-reset', JSON.stringify(userInput('absent_user')));
      assert.equal(knownReset.status, 202);
      assert.equal(absentReset.status, 202);
      assert.deepEqual(await knownReset.json(), await absentReset.json());
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('production sessions use the host-only Secure HttpOnly cookie and exclude the token from JSON', async () => {
    await clear();
    await activeUser('secure_user');
    const secureConfig = { ...config, production: true, secure: true, origin: 'https://buteami.example' };
    const server = createApp({ pool, config: secureConfig }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
        method: 'POST', headers: { Origin: secureConfig.origin, 'X-Buteami-Request': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify(userInput('secure_user')),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /^__Host-buteami_session=/);
      assert.match(cookie, /; Secure(?:;|$)/);
      assert.match(cookie, /; HttpOnly(?:;|$)/);
      assert.match(cookie, /; SameSite=Strict(?:;|$)/);
      assert.match(cookie, /; Path=\/(?:;|$)/);
      assert.doesNotMatch(cookie, /Domain=/i);
      assert.deepEqual(await response.json(), { user: { username: 'secure_user', fullName: '테스트 사용자' } });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('schema compatibility refuses incompatible engines and legacy user ID mappings', async () => {
    await clear();
    await pool.query('ALTER TABLE users ENGINE=Aria');
    try { await assert.rejects(assertSchema(pool), /InnoDB/); }
    finally { await pool.query('ALTER TABLE users ENGINE=InnoDB'); }
    await pool.query('ALTER TABLE users MODIFY id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL');
    try { await assert.rejects(assertSchema(pool), /collation/); }
    finally { await pool.query('ALTER TABLE users MODIFY id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL'); }
    await pool.query('ALTER TABLE auth_sessions MODIFY user_id VARCHAR(20) NOT NULL');
    try { await assert.rejects(assertSchema(pool), /capacity/); }
    finally { await pool.query('ALTER TABLE auth_sessions MODIFY user_id VARCHAR(50) NOT NULL'); }
    await assertSchema(pool);
  });

  await t.test('schema compatibility refuses short token hashes and invalid token lifetime or purpose columns', async () => {
    await clear();
    const mutations = [
      ['ALTER TABLE auth_tokens MODIFY token_hash CHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
        'ALTER TABLE auth_tokens MODIFY token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', /CHAR\(64\)/],
      ['ALTER TABLE auth_tokens MODIFY expires_at VARCHAR(32) NOT NULL',
        'ALTER TABLE auth_tokens MODIFY expires_at DATETIME(3) NOT NULL', /DATETIME/],
      ["ALTER TABLE auth_tokens MODIFY purpose ENUM('verify','reset','other') NOT NULL",
        "ALTER TABLE auth_tokens MODIFY purpose ENUM('verify','reset') NOT NULL", /enum mismatch/],
      ['ALTER TABLE auth_mail_outbox MODIFY payload VARCHAR(32) NOT NULL',
        'ALTER TABLE auth_mail_outbox MODIFY payload TEXT NOT NULL', /text required/],
      ['ALTER TABLE auth_mail_outbox MODIFY attempts TINYINT UNSIGNED NOT NULL DEFAULT 5',
        'ALTER TABLE auth_mail_outbox MODIFY attempts TINYINT UNSIGNED NOT NULL DEFAULT 0', /default 0/],
      ["ALTER TABLE auth_mail_outbox MODIFY created_at VARCHAR(32) NOT NULL DEFAULT ''",
        'ALTER TABLE auth_mail_outbox MODIFY created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)', /timestamp default/],
      ["ALTER TABLE auth_mail_outbox MODIFY lease_until DATETIME(3) NOT NULL DEFAULT '2000-01-01 00:00:00'",
        'ALTER TABLE auth_mail_outbox MODIFY lease_until DATETIME(3) NULL DEFAULT NULL', /empty lease/],
    ];
    for (const [mutate, restore, message] of mutations) {
      await pool.query(mutate);
      try { await assert.rejects(assertSchema(pool), message); }
      finally { await pool.query(restore); }
    }
    await assertSchema(pool);
  });

  await t.test('additive migration derives auxiliary user ID capacity and collation from a compatible prototype', async () => {
    await clear();
    for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
    const prototypeDdl = originalDdl.replace('varchar(50)', 'varchar(20)').replaceAll('utf8mb4_general_ci', 'utf8mb4_unicode_ci');
    try {
      await pool.query(prototypeDdl);
      await pool.execute('INSERT INTO users(id,password_hash,email,name) VALUES (?,?,?,?)', ['prototype_user', legacyHash, 'prototype@example.com', '기존 사용자']);
      const before = (await pool.query('SHOW CREATE TABLE users'))[0][0]['Create Table'];
      const rows = (await pool.query('SELECT * FROM users'))[0];
      await applyMigrations(pool);
      await applyMigrations(pool);
      assert.equal((await pool.query('SHOW CREATE TABLE users'))[0][0]['Create Table'], before);
      assert.deepEqual((await pool.query('SELECT * FROM users'))[0], rows);
      const [columns] = await pool.query(`SELECT CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='user_id'`);
      assert.equal(columns.length, 3);
      for (const column of columns) {
        assert.equal(column.CHARACTER_MAXIMUM_LENGTH, 20);
        assert.equal(column.COLLATION_NAME, 'utf8mb4_unicode_ci');
      }
    } finally {
      for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.query(originalDdl);
      await applyMigrations(pool);
    }
  });
});
