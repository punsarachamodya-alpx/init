import { afterAll, expect, test } from 'vitest';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';

afterAll(closeAppPool);

test('test database is reachable as the application role', async () => {
  const { rows } = await getAppPool().query('SELECT current_user AS u, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user');
  expect(rows[0]).toMatchObject({ u: 'colombo_app', rolbypassrls: false, rolsuper: false });
});
