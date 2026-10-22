import express from 'express';
import { createAuthService } from './auth-service.js';
import { validateInput } from './validation.js';
import { PublicError } from './security.js';
import { limitRate } from './rate-limit.js';

export function createApp({ pool, config, service = createAuthService({ pool, config }) }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy || false);
  const cookieName = config.secure ? '__Host-buteami_session' : 'buteami_session';
  const cookieOptions = { httpOnly: true, secure: config.secure, sameSite: 'strict', path: '/' };
  const sessionToken = request => (request.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  app.use('/api', (request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (request.headers.origin !== config.origin || request.headers['x-buteami-request'] !== '1') {
        return response.status(403).json({ message: '허용되지 않은 요청입니다.' });
      }
      if (!request.is('application/json')) return response.status(415).json({ message: 'JSON 요청이 필요합니다.' });
    }
    next();
  });
  app.use('/api', express.json({ limit: '8kb', strict: true }));
  app.get('/api/health/live', (request, response) => response.json({ status: 'ok' }));
  app.get('/api/health/ready', async (request, response) => {
    try {
      await pool.query('SELECT 1 FROM users,auth_pending_registrations,auth_sessions,auth_tokens,auth_rate_limits,auth_mail_outbox LIMIT 0');
      response.json({ status: 'ready' });
    }
    catch { response.status(503).json({ status: 'unavailable' }); }
  });
  app.get('/api/auth/me', async (request, response) => response.json(await service.me(sessionToken(request))));
  const actions = {
    signup: 'signup', 'verify-email': 'verifyEmail', 'resend-verification': 'resendVerification',
    'request-password-reset': 'requestPasswordReset', 'reset-password': 'resetPassword', 'find-id': 'findId', login: 'login',
  };
  for (const [path, method] of Object.entries(actions)) {
    app.post(`/api/auth/${path}`, async (request, response) => {
      // Shared database buckets work across API replicas and restarts. Never persist raw IP/email.
      await limitRate(pool, config.secret, 'auth-ip', request.ip, 120, 900);
      const input = validateInput(path, request.body);
      const key = input.username.toLowerCase() || input.email || input.token;
      await limitRate(pool, config.secret, path, key, path === 'login' ? 15 : 5, 900);
      const result = await service[method](input, sessionToken(request));
      if (path === 'login') {
        response.cookie(cookieName, result.token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 });
        return response.json({ user: result.user });
      }
      if (path === 'reset-password') response.clearCookie(cookieName, cookieOptions);
      if (['signup', 'find-id', 'resend-verification', 'request-password-reset'].includes(path)) {
        return response.status(202).json({ message: '입력 정보가 일치하면 등록된 이메일로 안내를 보냅니다. 메일이 오지 않으면 잠시 후 다시 요청해주세요.' });
      }
      response.json({ message: path === 'verify-email' ? '이메일 인증을 완료했습니다. 로그인해주세요.' : '비밀번호를 재설정했습니다. 다시 로그인해주세요.' });
    });
  }
  app.post('/api/auth/logout', async (request, response) => {
    await limitRate(pool, config.secret, 'auth-ip', request.ip, 120, 900);
    await service.logout(sessionToken(request));
    response.clearCookie(cookieName, cookieOptions);
    response.json({ message: '로그아웃했습니다.' });
  });
  app.use('/api', (request, response) => response.status(404).json({ message: '요청한 API를 찾을 수 없습니다.' }));
  app.use((error, request, response, next) => {
    if (error instanceof PublicError) {
      if (error.status === 429) response.set('Retry-After', '900');
      return response.status(error.status).json({ message: error.message });
    }
    if (error.type === 'entity.too.large') return response.status(413).json({ message: '요청 내용이 너무 큽니다.' });
    if (error.type === 'entity.parse.failed') return response.status(400).json({ message: '입력한 정보를 확인해주세요.' });
    console.error('api_request_failed');
    response.status(503).json({ message: '서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.' });
  });
  return app;
}
