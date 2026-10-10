import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { closeAppPool, getAppPool } from '../src/db/pool.ts';
import { withCompany } from '../src/db/withCompany.ts';
import { appendEvent, createContainer } from '../src/ledger/ledger.ts';
import { seedCompany, seedDocument, seedMessage } from './helpers.ts';

type Tenant = { id: string; containerId: string; messageId: string; documentId: string; eventId: string };

async function seedTenant(kind: 'cha' | 'client', containerNo: string): Promise<Tenant> {
  const id = await seedCompany(kind);
  const messageId = await seedMessage(id);
  const documentId = await seedDocument(id);
  return withCompany(id, async (c) => {
    const container = await createContainer(c, { containerNo });
    const event = await appendEvent(c, {
      containerId: container.id,
      eventType: 'do_received',
      occurredAt: new Date('2026-10-12T03:00:00Z'),
      source: { type: 'person', ref: 'synthetic-user' },
      confirmedBy: 'synthetic-ops-user',
      evidence: { type: 'message', messageId },
    });
    return { id, containerId: container.id, messageId, documentId, eventId: event.id };
  });
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  a = await seedTenant('cha', 'ZZZU1234564');
  b = await seedTenant('client', 'ZZZU2345670');
});
afterAll(closeAppPool);

const TABLES = ['companies', 'containers', 'messages', 'documents', 'events'] as const;

describe('cross-company reads are impossible', () => {
  test.each(TABLES)('%s: company A sees only its own rows', async (table) => {
    const rows = await withCompany(a.id, async (c) => (await c.query<{ company_id: string }>(`SELECT company_id FROM ${table}`)).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.company_id === a.id)).toBe(true);
  });

  test('B rows cannot be fetched by known id from A', async () => {
    await withCompany(a.id, async (c) => {
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
      withCompany(a.id, (c) => c.query("INSERT INTO containers (company_id, container_no) VALUES ($1, 'ZZZU3456787')", [b.id])),
    ).rejects.toThrow(/row-level security/);
  });

  test('insert without any company context is denied', async () => {
    await expect(
      getAppPool().query("INSERT INTO containers (company_id, container_no) VALUES ($1, 'ZZZU3456787')", [a.id]),
    ).rejects.toThrow(/row-level security/);
  });

  test('an event of A cannot reference a container, message or document of B', async () => {
    const insert = (containerId: string, messageId: string | null, documentId: string | null) =>
      withCompany(a.id, (c) =>
        c.query(
          `INSERT INTO events (company_id, container_id, event_type, occurred_at, source_type, source_ref, evidence_type, message_id, document_id, evidence_note, confirmed_by)
           VALUES ($1, $2, 'cusdec_lodged', now(), 'person', 'synthetic-user', $3, $4, $5, $6, 'synthetic-ops-user')`,
          [a.id, containerId, messageId ? 'message' : documentId ? 'document' : 'manual', messageId, documentId, messageId || documentId ? null : 'note'],
        ),
      );
    await expect(insert(b.containerId, null, null)).rejects.toThrow(/foreign key/);
    await expect(insert(a.containerId, b.messageId, null)).rejects.toThrow(/foreign key/);
    await expect(insert(a.containerId, null, b.documentId)).rejects.toThrow(/foreign key/);
  });

  test('the application role cannot update or delete any table', async () => {
    for (const table of TABLES) {
      await expect(withCompany(a.id, (c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(/permission denied/);
    }
    await expect(withCompany(a.id, (c) => c.query("UPDATE messages SET body = 'changed'"))).rejects.toThrow(/permission denied/);
    await expect(withCompany(a.id, (c) => c.query("UPDATE documents SET text_content = 'changed'"))).rejects.toThrow(/permission denied/);
  });
});

describe('the application role cannot escape row-level security', () => {
  test('cannot disable RLS or become the owner', async () => {
    await expect(withCompany(a.id, (c) => c.query('ALTER TABLE containers DISABLE ROW LEVEL SECURITY'))).rejects.toThrow(/must be owner/);
    await expect(withCompany(a.id, (c) => c.query('SET ROLE colombo_owner'))).rejects.toThrow(/permission denied/);
  });

  test('row_security = off does not bypass policies', async () => {
    await expect(
      withCompany(a.id, async (c) => {
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
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> 'schema_migrations'`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rows) expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
