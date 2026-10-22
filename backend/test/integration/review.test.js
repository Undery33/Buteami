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
import { digest, hashPassword, verifyPassword } from '../../src/security.js';
import { validateInput } from '../../src/validation.js';
import { limitRate } from '../../src/rate-limit.js';

const enabled = process.env.DB_TEST_ENABLED === '1';

test('MariaDB authentication and HTTP security integration', { skip: !enabled }, async t => {
  // These tests modify data and DDL in a dedicated local/CI fixture only.
  assert.equal(process.env.DB_NAME, 'buteami_test', 'Use only the dedicated buteami_test database');
  assert.ok(['127.0.0.1', 'localhost', 'db', 'mariadb'].includes(process.env.DB_HOST), 'Use only an isolated local or CI database');
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:8080', COOKIE_SECURE: 'false',
    APP_SECRET: process.env.APP_SECRET || 'isolated-integration-test-secret-32-bytes-minimum' });
  const pool = createPool(config);
  const secondPool = createPool(config);
  t.after(async () => { await secondPool.end(); await pool.end(); });
  const tables = ['auth_sessions', 'auth_rate_limits', 'users'];
  // Remove earlier test-only fixtures when upgrading this disposable database.
  for (const table of [...tables, 'auth_pending_registrations', 'auth_tokens', 'auth_mail_outbox']) await pool.query(`DROP TABLE IF EXISTS ${table}`);
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
  const activeUser = async username => { await signup(username); return userInput(username); };
  const getUser = async username => (await pool.execute('SELECT * FROM users WHERE id=?', [username]))[0][0];
  const rejectsPublic = (promise, status = 401) => assert.rejects(promise, error => error.status === status);
  const resetInput = (input, changes = {}) => validateInput('reset-password', { ...input, password: 'changed-password-2026', confirmPassword: 'changed-password-2026', ...changes });

  await t.test('additive migration preserves supplied existing users DDL and every preexisting value', async () => {
    await assertSchema(pool, { usersOnly: true });
    const sql = await readFile(new URL('../../migrations/001-auth.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(?:ALTER|DROP)\s+TABLE\b/i);
    for (let run = 0; run < 2; run++) {
      await applyMigrations(pool);
      await assertSchema(pool);
      assert.equal((await pool.query('SHOW CREATE TABLE users'))[0][0]['Create Table'], originalDdl);
      assert.deepEqual((await pool.query('SELECT * FROM users ORDER BY id'))[0], originalRows);
    }
    const [actualTables] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.deepEqual(actualTables.map(row => row.TABLE_NAME).sort(), [...tables].sort());
    const [columns] = await pool.query(`SELECT CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='user_id'`);
    assert.equal(columns.length, 1);
    assert.equal(columns[0].CHARACTER_MAXIMUM_LENGTH, 50);
    assert.equal(columns[0].COLLATION_NAME, 'utf8mb4_general_ci');
  });

  await t.test('an existing active account with nullable birthday and six-character password can authenticate', async () => {
    const result = await service.login(validateInput('login', { username: 'legacy_user', password: legacyPassword }));
    assert.equal(result.user.username, 'legacy_user');
    assert.equal((await getUser('legacy_user')).birthday, null);
    assert.equal(result.user.fullName.length, 100);
    assert.deepEqual(await service.me(result.token), { user: result.user });
  });

  await t.test('signup stores a salted hash and the new account can immediately log in', async () => {
    await clear();
    await signup('signup_user');
    const user = await getUser('signup_user');
    assert.equal(user.account_active, 1);
    assert.equal(user.failed_login_attempts, 0);
    assert.equal(user.account_locked, 0);
    assert.notEqual(user.password_hash, userInput('signup_user').password);
    assert.match(user.password_hash, /^scrypt\$/);
    assert.equal((await service.login(userInput('signup_user'))).user.username, 'signup_user');
  });

  await t.test('duplicate username or email returns a conflict without overwriting an account', async () => {
    await clear();
    await signup('duplicate_user');
    const initial = await getUser('duplicate_user');
    await rejectsPublic(signup('duplicate_user', { email: 'other@example.com', password: 'replacement-password-2026', confirmPassword: 'replacement-password-2026' }), 409);
    await rejectsPublic(signup('other_user', { email: initial.email }), 409);
    assert.deepEqual(await getUser('duplicate_user'), initial);
    assert.equal(await getUser('other_user'), undefined);
  });

  await t.test('successful login resets failure count and rotates a supplied session without exposing private fields', async () => {
    await clear();
    const input = await activeUser('session_user');
    await rejectsPublic(service.login({ ...input, password: 'wrong-password' }));
    assert.equal((await getUser(input.username)).failed_login_attempts, 1);
    const first = await service.login(input);
    assert.deepEqual(first.user, { username: input.username, fullName: input.fullName });
    assert.equal((await getUser(input.username)).failed_login_attempts, 0);
    const second = await secondService.login(input, first.token);
    await rejectsPublic(service.me(first.token));
    assert.deepEqual(await service.me(second.token), { user: first.user });
    assert.deepEqual((await pool.query('SELECT token_hash FROM auth_sessions'))[0].map(row => row.token_hash), [digest(second.token)]);
    await service.logout(second.token);
    await rejectsPublic(service.me(second.token));
  });

  await t.test('three concurrent failures across pools commit three attempts, lock the account and revoke sessions', async () => {
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
    const locked = await service.login(input).catch(error => error);
    const missing = await service.login({ username: 'absent_user', password: input.password }).catch(error => error);
    assert.equal(locked.message, missing.message);
    assert.equal(locked.status, missing.status);
  });

  await t.test('identifier lookup requires matching name and email and returns only the identifier', async () => {
    await clear();
    const input = userInput('lookup_user', { fullName: 'Mary' });
    await signup(input.username, { fullName: input.fullName });
    assert.deepEqual(await service.findId(validateInput('find-id', input)), { username: input.username });
    for (const changes of [{ fullName: '다른 이름' }, { fullName: 'mary' }, { email: 'other@example.com' }]) {
      await rejectsPublic(service.findId(validateInput('find-id', { ...input, ...changes })), 400);
    }
  });

  await t.test('a mismatched name, username or email cannot change password, unlock or revoke an existing session', async () => {
    await clear();
    const input = userInput('mismatch_user', { fullName: 'Mary' });
    await signup(input.username, { fullName: input.fullName });
    const session = await service.login(input);
    await pool.execute('UPDATE users SET failed_login_attempts=2 WHERE id=?', [input.username]);
    const original = await getUser(input.username);
    for (const changes of [{ fullName: '다른 이름' }, { fullName: 'mary' }, { username: 'other_user' }, { email: 'attacker@example.com' }]) {
      await rejectsPublic(service.resetPassword(resetInput(input, changes)), 400);
      assert.deepEqual(await getUser(input.username), original);
      assert.equal((await service.me(session.token)).user.username, input.username);
    }
    await pool.execute('UPDATE users SET account_locked=1,failed_login_attempts=3 WHERE id=?', [input.username]);
    await rejectsPublic(service.resetPassword(resetInput(input, { fullName: '다른 이름' })), 400);
    assert.equal((await getUser(input.username)).account_locked, 1);
    assert.equal((await getUser(input.username)).failed_login_attempts, 3);
  });

  await t.test('matching name, identifier and email reset the password, unlock the account and revoke every session', async () => {
    await clear();
    const input = await activeUser('recover_user');
    const first = await service.login(input);
    const second = await secondService.login(input);
    await pool.execute('UPDATE users SET account_locked=1,failed_login_attempts=3 WHERE id=?', [input.username]);
    await service.resetPassword(resetInput(input, { password: 'abcdef', confirmPassword: 'abcdef' }));
    const updated = await getUser(input.username);
    assert.equal(updated.account_active, 1);
    assert.equal(updated.account_locked, 0);
    assert.equal(updated.failed_login_attempts, 0);
    assert.equal(await verifyPassword('abcdef', updated.password_hash), true);
    await rejectsPublic(service.me(first.token));
    await rejectsPublic(service.me(second.token));
    await rejectsPublic(service.login(input));
    await service.login({ ...input, password: 'abcdef' });
  });

  await t.test('concurrent matching resets remain atomic and leave one complete valid password hash', async () => {
    await clear();
    const input = await activeUser('parallel_user');
    const session = await service.login(input);
    const passwords = ['first-new-password', 'second-new-password'];
    await Promise.all([service, secondService].map((instance, index) => instance.resetPassword(resetInput(input, { password: passwords[index], confirmPassword: passwords[index] }))));
    const updated = await getUser(input.username);
    const matches = await Promise.all(passwords.map(password => verifyPassword(password, updated.password_hash)));
    assert.equal(matches.filter(Boolean).length, 1);
    assert.equal(updated.account_locked, 0);
    assert.equal(updated.failed_login_attempts, 0);
    await rejectsPublic(service.me(session.token));
  });

  await t.test('disabled accounts and expired sessions cannot authenticate', async () => {
    await clear();
    const input = await activeUser('disabled_user');
    const session = await service.login(input);
    await pool.execute('UPDATE users SET account_active=0 WHERE id=?', [input.username]);
    const disabled = await getUser(input.username);
    await rejectsPublic(service.login(input));
    await rejectsPublic(service.me(session.token));
    await rejectsPublic(service.resetPassword(resetInput(input)), 400);
    assert.deepEqual(await getUser(input.username), disabled);
    await pool.execute('UPDATE users SET account_active=1 WHERE id=?', [input.username]);
    await pool.query('UPDATE auth_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)');
    await rejectsPublic(service.me(session.token));
  });

  await t.test('SQL-looking names remain data and cannot broaden identifier or reset queries', async () => {
    await clear();
    const input = await activeUser('sql_user');
    await rejectsPublic(service.findId({ fullName: "' OR 1=1 --", email: input.email }), 400);
    await rejectsPublic(service.resetPassword({ ...resetInput(input), username: "' OR 1=1 --" }), 400);
    assert.equal(await verifyPassword(input.password, (await getUser(input.username)).password_hash), true);
    const literal = { fullName: "O'Reilly; DROP TABLE users; --" };
    await signup('literal_user', literal);
    assert.deepEqual(await service.findId({ ...userInput('literal_user'), ...literal }), { username: 'literal_user' });
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM users'))[0][0].count, 2);
  });

  await t.test('shared rate limits serialize concurrent pools and reset only when their database window expires', async () => {
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

  await t.test('transaction failures roll back counters and password changes before session revocation', async () => {
    await clear();
    await assert.rejects(transaction(pool, async connection => {
      await connection.execute('INSERT INTO auth_rate_limits(bucket_hash,hits,reset_at) VALUES (?,1,UTC_TIMESTAMP(3))', ['a'.repeat(64)]);
      throw new Error('synthetic failure');
    }), /synthetic failure/);
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM auth_rate_limits'))[0][0].count, 0);
    const input = await activeUser('rollback_user');
    const session = await service.login(input);
    const original = await getUser(input.username);
    await pool.query('RENAME TABLE auth_sessions TO review_hidden_sessions');
    try { await assert.rejects(service.resetPassword(resetInput(input))); }
    finally { await pool.query('RENAME TABLE review_hidden_sessions TO auth_sessions'); }
    assert.deepEqual(await getUser(input.username), original);
    assert.equal((await service.me(session.token)).user.username, input.username);
  });

  await t.test('HTTP validates origin, JSON, body limits and identity matching, and removed endpoints return 404', async () => {
    await clear();
    const server = createApp({ pool, config }).listen(0, '127.0.0.1');
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
      for (const removed of ['verify-email', 'resend-verification', 'request-password-reset']) assert.equal((await post(removed, '{}')).status, 404);
      const input = userInput('http_user', { password: 'abcdef', confirmPassword: 'abcdef' });
      assert.equal((await post('signup', JSON.stringify(input))).status, 201);
      assert.equal((await post('signup', JSON.stringify(input))).status, 409);
      const login = await post('login', JSON.stringify(input));
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.ok(!JSON.stringify(await login.json()).includes('token'));
      const found = await post('find-id', JSON.stringify({ fullName: input.fullName, email: input.email }));
      assert.equal(found.status, 200);
      assert.deepEqual(await found.json(), { username: input.username });
      const missing = await post('find-id', JSON.stringify({ fullName: '다른 이름', email: input.email }));
      assert.equal(missing.status, 400);
      assert.ok(!JSON.stringify(await missing.json()).includes(input.email));
      const mismatch = await post('reset-password', JSON.stringify({ ...input, fullName: '다른 이름', password: 'newpass', confirmPassword: 'newpass' }));
      assert.equal(mismatch.status, 400);
      const reset = await post('reset-password', JSON.stringify({ ...input, password: 'newpass', confirmPassword: 'newpass' }));
      assert.equal(reset.status, 200);
      assert.ok(!JSON.stringify(await reset.json()).includes('newpass'));
      const expired = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie.split(';')[0] } });
      assert.equal(expired.status, 401);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('production sessions use a host-only Secure HttpOnly cookie and omit the token from JSON', async () => {
    await clear();
    await activeUser('secure_user');
    const secureConfig = { ...config, production: true, secure: true, origin: 'https://buteami.example' };
    const server = createApp({ pool, config: secureConfig }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, { method: 'POST',
        headers: { Origin: secureConfig.origin, 'X-Buteami-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(userInput('secure_user')) });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie');
      for (const pattern of [/^__Host-buteami_session=/, /; Secure(?:;|$)/, /; HttpOnly(?:;|$)/, /; SameSite=Strict(?:;|$)/, /; Path=\/(?:;|$)/]) assert.match(cookie, pattern);
      assert.doesNotMatch(cookie, /Domain=/i);
      assert.deepEqual(await response.json(), { user: { username: 'secure_user', fullName: '테스트 사용자' } });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('schema checks reject nontransactional engines, incompatible user IDs and insufficient auxiliary capacity', async () => {
    await clear();
    const mutations = [
      ['ALTER TABLE users ENGINE=Aria', 'ALTER TABLE users ENGINE=InnoDB', /InnoDB/],
      ['ALTER TABLE users MODIFY id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL',
        'ALTER TABLE users MODIFY id VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL', /collation/],
      ['ALTER TABLE auth_sessions MODIFY user_id VARCHAR(20) NOT NULL', 'ALTER TABLE auth_sessions MODIFY user_id VARCHAR(50) NOT NULL', /capacity/],
      ['ALTER TABLE auth_sessions MODIFY token_hash CHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL',
        'ALTER TABLE auth_sessions MODIFY token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', /CHAR\(64\)/],
      ['ALTER TABLE auth_sessions MODIFY expires_at VARCHAR(32) NOT NULL', 'ALTER TABLE auth_sessions MODIFY expires_at DATETIME(3) NOT NULL', /DATETIME/],
    ];
    for (const [mutate, restore, message] of mutations) {
      await pool.query(mutate);
      try { await assert.rejects(assertSchema(pool), message); }
      finally { await pool.query(restore); }
    }
    await assertSchema(pool);
  });

  await t.test('migration derives auxiliary ID capacity and collation from a compatible prototype without altering users', async () => {
    await clear();
    for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
    try {
      await pool.query(originalDdl.replace('varchar(50)', 'varchar(20)').replaceAll('utf8mb4_general_ci', 'utf8mb4_unicode_ci'));
      await pool.execute('INSERT INTO users(id,password_hash,email,name) VALUES (?,?,?,?)', ['prototype_user', legacyHash, 'prototype@example.com', '기존 사용자']);
      const before = (await pool.query('SHOW CREATE TABLE users'))[0][0]['Create Table'];
      const rows = (await pool.query('SELECT * FROM users'))[0];
      await applyMigrations(pool);
      await applyMigrations(pool);
      assert.equal((await pool.query('SHOW CREATE TABLE users'))[0][0]['Create Table'], before);
      assert.deepEqual((await pool.query('SELECT * FROM users'))[0], rows);
      const [columns] = await pool.query(`SELECT CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='user_id'`);
      assert.equal(columns.length, 1);
      assert.equal(columns[0].CHARACTER_MAXIMUM_LENGTH, 20);
      assert.equal(columns[0].COLLATION_NAME, 'utf8mb4_unicode_ci');
    } finally {
      for (const table of tables) await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.query(originalDdl);
      await applyMigrations(pool);
    }
  });
});
