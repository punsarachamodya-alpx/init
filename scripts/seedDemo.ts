// Synthetic demo data for the board: three companies (CHA, client, haulier) with one user each, contact details
// (invented numbers on the reserved .invalid domain), three containers from /fixtures/synthetic and a short event
// history. Nothing here is real. Used by `pnpm seed:demo` and by the browser tests.
import { randomUUID } from 'node:crypto';
import { grantAccess } from '../src/access/access.ts';
import { withActor } from '../src/db/withActor.ts';
import { withCompany } from '../src/db/withCompany.ts';
import type { DemoUser } from '../src/web/demoUsers.ts';
import { appendEvent, createContainer } from '../src/ledger/ledger.ts';
import type { EventType } from '../src/domain/statusChain.ts';

type Kind = 'cha' | 'client' | 'haulier';
const ROLE = { cha: 'cha_ops', client: 'client', haulier: 'haulier_dispatcher' } as const;

async function company(kind: Kind, name: string, userName: string, label: string, contact: { whatsapp?: string; email?: string; sms?: string; language: 'en' | 'si' | 'ta' }): Promise<DemoUser> {
  const companyId = randomUUID();
  const userId = await withCompany(companyId, async (c) => {
    await c.query('INSERT INTO companies (company_id, name, kind) VALUES ($1, $2, $3)', [companyId, name, kind]);
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO users (company_id, company_kind, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [companyId, kind, ROLE[kind], userName],
    );
    return rows[0]!.id;
  });
  await withActor({ companyId, userId }, (c) =>
    c.query('INSERT INTO user_contacts (company_id, user_id, whatsapp, email, sms, language) VALUES ($1, $2, $3, $4, $5, $6)', [
      companyId, userId, contact.whatsapp ?? null, contact.email ?? null, contact.sms ?? null, contact.language,
    ]),
  );
  return { label, role: ROLE[kind], companyName: name, companyId, userId };
}

export interface SeededDemo {
  users: DemoUser[];
  /** The container with no events yet: the browser tests walk the whole chain on it. */
  freshContainerNo: string;
}

export async function seedDemo(now: Date = new Date()): Promise<SeededDemo> {
  const cha = await company('cha', 'Demo Clearing Agents (Pvt) Ltd', 'Nimali (CHA operations)', 'CHA ops', { whatsapp: '+94770000001', email: 'ops@cha.example.invalid', language: 'en' });
  const client = await company('client', 'Sample Imports (Pvt) Ltd', 'Kamal (client)', 'Client', { whatsapp: '+94771110001', sms: '+94771110001', language: 'si' });
  const haulier = await company('haulier', 'Demo Haulage (Pvt) Ltd', 'Sunil (dispatcher)', 'Haulier', { whatsapp: '+94772220002', sms: '+94772220002', language: 'ta' });

  const ago = (days: number, hours = 0) => new Date(now.getTime() - (days * 24 + hours) * 3_600_000);
  const manual = (note: string) => ({ type: 'manual', note }) as const;
  const src = { type: 'person', ref: 'seed' } as const;

  await withActor({ companyId: cha.companyId, userId: cha.userId }, async (c) => {
    const fresh = await createContainer(c, { containerNo: 'ZZZU1234564', blNo: 'ESLCMB000101' });
    const advised = await createContainer(c, { containerNo: 'ZZZU2345670', blNo: 'ESLCMB000102' });
    const exam = await createContainer(c, { containerNo: 'ZZZU3456787', blNo: 'ESLCMB000103' });

    const record = (containerId: string, eventType: EventType, at: Date, note: string, payload = {}) =>
      appendEvent(c, { containerId, eventType, occurredAt: at, source: src, evidence: manual(note), payload });
    await record(advised.id, 'vessel_discharged', ago(4), 'synthetic seed');
    await record(advised.id, 'do_received', ago(3), 'synthetic seed');
    await record(advised.id, 'cusdec_lodged', ago(2, 5), 'synthetic seed');
    await record(advised.id, 'channel_assigned', ago(1, 3), 'synthetic seed', { result: 'green' });
    await record(exam.id, 'vessel_discharged', ago(6), 'synthetic seed');
    await record(exam.id, 'do_received', ago(5), 'synthetic seed');
    await record(exam.id, 'cusdec_lodged', ago(4), 'synthetic seed');
    await record(exam.id, 'channel_assigned', ago(3), 'synthetic seed', { result: 'red' });
    await record(exam.id, 'exam', ago(0, 20), 'synthetic seed', { yard: 'RCT' });

    for (const k of [fresh, advised, exam]) await grantAccess(c, { containerId: k.id, granteeCompanyId: client.companyId, kind: 'client' });
    for (const k of [fresh, advised]) await grantAccess(c, { containerId: k.id, granteeCompanyId: haulier.companyId, kind: 'haulier' });
  });

  return { users: [cha, client, haulier], freshContainerNo: 'ZZZU1234564' };
}
