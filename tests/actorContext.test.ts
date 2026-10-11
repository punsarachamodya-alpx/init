import { createHmac } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signActor } from '../src/db/actorToken.ts';
import { actorSecretHex, assertProductionSecret, dbUrl } from '../src/db/config.ts';
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
    expect(await visibleContainers({ 'app.actor': token(cha, { nowSeconds: now - 400, ttlSeconds: 300 }) })).toEqual([]); // expired 100 s ago
    expect(await visibleContainers({ 'app.actor': token(cha, { nowSeconds: now - 200, ttlSeconds: 300 }) })).toHaveLength(1);
    // boundary: a few seconds either side of "now"
    expect(await visibleContainers({ 'app.actor': token(cha, { nowSeconds: now - 5, ttlSeconds: 2 }) })).toEqual([]); // expired 3 s ago
    expect(await visibleContainers({ 'app.actor': token(cha, { nowSeconds: now, ttlSeconds: 5 }) })).toHaveLength(1); // 5 s left
  });

  test('tokens live 60 seconds by default', () => {
    const t = token(cha);
    expect(Number(t.split('.')[3]) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    expect(Number(t.split('.')[3]) - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(58);
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

describe('correctly SIGNED but malformed tokens are still refused (only the format checks can do it)', () => {
  const sign = (message: string) => `${message}.${createHmac('sha256', Buffer.from(actorSecretHex(), 'hex')).update(message).digest('hex')}`;
  const exp = () => Math.floor(Date.now() / 1000) + 30;

  test('control: a hand-signed well-formed token is accepted', async () => {
    expect(await visibleContainers({ 'app.actor': sign(`v1.${cha.companyId}.${cha.userId}.${exp()}`) })).toHaveLength(1);
  });

  test.each([
    ['version v2', () => `v2.${cha.companyId}.${cha.userId}.${exp()}`],
    ['version V1', () => `V1.${cha.companyId}.${cha.userId}.${exp()}`],
    ['six parts', () => `v1.${cha.companyId}.${cha.userId}.${exp()}.extra`],
    ['company not a uuid', () => `v1.not-a-uuid.${cha.userId}.${exp()}`],
    ['upper-case company uuid', () => `v1.${cha.companyId.toUpperCase()}.${cha.userId}.${exp()}`],
    ['user neither uuid nor dash', () => `v1.${cha.companyId}.someone.${exp()}`],
    ['non-numeric expiry', () => `v1.${cha.companyId}.${cha.userId}.soon`],
    ['absurdly long expiry', () => `v1.${cha.companyId}.${cha.userId}.${'9'.repeat(30)}`],
  ])('%s', async (_n, message) => {
    expect(await visibleContainers({ 'app.actor': sign(message()) })).toEqual([]);
  });
});

describe('temp-table shadowing cannot change who the database thinks you are', () => {
  async function asOwnerWithToken<T>(tok: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.actor', $1, true)", [tok]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }

  test('a temp "users" table claiming the haulier is a cha_ops does not change app_role()', async () => {
    const role = await asOwnerWithToken(token(haulier), async (c) => {
      await c.query('CREATE TEMP TABLE users (id uuid, company_id uuid, role text)');
      await c.query("INSERT INTO users VALUES ($1, $2, 'cha_ops')", [haulier.userId, haulier.companyId]);
      return (await c.query<{ r: string | null }>('SELECT app_role() AS r')).rows[0]!.r;
    });
    expect(role).toBe('haulier_dispatcher');
  });

  test('a temp "events" table cannot change what a correction target is', async () => {
    const { eventId, realType } = await withActor(cha, async (c) => {
      const { rows } = await c.query<{ id: string; event_type: string }>('SELECT id, event_type FROM events LIMIT 1');
      return { eventId: rows[0]!.id, realType: rows[0]!.event_type };
    });
    const seen = await asOwnerWithToken(token(cha), async (c) => {
      await c.query('CREATE TEMP TABLE events (id uuid, event_type text, correction_kind text)');
      await c.query("INSERT INTO events VALUES ($1, 'gate_pass', 'void')", [eventId]);
      const r = await c.query<{ t: string; k: string | null }>('SELECT correction_target_type($1) AS t, correction_target_kind($1) AS k', [eventId]);
      return r.rows[0]!;
    });
    expect(seen).toEqual({ t: realType, k: null });
  });

  test('the application role cannot create temporary tables at all', async () => {
    await expect(getAppPool().query('CREATE TEMP TABLE users (x int)')).rejects.toThrow(/permission denied/);
    const { rows } = await getAppPool().query<{ ok: boolean }>("SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') AS ok");
    expect(rows[0]!.ok).toBe(false);
  });

  test('every function we own pins its search_path', async () => {
    const { rows } = await getAppPool().query<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
    );
    expect(rows.length).toBeGreaterThan(8);
    const unpinned = rows.filter((r) => !(r.proconfig ?? []).some((c) => /^search_path=pg_catalog, public, pg_temp$/.test(c))).map((r) => r.proname);
    expect(unpinned).toEqual([]);
  });

  test('actor_key has row-level security on with no policy (a blanket GRANT could not leak it)', async () => {
    const { rows } = await getAppPool().query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE relname = 'actor_key'");
    expect(rows[0]!.relrowsecurity).toBe(true);
    const pol = await getAppPool().query("SELECT 1 FROM pg_policies WHERE tablename = 'actor_key'");
    expect(pol.rowCount).toBe(0);
  });
});

describe('the signing key is out of reach of the application role', () => {
  test('set-actor-key refuses the repo-known test secret outside tests', () => {
    expect(() => assertProductionSecret(actorSecretHex(), { isTest: false })).toThrow(/test secret/);
    expect(() => assertProductionSecret('cd'.repeat(32), { isTest: false })).not.toThrow();
    expect(() => assertProductionSecret(actorSecretHex(), { isTest: true })).not.toThrow();
  });

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

  test('a genuine fault in the verifier surfaces as an error; it is not swallowed into "nobody"', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE actor_key RENAME TO actor_key_moved'); // DDL is transactional: rolled back below
      await c.query("SELECT set_config('app.actor', $1, true)", [token(cha)]);
      await expect(c.query('SELECT app_company_id()')).rejects.toThrow(/actor_key/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
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
