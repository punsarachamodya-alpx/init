import pg from 'pg';
import { APP_ROLE, actorSecretHex, dbUrl } from '../../src/db/config.ts';
import { runMigrations } from '../../src/db/migrate.ts';

const APP_PASSWORD = 'colombo_app_pw'; // throwaway, local synthetic databases only

const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

/** Throws unless the connection string can only reach this machine (host, and node-pg's `?host=` override, local or a socket path). */
export function assertLocalUrl(url: string, name: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} is not a valid URL: refusing to rebuild; local synthetic databases only`);
  }
  const hosts = [parsed.hostname, ...(parsed.searchParams.get('host')?.split(',') ?? [])];
  const remote = hosts.filter((h) => !LOCAL.has(h) && !h.startsWith('/'));
  if (remote.length > 0) throw new Error(`${name} points at a non-local host: refusing to rebuild; local synthetic databases only`);
}

/**
 * Drop and recreate a LOCAL synthetic database, migrate it as the owner role and install the throwaway actor key.
 * Used by the Vitest and Playwright setups; never point it at anything real (it drops the database).
 */
export async function rebuildDatabase(name: string): Promise<void> {
  if (!/^colombo_(test|e2e)$/.test(name)) throw new Error(`refusing to rebuild "${name}": only colombo_test and colombo_e2e`);
  // It drops a database, resets the app role's password and installs the actor key: only ever on this machine.
  assertLocalUrl(dbUrl('ADMIN_DATABASE_URL'), 'ADMIN_DATABASE_URL');
  assertLocalUrl(dbUrl('OWNER_DATABASE_URL'), 'OWNER_DATABASE_URL');
  const admin = new pg.Client({ connectionString: dbUrl('ADMIN_DATABASE_URL') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (role.rowCount === 0) {
      await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${APP_PASSWORD}'`);
    } else {
      await admin.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO ${APP_ROLE}`);
  } finally {
    await admin.end();
  }

  const owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL').replace(/\/[^/]*$/, `/${name}`), max: 1 });
  try {
    await runMigrations(owner);
    await owner.query(
      'INSERT INTO actor_key (id, key) VALUES (true, decode($1, $2)) ON CONFLICT (id) DO UPDATE SET key = excluded.key, set_at = now()',
      [actorSecretHex(), 'hex'],
    );
  } finally {
    await owner.end();
  }
}
