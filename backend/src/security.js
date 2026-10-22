import { randomBytes, scrypt as deriveKey, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(deriveKey);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let activeHashes = 0;

export class PublicError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  // Bound expensive work per pod; retries go through the shared DB limiter again.
  if (activeHashes >= 4) throw new PublicError(503, '요청이 많습니다. 잠시 후 다시 시도해주세요.');
  activeHashes++;
  try {
    const key = await scrypt(password, salt, 64, options);
    return `scrypt$32768$8$3$${salt}$${key.toString('hex')}`;
  } finally { activeHashes--; }
}

export async function verifyPassword(password, encoded) {
  const match = /^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded || '');
  const salt = match ? match[1] : '0'.repeat(32);
  const calculated = await hashPassword(password, salt);
  return Boolean(match) && timingSafeEqual(Buffer.from(calculated), Buffer.from(encoded));
}
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const bucketKey = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
