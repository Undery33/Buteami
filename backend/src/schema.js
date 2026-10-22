import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const authColumns = {
  auth_sessions: ['token_hash', 'user_id', 'expires_at'],
  auth_rate_limits: ['bucket_hash', 'hits', 'reset_at'],
};
export async function assertSchema(pool, { usersOnly = false, allowMissingUsers = false } = {}) {
  const [tables] = await pool.query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
  const engines = new Map(tables.map(row => [row.TABLE_NAME, row.ENGINE]));
  if (!engines.has('users') && allowMissingUsers) return;
  const fail = detail => { throw new Error(`Incompatible schema: ${detail}. Inspect DDL; no existing table was changed.`); };
  const names = usersOnly ? ['users'] : ['users', ...Object.keys(authColumns)];
  for (const name of names) if (engines.get(name) !== 'InnoDB') fail(`${name} requires InnoDB`);
  const [columns] = await pool.query(`SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME,IS_NULLABLE,COLUMN_DEFAULT,EXTRA
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`);
  const byTable = name => new Map(columns.filter(row => row.TABLE_NAME === name).map(row => [row.COLUMN_NAME, row]));
  const users = byTable('users');
  const text = (name, length) => users.get(name)?.DATA_TYPE === 'varchar' && users.get(name).CHARACTER_MAXIMUM_LENGTH >= length;
  const supportedCollations = ['utf8mb4_general_ci', 'utf8mb4_unicode_ci'];
  if (!text('id', 20) || users.get('id').CHARACTER_MAXIMUM_LENGTH > 255 || !supportedCollations.includes(users.get('id').COLLATION_NAME)) fail('users.id must be VARCHAR(20..255) with a supported case-insensitive collation');
  if (!text('password_hash', 255) || !text('email', 254) || !text('name', 50) || users.get('birthday')?.DATA_TYPE !== 'date') fail('users text/date column capacity');
  for (const flag of ['account_active', 'failed_login_attempts', 'account_locked']) {
    if (!['tinyint', 'smallint', 'mediumint', 'int', 'bigint'].includes(users.get(flag)?.DATA_TYPE)) fail(`users.${flag} integer required`);
  }
  if (!['timestamp', 'datetime'].includes(users.get('created_at')?.DATA_TYPE)) fail('users.created_at timestamp required');
  if (users.get('created_at').IS_NULLABLE === 'NO' && users.get('created_at').COLUMN_DEFAULT === null) fail('users.created_at requires a default');
  // The supplied production DDL permits an unknown birthday for existing users.
  // New registrations still supply a validated date through the API.
  for (const name of ['id','password_hash','email','name','account_active','failed_login_attempts','account_locked']) {
    if (users.get(name).IS_NULLABLE !== 'NO') fail(`users.${name} must be NOT NULL`);
  }
  for (const column of users.values()) {
    if (!['id','password_hash','birthday','email','name','account_active','failed_login_attempts','account_locked','created_at'].includes(column.COLUMN_NAME) &&
        column.IS_NULLABLE === 'NO' && column.COLUMN_DEFAULT === null && !column.EXTRA.includes('auto_increment')) fail(`unhandled required users.${column.COLUMN_NAME}`);
  }
  const [indexes] = await pool.query(`SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX,SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()`);
  const unique = (table, column) => {
    const entries = indexes.filter(row => row.TABLE_NAME === table && row.NON_UNIQUE === 0);
    return entries.some(row => row.COLUMN_NAME === column && row.SUB_PART === null && entries.filter(other => other.INDEX_NAME === row.INDEX_NAME).length === 1);
  };
  if (!unique('users', 'id') || !unique('users', 'email')) fail('users requires full single-column unique id/email');
  if (!supportedCollations.includes(users.get('email').COLLATION_NAME)) fail('users.email requires a supported case-insensitive collation');
  if (usersOnly) return;
  for (const [table, fields] of Object.entries(authColumns)) {
    const actual = byTable(table);
    if (fields.some(name => !actual.has(name))) fail(`${table} missing columns`);
    const key = fields[0];
    if (!unique(table, key)) fail(`${table} requires unique ${key}`);
    if (actual.has('user_id') && (actual.get('user_id').DATA_TYPE !== 'varchar' || actual.get('user_id').CHARACTER_MAXIMUM_LENGTH < users.get('id').CHARACTER_MAXIMUM_LENGTH || actual.get('user_id').COLLATION_NAME !== users.get('id').COLLATION_NAME)) fail(`${table}.user_id capacity/collation`);
    for (const column of actual.values()) {
      const name = column.COLUMN_NAME;
      if (!fields.includes(name) && column.IS_NULLABLE === 'NO' && column.COLUMN_DEFAULT === null && !column.EXTRA.includes('auto_increment')) fail(`unhandled required ${table}.${name}`);
      if (['token_hash', 'bucket_hash'].includes(name)) {
        if (column.DATA_TYPE !== 'char' || column.CHARACTER_MAXIMUM_LENGTH !== 64 || column.COLLATION_NAME !== 'ascii_bin') fail(`${table}.${name} must be CHAR(64) ascii_bin`);
      }
      if (['expires_at', 'reset_at'].includes(name) && column.DATA_TYPE !== 'datetime') fail(`${table}.${name} DATETIME required`);
      if (name === 'hits' && (!['int', 'tinyint'].includes(column.DATA_TYPE) || !column.COLUMN_TYPE.includes('unsigned'))) fail(`${table}.${name} unsigned integer required`);
      if (fields.includes(name) && column.IS_NULLABLE !== 'NO') fail(`${table}.${name} must be NOT NULL`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(loadConfig());
  try { await assertSchema(pool); console.log('Schema compatibility check passed'); }
  catch (error) { console.error(error.message.startsWith('Incompatible schema:') ? error.message : 'Schema check failed; inspect connection configuration privately'); process.exitCode = 1; }
  finally { await pool.end(); }
}
