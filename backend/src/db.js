import mysql from 'mysql2/promise';

export function createPool(config) {
  return mysql.createPool({ ...config.db, connectionLimit: 10, waitForConnections: true,
    queueLimit: 50, connectTimeout: 10000, timezone: 'Z', dateStrings: true,
    multipleStatements: false, charset: 'utf8mb4_unicode_ci' });
}

export async function transaction(pool, action) {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();
    const result = await action(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
