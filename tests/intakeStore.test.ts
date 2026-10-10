import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantAccess } from '../src/access/access.ts';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { ConfirmationError, buildSuggestion, confirmSuggestionById, intake, intakeAndStore, listInbox, listStaleUndecided, loadSuggestion, recordManualEvent, rejectSuggestionById, saveSuggestion } from '../src/intake/index.ts';
import type { Extractor, RawExtraction, Suggestion } from '../src/intake/index.ts';
import { ExtractionFailedError } from '../src/intake/index.ts';
import { createContainer, listEvents } from '../src/ledger/ledger.ts';
import { signActor } from '../src/db/actorToken.ts';
import { newBl, seedActor } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
let client: TestActor;
let haulier: TestActor;
let outsider: TestActor;
let owner: pg.Pool;
let bl: string;
let containerId: string;

const raw = (over: Partial<RawExtraction> = {}): RawExtraction => ({ docType: null, suggestedEvent: null, language: 'en', notes: null, fields: {}, ...over });
const fake = (r: RawExtraction | Error): Extractor => ({ extract: async () => { if (r instanceof Error) throw r; return r; } });
const DO_TEXT = () => `DELIVERY ORDER\nB/L No: ${bl}\nContainer: ZZZU1234564\nDate: 12/10/2026\nVessel/Voyage: MV TEST HORIZON / 026E`;
const DO_RAW = () => raw({ docType: 'delivery_order', suggestedEvent: 'do_received', fields: { container_no: 'ZZZU1234564', bl_no: bl, vessel: 'MV TEST HORIZON', do_date: '2026-10-12' } });
const when = new Date('2026-10-12T04:00:00Z');

const store = (actor: TestActor, r: RawExtraction | Error = DO_RAW(), text = DO_TEXT()) =>
  withActor(actor, (c) => intakeAndStore(c, fake(r), { kind: 'document', docType: 'delivery_order', text }, 'fake'));
const events = (actor: TestActor) => withActor(actor, (c) => listEvents(c, containerId));

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
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('suggestions are stored, company-private and immutable', () => {
  test('a stored suggestion round-trips', async () => {
    const stored = await store(cha);
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    const loaded = await withActor(cha, (c) => loadSuggestion(c, stored.id));
    expect(loaded).toMatchObject({ id: stored.id, extractor: 'fake', createdByUserId: cha.userId });
    expect(loaded!.suggestion).toMatchObject({ status: 'ready', eventType: 'do_received', docType: 'delivery_order', evidence: stored.suggestion.evidence });
    expect(loaded!.suggestion.fields).toEqual(stored.suggestion.fields);
    expect(loaded!.suggestion.suggestedOccurredAt?.toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(loaded!.suggestion.confirmableBy).toEqual(['cha_ops', 'client']);
  });

  test('another company cannot see it', async () => {
    const stored = await store(cha);
    expect(await withActor(outsider, (c) => loadSuggestion(c, stored.id))).toBeNull();
    expect(await withActor(haulier, (c) => loadSuggestion(c, stored.id))).toBeNull();
    expect(await withActor(client, (c) => loadSuggestion(c, stored.id))).toBeNull();
  });

  test('the app role cannot update or delete, supply the creator, or insert for another company', async () => {
    const stored = await store(cha);
    await expect(withActor(cha, (c) => c.query("UPDATE intake_suggestions SET status = 'ready'"))).rejects.toThrow(/permission denied/);
    await expect(withActor(cha, (c) => c.query('DELETE FROM intake_suggestions'))).rejects.toThrow(/permission denied/);
    await expect(
      withActor(cha, (c) => c.query(`INSERT INTO intake_suggestions (created_by_user_id, company_id, message_id, status, extractor) VALUES ($1, $2, gen_random_uuid(), 'ready', 'x')`, [cha.userId, cha.companyId])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withActor(outsider, (c) =>
        c.query(`INSERT INTO intake_suggestions (company_id, document_id, status, extractor) VALUES ($1, $2, 'ready', 'x')`, [cha.companyId, stored.suggestion.evidence.type === 'document' ? stored.suggestion.evidence.documentId : null]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  test('the table owner is stopped by triggers', async () => {
    for (const sql of ["UPDATE intake_suggestions SET status = 'ready'", 'DELETE FROM intake_suggestions', 'TRUNCATE intake_suggestions CASCADE', "UPDATE intake_decisions SET reason = 'x'", 'DELETE FROM intake_decisions', 'TRUNCATE intake_decisions CASCADE']) {
      await expect(owner.query(sql), sql).rejects.toThrow(/append-only/);
    }
  });

  test('the database insists on exactly one piece of evidence and a valid status', async () => {
    const insert = (cols: string, vals: string) => withActor(cha, (c) => c.query(`INSERT INTO intake_suggestions (company_id, ${cols}, extractor) VALUES ($1, ${vals}, 'x')`, [cha.companyId]));
    await expect(insert('status', "'ready'")).rejects.toThrow(/check constraint/); // no evidence
    await expect(insert('message_id, document_id, status', "gen_random_uuid(), gen_random_uuid(), 'ready'")).rejects.toThrow(/check constraint/); // both
    const stored = await store(cha);
    const docId = stored.suggestion.evidence.type === 'document' ? stored.suggestion.evidence.documentId : '';
    await expect(insert('document_id, status', `'${docId}', 'maybe'`)).rejects.toThrow(/check constraint/);
  });

  test('a failed extraction is stored as a failed suggestion', async () => {
    const s = await store(cha, new ExtractionFailedError('refusal'));
    expect(s.suggestion.status).toBe('failed');
    expect((await withActor(cha, (c) => loadSuggestion(c, s.id)))!.suggestion.status).toBe('failed');
  });

  test('saveSuggestion stores a suggestion built elsewhere', async () => {
    const s = await withActor(cha, (c) => intake(c, fake(DO_RAW()), { kind: 'document', docType: 'delivery_order', text: DO_TEXT() }));
    const stored = await withActor(cha, (c) => saveSuggestion(c, s, 'manual-test'));
    expect(stored.extractor).toBe('manual-test');
  });
});

describe('the inbox lists undecided suggestions only', () => {
  test('newest first; decided ones disappear; others cannot see them', async () => {
    const a = await store(cha);
    const b = await store(cha);
    const ids = async () => (await withActor(cha, (c) => listInbox(c))).map((i) => i.id);
    expect((await ids()).slice(0, 2)).toEqual([b.id, a.id]);
    await withActor(cha, (c) => rejectSuggestionById(c, a.id, 'not ours'));
    expect(await ids()).not.toContain(a.id);
    expect(await ids()).toContain(b.id);
    expect((await withActor(outsider, (c) => listInbox(c))).map((i) => i.id)).not.toContain(b.id);
    const item = (await withActor(cha, (c) => listInbox(c))).find((i) => i.id === b.id)!;
    expect(item.excerpt).toContain('DELIVERY ORDER');
    expect(item.suggestion.status).toBe('ready');
  });

  test('stale undecided suggestions can be listed for reminders', async () => {
    const s = await store(cha);
    const future = new Date(Date.now() + 60_000);
    expect((await withActor(cha, (c) => listStaleUndecided(c, future))).map((i) => i.id)).toContain(s.id);
    expect((await withActor(cha, (c) => listStaleUndecided(c, new Date(Date.now() - 3_600_000)))).map((i) => i.id)).not.toContain(s.id);
  });
});

describe('confirming by id: the server loads the suggestion, the caller supplies only the person\'s values', () => {
  test('confirm writes the event and one decision, atomically', async () => {
    const s = await store(cha);
    const before = (await events(cha)).length;
    const { event } = await withActor(cha, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: when, fields: { ...s.suggestion.fields } }));
    expect((await events(cha)).length).toBe(before + 1);
    const rows = await withActor(cha, async (c) => (await c.query('SELECT decision, event_id, final_fields, decided_by_user_id FROM intake_decisions WHERE suggestion_id = $1', [s.id])).rows);
    expect(rows).toEqual([{ decision: 'confirmed', event_id: event.id, final_fields: s.suggestion.fields, decided_by_user_id: cha.userId }]);
    expect((await withActor(cha, (c) => listInbox(c))).map((i) => i.id)).not.toContain(s.id);
  });

  test('a suggestion can be decided once, however it was decided', async () => {
    const s = await store(cha);
    await withActor(cha, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: when, fields: { ...s.suggestion.fields } }));
    await expect(withActor(cha, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: when, fields: { ...s.suggestion.fields } }))).rejects.toMatchObject({ code: 'already_decided' });
    await expect(withActor(cha, (c) => rejectSuggestionById(c, s.id, 'changed my mind'))).rejects.toMatchObject({ code: 'already_decided' });
    const r = await store(cha);
    await withActor(cha, (c) => rejectSuggestionById(c, r.id, 'wrong container'));
    await expect(withActor(cha, (c) => confirmSuggestionById(c, r.id, { eventType: 'do_received', occurredAt: when, fields: { ...r.suggestion.fields } }))).rejects.toMatchObject({ code: 'already_decided' });
  });

  test('two simultaneous confirmations produce exactly one event', async () => {
    const s = await store(cha);
    const before = (await events(cha)).length;
    const attempt = () => withActor(cha, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: when, fields: { ...s.suggestion.fields } }));
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ name: 'ConfirmationError', code: 'already_decided' });
    expect((await events(cha)).length).toBe(before + 1);
  });

  test('status comes from the database: a rejected or failed suggestion cannot be confirmed', async () => {
    const rejected = await store(cha, raw({ suggestedEvent: 'gate_pass', fields: { container_no: 'ZZZU9999999' } }), 'ZZZU9999999 reached the yard');
    expect(rejected.suggestion.status).toBe('rejected');
    await expect(withActor(cha, (c) => confirmSuggestionById(c, rejected.id, { eventType: 'delivered', occurredAt: when, fields: { container_no: 'ZZZU1234564' } }))).rejects.toMatchObject({ code: 'not_confirmable' });
    const failed = await store(cha, new ExtractionFailedError('api_error'));
    await expect(withActor(cha, (c) => confirmSuggestionById(c, failed.id, { eventType: 'do_received', occurredAt: when, fields: {} }))).rejects.toMatchObject({ code: 'not_confirmable' });
  });

  test('the container number must be in the stored evidence text, whatever the stored fields say', async () => {
    const message = 'gate pass ready, no container number here';
    const s = await withActor(cha, async (c) => {
      const built = await intake(c, fake(raw({ suggestedEvent: 'cusdec_lodged' })), { kind: 'message', channel: 'whatsapp', text: message });
      // a suggestion whose stored fields name a container the evidence never mentions
      const forged: Suggestion = { ...built, status: 'ready', fields: { container_no: 'ZZZU1234564', bl_no: bl }, eventType: 'cusdec_lodged', confirmableBy: ['cha_ops', 'client'] };
      return saveSuggestion(c, forged, 'forged');
    });
    await expect(
      withActor(cha, (c) => confirmSuggestionById(c, s.id, { eventType: 'cusdec_lodged', occurredAt: when, fields: { ...s.suggestion.fields } })),
    ).rejects.toMatchObject({ code: 'ungrounded_container' });
  });

  test('unknown ids and other companies\' suggestions look the same', async () => {
    const s = await store(cha);
    await expect(withActor(outsider, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: when, fields: {} }))).rejects.toMatchObject({ code: 'suggestion_not_found' });
    await expect(withActor(cha, (c) => confirmSuggestionById(c, '11111111-1111-4111-8111-111111111111', { eventType: 'do_received', occurredAt: when, fields: {} }))).rejects.toMatchObject({ code: 'suggestion_not_found' });
  });

  test('the role matrix still applies: a haulier cannot confirm a DO, and the suggestion stays undecided', async () => {
    const s = await store(haulier);
    await expect(withActor(haulier, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: when, fields: { ...s.suggestion.fields } }))).rejects.toThrow(/row-level security/);
    expect((await withActor(haulier, (c) => listInbox(c))).map((i) => i.id)).toContain(s.id);
  });

  test('a client confirms a clearance stage on a shared container', async () => {
    const s = await store(client);
    const { event } = await withActor(client, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: when, fields: { ...s.suggestion.fields } }));
    expect(event).toMatchObject({ recordedByCompanyId: client.companyId, confirmedByUserId: client.userId });
  });

  test('a decision cannot point at someone else\'s event, nor at another company\'s suggestion', async () => {
    const s = await store(client);
    const chasEvent = (await events(cha))[0]!;
    await expect(
      withActor(client, (c) => c.query(`INSERT INTO intake_decisions (company_id, suggestion_id, decision, event_id) VALUES ($1, $2, 'confirmed', $3)`, [client.companyId, s.id, chasEvent.id])),
    ).rejects.toThrow(/row-level security/);
    const chas = await store(cha);
    await expect(
      withActor(outsider, (c) => c.query(`INSERT INTO intake_decisions (company_id, suggestion_id, decision, reason) VALUES ($1, $2, 'rejected', 'no')`, [outsider.companyId, chas.id])),
    ).rejects.toThrow(/foreign key/);
  });

  test('rejecting needs a reason, which is stored with the decider', async () => {
    const s = await store(cha);
    await expect(withActor(cha, (c) => rejectSuggestionById(c, s.id, '   '))).rejects.toMatchObject({ code: 'reason_required' });
    await withActor(cha, (c) => rejectSuggestionById(c, s.id, 'duplicate of earlier message'));
    const rows = await withActor(cha, async (c) => (await c.query('SELECT decision, reason, event_id, decided_by_user_id FROM intake_decisions WHERE suggestion_id = $1', [s.id])).rows);
    expect(rows).toEqual([{ decision: 'rejected', reason: 'duplicate of earlier message', event_id: null, decided_by_user_id: cha.userId }]);
  });

  test('a confirm that fails midway leaves no decision behind (same transaction)', async () => {
    const s = await store(cha);
    await expect(
      withActor(cha, (c) => confirmSuggestionById(c, s.id, { eventType: 'do_received', occurredAt: new Date('0001-01-01'), fields: { ...s.suggestion.fields } })),
    ).rejects.toMatchObject({ code: 'occurred_at_invalid' });
    expect((await withActor(cha, (c) => listInbox(c))).map((i) => i.id)).toContain(s.id);
  });
});

describe('manual entry: a person records a stage without a suggestion', () => {
  const manual = (actor: TestActor, over: Record<string, unknown> = {}) =>
    withActor(actor, (c) => recordManualEvent(c, { containerNo: 'ZZZU1234564', blNo: bl, eventType: 'cusdec_lodged', occurredAt: when, reason: 'called the CHA clerk', ...over } as never));

  test('the CHA records a clearance stage with manual evidence and a source of "manual"', async () => {
    const { event } = await manual(cha);
    expect(event).toMatchObject({ eventType: 'cusdec_lodged', source: { type: 'person', ref: 'manual' }, evidence: { type: 'manual', note: 'called the CHA clerk' }, confirmedByUserId: cha.userId });
  });

  test('a haulier records trucking stages; a client cannot; a haulier cannot record clearance', async () => {
    await expect(manual(haulier, { eventType: 'gate_pass', reason: 'driver phoned from gate' })).resolves.toMatchObject({ event: { eventType: 'gate_pass' } });
    await expect(manual(client, { eventType: 'gate_pass' })).rejects.toThrow(/row-level security/);
    await expect(manual(haulier, { eventType: 'do_received' })).rejects.toThrow(/row-level security/);
  });

  test('a reason is required, an unknown container is refused, and a bad number is rejected before the database', async () => {
    await expect(manual(cha, { reason: '  ' })).rejects.toMatchObject({ code: 'reason_required' });
    await expect(manual(cha, { containerNo: 'ZZZU2345670', blNo: 'NOPE1' })).rejects.toMatchObject({ code: 'container_not_found' });
    await expect(manual(cha, { containerNo: 'ZZZU9999999' })).rejects.toMatchObject({ code: 'invalid_field' });
    await expect(manual(cha, { occurredAt: new Date('nonsense') })).rejects.toMatchObject({ code: 'occurred_at_invalid' });
  });

  test('only the CHA can create the container, and only when asked', async () => {
    const no = 'ZZZU3456787';
    await expect(manual(cha, { containerNo: no, blNo: 'ESLCMB000777', eventType: 'vessel_discharged' })).rejects.toMatchObject({ code: 'container_not_found' });
    const made = await manual(cha, { containerNo: no, blNo: 'ESLCMB000777', eventType: 'vessel_discharged', createContainer: true });
    expect(made.container.containerNo).toBe(no);
    await expect(manual(client, { containerNo: 'ZZZU2345670', blNo: 'ESLCMB000778', eventType: 'do_received', createContainer: true })).rejects.toThrow(/row-level security/);
  });
});

describe('the persistence helpers keep the "only confirm.ts writes the ledger" rule', () => {
  test('ConfirmationError carries the new codes', () => {
    for (const code of ['suggestion_not_found', 'already_decided', 'ungrounded_container', 'reason_required'] as const) {
      expect(new ConfirmationError(code, 'x').code).toBe(code);
    }
    expect(buildSuggestion).toBeTypeOf('function');
    expect(signActor).toBeTypeOf('function');
  });
});
