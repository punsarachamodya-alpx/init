import path from 'node:path';
import { ESLint } from 'eslint';
import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { dbUrl } from '../src/db/config.ts';
import { withActor } from '../src/db/withActor.ts';
import { runScoped } from '../src/db/withCompany.ts';
import { seedActor } from './helpers.ts';

const SCOPE = { companyId: '00000000-0000-4000-8000-0000000000c1', userId: '00000000-0000-4000-8000-0000000000e1' };

/** A fake pool whose single client records every query and the argument of release(). */
function fakePool(opts: { failOn?: string } = {}) {
  const queries: string[] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      const verb = sql.trim().split(/\s+/).slice(0, 2).join(' ');
      queries.push(verb);
      if (opts.failOn && sql.startsWith(opts.failOn)) throw new Error(`${opts.failOn} failed`);
      return { rows: [], rowCount: 0 };
    },
    release: (arg?: unknown) => {
      releases.push(arg);
    },
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, queries, releases };
}

describe('connections go back to the pool clean, or not at all', () => {
  test('success path: BEGIN, token, COMMIT, RESET ALL, then a normal release', async () => {
    const { pool, queries, releases } = fakePool();
    await runScoped(SCOPE, async () => 'ok', pool);
    expect(queries).toEqual(['BEGIN', 'SELECT set_config(\'app.actor\',', 'COMMIT', 'RESET ALL']);
    expect(releases).toEqual([undefined]);
  });

  test('error path: ROLLBACK, RESET ALL, normal release, error rethrown', async () => {
    const { pool, queries, releases } = fakePool();
    await expect(runScoped(SCOPE, async () => { throw new Error('boom'); }, pool)).rejects.toThrow('boom');
    expect(queries.slice(-2)).toEqual(['ROLLBACK', 'RESET ALL']);
    expect(releases).toEqual([undefined]);
  });

  test('a failed ROLLBACK destroys the connection instead of returning it to the pool', async () => {
    const { pool, releases } = fakePool({ failOn: 'ROLLBACK' });
    await expect(runScoped(SCOPE, async () => { throw new Error('boom'); }, pool)).rejects.toThrow('boom'); // the original error, not the rollback error
    expect(releases).toEqual([true]);
  });

  test('a failed RESET ALL destroys the connection too', async () => {
    const { pool, releases } = fakePool({ failOn: 'RESET ALL' });
    await runScoped(SCOPE, async () => 'ok', pool);
    expect(releases).toEqual([true]);
  });
});

describe('session-level settings cannot leak to the next user of a pooled connection', () => {
  let one: pg.Pool | undefined;
  afterAll(async () => {
    await one?.end();
  });

  test('a set_config(..., false) inside the callback is gone afterwards', async () => {
    one = new pg.Pool({ connectionString: dbUrl('APP_DATABASE_URL'), max: 1 }); // the same connection is reused
    const actor = await seedActor('cha');
    await withActor(actor, (c) => c.query("SELECT set_config('app.leak', 'secret', false), set_config('app.actor', 'x', false)"), one);
    const { rows } = await one.query<{ leak: string | null; actor: string | null }>("SELECT current_setting('app.leak', true) AS leak, current_setting('app.actor', true) AS actor");
    expect(rows[0]!.leak || '').toBe('');
    expect(rows[0]!.actor || '').toBe('');
  });
});

describe('only src/db may reach for the raw application pool', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const lint = async (filePath: string) => {
    const eslint = new ESLint({ cwd: root });
    const [res] = await eslint.lintText("import { getAppPool } from '../db/pool.ts';\nvoid getAppPool;\n", { filePath: path.join(root, filePath) });
    return res!.messages.filter((m) => m.ruleId === 'no-restricted-syntax');
  };

  test('application code outside src/db is refused', async () => {
    expect(await lint('src/ledger/example.ts')).toHaveLength(1);
    expect(await lint('src/intake/example.ts')).toHaveLength(1);
  });

  test('src/db and tests may use it', async () => {
    expect(await lint('src/db/example.ts')).toHaveLength(0);
    expect(await lint('tests/example.ts')).toHaveLength(0);
  });
});
