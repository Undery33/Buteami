import nodemailer from 'nodemailer';
import { digest, randomToken, sealMail, openMail } from './security.js';
import { transaction } from './db.js';

export async function enqueueMail(connection, config, payload) {
  await connection.execute(`INSERT INTO auth_mail_outbox (id,payload,available_at) VALUES (?,?,UTC_TIMESTAMP(3))`,
    [digest(randomToken()), sealMail(config.secret, payload)]);
}

export async function deliverMailBatch(pool, config, transport = nodemailer.createTransport(config.smtp)) {
  const claim = digest(randomToken());
  const mail = await transaction(pool, async connection => {
    const [rows] = await connection.query(`SELECT id,payload FROM auth_mail_outbox
      WHERE attempts < 5 AND available_at <= UTC_TIMESTAMP(3)
      AND (lease_until IS NULL OR lease_until < UTC_TIMESTAMP(3)) ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!rows.length) return null;
    await connection.execute(`UPDATE auth_mail_outbox SET lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE), claim_hash=? WHERE id=?`, [claim, rows[0].id]);
    return rows[0];
  });
  if (!mail) return false;
  try {
    const payload = openMail(config.secret, mail.payload);
    await transport.sendMail({ ...payload, to: { address: payload.to }, from: config.mailFrom,
      disableFileAccess: true, disableUrlAccess: true });
    await pool.execute('DELETE FROM auth_mail_outbox WHERE id=? AND claim_hash=?', [mail.id, claim]);
  } catch {
    // Never log the SMTP exception: it can contain recipients and message content.
    console.error('mail_delivery_failed');
    await pool.execute(`UPDATE auth_mail_outbox SET attempts=attempts+1,available_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE),
      lease_until=NULL,claim_hash=NULL WHERE id=? AND claim_hash=?`, [mail.id, claim]);
  }
  return true;
}

export function startMailWorker(pool, config) {
  const transport = nodemailer.createTransport(config.smtp);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (let count = 0; count < 10 && await deliverMailBatch(pool, config, transport); count++);
    } catch { console.error('mail_worker_failed'); }
    finally { busy = false; }
  }, 1000);
  timer.unref();
  return () => { clearInterval(timer); transport.close(); };
}
