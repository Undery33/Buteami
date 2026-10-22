import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { assertSchema } from './schema.js';

const pool = createPool(loadConfig());
try {
  // Check existing users before executing any CREATE. DDL implicitly commits in MariaDB.
  await assertSchema(pool, { usersOnly: true, allowMissingUsers: true });
  const sql = await readFile(new URL('../migrations/001-auth.sql', import.meta.url), 'utf8');
  for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
  await assertSchema(pool);
  console.log('Non-destructive schema preparation completed');
} catch (error) {
  console.error(error.message.startsWith('Incompatible schema:') ? error.message : 'Migration failed; inspect configuration and grants privately');
  process.exitCode = 1;
} finally { await pool.end(); }
