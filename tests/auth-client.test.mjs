import test from 'node:test';
import assert from 'node:assert/strict';
import { accountRequest } from '../assets/auth.js';

test('account mutations use JSON with same-origin cookies and a custom CSRF header', async () => {
  const secret = 'private token or password';
  let call;
  const fetcher = async (...args) => { call = args; return new Response(JSON.stringify({ message: 'accepted' }), { status: 202 }); };
  const signal = new AbortController().signal;
  await accountRequest('request-password-reset', { username: 'demo_user', email: 'demo@example.com', testSecret: secret }, fetcher, signal);
  const [url, options] = call;
  assert.equal(url, '/api/auth/request-password-reset');
  assert.ok(!url.includes(secret));
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.headers['X-Buteami-Request'], '1');
  assert.equal(options.signal, signal);
  assert.equal(JSON.parse(options.body).testSecret, secret);
});
test('failed requests never expose server error bodies as UI text', async () => {
  for (const status of [400,401,403,409,423,429,500,503]) {
    await assert.rejects(accountRequest('login', {}, async () => new Response('<script>database secret</script>', { status })), (error) => !/database|script/.test(error.message));
  }
});
test('HTML, malformed JSON, unexpected success statuses, and null responses cannot report success', async () => {
  for (const [body,status] of [['<html>proxy</html>',200],['null',200],['[]',200],['{}',202]]) await assert.rejects(accountRequest('reset-password', {}, async () => new Response(body, { status })));
});
test('unknown actions are rejected before any request', async () => {
  let called = false;
  await assert.rejects(accountRequest('__proto__', {}, async () => { called = true; }));
  assert.equal(called, false);
});
