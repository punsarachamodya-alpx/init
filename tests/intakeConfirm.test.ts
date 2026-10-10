import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantAccess } from '../src/access/access.ts';
import { closeAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { ConfirmationError, buildSuggestion, confirmSuggestion, intake } from '../src/intake/index.ts';
import type { Extractor, RawExtraction, Suggestion } from '../src/intake/index.ts';
import { appendCorrection, createContainer, listEvents, voidEvent } from '../src/ledger/ledger.ts';
import { newBl, seedActor } from './helpers.ts';
import type { TestActor } from './helpers.ts';

const fixture = (name: string) => readFileSync(path.resolve(import.meta.dirname, '../fixtures/synthetic', name), 'utf8');
const DO_TEXT = fixture('delivery-order-ZZZU1234564.txt');
const CUSDEC_TEXT = fixture('cusdec-summary-ZZZU3456787.txt');

let cha: TestActor;
let client: TestActor;
let haulier: TestActor;
let outsider: TestActor;
let bl: string;
let containerId: string;

const raw = (over: Partial<RawExtraction> = {}): RawExtraction => ({ docType: null, suggestedEvent: null, language: 'en', notes: null, fields: {}, ...over });
const fake = (r: RawExtraction): Extractor => ({ extract: async () => r });
const DO_RAW = () =>
  raw({
    docType: 'delivery_order',
    suggestedEvent: 'do_received',
    fields: { container_no: 'ZZZU1234564', bl_no: bl, vessel: 'MV TEST HORIZON', consignee: 'SAMPLE IMPORTS (PVT) LTD', do_date: '2026-10-12', freight_paid: true },
  });
const doText = () => DO_TEXT.replaceAll('ESLCMB000101', bl); // the document names this test's BL
const suggest = (actor: TestActor, r: RawExtraction, text?: string) =>
  withActor(actor, (c) => intake(c, fake(r), { kind: 'document', docType: 'delivery_order', text: text ?? doText() }));
const events = (actor: TestActor) => withActor(actor, (c) => listEvents(c, containerId));
const when = new Date('2026-10-12T04:00:00Z');

beforeAll(async () => {
  cha = await seedActor('cha');
  client = await seedActor('client');
  haulier = await seedActor('haulier');
  outsider = await seedActor('cha');
  bl = newBl();
  containerId = await withActor(cha, async (c) => {
    const container = await createContainer(c, { blNo: bl, containerNo: 'ZZZU1234564' });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: client.companyId, kind: 'client' });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: haulier.companyId, kind: 'haulier' });
    return container.id;
  });
});
afterAll(closeAppPool);

describe('confirmation is the only way into the ledger', () => {
  test('confirming writes exactly one event: source intake, evidence, acting user as confirmer', async () => {
    const s = await suggest(cha, DO_RAW());
    const before = (await events(cha)).length;
    const { event } = await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields } }));
    const after = await events(cha);
    expect(after).toHaveLength(before + 1);
    expect(event).toMatchObject({
      eventType: 'do_received',
      source: { type: 'system', ref: 'intake' },
      evidence: s.evidence,
      confirmedByUserId: cha.userId,
      containerId,
    });
    expect(event.occurredAt.toISOString()).toBe(when.toISOString());
    expect(event.payload).toEqual({ reference: bl });
  });

  test('every extracted field must be acknowledged; nothing is written otherwise', async () => {
    const s = await suggest(cha, DO_RAW());
    const { vessel: _vessel, ...withoutVessel } = s.fields;
    void _vessel;
    const before = (await events(cha)).length;
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: withoutVessel })),
    ).rejects.toMatchObject({ name: 'ConfirmationError', code: 'fields_not_acknowledged' });
    expect((await events(cha)).length).toBe(before);
  });

  test('an edited invalid container number is refused, an edited ordinary value is accepted', async () => {
    const s = await suggest(cha, DO_RAW());
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields, container_no: 'ZZZU1234565' } })),
    ).rejects.toMatchObject({ code: 'invalid_field' });
    const { event } = await withActor(cha, (c) =>
      confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields, consignee: 'SAMPLE IMPORTS (EDITED)' } }),
    ); // the failed attempt consumed nothing
    expect(event.payload).toEqual({ reference: bl });
  });

  test('a rejected suggestion (invalid check digit) can never be confirmed', async () => {
    const s = await withActor(cha, (c) =>
      intake(c, fake(raw({ fields: { container_no: 'ZZZU9999999' } })), { kind: 'message', channel: 'whatsapp', text: 'ZZZU9999999 reached the yard' }),
    );
    expect(s.status).toBe('rejected');
    const before = (await events(cha)).length;
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'delivered', occurredAt: when, fields: { ...s.fields, container_no: 'ZZZU9999999' } })),
    ).rejects.toMatchObject({ code: 'not_confirmable' });
    expect((await events(cha)).length).toBe(before);
  });

  test('a failed extraction cannot be confirmed', async () => {
    const failed: Suggestion = {
      status: 'failed', eventType: null, docType: null, language: null, fields: {}, issues: [{ code: 'extraction_failed', severity: 'error', message: 'x' }],
      suggestedOccurredAt: null, confirmableBy: [], evidence: { type: 'message', messageId: '00000000-0000-4000-8000-0000000000a1' },
    };
    await expect(withActor(cha, (c) => confirmSuggestion(c, failed, { eventType: 'do_received', occurredAt: when, fields: {} }))).rejects.toMatchObject({ code: 'not_confirmable' });
  });

  test('confirming the same evidence twice is refused', async () => {
    const s = await suggest(cha, DO_RAW());
    await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.fields } }));
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.fields } })),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });

  test('after a wrong event is voided, the same evidence can be confirmed again with corrected values', async () => {
    const s = await suggest(cha, DO_RAW());
    const first = await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.fields } }));
    await withActor(cha, (c) => voidEvent(c, first.event.id, { source: { type: 'person', ref: 'ops' }, evidence: s.evidence }));
    const again = await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: new Date('2026-10-12T06:00:00Z'), fields: { ...s.fields } }));
    expect(again.event.id).not.toBe(first.event.id);
    // ...but two live events from the same evidence are still refused
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.fields } })),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });

  test('a replaced event still holds its evidence: only a void releases it', async () => {
    const s = await suggest(cha, DO_RAW());
    const first = await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.fields } }));
    // replace with manual evidence: the original is hidden, the replacement carries no message id
    const replacement = await withActor(cha, (c) =>
      appendCorrection(c, first.event.id, {
        containerId: first.container.id,
        eventType: 'cusdec_lodged',
        occurredAt: new Date('2026-10-12T06:00:00Z'),
        source: { type: 'person', ref: 'ops' },
        evidence: { type: 'manual', note: 'time corrected by phone' },
      }),
    );
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.fields } })),
    ).rejects.toMatchObject({ code: 'duplicate' });
    // voiding the replacement ends the chain in a void, which releases the evidence
    await withActor(cha, (c) => voidEvent(c, replacement.id, { source: { type: 'person', ref: 'ops' }, evidence: { type: 'manual', note: 'wrong container' } }));
    const again = await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.fields } }));
    expect(again.event.id).not.toBe(first.event.id);
  });

  test('the confirmer supplies the event time when the suggestion has none', async () => {
    const s = await withActor(cha, (c) =>
      intake(c, fake(raw({ suggestedEvent: 'do_received', fields: { container_no: 'ZZZU1234564' } })), { kind: 'message', channel: 'whatsapp', text: 'ZZZU1234564 DO kittu. CHA ge cusdec adha dannawa.' }),
    );
    expect(s.suggestedOccurredAt).toBeNull();
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', fields: { ...s.fields } })),
    ).rejects.toMatchObject({ code: 'occurred_at_required' });
    const { event } = await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields } }));
    expect(event.evidence.type).toBe('message'); // Romanised Sinhala message -> do_received after confirmation
  });

  test('a missing container is not created unless the confirmer asks and may', async () => {
    const r = raw({ docType: 'cusdec_summary', suggestedEvent: 'channel_assigned', fields: { container_no: 'ZZZU3456787', bl_no: 'ESLCMB000103', channel: 'red', exam_location: 'Grayline 1', exam_scheduled_at: '2026-10-14T10:00:00+05:30', cusdec_registered_at: '2026-10-12T09:20:00+05:30' } });
    const s = await suggest(cha, r, CUSDEC_TEXT);
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'channel_assigned', fields: { ...s.fields } })),
    ).rejects.toMatchObject({ code: 'container_not_found' });
    const { event, container } = await withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'channel_assigned', fields: { ...s.fields }, createContainer: true }));
    expect(container.containerNo).toBe('ZZZU3456787');
    expect(event.occurredAt.toISOString()).toBe('2026-10-12T03:50:00.000Z'); // cusdec_registered_at is the suggested time
    expect(event.payload).toEqual({ reference: 'ESLCMB000103', result: 'red', yard: 'Grayline 1', scheduled_at: '2026-10-14T04:30:00.000Z' });
  });
});

describe('acknowledging a field means giving it a value', () => {
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['blank string', '   '],
  ])('a %s is not an acknowledgement', async (_n, value) => {
    const s = await suggest(cha, DO_RAW());
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields, bl_no: value as never } })),
    ).rejects.toMatchObject({ code: 'fields_not_acknowledged' });
  });

  test('unknown keys, including __proto__, are refused', async () => {
    const s = await suggest(cha, DO_RAW());
    const sneaky = JSON.parse('{"__proto__": {"polluted": true}, "container_no": "ZZZU1234564"}');
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields, ...sneaky } })),
    ).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields, shoe_size: '9' } as never })),
    ).rejects.toMatchObject({ code: 'invalid_field' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('the event time and container creation are validated', () => {
  const day = 86_400_000;
  test.each([
    ['an Invalid Date', new Date('nonsense')],
    ['year 1', new Date('0001-01-01T00:00:00Z')],
    ['before 2000', new Date('1999-12-31T00:00:00Z')],
    ['two years ahead', new Date(Date.now() + 730 * day)],
    ['year 9999', new Date('9999-12-31T00:00:00Z')],
  ])('%s is refused', async (_n, occurredAt) => {
    const s = await suggest(cha, DO_RAW());
    await expect(
      withActor(cha, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt, fields: { ...s.fields } })),
    ).rejects.toMatchObject({ code: 'occurred_at_invalid' });
  });

  test('createContainer must be exactly true', async () => {
    const r = raw({ suggestedEvent: 'channel_assigned', fields: { container_no: 'ZZZU3456787', bl_no: 'ESLCMB000103', cusdec_registered_at: '2026-10-12T09:20:00+05:30' } });
    const s = await suggest(outsider, r, CUSDEC_TEXT);
    await expect(
      withActor(outsider, (c) => confirmSuggestion(c, s, { eventType: 'channel_assigned', fields: { ...s.fields }, createContainer: 'yes' as never })),
    ).rejects.toMatchObject({ code: 'container_not_found' });
  });
});

describe('roles still decide who may confirm', () => {
  test('a granted client can confirm a clearance stage on the shared container', async () => {
    const s = await suggest(client, DO_RAW());
    const { event } = await withActor(client, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields } }));
    expect(event).toMatchObject({ recordedByCompanyId: client.companyId, confirmedByUserId: client.userId });
  });

  test('a granted haulier cannot confirm a DO (permission matrix)', async () => {
    const s = await suggest(haulier, DO_RAW());
    expect(s.confirmableBy).not.toContain('haulier_dispatcher');
    await expect(
      withActor(haulier, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields } })),
    ).rejects.toThrow(/row-level security/);
  });

  test('a client cannot create a container from a suggestion', async () => {
    const s = await suggest(client, raw({ suggestedEvent: 'do_received', fields: { container_no: 'ZZZU2345670', bl_no: 'ESLCMB000102' } }), 'ZZZU2345670 DO, B/L ESLCMB000102');
    await expect(
      withActor(client, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields }, createContainer: true })),
    ).rejects.toThrow(/row-level security/);
  });

  test('an unrelated CHA cannot see or confirm onto another CHA\'s container', async () => {
    const s = await suggest(outsider, DO_RAW());
    await expect(
      withActor(outsider, (c) => confirmSuggestion(c, s, { eventType: 'do_received', occurredAt: when, fields: { ...s.fields } })),
    ).rejects.toMatchObject({ code: 'container_not_found' });
  });
});

test('ConfirmationError carries a stable code', () => {
  const e = new ConfirmationError('duplicate', 'x');
  expect(e).toMatchObject({ name: 'ConfirmationError', code: 'duplicate' });
  expect(buildSuggestion).toBeTypeOf('function');
});
