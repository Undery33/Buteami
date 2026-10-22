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
  responder = async (path) => { if (path.endsWith('/signup')) { await gate; return { status:201,body:{ message:'created' } }; } return { status:401,body:{} }; };
  await page.goto(origin+'/auth/signup.html');
  await fill('fullName','테스트 사용자'); await fill('username','demo_user'); await fill('birthday','2000-02-29'); await fill('email','demo@example.com'); await fill('password','abc12'); await fill('confirmPassword','abc12');
  await submit(); await visible('form-summary');
  assert.equal(calls.filter((call) => call.path.endsWith('/signup')).length,0,'Five-character signup password must stay on client');
  assert.equal(await page.locator('#password').getAttribute('minlength'),'6');
  await fill('password','abc123'); await fill('confirmPassword','abc123');
  await submit();
  assert.equal(await page.locator('[type=submit]').isDisabled(),true);
  await page.locator('#account-form').evaluate((form) => form.dispatchEvent(new Event('submit',{ bubbles:true,cancelable:true })));
  release(); await visible('form-result');
  assert.equal(calls.filter((call) => call.path.endsWith('/signup')).length,1);
  assert.match(await page.locator('#result-message').textContent(),/로그인할 수 있습니다/);
  assert.equal(await page.locator('#password').inputValue(),'');
  const signup = calls.find((call) => call.path.endsWith('/signup'));
  assert.equal(signup.data.birthday,'2000-02-29'); assert.equal(signup.origin,origin); assert.equal(signup.header,'1');

  responder = async (path) => ({ status:path.endsWith('/me') ? 401 : 200,body:{ user:{ username:'demo_user',fullName:'<img src=x onerror=alert(1)>' } },headers:path.endsWith('/login') ? { 'Set-Cookie':'buteami=test; HttpOnly; SameSite=Lax; Path=/' } : {} });
  await page.goto(origin+'/auth/login.html'); await fill('username','demo_user'); await fill('password','oldpass'); await submit(); await visible('logout');
  assert.match(await page.locator('#result-message').textContent(),/<img src=x/); assert.equal(await page.locator('#form-result img').count(),0);
  await page.locator('#logout').click(); await visible('account-form');
  assert.ok(calls.find((call) => call.path.endsWith('/logout')).cookie.includes('buteami=test'));

  let resetStatus = 400;
  responder = async () => ({ status:resetStatus,body:{ message:'internal database details must not render' } });
  await page.goto(origin+'/auth/reset-password.html');
  await fill('fullName','테스트 사용자'); await fill('username','demo_user'); await fill('email','demo@example.com');
  await fill('password','xyz789'); await fill('confirmPassword','xyz789');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('#password').inputValue(),'');
  await fill('fullName','테스트 사용자'); await fill('username','demo_user'); await fill('email','demo@example.com');
  await fill('password','xyz789'); await fill('confirmPassword','xyz789'); await submit(); await visible('form-summary');
  assert.equal(await page.locator('#form-result').isVisible(),false);
  assert.match(await page.locator('#form-summary').textContent(),/이름, 아이디와 이메일이 모두 일치/);
  assert.doesNotMatch(await page.locator('#form-summary').textContent(),/database/);
  assert.equal(await page.locator('#password').inputValue(),'');
  resetStatus = 200;
  assert.equal(await page.locator('#password').getAttribute('minlength'),'6');
  await fill('password','xyz789'); await fill('confirmPassword','xyz789'); await submit(); await visible('form-result');
  assert.match(await page.locator('#result-title').textContent(),/비밀번호를 변경/);
  const resetCalls=calls.filter(call=>call.path.endsWith('/reset-password'));
  assert.deepEqual(resetCalls.at(-1).data,{fullName:'테스트 사용자',username:'demo_user',email:'demo@example.com',password:'xyz789',confirmPassword:'xyz789'});

  let findStatus=400;
  responder=async()=>({status:findStatus,body:findStatus===200?{username:'<img src=x onerror=alert(1)>'}:{message:'raw server details'}});
  await page.goto(origin+'/auth/find-id.html'); await fill('fullName','테스트 사용자'); await fill('email','demo@example.com'); await submit(); await visible('form-summary');
  assert.equal(await page.locator('#form-result').isVisible(),false);
  assert.match(await page.locator('#form-summary').textContent(),/이름과 이메일/);
  findStatus=200; await submit(); await visible('form-result');
  assert.match(await page.locator('#result-message').textContent(),/<img src=x/);
  assert.equal(await page.locator('#form-result img').count(),0,'Recovered ID must be text, never HTML');
  assert.deepEqual(calls.filter(call=>call.path.endsWith('/find-id')).at(-1).data,{fullName:'테스트 사용자',email:'demo@example.com'});
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length),0);
  assert.equal(new URL(page.url()).search,'');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.locator('#result-message').textContent(),'');
  for (const status of [404,405,502,503]) {
    responder = async () => ({ status,body:{ message:'internal deployment details must not render' } });
    await page.goto(origin+'/auth/login.html'); await fill('username','demo_user'); await fill('password','abc123'); await submit(); await visible('form-summary');
    assert.equal(await page.locator('#form-summary').textContent(),'계정 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.');
    assert.equal(await page.locator('#form-result').isVisible(),false);
    assert.equal(await page.locator('[type=submit]').isDisabled(),false);
  }
  await page.setViewportSize({ width:375,height:900 });
  await page.goto(origin+'/auth/reset-password.html');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
  if (process.env.BUTEAMI_UI_SCREENSHOT) await page.screenshot({ path:process.env.BUTEAMI_UI_SCREENSHOT,fullPage:true });
  // Intercept every remote-host request locally; this regression never contacts a real remote server.
  const remoteContext = await browser.newContext();
  let remoteApiCalls = 0;
  const remoteRequests = [];
  await remoteContext.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    remoteRequests.push({ path:url.pathname, method:request.method(), body:request.postData() });
    if (url.pathname.startsWith('/api/')) {
      remoteApiCalls++;
      await route.fulfill({ status:503, contentType:'application/json', body:'{}' });
      return;
    }
    const file = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + sep)) { await route.fulfill({ status:403,body:'' }); return; }
    try { await route.fulfill({ status:200,contentType:types[extname(file)] || 'application/octet-stream',body:await readFile(file) }); }
    catch { await route.fulfill({ status:404,body:'' }); }
  });
  const remotePage = await remoteContext.newPage();
  remotePage.on('pageerror', (error) => errors.push(error.message));
  for (const accountPage of ['login','signup','find-id','reset-password']) {
    await remotePage.goto(`http://www.buteami.test/auth/${accountPage}.html`);
    await remotePage.locator('#form-summary').waitFor({ state:'visible' });
    assert.match(await remotePage.locator('#form-summary').textContent(),/HTTPS/);
    assert.equal(await remotePage.locator('[type=submit]').isDisabled(),true);
    assert.equal(await remotePage.locator('#form-result').isVisible(),false);
    assert.equal(await remotePage.locator('#form-summary a').getAttribute('href'),`https://www.buteami.com/auth/${accountPage}.html`);
    await remotePage.locator('#account-form').evaluate((form) => {
      for (const input of form.querySelectorAll('input')) input.value = 'never-transmit-this-secret';
      form.dispatchEvent(new Event('submit',{ bubbles:true,cancelable:true }));
    });
    const blocked = await remotePage.evaluate(async () => {
      const { accountRequest } = await import('/assets/auth.js');
      try { await accountRequest('login',{ username:'demo_user',password:'never-transmit-this-secret' }); return false; }
      catch (error) { return error.message.includes('HTTPS'); }
    });
    assert.equal(blocked,true);
  }
  assert.equal(remoteApiCalls,0,'Remote HTTP must not fetch me, login, or any account API');
  assert.ok(remoteRequests.every((request) => request.method === 'GET' && !request.body),'Remote HTTP must send no form values');
  assert.ok(!remoteRequests.some((request) => request.path.endsWith('/version.json')),'Unsafe setup returns before optional fetches');
  await remoteContext.close();
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: six-character signup/reset; signup/pending; login/logout cookie; recovery/reset error+success; direct ID safe text; identity-match reset; unavailable404/405/502/503; pagehide clearing; mobile width; remote HTTP blocks all account fetches.');
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
