// Run with Playwright installed, or BUTEAMI_PLAYWRIGHT_PATH pointing at its package.
// These browser checks mock only /api/auth; database integration is tested separately.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.BUTEAMI_PLAYWRIGHT_PATH || 'playwright');
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const calls = [];
let responder = async (path) => ({ status: path.endsWith('/me') ? 401 : 200, body: { message: 'ok' } });
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml' };
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/auth/')) {
      let raw = ''; for await (const part of req) raw += part;
      const data = raw ? JSON.parse(raw) : null;
      calls.push({ path: url.pathname, data, origin: req.headers.origin, header: req.headers['x-buteami-request'], cookie: req.headers.cookie });
      const reply = await responder(url.pathname, data);
      res.writeHead(reply.status, { 'Content-Type':'application/json', ...(reply.headers || {}) });
      res.end(JSON.stringify(reply.body)); return;
    }
    const file = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403).end(); return; }
    const data = await readFile(file); res.writeHead(200, { 'Content-Type':types[extname(file)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0,'127.0.0.1',done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless:true, ...(process.env.BUTEAMI_BROWSER_CHANNEL ? { channel:process.env.BUTEAMI_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport:{ width:1280,height:1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const fill = async (id,value) => page.locator('#'+id).fill(value);
const submit = () => page.locator('[type="submit"]').click();
const visible = async (id) => { await page.locator('#'+id).waitFor({ state:'visible' }); };
try {
  let release;
  const gate = new Promise((done) => { release = done; });
  responder = async (path) => { if (path.endsWith('/signup')) { await gate; return { status:202,body:{ message:'generic' } }; } return { status:401,body:{} }; };
  await page.goto(origin+'/auth/signup.html');
  await fill('fullName','테스트 사용자'); await fill('username','demo_user'); await fill('birthday','2000-02-29'); await fill('email','demo@example.com'); await fill('password','new-password-2026'); await fill('confirmPassword','new-password-2026');
  await submit();
  assert.equal(await page.locator('[type=submit]').isDisabled(),true);
  await page.locator('#account-form').evaluate((form) => form.dispatchEvent(new Event('submit',{ bubbles:true,cancelable:true })));
  release(); await visible('form-result');
  assert.equal(calls.filter((call) => call.path.endsWith('/signup')).length,1);
  assert.match(await page.locator('#result-message').textContent(),/가입 가능한 정보라면/);
  assert.equal(await page.locator('#password').inputValue(),'');
  const signup = calls.find((call) => call.path.endsWith('/signup'));
  assert.equal(signup.data.birthday,'2000-02-29'); assert.equal(signup.origin,origin); assert.equal(signup.header,'1');

  responder = async (path) => ({ status:path.endsWith('/me') ? 401 : 200,body:{ user:{ username:'demo_user',fullName:'<img src=x onerror=alert(1)>' } },headers:path.endsWith('/login') ? { 'Set-Cookie':'buteami=test; HttpOnly; SameSite=Lax; Path=/' } : {} });
  await page.goto(origin+'/auth/login.html'); await fill('username','demo_user'); await fill('password','oldpass'); await submit(); await visible('logout');
  assert.match(await page.locator('#result-message').textContent(),/<img src=x/); assert.equal(await page.locator('#form-result img').count(),0);
  await page.locator('#logout').click(); await visible('account-form');
  assert.ok(calls.find((call) => call.path.endsWith('/logout')).cookie.includes('buteami=test'));

  let resetStatus = 400;
  responder = async (path) => ({ status:path.endsWith('/request-password-reset') ? 202 : resetStatus,body:{ message:'internal database details must not render' } });
  await page.goto(origin+'/auth/reset-password.html'); await fill('username','demo_user'); await fill('email','demo@example.com'); await submit(); await visible('form-result');
  assert.match(await page.locator('#result-message').textContent(),/일치하는 인증된 계정이 있다면/);
  await page.locator('[data-form-kind="reset-password"]').click();
  assert.equal(await page.locator('#username').isDisabled(),true); assert.equal(await page.locator('#token').isDisabled(),false);
  await fill('token','a'.repeat(43)); await fill('password','new-password-2026'); await fill('confirmPassword','new-password-2026'); await submit(); await visible('form-summary');
  assert.equal(await page.locator('#form-result').isVisible(),false); assert.doesNotMatch(await page.locator('#form-summary').textContent(),/database/); assert.equal(await page.locator('#token').inputValue(),'');
  resetStatus = 200;
  await fill('token','a'.repeat(43)); await fill('password','new-password-2026'); await fill('confirmPassword','new-password-2026'); await submit(); await visible('form-result');
  assert.match(await page.locator('#result-title').textContent(),/비밀번호를 변경/);

  responder = async (path) => ({ status:path.endsWith('/verify-email') ? 200 : 202,body:{ message:'ok' } });
  await page.goto(origin+'/auth/verify-email.html'); await fill('token','a'.repeat(43));
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); assert.equal(await page.locator('#token').inputValue(),'');
  await fill('token','a'.repeat(43)); await submit(); await visible('form-result'); assert.match(await page.locator('#result-title').textContent(),/인증을 완료/);
  await page.locator('[data-form-kind="resend-verification"]').click(); await fill('username','demo_user'); await fill('email','demo@example.com'); await submit(); await visible('form-result');
  assert.match(await page.locator('#result-message').textContent(),/정보가 일치한다면/);
  await page.goto(origin+'/auth/find-id.html'); await fill('fullName','테스트 사용자'); await fill('email','demo@example.com'); await submit(); await visible('form-result');
  assert.match(await page.locator('#result-message').textContent(),/일치하는 인증된 계정이 있다면/);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length),0);
  assert.equal(new URL(page.url()).search,'');
  await page.setViewportSize({ width:375,height:900 });
  await page.goto(origin+'/auth/reset-password.html'); await page.locator('[data-form-kind="reset-password"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
  if (process.env.BUTEAMI_UI_SCREENSHOT) await page.screenshot({ path:process.env.BUTEAMI_UI_SCREENSHOT,fullPage:true });
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: signup/pending; login/logout cookie; recovery/reset error+success; verify/resend; find ID; pagehide clearing; mobile width.');
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
