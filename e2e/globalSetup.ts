import { writeFileSync } from 'node:fs';
import { rebuildDatabase } from '../tests/setup/rebuild.ts';
import { DEMO_FILE, E2E_DB, E2E_ENV } from './env.ts';

/** A fresh synthetic database with the demo company, users and containers, and the picker file the dev server reads. */
export default async function setup(): Promise<void> {
  Object.assign(process.env, E2E_ENV);
  await rebuildDatabase(E2E_DB);
  const { seedDemo } = await import('../scripts/seedDemo.ts');
  const { closeAppPool } = await import('../src/db/pool.ts');
  try {
    const { users } = await seedDemo();
    writeFileSync(DEMO_FILE, `${JSON.stringify({ users }, null, 2)}\n`);
  } finally {
    await closeAppPool();
  }
}
