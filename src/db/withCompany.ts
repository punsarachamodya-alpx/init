import type pg from 'pg';
import { getAppPool } from './pool.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompanyClient = pg.PoolClient;

export function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new Error(`${name} must be a UUID`);
}

/**
 * Run `fn` in a transaction with transaction-local company (and optionally user) settings that
 * every row-level-security policy reads. There is deliberately no way to obtain a client
 * without a company context. Prefer `withActor`; this is the shared implementation.
 */
export async function runScoped<T>(
  scope: { companyId: string; userId?: string },
  fn: (client: CompanyClient) => Promise<T>,
  pool: pg.Pool = getAppPool(),
): Promise<T> {
  assertUuid(scope.companyId, 'companyId');
  if (scope.userId !== undefined) assertUuid(scope.userId, 'userId');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)", [
      scope.companyId,
      scope.userId ?? '',
    ]);
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

/**
 * Company-only context, for BOOTSTRAP ONLY (creating a company and its first users).
 * Without a user the database refuses to read or write containers, events, messages or
 * documents. Everything else must use `withActor`.
 */
export function withCompany<T>(
  companyId: string,
  fn: (client: CompanyClient) => Promise<T>,
  pool?: pg.Pool,
): Promise<T> {
  return runScoped({ companyId }, fn, pool);
}
