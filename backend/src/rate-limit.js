import { transaction } from './db.js';
import { bucketKey, PublicError } from './security.js';

export async function limitRate(pool, secret, scope, key, maximum, seconds) {
  const allowed = await transaction(pool, async connection => {
    const bucket = bucketKey(secret, `${scope}:${key}`);
    await connection.execute(`INSERT INTO auth_rate_limits (bucket_hash,hits,reset_at)
      VALUES (?,0,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND)) ON DUPLICATE KEY UPDATE bucket_hash=bucket_hash`, [bucket, seconds]);
    const [rows] = await connection.execute('SELECT hits,reset_at <= UTC_TIMESTAMP(3) AS expired FROM auth_rate_limits WHERE bucket_hash=? FOR UPDATE', [bucket]);
    const hits = rows[0].expired ? 0 : rows[0].hits;
    if (hits >= maximum) return false;
    await connection.execute(`UPDATE auth_rate_limits SET hits=?,reset_at=IF(?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND),reset_at) WHERE bucket_hash=?`, [hits + 1, rows[0].expired, seconds, bucket]);
    return true;
  });
  if (!allowed) throw new PublicError(429, '요청이 많습니다. 잠시 후 다시 시도해주세요.');
}
