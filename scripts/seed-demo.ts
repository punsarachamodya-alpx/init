// Write synthetic demo data into the database named by APP_DATABASE_URL and list the demo users for the dev login
// picker in .demo-users.json (gitignored).
//   APP_DATABASE_URL=... ACTOR_CONTEXT_SECRET=... pnpm seed:demo
import { writeFileSync } from 'node:fs';
import { closeAppPool } from '../src/db/pool.ts';
import { DEMO_USERS_FILE } from '../src/web/demoUsers.ts';
import { seedDemo } from './seedDemo.ts';

if (process.env.NODE_ENV === 'production') throw new Error('seed:demo writes synthetic data: not for production');
try {
  const { users } = await seedDemo();
  const file = process.env.DEMO_USERS_FILE ?? DEMO_USERS_FILE;
  writeFileSync(file, `${JSON.stringify({ users }, null, 2)}\n`);
  console.log(`seeded ${users.length} demo users; picker file: ${file}`);
} finally {
  await closeAppPool();
}
