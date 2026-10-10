import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantAccess, listActiveAccess, revokeAccess } from '../src/access/access.ts';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { appendEvent, createContainer, currentStatus, listEvents } from '../src/ledger/ledger.ts';
import { newBl, seedActor, seedMessage, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
let cha2: TestActor;
let client: TestActor;
let haulierA: TestActor;
let haulierB: TestActor;
let containerId: string;
let eventId: string;
let owner: pg.Pool;

const countContainers = (a: TestActor) => withActor(a, async (c) => (await c.query('SELECT 1 FROM containers')).rowCount);
const countEvents = (a: TestActor) => withActor(a, async (c) => (await c.query('SELECT 1 FROM events')).rowCount);

beforeAll(async () => {
  cha = await seedActor('cha');
  cha2 = await seedActor('cha');
  client = await seedActor('client');
  haulierA = await seedActor('haulier');
  haulierB = await seedActor('haulier');
  const messageId = await seedMessage(cha);
  ({ containerId, eventId } = await withActor(cha, async (c) => {
    const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
    const e = await appendEvent(c, {
      containerId: container.id,
      eventType: 'do_received',
      occurredAt: new Date('2026-10-12T03:00:00Z'),
      source: { type: 'person', ref: 'synthetic-user' },
      evidence: { type: 'message', messageId },
    });
    return { containerId: container.id, eventId: e.id };
  }));
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('nothing is shared until the owning CHA grants access', () => {
  test.each([
    ['client', () => client],
    ['haulier A', () => haulierA],
    ['another CHA', () => cha2],
  ])('%s sees no containers or events', async (_n, who) => {
    expect(await countContainers(who())).toBe(0);
    expect(await countEvents(who())).toBe(0);
  });
});

describe('granting access', () => {
  beforeAll(async () => {
    await withActor(cha, async (c) => {
      await grantAccess(c, { containerId, granteeCompanyId: client.companyId, kind: 'client' });
      await grantAccess(c, { containerId, granteeCompanyId: haulierA.companyId, kind: 'haulier' });
    });
  });

  test.each([
    ['client', () => client],
    ['haulier A', () => haulierA],
  ])('%s can read the container, its events and its current status', async (_n, who) => {
    expect(await countContainers(who())).toBe(1);
    const events = await withActor(who(), (c) => listEvents(c, containerId));
    expect(events.map((e) => e.id)).toEqual([eventId]);
    expect((await withActor(who(), (c) => currentStatus(c, containerId)))!.eventType).toBe('do_received');
  });

  test('haulier B and another CHA still see nothing', async () => {
    for (const who of [haulierB, cha2]) {
      expect(await countContainers(who)).toBe(0);
      expect(await countEvents(who)).toBe(0);
      expect(await withActor(who, (c) => currentStatus(c, containerId))).toBeNull();
    }
  });

  test('a grantee sees the owning CHA company and itself, nobody else', async () => {
    const names = async (a: TestActor) =>
      (await withActor(a, async (c) => (await c.query<{ company_id: string }>('SELECT company_id FROM companies')).rows)).map((r) => r.company_id).sort();
    expect(await names(haulierA)).toEqual([cha.companyId, haulierA.companyId].sort());
    expect(await names(client)).toEqual([cha.companyId, client.companyId].sort());
    expect(await names(haulierB)).toEqual([haulierB.companyId]);
    expect(await names(cha)).toEqual([cha.companyId, client.companyId, haulierA.companyId].sort());
  });

  test('a grantee sees only its own grant rows and no users of other companies', async () => {
    const rows = await withActor(haulierA, async (c) => (await c.query<{ grantee_company_id: string }>('SELECT grantee_company_id FROM container_access')).rows);
    expect(rows.map((r) => r.grantee_company_id)).toEqual([haulierA.companyId]);
    const users = await withActor(haulierA, async (c) => (await c.query<{ company_id: string }>('SELECT company_id FROM users')).rows);
    expect(users.every((u) => u.company_id === haulierA.companyId)).toBe(true);
  });

  test('a grantee cannot read the owner\'s messages or documents', async () => {
    const n = await withActor(haulierA, async (c) => (await c.query('SELECT 1 FROM messages')).rowCount);
    expect(n).toBe(0);
  });

  test('grantees cannot grant onward, and still cannot create containers or events', async () => {
    for (const who of [client, haulierA]) {
      await expect(
        withActor(who, (c) => grantAccess(c, { containerId, granteeCompanyId: haulierB.companyId, kind: 'haulier' })),
      ).rejects.toThrow(/row-level security|foreign key/);
    }
  });

  test('the grantee kind must match the company kind', async () => {
    await expect(withActor(cha, (c) => grantAccess(c, { containerId, granteeCompanyId: haulierB.companyId, kind: 'client' }))).rejects.toThrow(/foreign key/);
    await expect(withActor(cha, (c) => grantAccess(c, { containerId, granteeCompanyId: client.companyId, kind: 'haulier' }))).rejects.toThrow(/foreign key/);
  });

  test('another CHA cannot grant access to a container it does not own', async () => {
    await expect(
      withActor(cha2, (c) => grantAccess(c, { containerId, granteeCompanyId: haulierB.companyId, kind: 'haulier' })),
    ).rejects.toThrow(/foreign key/);
  });

  test('a company cannot be granted access to its own container', async () => {
    await expect(
      withActor(cha, (c) => c.query("INSERT INTO container_access (company_id, container_id, grantee_company_id, access_kind, action) VALUES ($1, $2, $1, 'client', 'grant')", [cha.companyId, containerId])),
    ).rejects.toThrow(/check constraint|foreign key/);
  });

  test('the access log is append-only and cannot be forged', async () => {
    await expect(withActor(cha, (c) => c.query("UPDATE container_access SET action = 'revoke'"))).rejects.toThrow(/permission denied/);
    await expect(withActor(cha, (c) => c.query('DELETE FROM container_access'))).rejects.toThrow(/permission denied/);
    await expect(owner.query("UPDATE container_access SET action = 'revoke'")).rejects.toThrow(/append-only/);
    await expect(owner.query('TRUNCATE container_access')).rejects.toThrow(/append-only/);
    await expect(
      withActor(cha, (c) =>
        c.query("INSERT INTO container_access (created_at, company_id, container_id, grantee_company_id, access_kind, action) VALUES ('2001-01-01', $1, $2, $3, 'haulier', 'grant')", [cha.companyId, containerId, haulierB.companyId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withActor(cha, (c) =>
        c.query("INSERT INTO container_access (granted_by_user_id, company_id, container_id, grantee_company_id, access_kind, action) VALUES ($4, $1, $2, $3, 'haulier', 'grant')", [cha.companyId, containerId, haulierB.companyId, haulierA.userId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test('listActiveAccess reports the current grants to the owner', async () => {
    const rows = await withActor(cha, (c) => listActiveAccess(c, containerId));
    expect(rows.map((r) => [r.granteeCompanyId, r.kind]).sort()).toEqual(
      [[client.companyId, 'client'], [haulierA.companyId, 'haulier']].sort(),
    );
  });
});

describe('revoking access', () => {
  test('a revoke row removes read access at once; a later grant restores it', async () => {
    const h = await seedActor('haulier');
    await withActor(cha, (c) => grantAccess(c, { containerId, granteeCompanyId: h.companyId, kind: 'haulier' }));
    expect(await countContainers(h)).toBe(1);

    await withActor(cha, (c) => revokeAccess(c, { containerId, granteeCompanyId: h.companyId, kind: 'haulier' }));
    expect(await countContainers(h)).toBe(0);
    expect(await countEvents(h)).toBe(0);
    expect((await withActor(cha, (c) => listActiveAccess(c, containerId))).map((r) => r.granteeCompanyId)).not.toContain(h.companyId);

    await withActor(cha, (c) => grantAccess(c, { containerId, granteeCompanyId: h.companyId, kind: 'haulier' }));
    expect(await countContainers(h)).toBe(1);
  });

  test('revocation of one grantee does not affect the others', async () => {
    expect(await countContainers(client)).toBe(1);
    expect(await countContainers(haulierA)).toBe(1);
  });

  test('the history is kept: grants and revokes are all rows', async () => {
    const { rows } = await getAppPool().query('SELECT 1'); // pool alive
    expect(rows).toHaveLength(1);
    const n = await withActor(cha, async (c) => (await c.query('SELECT 1 FROM container_access')).rowCount);
    expect(n).toBeGreaterThanOrEqual(5);
  });
});

describe('no actor, no sharing', () => {
  test('a company-only context cannot read shared data', async () => {
    const { withCompany } = await import('../src/db/withCompany.ts');
    const n = await withCompany(haulierA.companyId, async (c) => (await c.query('SELECT 1 FROM containers')).rowCount);
    expect(n).toBe(0);
  });
});
