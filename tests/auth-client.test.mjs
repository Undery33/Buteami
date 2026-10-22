import test from 'node:test';
import assert from 'node:assert/strict';
import { accountRequest, isAccountTransportAllowed } from '../assets/auth.js';

test('account transport permits HTTPS and only exact HTTP loopback hosts', () => {
  for (const url of ['https://www.buteami.com','https://192.168.20.10','https://example.test','http://localhost:8080','http://127.0.0.1:42801','http://[::1]:8080']) assert.equal(isAccountTransportAllowed(new URL(url)), true, url);
  for (const url of ['http://www.buteami.com','http://192.168.10.110:31991','http://127.0.0.2','http://localhost.example.com','http://localhost.','http://[::2]','file:///auth/login.html','ftp://localhost']) assert.equal(isAccountTransportAllowed(new URL(url)), false, url);
  for (const location of [undefined,null,{}, {protocol:'http:',hostname:'127.0.0.1.evil.test'}]) assert.equal(isAccountTransportAllowed(location),false);
});

test('remote HTTP blocks every account mutation before fetch sees credentials', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'location');
  let calls = 0;
  try {
    Object.defineProperty(globalThis, 'location', { configurable:true, value:new URL('http://www.buteami.com/auth/login.html') });
    for (const kind of ['login','signup','find-id','request-password-reset','reset-password','verify-email','resend-verification','logout']) {
      await assert.rejects(accountRequest(kind, {password:'never transmit',token:'never transmit'}, async () => { calls++; }), /HTTPS/);
    }
    assert.equal(calls,0);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'location', prior);
    else delete globalThis.location;
  }
});

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
