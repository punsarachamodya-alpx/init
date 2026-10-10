import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { withCompany } from '../src/db/withCompany.ts';
import { appendEvent, createContainer } from '../src/ledger/ledger.ts';
import { newBl, seedActor, seedDocument, seedMessage, seedUser } from './helpers.ts';
import type { TestActor } from './helpers.ts';

type Tenant = { id: string; actor: TestActor; containerId: string; messageId: string; documentId: string; eventId: string };

async function seedTenant(containerNo: string): Promise<Tenant> {
  const actor = await seedActor('cha');
  const messageId = await seedMessage(actor);
  const documentId = await seedDocument(actor);
  return withActor(actor, async (c) => {
    const container = await createContainer(c, { blNo: newBl(), containerNo });
    const event = await appendEvent(c, {
      containerId: container.id,
      eventType: 'do_received',
      occurredAt: new Date('2026-10-12T03:00:00Z'),
      source: { type: 'person', ref: 'synthetic-user' },
      evidence: { type: 'message', messageId },
    });
    return { id: actor.companyId, actor, containerId: container.id, messageId, documentId, eventId: event.id };
  });
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  a = await seedTenant('ZZZU1234564');
  b = await seedTenant('ZZZU2345670');
});
afterAll(closeAppPool);

const TABLES = ['companies', 'users', 'containers', 'messages', 'documents', 'events'] as const;

describe('cross-company reads are impossible', () => {
  test.each(TABLES)('%s: company A sees only its own rows', async (table) => {
    const rows = await withActor(a.actor, async (c) => (await c.query<{ company_id: string }>(`SELECT company_id FROM ${table}`)).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.company_id === a.id)).toBe(true);
  });

  test('B rows cannot be fetched by known id from A', async () => {
    await withActor(a.actor, async (c) => {
      expect((await c.query('SELECT 1 FROM containers WHERE id = $1', [b.containerId])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM messages WHERE id = $1', [b.messageId])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM documents WHERE id = $1', [b.documentId])).rowCount).toBe(0);
      expect((await c.query('SELECT 1 FROM events WHERE id = $1', [b.eventId])).rowCount).toBe(0);
    });
  });

  test.each(TABLES)('%s: no company context returns zero rows', async (table) => {
    const res = await getAppPool().query(`SELECT * FROM ${table}`);
    expect(res.rowCount).toBe(0);
  });

  test.each(['containers', 'messages', 'documents', 'events'] as const)(
    '%s: a company context without a user sees nothing (bootstrap context)',
    async (table) => {
      const n = await withCompany(a.id, async (c) => (await c.query(`SELECT 1 FROM ${table}`)).rowCount);
      expect(n).toBe(0);
    },
  );

  test('a user of another company cannot act inside this company', async () => {
    const intruder = await seedUser(b.id, 'cha');
    const n = await withActor({ companyId: a.id, userId: intruder }, async (c) => (await c.query('SELECT 1 FROM containers')).rowCount);
    expect(n).toBe(0);
    await expect(
      withActor({ companyId: a.id, userId: intruder }, (c) => createContainer(c, { blNo: newBl(), containerNo: 'ZZZU3456787' })),
    ).rejects.toThrow(/row-level security/);
  });

  test('an unknown company sees nothing', async () => {
    const stranger = '00000000-0000-4000-8000-000000000000';
    const n = await withCompany(stranger, async (c) => (await c.query('SELECT 1 FROM containers')).rowCount);
    expect(n).toBe(0);
  });

  test('withCompany rejects a non-UUID company id', async () => {
    await expect(withCompany("x'; select 1 --", async () => 1)).rejects.toThrow(/UUID/);
  });
});

describe('cross-company writes and references are impossible', () => {
  test('inserting a row for another company is denied by row-level security', async () => {
    await expect(
      withActor(a.actor, (c) => c.query("INSERT INTO containers (company_id, container_no, bl_no) VALUES ($1, 'ZZZU3456787', 'SYNTHBL999999')", [b.id])),
    ).rejects.toThrow(/row-level security/);
  });

  test('insert without any company context is denied', async () => {
    await expect(
      getAppPool().query("INSERT INTO containers (company_id, container_no, bl_no) VALUES ($1, 'ZZZU3456787', 'SYNTHBL999999')", [a.id]),
    ).rejects.toThrow(/row-level security/);
  });

  test('an event of A cannot reference a container, message or document of B', async () => {
    const insert = (containerId: string, messageId: string | null, documentId: string | null) =>
      withActor(a.actor, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, message_id, document_id, evidence_note)
           VALUES ($1, $2, 'cusdec_lodged', now(), 'person', 'synthetic-user', $3, $4, $5, $6)`,
          [a.id, containerId, messageId ? 'message' : documentId ? 'document' : 'manual', messageId, documentId, messageId || documentId ? null : 'note'],
        ),
      );
    await expect(insert(b.containerId, null, null)).rejects.toThrow(/foreign key/);
    await expect(insert(a.containerId, b.messageId, null)).rejects.toThrow(/foreign key/);
    await expect(insert(a.containerId, null, b.documentId)).rejects.toThrow(/foreign key/);
  });

  test('the application role cannot update or delete any table', async () => {
    for (const table of TABLES) {
      await expect(withActor(a.actor, (c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(withActor(a.actor, (c) => c.query("UPDATE messages SET body = 'changed'"))).rejects.toThrow(/permission denied/);
    await expect(withActor(a.actor, (c) => c.query("UPDATE documents SET text_content = 'changed'"))).rejects.toThrow(/permission denied/);
  });
});

describe('the application role cannot escape row-level security', () => {
  test('cannot disable RLS or become the owner', async () => {
    await expect(withActor(a.actor, (c) => c.query('ALTER TABLE containers DISABLE ROW LEVEL SECURITY'))).rejects.toThrow(/must be owner/);
    await expect(withActor(a.actor, (c) => c.query('SET ROLE colombo_owner'))).rejects.toThrow(/permission denied/);
  });

  test('row_security = off does not bypass policies', async () => {
    await expect(
      withActor(a.actor, async (c) => {
        await c.query('SET LOCAL row_security = off');
        return c.query('SELECT * FROM containers');
      }),
    ).rejects.toThrow(/row-level security/);
  });

  test('the application role is not a superuser and does not bypass RLS', async () => {
    const { rows } = await getAppPool().query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  test('every public table has forced row-level security', async () => {
    const { rows } = await getAppPool().query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname NOT IN ('schema_migrations', 'actor_key')`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...TABLES, 'container_access', 'intake_suggestions', 'intake_decisions', 'user_contacts', 'notifications', 'notification_attempts'].sort(),
    );
    for (const r of rows) expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
