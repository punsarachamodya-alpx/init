import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withCompany } from '../src/db/withCompany.ts';
import { ConfirmationRequiredError, appendEvent, createContainer, currentStatus } from '../src/ledger/ledger.ts';
import type { EventInput } from '../src/ledger/ledger.ts';
import { seedCompany, seedDocument, seedMessage, validContainerNo } from './helpers.ts';

let companyId: string;
let messageId: string;
let documentId: string;
let containerId: string;
let owner: pg.Pool;

const base = (extra: Partial<EventInput> = {}): EventInput => ({
  containerId,
  eventType: 'do_received',
  occurredAt: new Date('2026-10-12T03:00:00Z'),
  source: { type: 'person', ref: 'synthetic-driver' },
  confirmedBy: 'synthetic-ops-user',
  evidence: { type: 'message', messageId },
  ...extra,
});

/** Run as the table owner inside a company context, always rolled back. */
async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const RAW_COLS = `company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note, confirmed_by`;
const RAW_VALS = `$1, $2, 'gate_pass', now(), 'person', 'u', 'manual', 'n', 'synthetic-ops-user'`;

beforeAll(async () => {
  companyId = await seedCompany('cha');
  messageId = await seedMessage(companyId);
  documentId = await seedDocument(companyId);
  containerId = await withCompany(companyId, async (c) => (await createContainer(c, { containerNo: validContainerNo() })).id);
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('ledger order and time cannot be forged', () => {
  test('the application role cannot supply id, seq or recorded_at', async () => {
    const run = (sql: string) => withCompany(companyId, (c) => c.query(sql, [companyId, containerId]));
    await expect(run(`INSERT INTO events (id, ${RAW_COLS}) VALUES (gen_random_uuid(), ${RAW_VALS})`)).rejects.toThrow(/permission denied/);
    await expect(run(`INSERT INTO events (seq, ${RAW_COLS}) OVERRIDING SYSTEM VALUE VALUES (1, ${RAW_VALS})`)).rejects.toThrow(/permission denied/);
    await expect(run(`INSERT INTO events (recorded_at, ${RAW_COLS}) VALUES ('2001-01-01', ${RAW_VALS})`)).rejects.toThrow(/permission denied/);
  });

  test('a normal append still works and recorded_at is server time', async () => {
    const e = await withCompany(companyId, (c) => appendEvent(c, base()));
    expect(Math.abs(e.recordedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  test('seq is unique even for the table owner', async () => {
    await withCompany(companyId, (c) => appendEvent(c, base()));
    await expect(
      asOwner(async (c) => {
        const { rows } = await c.query<{ seq: string }>('SELECT seq FROM events LIMIT 1');
        return c.query(`INSERT INTO events (seq, ${RAW_COLS}) OVERRIDING SYSTEM VALUE VALUES ($3, ${RAW_VALS})`, [companyId, containerId, rows[0]!.seq]);
      }),
    ).rejects.toThrow(/unique|duplicate/);
  });

  test('an event cannot supersede itself, and status stays defined', async () => {
    await expect(
      asOwner((c) =>
        c.query(
          `INSERT INTO events (id, corrects_event_id, ${RAW_COLS}) VALUES ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', ${RAW_VALS})`,
          [companyId, containerId],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    // A real attempt through the ledger path leaves the container with a defined status.
    const fresh = await withCompany(companyId, async (c) => (await createContainer(c, { containerNo: validContainerNo() })).id);
    await withCompany(companyId, (c) => appendEvent(c, base({ containerId: fresh })));
    expect((await withCompany(companyId, (c) => currentStatus(c, fresh)))!.eventType).toBe('do_received');
  });
});

describe('evidence is append-only', () => {
  test.each(['messages', 'documents'])('%s: app role cannot update, delete or truncate', async (table) => {
    await expect(withCompany(companyId, (c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(/permission denied/);
    await expect(withCompany(companyId, (c) => c.query(`TRUNCATE ${table}`))).rejects.toThrow(/permission denied/);
  });

  test.each([
    ['messages', "UPDATE messages SET body = 'changed'"],
    ['messages', 'DELETE FROM messages'],
    ['messages', 'TRUNCATE messages CASCADE'],
    ['documents', "UPDATE documents SET text_content = 'changed'"],
    ['documents', 'DELETE FROM documents'],
    ['documents', 'TRUNCATE documents CASCADE'],
  ])('%s: the table owner is stopped by a trigger (%s)', async (_table, sql) => {
    await expect(asOwner((c) => c.query(sql))).rejects.toThrow(/append-only/);
  });
});

describe('evidence ids and timestamps are server-generated', () => {
  test.each([
    ['messages', `INSERT INTO messages (id, company_id, channel, body) VALUES (gen_random_uuid(), $1, 'web', 'x')`],
    ['messages', `INSERT INTO messages (received_at, company_id, channel, body) VALUES ('2001-01-01', $1, 'web', 'x')`],
    ['documents', `INSERT INTO documents (id, company_id, doc_type, text_content) VALUES (gen_random_uuid(), $1, 'other', 'x')`],
    ['documents', `INSERT INTO documents (received_at, company_id, doc_type, text_content) VALUES ('2001-01-01', $1, 'other', 'x')`],
  ])('%s: app role cannot supply id or received_at (%s)', async (_t, sql) => {
    await expect(withCompany(companyId, (c) => c.query(sql, [companyId]))).rejects.toThrow(/permission denied/);
  });

  test('app role can insert only the content columns of messages and documents', async () => {
    const { rows } = await getAppPool().query<{ table_name: string; column_name: string; ok: boolean }>(
      `SELECT table_name, column_name, has_column_privilege('colombo_app', format('public.%I', table_name), column_name, 'INSERT') AS ok
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('messages', 'documents')`,
    );
    const ok = (t: string) => rows.filter((r) => r.table_name === t && r.ok).map((r) => r.column_name).sort();
    expect(ok('messages')).toEqual(['body', 'channel', 'company_id', 'language']);
    expect(ok('documents')).toEqual(['company_id', 'doc_type', 'text_content']);
  });
});

describe('a person confirms every event', () => {
  test('confirmed_by is required and cannot be blank', async () => {
    const insert = (confirmedBy: string | null) =>
      withCompany(companyId, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note, confirmed_by)
           VALUES ($1, $2, 'gate_pass', now(), 'person', 'u', 'manual', 'n', $3)`,
          [companyId, containerId, confirmedBy],
        ),
      );
    await expect(insert(null)).rejects.toThrow(/null value|not-null/);
    await expect(insert('   ')).rejects.toThrow(/check constraint/);
  });

  test('appendEvent without confirmedBy is rejected at runtime', async () => {
    const { confirmedBy: _omit, ...rest } = base();
    void _omit;
    await expect(withCompany(companyId, (c) => appendEvent(c, rest as EventInput))).rejects.toThrow(ConfirmationRequiredError);
  });

  test.each([
    ['empty', ''],
    ['spaces', '   '],
    ['zero-width space', '\u200B'],
    ['zero-width joiner and spaces', ' \u200D \uFEFF '],
  ])('appendEvent rejects a blank confirmedBy (%s)', async (_name, confirmedBy) => {
    await expect(withCompany(companyId, (c) => appendEvent(c, base({ confirmedBy })))).rejects.toThrow(ConfirmationRequiredError);
  });

  test('a system source cannot confirm itself', async () => {
    await expect(
      withCompany(companyId, (c) => appendEvent(c, base({ source: { type: 'system', ref: 'intake' }, confirmedBy: ' Intake ' }))),
    ).rejects.toThrow(ConfirmationRequiredError);
  });

  test('confirmedBy is stored trimmed', async () => {
    const e = await withCompany(companyId, (c) => appendEvent(c, base({ confirmedBy: '  synthetic-ops-user ' })));
    expect(e.confirmedBy).toBe('synthetic-ops-user');
  });

  test('a system reporter is fine when a person confirmed', async () => {
    const e = await withCompany(companyId, (c) =>
      appendEvent(c, base({ eventType: 'cusdec_lodged', source: { type: 'system', ref: 'intake' }, evidence: { type: 'document', documentId } })),
    );
    expect(e).toMatchObject({ source: { type: 'system', ref: 'intake' }, confirmedBy: 'synthetic-ops-user' });
  });
});

describe('grants and triggers are exactly as designed', () => {
  test('app role on events: select + column-limited insert only', async () => {
    const { rows } = await getAppPool().query<Record<string, boolean>>(
      `SELECT has_table_privilege('colombo_app', 'events', 'SELECT')      AS sel,
              has_table_privilege('colombo_app', 'events', 'INSERT')      AS ins_table,
              has_table_privilege('colombo_app', 'events', 'UPDATE')      AS upd,
              has_table_privilege('colombo_app', 'events', 'DELETE')      AS del,
              has_table_privilege('colombo_app', 'events', 'TRUNCATE')    AS trunc,
              has_table_privilege('colombo_app', 'events', 'TRIGGER')     AS trig,
              has_table_privilege('colombo_app', 'events', 'REFERENCES')  AS refs`,
    );
    expect(rows[0]).toEqual({ sel: true, ins_table: false, upd: false, del: false, trunc: false, trig: false, refs: false });
    const cols = await getAppPool().query<{ column_name: string; ok: boolean }>(
      `SELECT column_name, has_column_privilege('colombo_app', 'events', column_name, 'INSERT') AS ok
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events' ORDER BY ordinal_position`,
    );
    const insertable = cols.rows.filter((r) => r.ok).map((r) => r.column_name).sort();
    expect(insertable).toEqual(
      ['company_id', 'container_id', 'event_type', 'occurred_at', 'source_type', 'source_ref', 'evidence_type', 'message_id', 'document_id', 'evidence_note', 'corrects_event_id', 'payload', 'confirmed_by'].sort(),
    );
  });

  test('every append-only trigger exists and is enabled', async () => {
    const { rows } = await getAppPool().query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal
         AND tgrelid IN ('events'::regclass, 'messages'::regclass, 'documents'::regclass) ORDER BY tgname`,
    );
    expect(rows).toEqual(
      ['documents_no_truncate', 'documents_no_update_delete', 'events_no_truncate', 'events_no_update_delete', 'messages_no_truncate', 'messages_no_update_delete'].map(
        (tgname) => ({ tgname, tgenabled: 'O' }),
      ),
    );
  });
});
