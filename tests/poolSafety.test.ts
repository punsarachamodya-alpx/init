import path from 'node:path';
import { ESLint } from 'eslint';
import pg from 'pg';
import { afterAll, describe, expect, test } from 'vitest';
import { ActorContextError } from '../src/db/actorToken.ts';
import { dbUrl } from '../src/db/config.ts';
import { withActor } from '../src/db/withActor.ts';
import { runScoped } from '../src/db/withCompany.ts';
import { seedActor } from './helpers.ts';

const SCOPE = { companyId: '00000000-0000-4000-8000-0000000000c1', userId: '00000000-0000-4000-8000-0000000000e1' };

/** A fake pool whose single client records every query and the argument of release(). */
function fakePool(opts: { failOn?: string; connectDelayMs?: number; rejectToken?: boolean } = {}) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (sql: string, p: unknown[] = []) => {
      const verb = sql.trim().split(/\s+/).slice(0, 2).join(' ');
      queries.push(verb);
      params.push(p);
      if (opts.failOn && sql.startsWith(opts.failOn)) throw new Error(`${opts.failOn} failed`);
      if (sql.startsWith('SELECT app_company_id()')) return { rows: [{ company: opts.rejectToken ? null : SCOPE.companyId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: (arg?: unknown) => {
      releases.push(arg);
    },
  };
  const connect = async () => {
    if (opts.connectDelayMs) await new Promise((r) => setTimeout(r, opts.connectDelayMs));
    return client;
  };
  return { pool: { connect } as unknown as pg.Pool, queries, params, releases };
}

describe('connections go back to the pool clean, or not at all', () => {
  test('success path: BEGIN, token, token check, COMMIT, DISCARD ALL, then a normal release', async () => {
    const { pool, queries, releases } = fakePool();
    await runScoped(SCOPE, async () => 'ok', pool);
    expect(queries).toEqual(['BEGIN', 'SELECT set_config(\'app.actor\',', 'SELECT app_company_id()', 'COMMIT', 'DISCARD ALL']);
    expect(releases).toEqual([undefined]);
  });

  test('error path: ROLLBACK, DISCARD ALL, normal release, error rethrown', async () => {
    const { pool, queries, releases } = fakePool();
    await expect(runScoped(SCOPE, async () => { throw new Error('boom'); }, pool)).rejects.toThrow('boom');
    expect(queries.slice(-2)).toEqual(['ROLLBACK', 'DISCARD ALL']);
    expect(releases).toEqual([undefined]);
  });

  test('a failed ROLLBACK destroys the connection instead of returning it to the pool', async () => {
    const { pool, releases } = fakePool({ failOn: 'ROLLBACK' });
    await expect(runScoped(SCOPE, async () => { throw new Error('boom'); }, pool)).rejects.toThrow('boom'); // the original error, not the rollback error
    expect(releases).toEqual([true]);
  });

  test('a failed DISCARD ALL destroys the connection too', async () => {
    const { pool, releases } = fakePool({ failOn: 'DISCARD ALL' });
    await runScoped(SCOPE, async () => 'ok', pool);
    expect(releases).toEqual([true]);
  });
});

describe('the identity is checked before any work, and minted late', () => {
  test('a token the database rejects raises a clear error instead of silently returning nothing', async () => {
    const { pool, queries, releases } = fakePool({ rejectToken: true });
    await expect(runScoped(SCOPE, async () => 'never', pool)).rejects.toBeInstanceOf(ActorContextError);
    expect(queries).not.toContain('COMMIT');
    expect(releases).toEqual([undefined]); // rolled back and released cleanly
  });

  test('the real database refuses a token signed with the wrong secret, loudly', async () => {
    const actor = await seedActor('cha');
    const saved = process.env.ACTOR_CONTEXT_SECRET;
    process.env.ACTOR_CONTEXT_SECRET = 'cd'.repeat(32);
    try {
      await expect(withActor(actor, async () => 'never')).rejects.toBeInstanceOf(ActorContextError);
    } finally {
      if (saved === undefined) delete process.env.ACTOR_CONTEXT_SECRET;
      else process.env.ACTOR_CONTEXT_SECRET = saved;
    }
  });

  test('the token is minted after the connection is obtained, so a long pool wait cannot expire it', async () => {
    const { pool, params } = fakePool({ connectDelayMs: 1500 });
    const before = Math.floor(Date.now() / 1000);
    await runScoped(SCOPE, async () => 'ok', pool);
    const token = String(params.find((p) => String(p[0]).startsWith('v1.'))![0]);
    const exp = Number(token.split('.')[3]);
    expect(exp).toBeGreaterThanOrEqual(before + 1 + 60); // minted >= 1 s after the start (signing before connecting gives <= before + 60)
    expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
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

describe('DISCARD ALL drops temp tables and settings before reuse (a role that can create them)', () => {
  let ownerOne: pg.Pool | undefined;
  afterAll(async () => {
    await ownerOne?.end();
  });

  test('a temp table made inside the callback is gone for the next user of the same connection', async () => {
    ownerOne = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 1 });
    await runScoped({ companyId: SCOPE.companyId }, (c) => c.query('CREATE TEMP TABLE leaked (x int)'), ownerOne);
    await expect(ownerOne.query('SELECT * FROM leaked')).rejects.toThrow(/does not exist/);
  });
});

describe('the raw database layer is reachable only from src/db (lint)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const lint = async (filePath: string, code: string) => {
    const eslint = new ESLint({ cwd: root });
    const [res] = await eslint.lintText(code, { filePath: path.join(root, filePath) });
    return res!.messages.filter((m) => /no-restricted-(imports|syntax)/.test(m.ruleId ?? ''));
  };
  const BANNED: Array<[string, string]> = [
    ['named import of the pool', "import { getAppPool } from '../db/pool.ts';\nvoid getAppPool;\n"],
    ['namespace import of the pool', "import * as p from '../db/pool.ts';\nvoid p;\n"],
    ['re-export of the pool', "export { getAppPool } from '../db/pool.ts';\n"],
    ['runScoped', "import { runScoped } from '../db/withCompany.ts';\nvoid runScoped;\n"],
    ['withCompany', "import { withCompany } from '../db/withCompany.ts';\nvoid withCompany;\n"],
    ['signing tokens', "import { signActor } from '../db/actorToken.ts';\nvoid signActor;\n"],
    ['reading config secrets', "import { actorSecretHex } from '../db/config.ts';\nvoid actorSecretHex;\n"],
    ['pg itself', "import pg from 'pg';\nvoid pg;\n"],
    ['pg-pool', "import Pool from 'pg-pool';\nvoid Pool;\n"],
    ['pg-boss', "import PgBoss from 'pg-boss';\nvoid PgBoss;\n"],
    ['dynamic import of the pool', "const m = await import('../db/pool.ts');\nvoid m;\n"],
  ];
  const ALLOWED: Array<[string, string]> = [
    ['withActor', "import { withActor } from '../db/withActor.ts';\nvoid withActor;\n"],
    ['type-only CompanyClient', "import type { CompanyClient } from '../db/withCompany.ts';\nexport type X = CompanyClient;\n"],
    ['type-only pg', "import type pg from 'pg';\nexport type Y = pg.Pool;\n"],
  ];

  test.each(BANNED)('refused in application code: %s', async (_n, code) => {
    expect((await lint('src/ledger/example.ts', code)).length).toBeGreaterThan(0);
    expect((await lint('app/example.tsx', code)).length).toBeGreaterThan(0);
    for (const ext of ['mts', 'cts', 'cjs']) expect((await lint(`src/ledger/example.${ext}`, code)).length).toBeGreaterThan(0);
  });

  test.each(ALLOWED)('allowed in application code: %s', async (_n, code) => {
    expect(await lint('src/ledger/example.ts', code)).toHaveLength(0);
    expect(await lint('app/example.tsx', code)).toHaveLength(0);
  });

  // ESLint reports no rule messages for ignored paths, so assert on the resolved config: the restriction is
  // simply not configured for src/db and tests (and is configured for application code).
  test.each([['src/db/example.ts', false], ['tests/example.ts', false], ['src/ledger/example.ts', true], ['app/example.tsx', true]] as const)(
    'the import restriction applies to %s: %s',
    async (file, applies) => {
      const cfg = await new ESLint({ cwd: root }).calculateConfigForFile(path.join(root, file));
      expect(Boolean(cfg?.rules?.['@typescript-eslint/no-restricted-imports'])).toBe(applies);
    },
  );
});
