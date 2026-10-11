import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantAccess, revokeAccess } from '../src/access/access.ts';
import { closeAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { appendCorrection, appendEvent, createContainer, currentStatus, listEvents, voidEvent } from '../src/ledger/ledger.ts';
import type { EventInput } from '../src/ledger/ledger.ts';
import type { EventType } from '../src/domain/statusChain.ts';
import { newBl, seedActor, seedMessage, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
let cha2: TestActor;
let client: TestActor;
let haulierA: TestActor;
let haulierB: TestActor;

const manual = (note: string) => ({ type: 'manual', note }) as const;
const source = { type: 'person', ref: 'synthetic-reporter' } as const;

async function shared(): Promise<string> {
  return withActor(cha, async (c) => {
    const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: client.companyId, kind: 'client' });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: haulierA.companyId, kind: 'haulier' });
    return container.id;
  });
}
const record = (actor: TestActor, containerId: string, eventType: EventType, extra: Partial<EventInput> = {}) =>
  withActor(actor, (c) => appendEvent(c, { containerId, eventType, occurredAt: new Date('2026-10-14T03:00:00Z'), source, evidence: manual(`synthetic ${eventType}`), ...extra }));
const status = (actor: TestActor, containerId: string) => withActor(actor, (c) => currentStatus(c, containerId));

beforeAll(async () => {
  cha = await seedActor('cha');
  cha2 = await seedActor('cha');
  client = await seedActor('client');
  haulierA = await seedActor('haulier');
  haulierB = await seedActor('haulier');
});
afterAll(closeAppPool);

describe('the owning CHA can undo a false event, including a trucking one', () => {
  test('a false delivered is voided and the status falls back; the history is kept', async () => {
    const id = await shared();
    const gate = await record(haulierA, id, 'gate_pass');
    const falseDelivered = await record(haulierA, id, 'delivered');
    expect((await status(cha, id))!.eventType).toBe('delivered');

    const voided = await withActor(cha, (c) => voidEvent(c, falseDelivered.id, { source, evidence: manual('driver confirmed it was not delivered') }));
    expect(voided).toMatchObject({ correctionKind: 'void', correctsEventId: falseDelivered.id, eventType: 'delivered', recordedByCompanyId: cha.companyId });
    expect((await status(cha, id))!).toMatchObject({ eventType: 'gate_pass', eventId: gate.id });
    const all = await withActor(cha, (c) => listEvents(c, id));
    expect(all.map((e) => e.id)).toEqual([gate.id, falseDelivered.id, voided.id]); // nothing deleted
    expect((await status(haulierA, id))!.eventType).toBe('gate_pass'); // the haulier sees the same corrected status
  });

  test('...even after the haulier has been revoked', async () => {
    const h = await seedActor('haulier');
    const id = await withActor(cha, async (c) => {
      const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
      await grantAccess(c, { containerId: container.id, granteeCompanyId: h.companyId, kind: 'haulier' });
      return container.id;
    });
    const falseEmpty = await record(h, id, 'empty_returned');
    await withActor(cha, (c) => revokeAccess(c, { containerId: id, granteeCompanyId: h.companyId, kind: 'haulier' }));
    await withActor(cha, (c) => voidEvent(c, falseEmpty.id, { source, evidence: manual('haulier no longer assigned; entry was wrong') }));
    expect(await status(cha, id)).toBeNull();
  });

  test('voiding the only event leaves the container with no status', async () => {
    const id = await shared();
    const only = await record(cha, id, 'do_received');
    await withActor(cha, (c) => voidEvent(c, only.id, { source, evidence: manual('wrong container') }));
    expect(await status(cha, id)).toBeNull();
  });

  test('the CHA still cannot RECORD trucking stages (SPEC)', async () => {
    const id = await shared();
    await expect(record(cha, id, 'gate_pass')).rejects.toThrow(/row-level security/);
  });
});

describe('everyone else is limited to what their role may record', () => {
  test('a haulier voids its own event but not the CHA\'s', async () => {
    const id = await shared();
    const mine = await record(haulierA, id, 'picked_up');
    const chas = await record(cha, id, 'do_received');
    await expect(withActor(haulierA, (c) => voidEvent(c, mine.id, { source, evidence: manual('typo') }))).resolves.toMatchObject({ correctionKind: 'void' });
    await expect(withActor(haulierA, (c) => voidEvent(c, chas.id, { source, evidence: manual('no') }))).rejects.toThrow(/row-level security/);
  });

  test('a client cannot void a trucking event', async () => {
    const id = await shared();
    const e = await record(haulierA, id, 'truck_dispatched');
    await expect(withActor(client, (c) => voidEvent(c, e.id, { source, evidence: manual('no') }))).rejects.toThrow(/row-level security/);
  });

  test('an unassigned haulier and another CHA cannot void anything on the container', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    await expect(withActor(haulierB, (c) => voidEvent(c, e.id, { source, evidence: manual('no') }))).rejects.toThrow(/row-level security/);
    await expect(withActor(cha2, (c) => voidEvent(c, e.id, { source, evidence: manual('no') }))).rejects.toThrow(/row-level security/);
  });

  test('raw void rows naming the owner company are refused without an active grant', async () => {
    const id = await shared();
    const e = await record(haulierA, id, 'gate_pass');
    const rawVoid = (actor: TestActor) =>
      withActor(actor, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note, corrects_event_id, correction_kind)
           VALUES ($1, $2, 'gate_pass', now(), 'person', 'u', 'manual', 'n', $3, 'void')`,
          [cha.companyId, id, e.id],
        ),
      );
    await expect(rawVoid(haulierB)).rejects.toThrow(/row-level security/);
    await expect(rawVoid(cha2)).rejects.toThrow(/row-level security/);
    await expect(rawVoid(client)).rejects.toThrow(/row-level security/);
  });
});

describe('what a void row may look like', () => {
  test('it must carry the voided event\'s own type and a target', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    const raw = (type: string, target: string | null, kind = 'void') =>
      withActor(cha, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note, corrects_event_id, correction_kind)
           VALUES ($1, $2, $3, now(), 'person', 'u', 'manual', 'n', $4, $5)`,
          [cha.companyId, id, type, target, kind],
        ),
      );
    await expect(raw('cusdec_lodged', e.id)).rejects.toThrow(/row-level security/); // wrong type
    await expect(raw('do_received', null)).rejects.toThrow(/check constraint|row-level security/); // no target
    await expect(raw('do_received', e.id, 'erase')).rejects.toThrow(/check constraint/); // unknown kind
  });

  test('a void carries no payload', async () => {
    const id = await shared();
    const e = await record(cha, id, 'exam', { payload: { yard: 'RCT' } });
    await expect(
      withActor(cha, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note, corrects_event_id, correction_kind, payload)
           VALUES ($1, $2, 'exam', now(), 'person', 'u', 'manual', 'n', $3, 'void', '{"note":"x"}'::jsonb)`,
          [cha.companyId, id, e.id],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  test('an event is voided once; a void cannot be voided or replaced', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    const v = await withActor(cha, (c) => voidEvent(c, e.id, { source, evidence: manual('first') }));
    await expect(withActor(cha, (c) => voidEvent(c, e.id, { source, evidence: manual('again') }))).rejects.toThrow(/duplicate|unique/);
    await expect(withActor(cha, (c) => voidEvent(c, v.id, { source, evidence: manual('undo the void') }))).rejects.toThrow(/row-level security/);
    await expect(
      withActor(cha, (c) => appendCorrection(c, v.id, { containerId: id, eventType: 'do_received', occurredAt: new Date(), source, evidence: manual('resurrect') })),
    ).rejects.toThrow(/row-level security/);
    expect(await status(cha, id)).toBeNull();
  });
});

describe('ordinary corrections are marked and no longer fail open', () => {
  test('appendCorrection records kind replace', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    const r = await withActor(cha, (c) => appendCorrection(c, e.id, { containerId: id, eventType: 'do_received', occurredAt: new Date('2026-10-14T05:00:00Z'), source, evidence: manual('time fixed') }));
    expect(r.correctionKind).toBe('replace');
    expect((await status(cha, id))!.eventId).toBe(r.id);
  });

  test('a missing target and an invisible target are refused the same way', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    await withActor(cha, (c) => appendCorrection(c, e.id, { containerId: id, eventType: 'do_received', occurredAt: new Date(), source, evidence: manual('already corrected') }));
    const attempt = (actor: TestActor, target: string) =>
      withActor(actor, (c) => appendCorrection(c, target, { containerId: id, eventType: 'do_received', occurredAt: new Date(), source, evidence: manual('probe') })).catch((err: Error) => err.message);
    const missing = await attempt(haulierB, '11111111-1111-4111-8111-111111111111');
    const invisible = await attempt(haulierB, e.id); // exists and already corrected, but haulier B cannot see it
    expect(missing).toMatch(/row-level security/);
    expect(invisible).toBe(missing); // no "has event X been corrected?" oracle
    // the owner, who can see it, learns it was already corrected
    await expect(
      withActor(cha, (c) => appendCorrection(c, e.id, { containerId: id, eventType: 'do_received', occurredAt: new Date(), source, evidence: manual('twice') })),
    ).rejects.toThrow(/duplicate|unique/);
  });

  test('a client may still supersede the CHA\'s clearance event (type-match rule unchanged)', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    await expect(
      withActor(client, (c) => appendCorrection(c, e.id, { containerId: id, eventType: 'do_received', occurredAt: new Date(), source, evidence: manual('DO date fixed') })),
    ).resolves.toMatchObject({ correctionKind: 'replace' });
  });
});

describe('voids and replacements interact predictably', () => {
  test('voiding a replacement hides both it and the original it replaced (documented behaviour)', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    const r = await withActor(cha, (c) => appendCorrection(c, e.id, { containerId: id, eventType: 'do_received', occurredAt: new Date(), source, evidence: manual('time fixed') }));
    await withActor(cha, (c) => voidEvent(c, r.id, { source, evidence: manual('the fix was wrong too') }));
    expect(await status(cha, id)).toBeNull();
  });

  test('status follows the chain after a void and a later event', async () => {
    const id = await shared();
    await record(haulierA, id, 'gate_pass');
    const falseDelivered = await record(haulierA, id, 'delivered');
    await withActor(cha, (c) => voidEvent(c, falseDelivered.id, { source, evidence: manual('not delivered') }));
    expect((await status(cha, id))!.eventType).toBe('gate_pass');
    await record(haulierA, id, 'picked_up');
    expect((await status(cha, id))!.eventType).toBe('picked_up');
  });

  test('listEvents includes void rows; consumers filter on correctionKind', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    await withActor(cha, (c) => voidEvent(c, e.id, { source, evidence: manual('wrong') }));
    const all = await withActor(cha, (c) => listEvents(c, id));
    expect(all.map((x) => x.correctionKind)).toEqual([null, 'void']);
  });
});

describe('seedMessage still works as evidence for voids', () => {
  test('a void can cite a stored message', async () => {
    const id = await shared();
    const e = await record(cha, id, 'do_received');
    const messageId = await seedMessage(cha, 'SYNTHETIC: ignore the earlier DO message');
    const v = await withActor(cha, (c) => voidEvent(c, e.id, { source, evidence: { type: 'message', messageId } }));
    expect(v.evidence).toEqual({ type: 'message', messageId });
  });
});
