import type pg from 'pg';
import { signActor } from './actorToken.ts';
import { getAppPool } from './pool.ts';

export type CompanyClient = pg.PoolClient;

/**
 * Run `fn` in a transaction whose identity is a signed, transaction-local actor token that every
 * row-level-security policy verifies in the database. There is deliberately no way to obtain a client
 * without a company context. Prefer `withActor`; this is the shared implementation.
 */
export async function runScoped<T>(
  scope: { companyId: string; userId?: string },
  fn: (client: CompanyClient) => Promise<T>,
  pool: pg.Pool = getAppPool(),
): Promise<T> {
  const token = signActor(scope); // validates the ids
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor', $1, true)", [token]);
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
