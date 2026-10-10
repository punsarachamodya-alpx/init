// Provision (or rotate) the key the database verifies actor tokens against.
//   OWNER_DATABASE_URL=... ACTOR_CONTEXT_SECRET=<64+ hex chars> pnpm set-actor-key
// Run as the OWNER role, once per environment; the application holds the same secret in its
// environment and signs tokens with it. Rotation: run again with a new secret, restart the app
// (tokens live five minutes). Never commit or print the secret.
import pg from 'pg';
import { actorSecretHex, assertProductionSecret, dbUrl } from '../src/db/config.ts';

const pool = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 1 });
try {
  assertProductionSecret(actorSecretHex());
  await pool.query(
    'INSERT INTO actor_key (id, key) VALUES (true, decode($1, $2)) ON CONFLICT (id) DO UPDATE SET key = excluded.key, set_at = now()',
    [actorSecretHex(), 'hex'],
  );
  console.log('actor key set');
} finally {
  await pool.end();
}
