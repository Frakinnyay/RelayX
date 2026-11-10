import { Pool } from 'pg';
import type { Logger } from '../logger';

export interface Db {
  query(text: string, values?: unknown[]): Promise<import('pg').QueryResult>;
}

export function createPool(databaseUrl: string, max: number, logger?: Logger): Pool {
  const pool = new Pool({ connectionString: databaseUrl, max, connectionTimeoutMillis: 5000 });
  // Idle clients can emit errors (e.g. database restart). Without a handler Node would crash.
  pool.on('error', (err) => logger?.error('db_pool_error', { error: err.message }));
  return pool;
}
