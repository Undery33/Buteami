import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export function loadConfig(env = process.env) {
  const required = (name) => {
    if (!env[name]?.trim()) throw new Error(`Missing configuration: ${name}`);
    return env[name];
  };
  const integer = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid configuration: ${name}`);
    return value;
  };
  const production = env.NODE_ENV === 'production';
  const origin = new URL(required('APP_ORIGIN'));
  if (origin.origin !== env.APP_ORIGIN || !['https:', 'http:'].includes(origin.protocol)) throw new Error('APP_ORIGIN must be an exact origin');
  const secure = env.COOKIE_SECURE !== 'false';
  if (production && (origin.protocol !== 'https:' || !secure)) throw new Error('Production requires HTTPS and Secure cookies');
  const secret = required('APP_SECRET');
  if (Buffer.byteLength(secret) < 32) throw new Error('APP_SECRET requires at least 32 bytes');
  const dbHost = env.DB_HOST || '192.168.20.10';
  // mysql2 only performs hostname identity checks with a DNS hostname. Fail closed
  // rather than silently accepting a CA-signed certificate for a different IP.
  if (env.DB_TLS_CA_FILE && isIP(dbHost)) throw new Error('DB TLS requires a DNS DB_HOST matching the server certificate');
  return {
    production, origin: origin.origin, secure, secret, port: integer('PORT', 3000),
    trustProxy: env.TRUST_PROXY_CIDRS?.split(',').map(value => value.trim()).filter(Boolean) || false,
    db: { host: dbHost, port: integer('DB_PORT', 3306),
      database: env.DB_NAME || 'buteami_db', user: env.DB_USER || 'buteami_app', password: required('DB_PASSWORD'),
      ...(env.DB_TLS_CA_FILE ? { ssl: { ca: readFileSync(env.DB_TLS_CA_FILE), rejectUnauthorized: true, verifyIdentity: true } } : {}) },
  };
}
