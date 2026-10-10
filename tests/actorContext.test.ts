import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signActor } from '../src/db/actorToken.ts';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { grantAccess } from '../src/access/access.ts';
import { appendEvent, createContainer } from '../src/ledger/ledger.ts';
import { newBl, seedActor, seedMessage, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
let haulier: TestActor;
let otherCha: TestActor;
let owner: pg.Pool;

/** Run raw SQL as the application role with a hand-made app.* setting (what a compromised session could do). */
async function raw<T>(settings: Record<string, string>, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await getAppPool().connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [k, v]);
    const res = await c.query(sql, params);
    return res.rows as T[];
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const visibleContainers = (settings: Record<string, string>) => raw<{ id: string }>(settings, 'SELECT id FROM containers');
const token = (a: TestActor, opts?: Parameters<typeof signActor>[1]) => signActor({ companyId: a.companyId, userId: a.userId }, opts);

beforeAll(async () => {
  cha = await seedActor('cha');
  haulier = await seedActor('haulier');
  otherCha = await seedActor('cha');
  const messageId = await seedMessage(cha);
  await withActor(cha, async (c) => {
    const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: haulier.companyId, kind: 'haulier' });
    await appendEvent(c, { containerId: container.id, eventType: 'do_received', occurredAt: new Date('2026-10-12T03:00:00Z'), source: { type: 'person', ref: 'synthetic' }, evidence: { type: 'message', messageId } });
  });
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('the database trusts only a signed actor token', () => {
  test('control: a validly signed token for the CHA user sees the container', async () => {
    expect(await visibleContainers({ 'app.actor': token(cha) })).toHaveLength(1);
  });

  test('plain app.company_id / app.user_id settings no longer identify anyone', async () => {
    expect(await visibleContainers({ 'app.company_id': cha.companyId, 'app.user_id': cha.userId })).toEqual([]);
    await expect(
      raw({ 'app.company_id': cha.companyId, 'app.user_id': cha.userId }, "INSERT INTO containers (company_id, container_no, bl_no) VALUES ($1, 'ZZZU3456787', 'FORGED1')", [cha.companyId]),
    ).rejects.toThrow(/row-level security/);
  });

  test('a haulier who knows the CHA company and user ids still cannot act as the CHA', async () => {
    const forged = `v1.${cha.companyId}.${cha.userId}.${Math.floor(Date.now() / 1000) + 300}.${'ab'.repeat(32)}`;
    expect(await visibleContainers({ 'app.actor': forged })).toEqual([]);
    // the haulier's own valid signature moved onto the CHA's ids
    const hauliersToken = token(haulier);
    const parts = hauliersToken.split('.');
    const spliced = ['v1', cha.companyId, cha.userId, parts[3], parts[4]].join('.');
    expect(await visibleContainers({ 'app.actor': spliced })).toEqual([]);
    // the haulier's genuine token still shows only what is shared with it
    expect((await visibleContainers({ 'app.actor': hauliersToken })).length).toBe(1);
  });

  test.each([
    ['tampered expiry', (t: string) => t.replace(/\.(\d+)\.([0-9a-f]+)$/, (_m, e: string, sig: string) => `.${Number(e) + 100000}.${sig}`)],
    ['tampered signature', (t: string) => t.slice(0, -1) + (t.endsWith('0') ? '1' : '0')],
    ['wrong version', (t: string) => t.replace(/^v1\./, 'v0.')],
    ['missing part', (t: string) => t.split('.').slice(0, 4).join('.')],
    ['extra part', (t: string) => `${t}.extra`],
    ['empty', () => ''],
    ['garbage', () => 'not a token'],
  ])('%s is rejected', async (_n, mutate) => {
    expect(await visibleContainers({ 'app.actor': mutate(token(cha)) })).toEqual([]);
  });

  test('an expired token is rejected, one just inside its life is accepted', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await visibleContainers({ 'app.actor': token(cha, { nowSeconds: now - 400 }) })).toEqual([]); // expired 100 s ago
    expect(await visibleContainers({ 'app.actor': token(cha, { nowSeconds: now - 200 }) })).toHaveLength(1);
  });

  test('a token signed with another secret is rejected', async () => {
    expect(await visibleContainers({ 'app.actor': token(cha, { secretHex: 'cd'.repeat(32) }) })).toEqual([]);
  });

  test('a company-only (bootstrap) token identifies the company but no user', async () => {
    const t = signActor({ companyId: cha.companyId });
    const [row] = await raw<{ c: string | null; u: string | null; r: string | null }>({ 'app.actor': t }, 'SELECT app_company_id() AS c, app_user_id() AS u, app_role() AS r');
    expect(row).toEqual({ c: cha.companyId, u: null, r: null });
  });

  test('inside withActor, overriding the old settings changes nothing', async () => {
    const seen = await withActor(cha, async (c) => {
      await c.query("SELECT set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)", [otherCha.companyId, otherCha.userId]);
      return (await c.query<{ company_id: string }>('SELECT company_id FROM containers')).rows;
    });
    expect(seen.every((r) => r.company_id === cha.companyId)).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('inside withActor, replacing app.actor with garbage locks the session out rather than widening it', async () => {
    const seen = await withActor(cha, async (c) => {
      await c.query("SELECT set_config('app.actor', 'x', true)");
      return (await c.query('SELECT 1 FROM containers')).rowCount;
    });
    expect(seen).toBe(0);
  });
});

describe('the signing key is out of reach of the application role', () => {
  test('actor_key cannot be read, written or listed', async () => {
    await expect(getAppPool().query('SELECT * FROM actor_key')).rejects.toThrow(/permission denied/);
    await expect(getAppPool().query("INSERT INTO actor_key (key) VALUES ('\\x00')")).rejects.toThrow(/permission denied/);
    await expect(getAppPool().query('UPDATE actor_key SET key = key')).rejects.toThrow(/permission denied/);
    await expect(getAppPool().query('DELETE FROM actor_key')).rejects.toThrow(/permission denied/);
  });

  test('the only SECURITY DEFINER function is the verifier, and its search_path is pinned', async () => {
    const { rows } = await getAppPool().query<{ proname: string; proconfig: string[] | null }>(
      "SELECT proname, proconfig FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace",
    );
    expect(rows.map((r) => r.proname)).toEqual(['verified_actor_parts']);
    expect(rows[0]!.proconfig?.join(',')).toMatch(/search_path=pg_catalog, public/);
  });

  test('with no key provisioned, every token fails closed', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM actor_key');
      await c.query("SELECT set_config('app.actor', $1, true)", [token(cha)]);
      const { rows } = await c.query<{ c: string | null }>('SELECT app_company_id() AS c');
      expect(rows[0]!.c).toBeNull();
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
