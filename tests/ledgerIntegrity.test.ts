import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { signActor } from '../src/db/actorToken.ts';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { withCompany } from '../src/db/withCompany.ts';
import { appendEvent, createContainer, currentStatus } from '../src/ledger/ledger.ts';
import type { EventInput } from '../src/ledger/ledger.ts';
import { newBl, seedActor, seedDocument, seedMessage, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
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
  evidence: { type: 'message', messageId },
  ...extra,
});

/** Run as the table owner inside the actor's context, always rolled back. */
async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.actor', $1, true)", [signActor({ companyId, userId: cha.userId })]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const RAW_COLS = `company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, evidence_note`;
const RAW_VALS = `$1, $2, 'cusdec_lodged', now(), 'person', 'u', 'manual', 'n'`;

beforeAll(async () => {
  cha = await seedActor('cha');
  companyId = cha.companyId;
  messageId = await seedMessage(cha);
  documentId = await seedDocument(cha);
  containerId = await withActor(cha, async (c) => (await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() })).id);
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('ledger order and time cannot be forged', () => {
  test('the application role cannot supply id, seq or recorded_at', async () => {
    const run = (sql: string) => withActor(cha, (c) => c.query(sql, [companyId, containerId]));
    await expect(run(`INSERT INTO events (id, ${RAW_COLS}) VALUES (gen_random_uuid(), ${RAW_VALS})`)).rejects.toThrow(/permission denied/);
    await expect(run(`INSERT INTO events (seq, ${RAW_COLS}) OVERRIDING SYSTEM VALUE VALUES (1, ${RAW_VALS})`)).rejects.toThrow(/permission denied/);
    await expect(run(`INSERT INTO events (recorded_at, ${RAW_COLS}) VALUES ('2001-01-01', ${RAW_VALS})`)).rejects.toThrow(/permission denied/);
  });

  test('a normal append still works and recorded_at is server time', async () => {
    const e = await withActor(cha, (c) => appendEvent(c, base()));
    expect(Math.abs(e.recordedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  test('seq is unique even for the table owner', async () => {
    await withActor(cha, (c) => appendEvent(c, base()));
    await expect(
      asOwner(async (c) => {
        const { rows } = await c.query<{ seq: string }>('SELECT seq FROM events LIMIT 1');
        return c.query(`INSERT INTO events (seq, ${RAW_COLS}) OVERRIDING SYSTEM VALUE VALUES ($3, ${RAW_VALS})`, [companyId, containerId, rows[0]!.seq]);
      }),
    ).rejects.toThrow(/unique|duplicate/);
  });

  test('an event cannot supersede itself (the CHECK itself, with row-level security out of the way)', async () => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.actor', $1, true)", [signActor({ companyId, userId: cha.userId })]);
      await c.query('ALTER TABLE events NO FORCE ROW LEVEL SECURITY'); // DDL is transactional: rolled back below
      await expect(
        c.query(
          `INSERT INTO events (id, corrects_event_id, ${RAW_COLS}) VALUES ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', ${RAW_VALS})`,
          [companyId, containerId],
        ),
      ).rejects.toThrow(/events_no_self_correction/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  test('...and through the ledger path the container keeps a defined status', async () => {
    const fresh = await withActor(cha, async (c) => (await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() })).id);
    await withActor(cha, (c) => appendEvent(c, base({ containerId: fresh })));
    expect((await withActor(cha, (c) => currentStatus(c, fresh)))!.eventType).toBe('do_received');
  });
});

describe('evidence is append-only', () => {
  test.each(['messages', 'documents'])('%s: app role cannot update, delete or truncate', async (table) => {
    await expect(withActor(cha, (c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(/permission denied/);
    await expect(withActor(cha, (c) => c.query(`TRUNCATE ${table}`))).rejects.toThrow(/permission denied/);
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
    await expect(withActor(cha, (c) => c.query(sql, [companyId]))).rejects.toThrow(/permission denied/);
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

describe('the confirming person is the acting user', () => {
  test('every event stores the acting user as confirmer', async () => {
    const e = await withActor(cha, (c) => appendEvent(c, base()));
    expect(e.confirmedByUserId).toBe(cha.userId);
  });

  test('the app role cannot supply the confirming user', async () => {
    const other = await seedActor('cha');
    await expect(
      withActor(cha, (c) =>
        c.query(`INSERT INTO events (confirmed_by_user_id, ${RAW_COLS}) VALUES ($3, ${RAW_VALS})`, [companyId, containerId, other.userId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test('there is no free-text confirmer column any more', async () => {
    const { rowCount } = await getAppPool().query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'confirmed_by'",
    );
    expect(rowCount).toBe(0);
  });

  test('without a user (company-only context) nothing can be recorded', async () => {
    await expect(
      withCompany(companyId, (c) => c.query(`INSERT INTO events (${RAW_COLS}) VALUES (${RAW_VALS})`, [companyId, containerId])),
    ).rejects.toThrow(/row-level security|null value/);
  });

  test('a user of another company cannot record events in this company', async () => {
    const intruder = await seedActor('cha');
    await expect(
      withActor({ companyId, userId: intruder.userId }, (c) => appendEvent(c, base())),
    ).rejects.toThrow(/row-level security/);
  });

  test('a system source is fine: the confirmer is still the acting person', async () => {
    const e = await withActor(cha, (c) =>
      appendEvent(c, base({ eventType: 'cusdec_lodged', source: { type: 'system', ref: 'intake' }, evidence: { type: 'document', documentId } })),
    );
    expect(e).toMatchObject({ source: { type: 'system', ref: 'intake' }, confirmedByUserId: cha.userId });
  });
});

describe('role gates', () => {
  test.each(['client', 'haulier'] as const)('a %s user cannot create containers or events', async (kind) => {
    const actor = await seedActor(kind);
    await expect(withActor(actor, (c) => createContainer(c, { blNo: newBl(), containerNo: validContainerNo() }))).rejects.toThrow(/row-level security/);
    // A haulier may not record do_received at all (policy). A client may, but the CHA's container is not
    // visible to it, so the ledger helper falls back to the client's own company and the foreign key refuses.
    await expect(withActor(actor, (c) => appendEvent(c, base()))).rejects.toThrow(kind === 'haulier' ? /row-level security/ : /foreign key/);
  });

  test.each(['client', 'haulier'] as const)('a %s user can store its own messages and documents', async (kind) => {
    const actor = await seedActor(kind);
    await expect(seedMessage(actor)).resolves.toBeTruthy();
    await expect(seedDocument(actor)).resolves.toBeTruthy();
  });
});

describe('users', () => {
  test('a role must match its company kind', async () => {
    const bad = (kind: string, role: string) =>
      withCompany(companyId, (c) =>
        c.query('INSERT INTO users (company_id, company_kind, role, display_name) VALUES ($1, $2, $3, $4)', [companyId, kind, role, 'Synthetic']),
      );
    await expect(bad('cha', 'haulier_dispatcher')).rejects.toThrow(/check constraint|foreign key/);
    await expect(bad('haulier', 'haulier_dispatcher')).rejects.toThrow(/foreign key/); // company is a CHA
    await expect(bad('cha', 'driver')).rejects.toThrow(/check constraint/);
  });

  test('users cannot be changed or removed by the app role', async () => {
    await expect(withActor(cha, (c) => c.query("UPDATE users SET role = 'client'"))).rejects.toThrow(/permission denied/);
    await expect(withActor(cha, (c) => c.query('DELETE FROM users'))).rejects.toThrow(/permission denied/);
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
      ['company_id', 'container_id', 'event_type', 'occurred_at', 'source_type', 'source_ref', 'evidence_type', 'message_id', 'document_id', 'evidence_note', 'corrects_event_id', 'correction_kind', 'payload'].sort(),
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
