import type pg from 'pg';
import { getAppPool } from './pool.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompanyClient = pg.PoolClient;

/**
 * Run `fn` in a transaction scoped to one company. The company id is set as a
 * transaction-local setting that every row-level-security policy reads. There is
 * deliberately no way to obtain a client without a company context.
 */
export async function withCompany<T>(
  companyId: string,
  fn: (client: CompanyClient) => Promise<T>,
  pool: pg.Pool = getAppPool(),
): Promise<T> {
  if (!UUID_RE.test(companyId)) throw new Error('withCompany: companyId must be a UUID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
