import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantAccess, revokeAccess } from '../src/access/access.ts';
import { signActor } from '../src/db/actorToken.ts';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { EVENT_TYPES, ROLE_EVENT_TYPES, eventAllowed } from '../src/domain/statusChain.ts';
import type { EventType } from '../src/domain/statusChain.ts';
import { appendCorrection, appendEvent, createContainer, currentStatus, listEvents } from '../src/ledger/ledger.ts';
import type { EventInput } from '../src/ledger/ledger.ts';
import { newBl, seedActor, seedDocument, seedMessage, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
let cha2: TestActor;
let client: TestActor;
let haulierA: TestActor;
let haulierB: TestActor;
let owner: pg.Pool;

/** A fresh container owned by `cha`, shared with the client and haulier A. */
async function sharedContainer(): Promise<string> {
  return withActor(cha, async (c) => {
    const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: client.companyId, kind: 'client' });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: haulierA.companyId, kind: 'haulier' });
    return container.id;
  });
}

async function ev(actor: TestActor, containerId: string, eventType: EventType, extra: Partial<EventInput> = {}) {
  const messageId = await seedMessage(actor);
  return withActor(actor, (c) =>
    appendEvent(c, {
      containerId,
      eventType,
      occurredAt: new Date('2026-10-14T03:00:00Z'),
      source: { type: 'person', ref: 'synthetic-reporter' },
      evidence: { type: 'message', messageId },
      ...extra,
    }),
  );
}

beforeAll(async () => {
  cha = await seedActor('cha');
  cha2 = await seedActor('cha');
  client = await seedActor('client');
  haulierA = await seedActor('haulier');
  haulierB = await seedActor('haulier');
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('permission matrix', () => {
  const ROLES = ['cha_ops', 'client', 'haulier_dispatcher'] as const;

  test.each(ROLES)('database and code agree for every event type (%s)', async (role) => {
    for (const type of EVENT_TYPES) {
      const { rows } = await getAppPool().query<{ ok: boolean }>('SELECT event_allowed($1, $2) AS ok', [role, type]);
      expect(rows[0]!.ok, `${role} / ${type}`).toBe(eventAllowed(role, type));
    }
  });

  test('every chain status is recordable by someone, and by exactly the intended roles', () => {
    expect(ROLE_EVENT_TYPES.cha_ops).toEqual(['vessel_discharged', 'do_received', 'cusdec_lodged', 'channel_assigned', 'exam', 'release_advice']);
    expect(ROLE_EVENT_TYPES.client).toEqual(['do_received', 'cusdec_lodged', 'channel_assigned', 'exam', 'release_advice']);
    expect(ROLE_EVENT_TYPES.haulier_dispatcher).toEqual(['gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned']);
    for (const type of EVENT_TYPES) expect(ROLES.some((r) => eventAllowed(r, type))).toBe(true);
  });

  test('unknown roles and a missing role are never allowed', async () => {
    const { rows } = await getAppPool().query<{ a: boolean; b: boolean }>("SELECT event_allowed('driver', 'gate_pass') AS a, coalesce(event_allowed(NULL, 'gate_pass'), false) AS b");
    expect(rows[0]).toEqual({ a: false, b: false });
  });
});

describe('who may record which stage', () => {
  test('the assigned haulier records trucking stages in the CHA ledger, confirmed by its own user', async () => {
    const id = await sharedContainer();
    const e = await ev(haulierA, id, 'gate_pass');
    expect(e).toMatchObject({ eventType: 'gate_pass', confirmedByUserId: haulierA.userId, recordedByCompanyId: haulierA.companyId });
    const seenByCha = await withActor(cha, (c) => listEvents(c, id));
    expect(seenByCha.map((x) => x.id)).toContain(e.id);
    expect((await withActor(cha, (c) => currentStatus(c, id)))!.eventType).toBe('gate_pass');
  });

  test('the haulier cannot record clearance stages', async () => {
    const id = await sharedContainer();
    for (const t of ['do_received', 'cusdec_lodged', 'channel_assigned', 'exam', 'release_advice', 'vessel_discharged'] as const) {
      await expect(ev(haulierA, id, t), t).rejects.toThrow(/row-level security/);
    }
  });

  test('the client records clearance stages but not trucking stages', async () => {
    const id = await sharedContainer();
    await expect(ev(client, id, 'cusdec_lodged')).resolves.toMatchObject({ eventType: 'cusdec_lodged', recordedByCompanyId: client.companyId });
    for (const t of ['vessel_discharged', 'gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned'] as const) {
      await expect(ev(client, id, t), t).rejects.toThrow(/row-level security/);
    }
  });

  test('the CHA records clearance stages but, per SPEC, not trucking stages', async () => {
    const id = await sharedContainer();
    await expect(ev(cha, id, 'release_advice')).resolves.toMatchObject({ recordedByCompanyId: cha.companyId });
    for (const t of ['gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned'] as const) {
      await expect(ev(cha, id, t), t).rejects.toThrow(/row-level security/);
    }
  });

  test('an unassigned haulier and another CHA cannot record on the container', async () => {
    const id = await sharedContainer();
    await expect(ev(haulierB, id, 'gate_pass')).rejects.toThrow(/row-level security|foreign key/);
    await expect(ev(cha2, id, 'release_advice')).rejects.toThrow(/row-level security|foreign key/);
  });

  test('a raw insert naming the owning CHA is refused without an active grant (policy, not just the FK)', async () => {
    const id = await sharedContainer();
    const raw = (actor: TestActor, eventType: string) =>
      withActor(actor, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note)
           VALUES ($1, $2, $3, now(), 'person', 'u', 'manual', 'n')`,
          [cha.companyId, id, eventType],
        ),
      );
    await expect(raw(haulierB, 'gate_pass')).rejects.toThrow(/row-level security/);
    await expect(raw(cha2, 'release_advice')).rejects.toThrow(/row-level security/);
    await expect(raw(haulierA, 'gate_pass')).resolves.toBeTruthy(); // control: the assigned haulier passes
  });

  test('revoking a haulier stops it recording as well as reading', async () => {
    const h = await seedActor('haulier');
    const id = await withActor(cha, async (c) => {
      const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
      await grantAccess(c, { containerId: container.id, granteeCompanyId: h.companyId, kind: 'haulier' });
      return container.id;
    });
    await expect(ev(h, id, 'gate_pass')).resolves.toBeTruthy();
    await withActor(cha, (c) => revokeAccess(c, { containerId: id, granteeCompanyId: h.companyId, kind: 'haulier' }));
    await expect(ev(h, id, 'truck_dispatched')).rejects.toThrow(/row-level security|foreign key/);
  });
});

describe('the recorder and confirmer cannot be forged', () => {
  test('recorded_by_company_id and confirmed_by_user_id are not insertable', async () => {
    const id = await sharedContainer();
    const raw = (col: string, val: string) =>
      withActor(haulierA, (c) =>
        c.query(
          `INSERT INTO events (${col}, company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note)
           VALUES ($3, $1, $2, 'gate_pass', now(), 'person', 'u', 'manual', 'n')`,
          [cha.companyId, id, val],
        ),
      );
    await expect(raw('recorded_by_company_id', cha.companyId)).rejects.toThrow(/permission denied/);
    await expect(raw('confirmed_by_user_id', cha.userId)).rejects.toThrow(/permission denied/);
  });

  test('evidence must belong to the recording company', async () => {
    const id = await sharedContainer();
    const chasMessage = await seedMessage(cha);
    const chasDocument = await seedDocument(cha);
    await expect(ev(haulierA, id, 'gate_pass', { evidence: { type: 'message', messageId: chasMessage } })).rejects.toThrow(/foreign key/);
    await expect(ev(haulierA, id, 'gate_pass', { evidence: { type: 'document', documentId: chasDocument } })).rejects.toThrow(/foreign key/);
    await expect(ev(haulierA, id, 'gate_pass', { evidence: { type: 'manual', note: 'called the yard' } })).resolves.toBeTruthy();
  });

  test('the owning CHA cannot read a haulier\'s messages even if an event points at them', async () => {
    const id = await sharedContainer();
    const messageId = await seedMessage(haulierA, 'SYNTHETIC driver message');
    await ev(haulierA, id, 'picked_up', { evidence: { type: 'message', messageId } });
    const visible = await withActor(cha, async (c) => (await c.query('SELECT 1 FROM messages WHERE id = $1', [messageId])).rowCount);
    expect(visible).toBe(0);
  });
});

describe('corrections across roles', () => {
  test('a role may supersede only stages it could record itself', async () => {
    const id = await sharedContainer();
    const chasDo = await ev(cha, id, 'do_received');
    const hauliersGate = await ev(haulierA, id, 'gate_pass');

    // haulier cannot supersede a clearance event, even with a trucking type; cha cannot supersede a trucking event
    await expect(
      withActor(haulierA, async (c) =>
        appendCorrection(c, chasDo.id, {
          containerId: id, eventType: 'gate_pass', occurredAt: new Date(), source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'n' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withActor(cha, async (c) =>
        appendCorrection(c, hauliersGate.id, {
          containerId: id, eventType: 'release_advice', occurredAt: new Date(), source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'n' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);

    // the client may supersede the CHA's DO with another clearance event; the haulier its own gate pass
    await expect(
      withActor(client, (c) =>
        appendCorrection(c, chasDo.id, {
          containerId: id, eventType: 'do_received', occurredAt: new Date(), source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'DO date fixed' },
        }),
      ),
    ).resolves.toMatchObject({ correctsEventId: chasDo.id });
    await expect(
      withActor(haulierA, (c) =>
        appendCorrection(c, hauliersGate.id, {
          containerId: id, eventType: 'gate_pass', occurredAt: new Date(), source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'wrong time' },
        }),
      ),
    ).resolves.toMatchObject({ correctsEventId: hauliersGate.id });
  });
});

describe('payload cannot carry commercial data (hauliers read events)', () => {
  test.each([
    ['freight key', { freight: 1200 }],
    ['demurrage key', { demurrage_estimate: 40 }],
    ['nested object', { note: { freight: 1 } }],
    ['nested array', { note: ['a'] }],
  ])('%s is rejected', async (_n, payload) => {
    const id = await sharedContainer();
    await expect(ev(cha, id, 'exam', { payload: payload as never })).rejects.toThrow(/check constraint/);
  });

  test('a JSON array or scalar payload is rejected, even for the table owner', async () => {
    const id = await sharedContainer();
    for (const bad of ['[]', '"x"', '1']) {
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.actor', $1, true)", [signActor({ companyId: cha.companyId, userId: cha.userId })]);
        await expect(
          c.query(
            `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note, payload)
             VALUES ($1, $2, 'exam', now(), 'person', 'u', 'manual', 'n', $3::jsonb)`,
            [cha.companyId, id, bad],
          ),
        ).rejects.toThrow(/check constraint/);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
  });

  test('whitelisted keys are accepted', async () => {
    const id = await sharedContainer();
    const e = await ev(cha, id, 'exam', { payload: { yard: 'Grayline 1', note: 'scheduled', scheduled_at: '2026-10-14T10:00:00+05:30' } });
    expect(e.payload).toEqual({ yard: 'Grayline 1', note: 'scheduled', scheduled_at: '2026-10-14T10:00:00+05:30' });
  });
});
