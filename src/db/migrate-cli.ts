import pg from 'pg';
import { dbUrl } from './config.ts';
import { runMigrations } from './migrate.ts';

const pool = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 1 });
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} finally {
  await pool.end();
}
