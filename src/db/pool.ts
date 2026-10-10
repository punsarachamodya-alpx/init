import pg from 'pg';
import { dbUrl } from './config.ts';

let appPool: pg.Pool | undefined;

/** Pool for the application role. Queries must go through `withCompany`. */
export function getAppPool(): pg.Pool {
  appPool ??= new pg.Pool({ connectionString: dbUrl('APP_DATABASE_URL'), max: 5 });
  return appPool;
}

export async function closeAppPool(): Promise<void> {
  const p = appPool;
  appPool = undefined;
  await p?.end();
}
