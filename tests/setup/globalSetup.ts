import pg from 'pg';
import { APP_ROLE, actorSecretHex, dbUrl } from '../../src/db/config.ts';
import { runMigrations } from '../../src/db/migrate.ts';

const TEST_DB = 'colombo_test';
const APP_PASSWORD = 'colombo_app_pw'; // throwaway, local synthetic test database only

/** Rebuild a fresh test database and migrate it as the owner role. */
export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: dbUrl('ADMIN_DATABASE_URL') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
    if (role.rowCount === 0) {
      await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${APP_PASSWORD}'`);
    } else {
      await admin.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`);
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DB} TO ${APP_ROLE}`);
  } finally {
    await admin.end();
  }

  const owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 1 });
  try {
    await runMigrations(owner);
    // The verification key the database checks actor tokens against (throwaway, test database only).
    await owner.query(
      'INSERT INTO actor_key (id, key) VALUES (true, decode($1, $2)) ON CONFLICT (id) DO UPDATE SET key = excluded.key, set_at = now()',
      [actorSecretHex(), 'hex'],
    );
  } finally {
    await owner.end();
  }
}
