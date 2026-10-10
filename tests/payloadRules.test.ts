import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { isValidPayload } from '../src/domain/statusChain.ts';
import { appendEvent, createContainer } from '../src/ledger/ledger.ts';
import { newBl, seedActor, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

const Z = '2026-10-14T04:30:00Z';
const VALID: Array<[string, Record<string, unknown>]> = [
  ['empty', {}],
  ['yard RCT', { yard: 'RCT' }],
  ['yard Grayline 1', { yard: 'Grayline 1' }],
  ['yard Grayline 2', { yard: 'Grayline 2' }],
  ['result green', { result: 'green' }],
  ['result yellow', { result: 'yellow' }],
  ['result red', { result: 'red' }],
  ['result blue', { result: 'blue' }],
  ['scheduled_at in UTC', { scheduled_at: Z }],
  ['scheduled_at with millis', { scheduled_at: '2026-10-14T04:30:00.123Z' }],
  ['pickup_window in UTC', { pickup_window: `${Z}/2026-10-14T08:30:00Z` }],
  ['reference (BL)', { reference: 'ESLCMB000101' }],
  ['reference with separators', { reference: 'A/B-1.2_x' }],
  ['note', { note: 'truck delayed at gate' }],
  ['note at the limit', { note: 'x'.repeat(140) }],
  ['reference at the limit', { reference: 'R'.repeat(64) }],
  ['several keys', { yard: 'RCT', result: 'red', scheduled_at: Z, reference: 'ESLCMB000103', note: 'ok' }],
];
const INVALID: Array<[string, unknown]> = [
  ['unknown key', { freight: 'x' }],
  ['unknown key demurrage', { demurrage_estimate: 'x' }],
  ['yard outside the list', { yard: 'Colombo yard' }],
  ['yard wrong case', { yard: 'grayline 1' }],
  ['result outside the list', { result: 'purple' }],
  ['scheduled_at with +05:30 (UTC only)', { scheduled_at: '2026-10-14T10:00:00+05:30' }],
  ['scheduled_at without zone', { scheduled_at: '2026-10-14T04:30:00' }],
  ['scheduled_at date only', { scheduled_at: '2026-10-14' }],
  ['scheduled_at words', { scheduled_at: 'tomorrow' }],
  ['pickup_window one-sided', { pickup_window: Z }],
  ['pickup_window with offsets', { pickup_window: '2026-10-14T10:00:00+05:30/2026-10-14T12:00:00+05:30' }],
  ['reference with a space (prices read like this)', { reference: 'USD 1200' }],
  ['reference with currency symbol', { reference: '$1200' }],
  ['reference empty', { reference: '' }],
  ['reference too long', { reference: 'R'.repeat(65) }],
  ['note too long', { note: 'x'.repeat(141) }],
  ['number value', { note: 1200 }],
  ['boolean value', { result: true }],
  ['null value', { yard: null }],
  ['nested object', { note: { a: 1 } }],
  ['nested array', { note: ['a'] }],
  ['array payload', []],
  ['string payload', 'x'],
  ['number payload', 1],
];

describe('payload rules: database and code agree, and every value is constrained', () => {
  test.each(VALID)('valid: %s', async (_n, payload) => {
    const { rows } = await getAppPool().query<{ ok: boolean }>('SELECT payload_ok($1::jsonb) AS ok', [JSON.stringify(payload)]);
    expect(rows[0]!.ok).toBe(true);
    expect(isValidPayload(payload)).toBe(true);
  });

  test.each(INVALID)('invalid: %s', async (_n, payload) => {
    const { rows } = await getAppPool().query<{ ok: boolean }>('SELECT payload_ok($1::jsonb) AS ok', [JSON.stringify(payload)]);
    expect(rows[0]!.ok).toBe(false);
    expect(isValidPayload(payload)).toBe(false);
  });
});

describe('the rules are enforced on the ledger', () => {
  let cha: TestActor;
  let containerId: string;
  beforeAll(async () => {
    cha = await seedActor('cha');
    containerId = await withActor(cha, async (c) => (await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() })).id);
  });
  afterAll(closeAppPool);

  const record = (payload: Record<string, unknown>) =>
    withActor(cha, (c) =>
      appendEvent(c, {
        containerId,
        eventType: 'exam',
        occurredAt: new Date('2026-10-14T03:00:00Z'),
        source: { type: 'person', ref: 'synthetic' },
        evidence: { type: 'manual', note: 'synthetic' },
        payload: payload as never,
      }),
    );

  test('a valid payload is stored as given', async () => {
    const e = await record({ yard: 'Grayline 2', scheduled_at: Z });
    expect(e.payload).toEqual({ yard: 'Grayline 2', scheduled_at: Z });
  });

  test.each([
    ['price-like reference', { reference: 'USD 1200' }],
    ['local-time schedule', { scheduled_at: '2026-10-14T10:00:00+05:30' }],
    ['unknown yard', { yard: 'Somewhere' }],
    ['long note', { note: 'x'.repeat(141) }],
  ])('%s is refused by the database', async (_n, payload) => {
    await expect(record(payload)).rejects.toThrow(/check constraint/);
  });

  test('free-text columns hauliers can read have length limits', async () => {
    const raw = (evidenceNote: string, sourceRef: string) =>
      withActor(cha, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note)
           VALUES ($1, $2, 'exam', now(), 'person', $4, 'manual', $3)`,
          [cha.companyId, containerId, evidenceNote, sourceRef],
        ),
      );
    await expect(raw('n'.repeat(200), 'r'.repeat(100))).resolves.toBeTruthy();
    await expect(raw('n'.repeat(201), 'ok')).rejects.toThrow(/check constraint/);
    await expect(raw('ok', 'r'.repeat(101))).rejects.toThrow(/check constraint/);
  });
});
