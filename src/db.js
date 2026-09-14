// Postgres connection pool. Every query in this codebase goes through here and
// every one of them is parameterised -- we never build SQL by string-concatenating
// user input.
import pg from 'pg';

// Postgres returns BIGINT as a string to avoid precision loss. Our ids fit in a
// JS number comfortably, and the front end expects numbers in JSON, so parse them.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

export const pool = new pg.Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/** Run a parameterised query and return the rows. */
export async function query(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

/** Run a parameterised query and return the first row, or undefined. */
export async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0];
}
