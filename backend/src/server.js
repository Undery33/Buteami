import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { assertSchema } from './schema.js';
import { createApp } from './app.js';
import { startMailWorker } from './mail.js';

let pool;
try {
  const config = loadConfig();
  pool = createPool(config);
  await assertSchema(pool);
  const app = createApp({ pool, config });
  const server = app.listen(config.port, '0.0.0.0', () => console.log('Buteami API ready'));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const stopMail = startMailWorker(pool, config);
  const cleanup = setInterval(async () => {
    try {
      await pool.query('DELETE FROM auth_sessions WHERE expires_at < UTC_TIMESTAMP(3) LIMIT 1000');
      await pool.query('DELETE FROM auth_tokens WHERE expires_at < UTC_TIMESTAMP(3) LIMIT 1000');
      await pool.query('DELETE FROM auth_rate_limits WHERE reset_at < UTC_TIMESTAMP(3) LIMIT 1000');
      await pool.query('DELETE FROM auth_mail_outbox WHERE created_at < DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) LIMIT 1000');
    } catch { console.error('auth_cleanup_failed'); }
  }, 60000);
  cleanup.unref();
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopMail(); clearInterval(cleanup);
    server.close(async () => { await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 15000).unref();
  });
} catch {
  console.error('Buteami API startup failed: inspect configuration and schema privately');
  await pool?.end();
  process.exitCode = 1;
}
