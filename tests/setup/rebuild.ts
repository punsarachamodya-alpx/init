import pg from 'pg';
import { APP_ROLE, actorSecretHex, dbUrl } from '../../src/db/config.ts';
import { runMigrations } from '../../src/db/migrate.ts';

const APP_PASSWORD = 'colombo_app_pw'; // throwaway, local synthetic databases only

/**
 * Drop and recreate a LOCAL synthetic database, migrate it as the owner role and install the throwaway actor key.
 * Used by the Vitest and Playwright setups; never point it at anything real (it drops the database).
 */
export async function rebuildDatabase(name: string): Promise<void> {
  if (!/^colombo_(test|e2e)$/.test(name)) throw new Error(`refusing to rebuild "${name}": only colombo_test and colombo_e2e`);
  // It drops a database and resets the app role's password: only ever on this machine.
  const host = new URL(dbUrl('ADMIN_DATABASE_URL')).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error(`refusing to rebuild a database on "${host}": local synthetic databases only`);
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
