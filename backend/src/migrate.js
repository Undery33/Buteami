import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { assertSchema } from './schema.js';

export async function applyMigrations(pool) {
  // Check existing users before executing any CREATE. DDL implicitly commits in MariaDB.
  await assertSchema(pool, { usersOnly: true, allowMissingUsers: true });
  let sql = await readFile(new URL('../migrations/001-auth.sql', import.meta.url), 'utf8');
  const [existing] = await pool.query(`SELECT CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='id'`);
  if (existing.length) {
    const length = Number(existing[0].CHARACTER_MAXIMUM_LENGTH);
    const collation = existing[0].COLLATION_NAME;
    // Only values admitted by the preflight may be used in new-table DDL.
    if (!Number.isInteger(length) || length < 20 || length > 255 || !['utf8mb4_general_ci','utf8mb4_unicode_ci'].includes(collation)) throw new Error('Incompatible schema: unsupported user ID definition');
    sql = sql.replaceAll('COLLATE=utf8mb4_general_ci', `COLLATE=${collation}`)
      .replaceAll('user_id VARCHAR(50)', `user_id VARCHAR(${length})`);
  }
  for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
  await assertSchema(pool);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(loadConfig());
  try { await applyMigrations(pool); console.log('Non-destructive schema preparation completed'); }
  catch (error) {
    console.error(error.message.startsWith('Incompatible schema:') ? error.message : 'Migration failed; inspect configuration and grants privately');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
