import pg, { type Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** Anything that can run a query: a Pool (autocommit) or a PoolClient inside a transaction. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export const createPool = (connectionString: string, max = 10): Pool => new pg.Pool({ connectionString, max });

export const withTx = async <T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

export const isUniqueViolation = (e: unknown, constraint?: string): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505' &&
  (constraint === undefined || (e as { constraint?: string }).constraint === constraint);

export const big = (v: string | number | bigint | null | undefined): bigint => (v == null ? 0n : BigInt(v));
export const bigOrNull = (v: string | null | undefined): bigint | null => (v == null ? null : BigInt(v));
/** JSON replacer that keeps bigints and Dates round-trippable in jsonb columns. */
export const jsonb = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
