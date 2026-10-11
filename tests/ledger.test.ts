import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { InvalidContainerNoError } from '../src/domain/iso6346.ts';
import { grantAccess } from '../src/access/access.ts';
import { EVENT_TYPES, ROLE_EVENT_TYPES } from '../src/domain/statusChain.ts';
import { appendCorrection, appendEvent, createContainer, currentStatus, listEvents } from '../src/ledger/ledger.ts';
import type { EventInput } from '../src/ledger/ledger.ts';
import { newBl, seedActor, seedDocument, seedMessage, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
let outsider: TestActor;
let companyId: string;
let messageId: string;
let documentId: string;
let owner: pg.Pool;

const person = { type: 'person', ref: 'synthetic-user' } as const;
const at = (iso: string) => new Date(iso);

function input(containerId: string, eventType: EventInput['eventType'], extra: Partial<EventInput> = {}): EventInput {
  return {
    containerId,
    eventType,
    occurredAt: at('2026-10-12T03:00:00Z'),
    source: person,
    evidence: { type: 'message', messageId },
    ...extra,
  };
}

beforeAll(async () => {
  cha = await seedActor('cha');
  outsider = await seedActor('cha');
  companyId = cha.companyId;
  messageId = await seedMessage(cha);
  documentId = await seedDocument(cha);
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('container numbers are validated before saving', () => {
  test('an invalid check digit is rejected and nothing is stored', async () => {
    await expect(withActor(cha, (c) => createContainer(c, { blNo: newBl(), containerNo: 'ZZZU9999999' }))).rejects.toThrow(InvalidContainerNoError);
    const n = await withActor(cha, async (c) => (await c.query("SELECT 1 FROM containers WHERE container_no = 'ZZZU9999999'")).rowCount);
    expect(n).toBe(0);
  });

  test('the database itself rejects an invalid number (check constraint)', async () => {
    await expect(
      withActor(cha, (c) => c.query("INSERT INTO containers (company_id, container_no, bl_no) VALUES ($1, 'ZZZU9999999', 'SYNTHBL000000')", [companyId])),
    ).rejects.toThrow(/container_no/);
  });

  test('a valid lower-case number is stored normalised', async () => {
    const c1 = await withActor(cha, (c) => createContainer(c, { blNo: newBl(), containerNo: 'zzzu 3456787' }));
    expect(c1.containerNo).toBe('ZZZU3456787');
  });

  test('the same consignment (container number + BL) cannot be created twice', async () => {
    const bl = newBl();
    await withActor(cha, (c) => createContainer(c, { blNo: bl, containerNo: 'ZZZU2345670' }));
    await expect(withActor(cha, (c) => createContainer(c, { blNo: bl, containerNo: 'ZZZU2345670' }))).rejects.toThrow(/duplicate|unique/);
  });

  test('a recycled container number is allowed with a different BL (repeat visit, LCL)', async () => {
    const no = validContainerNo();
    await withActor(cha, (c) => createContainer(c, { blNo: newBl(), containerNo: no }));
    await withActor(cha, (c) => createContainer(c, { blNo: newBl(), containerNo: no, cargoType: 'LCL' }));
    const n = await withActor(cha, async (c) => (await c.query('SELECT 1 FROM containers WHERE container_no = $1', [no])).rowCount);
    expect(n).toBe(2);
  });

  test('a blank BL is rejected', async () => {
    await expect(withActor(cha, (c) => createContainer(c, { blNo: '  ', containerNo: validContainerNo() }))).rejects.toThrow();
  });
});

describe('the ledger is append-only', () => {
  let containerId: string;
  let eventId: string;
  beforeAll(async () => {
    const r = await withActor(cha, async (c) => {
      const cont = await createContainer(c, { blNo: newBl(), containerNo: 'ZZZU1234564' });
      const ev = await appendEvent(c, input(cont.id, 'do_received'));
      return { containerId: cont.id, eventId: ev.id };
    });
    ({ containerId, eventId } = r);
  });

  test('UPDATE, DELETE and TRUNCATE are denied to the application role', async () => {
    await expect(withActor(cha, (c) => c.query("UPDATE events SET source_ref = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withActor(cha, (c) => c.query('DELETE FROM events'))).rejects.toThrow(/permission denied/);
    await expect(withActor(cha, (c) => c.query('TRUNCATE events'))).rejects.toThrow(/permission denied/);
  });

  test('UPDATE, DELETE and TRUNCATE are denied to the table owner too (triggers)', async () => {
    await expect(owner.query("UPDATE events SET source_ref = 'x'")).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM events')).rejects.toThrow(/append-only/);
    // CASCADE because intake_decisions references events: without it Postgres refuses first, for a different
    // reason, and the trigger would go untested. If the trigger regressed this empties the test tables and the
    // next test fails loudly.
    await expect(owner.query('TRUNCATE events CASCADE')).rejects.toThrow(/append-only/);
  });

  test('the event row is unchanged after the failed attempts', async () => {
    const events = await withActor(cha, (c) => listEvents(c, containerId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: eventId, eventType: 'do_received', source: person, confirmedByUserId: cha.userId });
  });

  test('a correction is a new event that references the original', async () => {
    const correction = await withActor(cha, (c) =>
      appendCorrection(c, eventId, input(containerId, 'do_received', { occurredAt: at('2026-10-12T05:00:00Z'), evidence: { type: 'manual', note: 'DO time corrected from the stamped copy' } })),
    );
    expect(correction.correctsEventId).toBe(eventId);
    const events = await withActor(cha, (c) => listEvents(c, containerId));
    expect(events.map((e) => e.id)).toEqual([eventId, correction.id]);
    expect(events[0]!.occurredAt.toISOString()).toBe('2026-10-12T03:00:00.000Z'); // original untouched
    const status = await withActor(cha, (c) => currentStatus(c, containerId));
    expect(status).toMatchObject({ eventId: correction.id, eventType: 'do_received' });
    expect(status!.occurredAt.toISOString()).toBe('2026-10-12T05:00:00.000Z');
  });

  test('an event can be corrected only once (chain the correction instead)', async () => {
    await expect(
      withActor(cha, (c) => appendCorrection(c, eventId, input(containerId, 'do_received', { evidence: { type: 'manual', note: 'second' } }))),
    ).rejects.toThrow(/duplicate|unique/);
  });

  test('a correction must reference an event of the same container and company', async () => {
    const other = await withActor(cha, (c) => createContainer(c, { blNo: newBl(), containerNo: validContainerNo() }));
    const fresh = await withActor(cha, (c) => appendEvent(c, input(containerId, 'cusdec_lodged')));
    await expect(
      withActor(cha, (c) => appendCorrection(c, fresh.id, input(other.id, 'cusdec_lodged', { evidence: { type: 'manual', note: 'wrong container' } }))),
    ).rejects.toThrow(/foreign key/);
    await expect(
      withActor(cha, (c) => appendCorrection(c, '11111111-1111-4111-8111-111111111111', input(containerId, 'do_received', { evidence: { type: 'manual', note: 'missing' } }))),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withActor(outsider, (c) => appendCorrection(c, fresh.id, input(containerId, 'cusdec_lodged', { evidence: { type: 'manual', note: 'cross tenant' } }))),
    ).rejects.toThrow(/foreign key|row-level security/);
  });
});

describe('every event records source and evidence', () => {
  let containerId: string;
  beforeAll(async () => {
    containerId = await withActor(cha, async (c) => (await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() })).id);
  });

  test('message, document and manual evidence are all accepted', async () => {
    await withActor(cha, async (c) => {
      await appendEvent(c, input(containerId, 'cusdec_lodged', { evidence: { type: 'message', messageId } }));
      await appendEvent(c, input(containerId, 'channel_assigned', { evidence: { type: 'document', documentId }, source: { type: 'system', ref: 'intake' } }));
      await appendEvent(c, input(containerId, 'exam', { evidence: { type: 'manual', note: 'Grayline 1 per CHA call' }, payload: { yard: 'Grayline 1' } }));
    });
    const events = await withActor(cha, (c) => listEvents(c, containerId));
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.source.ref).toBeTruthy();
      expect(['message', 'document', 'manual']).toContain(e.evidence.type);
    }
    expect(events[2]!.payload).toEqual({ yard: 'Grayline 1' });
  });

  test('the database refuses evidence that does not match its type', async () => {
    const bad = (evidenceType: string, messageIdArg: string | null, documentIdArg: string | null, note: string | null) =>
      withActor(cha, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, message_id, document_id, evidence_note)
           VALUES ($1, $2, 'cusdec_lodged', now(), 'person', 'u', $3, $4, $5, $6)`,
          [companyId, containerId, evidenceType, messageIdArg, documentIdArg, note],
        ),
      );
    await expect(bad('message', null, null, null)).rejects.toThrow(/check constraint/);
    await expect(bad('document', null, null, null)).rejects.toThrow(/check constraint/);
    await expect(bad('manual', null, null, null)).rejects.toThrow(/check constraint/);
    await expect(bad('message', messageId, documentId, null)).rejects.toThrow(/check constraint/);
    await expect(bad('whatsapp', messageId, null, null)).rejects.toThrow(/check constraint/);
  });

  test('source is required', async () => {
    await expect(
      withActor(cha, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, evidence_type, evidence_note)
           VALUES ($1, $2, 'cusdec_lodged', now(), 'manual', 'n')`,
          [companyId, containerId],
        ),
      ),
    ).rejects.toThrow(/null value|not-null/);
  });

  test('an event cannot use evidence from another company', async () => {
    const foreignMessage = await seedMessage(outsider);
    await expect(
      withActor(cha, (c) => appendEvent(c, input(containerId, 'cusdec_lodged', { evidence: { type: 'message', messageId: foreignMessage } }))),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('status chain', () => {
  let containerId: string;
  beforeAll(async () => {
    containerId = await withActor(cha, async (c) => (await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() })).id);
  });

  test('the chain is exactly the documented sequence', () => {
    expect([...EVENT_TYPES]).toEqual([
      'vessel_discharged',
      'do_received',
      'cusdec_lodged',
      'channel_assigned',
      'exam',
      'release_advice',
      'gate_pass',
      'truck_dispatched',
      'picked_up',
      'delivered',
      'empty_returned',
    ]);
  });

  test('a status outside the chain is rejected', async () => {
    await expect(
      withActor(cha, (c) => appendEvent(c, input(containerId, 'invented_status' as EventInput['eventType']))),
    ).rejects.toThrow(/row-level security|check constraint/); // the permission matrix and the CHECK both refuse it
  });

  test('every chain status can be stored and current status follows chain order, not arrival order', async () => {
    const haulier = await seedActor('haulier');
    const id = await withActor(cha, async (c) => {
      const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
      await grantAccess(c, { containerId: container.id, granteeCompanyId: haulier.companyId, kind: 'haulier' });
      return container.id;
    });
    const record = async (type: EventInput['eventType']) => {
      const actor = ROLE_EVENT_TYPES.cha_ops.includes(type) ? cha : haulier;
      const evidence = { type: 'manual', note: `synthetic ${type}` } as const;
      await withActor(actor, (c) => appendEvent(c, input(id, type, { evidence })));
    };
    expect(await withActor(cha, (c) => currentStatus(c, id))).toBeNull();
    // Messages arrive out of order: the gate pass is recorded before the DO.
    await record('gate_pass');
    await record('do_received');
    expect((await withActor(cha, (c) => currentStatus(c, id)))!.eventType).toBe('gate_pass');
    for (const t of EVENT_TYPES) {
      await record(t);
      expect((await withActor(cha, (c) => currentStatus(c, id)))!.eventType).toBe(
        EVENT_TYPES.indexOf(t) >= EVENT_TYPES.indexOf('gate_pass') ? t : 'gate_pass',
      );
    }
  });

  test('exam sits between channel assigned and release', async () => {
    const id = await withActor(cha, async (c) => (await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() })).id);
    await withActor(cha, async (c) => {
      await appendEvent(c, input(id, 'release_advice'));
      await appendEvent(c, input(id, 'exam'));
    });
    expect((await withActor(cha, (c) => currentStatus(c, id)))!.eventType).toBe('release_advice');
  });

  test('occurred_at is stored as an instant (UTC)', async () => {
    const id = await withActor(cha, async (c) => (await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() })).id);
    await withActor(cha, (c) => appendEvent(c, input(id, 'cusdec_lodged', { occurredAt: new Date('2026-10-14T18:45:00+05:30') })));
    const [e] = await withActor(cha, (c) => listEvents(c, id));
    expect(e!.occurredAt.toISOString()).toBe('2026-10-14T13:15:00.000Z');
  });
});
