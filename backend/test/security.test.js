import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { hashPassword, verifyPassword, randomToken, validToken, digest, sealMail, openMail } from '../src/security.js';
import { validateInput } from '../src/validation.js';
import { loadConfig } from '../src/config.js';

const input = {
  username: 'review_user', fullName: '검증 사용자', email: 'Review@Example.com',
  birthday: '2000-02-29', password: '  exact-password-2026  ', confirmPassword: '  exact-password-2026  ',
};
const config = {
  NODE_ENV: 'development', APP_ORIGIN: 'http://localhost:8080', COOKIE_SECURE: 'false',
  APP_SECRET: 'test-only-configuration-key-32-bytes-minimum', DB_PASSWORD: 'test-only-db-password',
  SMTP_HOST: 'localhost', SMTP_FROM: 'Buteami <test@example.invalid>',
};

test('password hashing uses distinct salts and verifies exact whitespace without plaintext storage', async () => {
  const first = await hashPassword(input.password);
  const second = await hashPassword(input.password);
  assert.match(first, /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes(input.password));
  assert.equal(await verifyPassword(input.password, first), true);
  assert.equal(await verifyPassword(input.password.trim(), first), false);
  assert.equal(await verifyPassword('wrong password', first), false);
});

test('malformed and unsupported password hash parameters fail closed', async () => {
  for (const encoded of [null, '', 'plaintext-password', 'scrypt$999999999$8$3$x$y', `scrypt$32768$8$3$${'0'.repeat(32)}$bad`]) {
    assert.equal(await verifyPassword(input.password, encoded), false);
  }
});

test('opaque tokens have high entropy and only hashes need be persisted', () => {
  const tokens = Array.from({ length: 100 }, randomToken);
  assert.equal(new Set(tokens).size, 100);
  for (const token of tokens) {
    assert.equal(validToken(token), true);
    assert.match(digest(token), /^[a-f0-9]{64}$/);
    assert.notEqual(digest(token), token);
  }
  for (const invalid of [null, [], {}, 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}+`]) {
    assert.equal(validToken(invalid), false);
  }
});

test('mail outbox encryption conceals recovery data and rejects tampering or another key', () => {
  const payload = { to: 'review@example.com', text: `https://example.com/#token=${randomToken()}` };
  const sealed = sealMail(config.APP_SECRET, payload);
  assert.deepEqual(openMail(config.APP_SECRET, sealed), payload);
  assert.ok(!sealed.includes(payload.to));
  assert.notEqual(sealMail(config.APP_SECRET, payload), sealed);
  assert.throws(() => openMail('different-key-which-cannot-open-mail', sealed));
  const bytes = Buffer.from(sealed, 'base64');
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => openMail(config.APP_SECRET, bytes.toString('base64')));
});

test('server validates real calendar dates, password confirmation and hostile identifiers', () => {
  assert.equal(validateInput('signup', input).password, input.password);
  assert.equal(validateInput('signup', input).email, 'review@example.com');
  for (const birthday of ['2001-02-29', '2000-02-30', '2000-13-01', '1899-12-31', '9999-01-01', '']) {
    assert.throws(() => validateInput('signup', { ...input, birthday }), error => error.status === 400);
  }
  for (const username of ["' OR 1=1 --", 'abc', 'a'.repeat(21), '<script>', ['valid_user']]) {
    assert.throws(() => validateInput('login', { ...input, username }), error => error.status === 400);
  }
  assert.throws(() => validateInput('signup', { ...input, confirmPassword: input.password.trim() }));
  assert.throws(() => validateInput('signup', { ...input, password: ' '.repeat(12), confirmPassword: ' '.repeat(12) }));
  assert.throws(() => validateInput('signup', { ...input, email: 'review@example.com\r\nBcc: attacker@example.com' }));
  for (const email of ['first@example.com,second@example.com', 'Name<review@example.com>', 'review(comment)@example.com', 'review\u0000@example.com']) {
    assert.throws(() => validateInput('signup', { ...input, email }));
  }
  assert.throws(() => validateInput('signup', []));
  assert.equal(validateInput('login', { ...input, password: 'legacy' }).password, 'legacy');
});

test('production configuration requires an exact HTTPS origin, secure cookies and secret material', () => {
  assert.equal(loadConfig(config).origin, config.APP_ORIGIN);
  const production = { ...config, NODE_ENV: 'production', APP_ORIGIN: 'https://buteami.example', COOKIE_SECURE: 'true' };
  assert.equal(loadConfig(production).smtp.requireTLS, true);
  assert.equal(loadConfig(production).secure, true);
  for (const change of [
    { APP_ORIGIN: 'http://buteami.example' }, { COOKIE_SECURE: 'false' },
    { APP_ORIGIN: 'https://buteami.example/' }, { APP_ORIGIN: 'https://buteami.example/path' },
    { APP_ORIGIN: 'https://name:password@buteami.example' }, { APP_SECRET: 'short' }, { DB_PASSWORD: '' },
  ]) assert.throws(() => loadConfig({ ...production, ...change }));
});

test('signup and reset accept six-character passwords and reject shorter or mismatched values', () => {
  for (const kind of ['signup', 'reset-password']) {
    for (const length of [6, 128]) {
      const password = 'a'.repeat(length);
      assert.equal(validateInput(kind, { ...input, token: 'a'.repeat(43), password, confirmPassword: password }).password, password);
    }
    for (const length of [0, 5, 129]) {
      const password = 'a'.repeat(length);
      assert.throws(() => validateInput(kind, { ...input, token: 'a'.repeat(43), password, confirmPassword: password }), error => error.status === 400);
    }
    assert.throws(() => validateInput(kind, { ...input, token: 'a'.repeat(43), password: ' '.repeat(6), confirmPassword: ' '.repeat(6) }));
    assert.throws(() => validateInput(kind, { ...input, token: 'a'.repeat(43), password: 'abcdef', confirmPassword: 'abcdeg' }));
  }
});

test('database TLS verifies certificate identity and rejects IP hosts before a connection is attempted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'buteami-ca-test-'));
  const ca = join(directory, 'ca.pem');
  try {
    writeFileSync(ca, rootCertificates[0]);
    const loaded = loadConfig({ ...config, DB_HOST: 'db.example.invalid', DB_TLS_CA_FILE: ca });
    assert.equal(loaded.db.ssl.verifyIdentity, true);
    assert.equal(loaded.db.ssl.rejectUnauthorized, true);
    assert.ok(Buffer.isBuffer(loaded.db.ssl.ca));
    for (const DB_HOST of ['192.168.20.10', '127.0.0.1', '::1']) {
      assert.throws(() => loadConfig({ ...config, DB_HOST, DB_TLS_CA_FILE: ca }), /DNS DB_HOST/);
    }
  } finally { unlinkSync(ca); rmdirSync(directory); }
});
