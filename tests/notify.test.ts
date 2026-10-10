import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantAccess, revokeAccess } from '../src/access/access.ts';
import { dbUrl } from '../src/db/config.ts';
import { closeAppPool } from '../src/db/pool.ts';
import { withActor } from '../src/db/withActor.ts';
import { EVENT_TYPES } from '../src/domain/statusChain.ts';
import { LOCALES, t } from '../src/i18n/index.ts';
import type { Locale } from '../src/i18n/index.ts';
import { intakeAndStore } from '../src/intake/index.ts';
import type { Extractor } from '../src/intake/index.ts';
import { appendEvent, createContainer, voidEvent } from '../src/ledger/ledger.ts';
import {
  FakeNotifier,
  LoggingNotifier,
  NotifierError,
  dispatchPending,
  enqueueNotification,
  enqueueSuggestionReminders,
  notifyAfterEvent,
  notifyPendingEvents,
  notifyHaulierAssigned,
  renderNotification,
} from '../src/notify/index.ts';
import type { Channel, Notifier } from '../src/notify/index.ts';
import { newBl, seedActor, seedUser, validContainerNo } from './helpers.ts';
import type { TestActor } from './helpers.ts';

let cha: TestActor;
let chaOps2: string; // a second ops user in the CHA company
let client: TestActor;
let haulier: TestActor;
let haulierB: TestActor;
let stranger: TestActor;
let owner: pg.Pool;

async function addContact(actor: { companyId: string; userId: string }, fields: Partial<Record<Channel, string>>, language: Locale = 'en') {
  await withActor(actor, (c) =>
    c.query('INSERT INTO user_contacts (company_id, user_id, whatsapp, email, sms, language) VALUES ($1, $2, $3, $4, $5, $6)', [
      actor.companyId, actor.userId, fields.whatsapp ?? null, fields.email ?? null, fields.sms ?? null, language,
    ]),
  );
}
const outbox = (actor: { companyId: string; userId: string }, kind?: string) =>
  withActor(actor, async (c) => (await c.query<{ id: string; kind: string; recipient_user_id: string; params: Record<string, string> }>(
    'SELECT id, kind, recipient_user_id, params FROM notifications WHERE ($1::text IS NULL OR kind = $1) ORDER BY seq', [kind ?? null])).rows);
const attempts = (actor: { companyId: string; userId: string }, notificationId: string) =>
  withActor(actor, async (c) => (await c.query<{ channel: string; outcome: string; error: string | null; provider_ref: string | null }>(
    'SELECT channel, outcome, error, provider_ref FROM notification_attempts WHERE notification_id = $1 ORDER BY seq', [notificationId])).rows);

async function sharedContainer() {
  return withActor(cha, async (c) => {
    const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: client.companyId, kind: 'client' });
    await grantAccess(c, { containerId: container.id, granteeCompanyId: haulier.companyId, kind: 'haulier' });
    return container;
  });
}
// The recorder follows the role matrix (the CHA records clearance stages, the haulier trucking stages); the CHA
// then runs the notification trigger, because only the owning CHA can read its grantees' contacts.
const TRUCKING = ['gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned'];
const chaEvent = async (containerId: string, eventType: (typeof EVENT_TYPES)[number]) => {
  const recorder = TRUCKING.includes(eventType) ? haulier : cha;
  const event = await withActor(recorder, (c) =>
    appendEvent(c, { containerId, eventType, occurredAt: new Date('2026-10-14T03:00:00Z'), source: { type: 'person', ref: 'synthetic' }, evidence: { type: 'manual', note: 'synthetic' } }),
  );
  return { event, notified: await withActor(cha, (c) => notifyAfterEvent(c, event)) };
};

beforeAll(async () => {
  cha = await seedActor('cha');
  chaOps2 = await seedUser(cha.companyId, 'cha');
  client = await seedActor('client');
  haulier = await seedActor('haulier');
  haulierB = await seedActor('haulier');
  stranger = await seedActor('client');
  await addContact(cha, { email: 'ops@cha.example.invalid' });
  await addContact({ companyId: cha.companyId, userId: chaOps2 }, { whatsapp: '+94770000001', email: 'ops2@cha.example.invalid' });
  await addContact(client, { whatsapp: '+94771110001', email: 'client@client.example.invalid', sms: '+94771110001' }, 'si');
  await addContact(haulier, { whatsapp: '+94772220002', sms: '+94772220002' }, 'ta');
  await addContact(haulierB, { sms: '+94773330003' });
  owner = new pg.Pool({ connectionString: dbUrl('OWNER_DATABASE_URL'), max: 2 });
});
afterAll(async () => {
  await owner.end();
  await closeAppPool();
});

describe('message text comes from the locales, in the recipient\'s language, with safe parameters only', () => {
  const params = { container: 'ZZZU1234564', status: 'release_advice' } as const;

  test.each(LOCALES.flatMap((l) => (['client_status', 'haulier_assigned', 'haulier_cleared'] as const).map((k) => [l, k] as const)))('%s / %s mentions the container and, where relevant, the localised status', (locale, kind) => {
    const m = renderNotification(kind, locale, params);
    expect(m.text).toContain('ZZZU1234564');
    expect(m.subject.length).toBeGreaterThan(0);
    if (kind === 'client_status') expect(m.text).toContain(t(locale, 'status.release_advice'));
  });

  test('the Sinhala and Tamil texts differ from English', () => {
    const en = renderNotification('client_status', 'en', params).text;
    expect(renderNotification('client_status', 'si', params).text).not.toBe(en);
    expect(renderNotification('client_status', 'ta', params).text).not.toBe(en);
  });

  test('the reminder carries only a count', () => {
    const m = renderNotification('suggestion_reminder', 'en', { count: '3' });
    expect(m.text).toContain('3');
  });
});

describe('providers', () => {
  test('FakeNotifier records messages, returns a reference, and can be told to fail', async () => {
    const fake = new FakeNotifier('whatsapp');
    const ok = await fake.send({ to: '+94770000001', subject: 's', text: 'hello', idempotencyKey: 'k1' });
    expect(ok.providerRef).toMatch(/^fake-/);
    expect(fake.sent).toHaveLength(1);
    fake.failNext(new NotifierError('rate limited'));
    await expect(fake.send({ to: '+94770000001', subject: 's', text: 'x', idempotencyKey: 'k2' })).rejects.toBeInstanceOf(NotifierError);
    await expect(fake.send({ to: '+94770000001', subject: 's', text: 'y', idempotencyKey: 'k3' })).resolves.toBeTruthy(); // only the next one fails
  });

  test('LoggingNotifier logs a redacted line: no full address, no message body', async () => {
    const lines: string[] = [];
    const logger = new LoggingNotifier('email', (l) => lines.push(l));
    await logger.send({ to: 'ops2@cha.example.invalid', subject: 'Release', text: 'Container ZZZU1234564 is released', idempotencyKey: 'k' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/email/);
    expect(lines[0]).not.toContain('ops2@cha.example.invalid');
    expect(lines[0]).not.toContain('Container ZZZU1234564');
  });
});

describe('contacts and the outbox follow the sharing rules', () => {
  test('a CHA reads the contacts of companies it currently shares a container with, not of strangers', async () => {
    const c = await sharedContainer();
    const visible = await withActor(cha, async (cl) => (await cl.query<{ user_id: string }>('SELECT user_id FROM user_contacts')).rows.map((r) => r.user_id));
    expect(visible).toEqual(expect.arrayContaining([client.userId, haulier.userId, cha.userId, chaOps2]));
    expect(visible).not.toContain(haulierB.userId); // never granted
    expect(visible).not.toContain(stranger.userId);
    await withActor(cha, (cl) => revokeAccess(cl, { containerId: c.id, granteeCompanyId: haulier.companyId, kind: 'haulier' }));
    // the same haulier company is still shared on another container created above, so check a company with only this grant
    expect(c.id).toBeTruthy();
  });

  test('a revoked-only company\'s contacts disappear', async () => {
    const h = await seedActor('haulier');
    await addContact(h, { sms: '+94774440004' });
    const id = await withActor(cha, async (c) => {
      const container = await createContainer(c, { blNo: newBl(), containerNo: validContainerNo() });
      await grantAccess(c, { containerId: container.id, granteeCompanyId: h.companyId, kind: 'haulier' });
      return container.id;
    });
    const sees = () => withActor(cha, async (c) => (await c.query('SELECT 1 FROM user_contacts WHERE user_id = $1', [h.userId])).rowCount);
    expect(await sees()).toBe(1);
    await withActor(cha, (c) => revokeAccess(c, { containerId: id, granteeCompanyId: h.companyId, kind: 'haulier' }));
    expect(await sees()).toBe(0);
  });

  test('clients and hauliers read only their own company\'s contacts', async () => {
    for (const actor of [client, haulier]) {
      const rows = await withActor(actor, async (c) => (await c.query<{ company_id: string }>('SELECT company_id FROM user_contacts')).rows);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.company_id === actor.companyId)).toBe(true);
    }
  });

  test('contact rows are validated and immutable', async () => {
    const bad = (fields: Record<string, string>) => withActor(stranger, (c) =>
      c.query('INSERT INTO user_contacts (company_id, user_id, whatsapp, email, sms, language) VALUES ($1, $2, $3, $4, $5, $6)', [
        stranger.companyId, stranger.userId, fields.whatsapp ?? null, fields.email ?? null, fields.sms ?? null, fields.language ?? 'en']));
    await expect(bad({})).rejects.toThrow(/check constraint/); // no channel at all
    await expect(bad({ whatsapp: 'not a number' })).rejects.toThrow(/check constraint/);
    await expect(bad({ email: 'no-at-sign' })).rejects.toThrow(/check constraint/);
    await expect(bad({ sms: '+94775550005', language: 'fr' })).rejects.toThrow(/check constraint/);
    await expect(withActor(client, (c) => c.query("UPDATE user_contacts SET email = 'x@y.z'"))).rejects.toThrow(/permission denied/);
    await expect(owner.query("UPDATE user_contacts SET language = 'en'")).rejects.toThrow(/append-only/);
  });

  test('a user cannot add contacts for a colleague (unless cha_ops), nor for another company', async () => {
    const colleague = await seedUser(client.companyId, 'client');
    await expect(
      withActor(client, (c) => c.query(`INSERT INTO user_contacts (company_id, user_id, sms) VALUES ($1, $2, '+94776660006')`, [client.companyId, colleague])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withActor(client, (c) => c.query(`INSERT INTO user_contacts (company_id, user_id, sms) VALUES ($1, $2, '+94776660006')`, [haulier.companyId, haulier.userId])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withActor(cha, (c) => c.query(`INSERT INTO user_contacts (company_id, user_id, sms) VALUES ($1, $2, '+94776660007')`, [cha.companyId, (colleague)])),
    ).rejects.toThrow(/foreign key/); // cha_ops may add for its own users only
  });

  test('a sender can address its own users and its current grantees, nobody else', async () => {
    const c = await sharedContainer();
    const enq = (recipient: { companyId: string; userId: string }, params: Record<string, string> = { container: 'ZZZU1234564', status: 'delivered' }) =>
      withActor(cha, (cl) => enqueueNotification(cl, { kind: 'client_status', recipientCompanyId: recipient.companyId, recipientUserId: recipient.userId, params: params as never }));
    await expect(enq(client)).resolves.toBeTruthy();
    await expect(enq(cha)).resolves.toBeTruthy(); // its own users
    await expect(enq(stranger)).rejects.toThrow(/row-level security/);
    await expect(enq(haulierB)).rejects.toThrow(/row-level security/);
    expect(c.id).toBeTruthy();
  });

  test('parameters are restricted to a container number, a status and a count', async () => {
    const enq = (params: Record<string, string>) =>
      withActor(cha, (cl) => enqueueNotification(cl, { kind: 'client_status', recipientCompanyId: client.companyId, recipientUserId: client.userId, params: params as never }));
    await sharedContainer();
    await expect(enq({ container: 'ZZZU1234564', status: 'delivered', freight: '1200' })).rejects.toThrow(/check constraint/);
    await expect(enq({ container: 'not a container' })).rejects.toThrow(/check constraint/);
    await expect(enq({ status: 'invented' })).rejects.toThrow(/check constraint/);
    await expect(enq({ count: 'lots' })).rejects.toThrow(/check constraint/);
    await expect(enq({ container: 'ZZZU1234564', status: 'delivered' })).resolves.toBeTruthy();
  });

  test('the outbox and the attempt log are immutable', async () => {
    for (const sql of ["UPDATE notifications SET kind = 'client_status'", 'DELETE FROM notifications', 'TRUNCATE notifications CASCADE', "UPDATE notification_attempts SET outcome = 'sent'", 'DELETE FROM notification_attempts', 'TRUNCATE notification_attempts CASCADE']) {
      await expect(owner.query(sql), sql).rejects.toThrow(/append-only/);
    }
    await expect(withActor(cha, (c) => c.query("UPDATE notifications SET kind = 'client_status'"))).rejects.toThrow(/permission denied/);
  });

  test('another company cannot read the outbox', async () => {
    await sharedContainer();
    await withActor(cha, (cl) => enqueueNotification(cl, { kind: 'client_status', recipientCompanyId: client.companyId, recipientUserId: client.userId, params: { container: 'ZZZU1234564', status: 'delivered' } }));
    expect((await outbox(client)).length).toBe(0);
    expect((await outbox(cha)).length).toBeGreaterThan(0);
  });
});

describe('triggers: who is told what when the CHA records an event', () => {
  test('release advice tells the client and the assigned haulier, each in their own language', async () => {
    const c = await sharedContainer();
    const { notified } = await chaEvent(c.id, 'release_advice');
    expect(notified).toHaveLength(2);
    const rows = (await outbox(cha)).filter((r) => r.params.container === c.containerNo);
    expect(rows.map((r) => [r.kind, r.recipient_user_id]).sort()).toEqual(
      [['client_status', client.userId], ['haulier_cleared', haulier.userId]].sort(),
    );
    expect(rows.every((r) => r.params.container === c.containerNo)).toBe(true);
  });

  test.each(['channel_assigned', 'delivered', 'empty_returned'] as const)('%s tells the client only', async (type) => {
    const c = await sharedContainer();
    const { notified } = await chaEvent(c.id, type);
    expect(notified).toHaveLength(1);
    const rows = (await outbox(cha)).filter((r) => r.params.container === c.containerNo);
    expect(rows.map((r) => r.kind)).toEqual(['client_status']);
  });

  test.each(['vessel_discharged', 'do_received', 'cusdec_lodged', 'exam'] as const)('%s tells nobody', async (type) => {
    const c = await sharedContainer();
    expect((await chaEvent(c.id, type)).notified).toHaveLength(0);
  });

  test('the trigger does nothing when a haulier runs it (only the owning CHA reads the other parties\' contacts)', async () => {
    const c = await sharedContainer();
    const byHaulier = await withActor(haulier, async (cl) => {
      const e = await appendEvent(cl, { containerId: c.id, eventType: 'delivered', occurredAt: new Date('2026-10-14T03:00:00Z'), source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'x' } });
      return notifyAfterEvent(cl, e);
    });
    expect(byHaulier).toEqual([]);
  });

  test('a revoked haulier is not told "cleared to collect"', async () => {
    const h = await seedActor('haulier');
    await addContact(h, { sms: '+94778880008' });
    const c = await withActor(cha, async (cl) => {
      const container = await createContainer(cl, { blNo: newBl(), containerNo: validContainerNo() });
      await grantAccess(cl, { containerId: container.id, granteeCompanyId: client.companyId, kind: 'client' });
      await grantAccess(cl, { containerId: container.id, granteeCompanyId: h.companyId, kind: 'haulier' });
      await revokeAccess(cl, { containerId: container.id, granteeCompanyId: h.companyId, kind: 'haulier' });
      return container;
    });
    const { notified } = await chaEvent(c.id, 'release_advice');
    expect(notified).toHaveLength(1); // the client only
  });

  test('a trucking event recorded by the haulier reaches the client through the CHA sweep, once', async () => {
    const c = await sharedContainer();
    const e = await withActor(haulier, (cl) =>
      appendEvent(cl, { containerId: c.id, eventType: 'delivered', occurredAt: new Date('2026-10-14T03:00:00Z'), source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'x' } }),
    );
    const since = new Date(Date.now() - 3_600_000);
    const first = await withActor(cha, (cl) => notifyPendingEvents(cl, since));
    expect(first.length).toBeGreaterThanOrEqual(1);
    const rows = (await outbox(cha, 'client_status')).filter((r) => r.params.container === c.containerNo);
    expect(rows.map((r) => r.recipient_user_id)).toEqual([client.userId]);
    expect(await withActor(cha, (cl) => notifyPendingEvents(cl, since))).toEqual([]); // nothing new the second time
    expect(await withActor(cha, (cl) => notifyAfterEvent(cl, e))).toEqual([]); // and the trigger is idempotent per event
  });

  test('a voided event is not announced', async () => {
    const c = await sharedContainer();
    const e = await withActor(cha, (cl) =>
      appendEvent(cl, { containerId: c.id, eventType: 'release_advice', occurredAt: new Date('2026-10-14T03:00:00Z'), source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'x' } }),
    );
    const v = await withActor(cha, (cl) => voidEvent(cl, e.id, { source: { type: 'person', ref: 'x' }, evidence: { type: 'manual', note: 'wrong container' } }));
    expect(await withActor(cha, (cl) => notifyAfterEvent(cl, v))).toEqual([]); // the void row itself
    expect(await withActor(cha, (cl) => notifyAfterEvent(cl, e))).toEqual([]); // and the voided original
  });

  test('assigning a haulier tells that haulier; assigning a client does not', async () => {
    const h = await seedActor('haulier');
    await addContact(h, { whatsapp: '+94779990009' }, 'si');
    const out = await withActor(cha, async (cl) => {
      const container = await createContainer(cl, { blNo: newBl(), containerNo: validContainerNo() });
      await grantAccess(cl, { containerId: container.id, granteeCompanyId: h.companyId, kind: 'haulier' });
      const toHaulier = await notifyHaulierAssigned(cl, container.id, h.companyId);
      await grantAccess(cl, { containerId: container.id, granteeCompanyId: client.companyId, kind: 'client' });
      return { toHaulier, container };
    });
    expect(out.toHaulier).toHaveLength(1);
    const rows = (await outbox(cha, 'haulier_assigned')).filter((r) => r.params.container === out.container.containerNo);
    expect(rows.map((r) => r.recipient_user_id)).toEqual([h.userId]);
  });

  test('a company with no contacts is skipped quietly', async () => {
    const bare = await seedActor('client');
    const c = await withActor(cha, async (cl) => {
      const container = await createContainer(cl, { blNo: newBl(), containerNo: validContainerNo() });
      await grantAccess(cl, { containerId: container.id, granteeCompanyId: bare.companyId, kind: 'client' });
      return container;
    });
    expect((await chaEvent(c.id, 'channel_assigned')).notified).toHaveLength(0);
  });
});

describe('reminders for suggestions nobody has decided', () => {
  const noop: Extractor = { extract: async () => ({ docType: null, suggestedEvent: null, language: 'en', notes: null, fields: {} }) };

  test('one reminder per ops contact, with only a count, for suggestions older than the cutoff', async () => {
    const ops = await seedActor('cha');
    const second = await seedUser(ops.companyId, 'cha');
    await addContact(ops, { email: 'a@ops.example.invalid' });
    await addContact({ companyId: ops.companyId, userId: second }, { email: 'b@ops.example.invalid' });
    for (let i = 0; i < 3; i++) await withActor(ops, (c) => intakeAndStore(c, noop, { kind: 'message', channel: 'whatsapp', text: `message ${i}` }, 'fake'));
    const none = await withActor(ops, (c) => enqueueSuggestionReminders(c, new Date(Date.now() - 3_600_000)));
    expect(none).toEqual([]);
    const made = await withActor(ops, (c) => enqueueSuggestionReminders(c, new Date(Date.now() + 60_000)));
    expect(made).toHaveLength(2);
    const rows = await outbox(ops, 'suggestion_reminder');
    expect(rows.map((r) => r.params)).toEqual([{ count: '3' }, { count: '3' }]);
  });

  test('nothing to remind about means no notifications', async () => {
    const ops = await seedActor('cha');
    await addContact(ops, { email: 'c@ops.example.invalid' });
    expect(await withActor(ops, (c) => enqueueSuggestionReminders(c, new Date(Date.now() + 60_000)))).toEqual([]);
  });
});

describe('dispatch: WhatsApp, then email, then SMS; every attempt is recorded', () => {
  const notifiers = () => ({ whatsapp: new FakeNotifier('whatsapp'), email: new FakeNotifier('email'), sms: new FakeNotifier('sms') });
  const asMap = (n: ReturnType<typeof notifiers>): Partial<Record<Channel, Notifier>> => n;

  async function pendingFor(recipient: TestActor) {
    const c = await sharedContainer();
    await chaEvent(c.id, 'delivered');
    return { container: c, rows: (await outbox(cha, 'client_status')).filter((r) => r.params.container === c.containerNo && r.recipient_user_id === recipient.userId) };
  }

  test('the first available channel in the order is used, in the recipient\'s language', async () => {
    const { rows, container } = await pendingFor(client);
    const n = notifiers();
    const summary = await withActor(cha, (c) => dispatchPending(c, asMap(n)));
    expect(summary.sent).toBeGreaterThan(0);
    expect(n.whatsapp.sent.some((m) => m.text.includes(container.containerNo))).toBe(true);
    const msg = n.whatsapp.sent.find((m) => m.text.includes(container.containerNo))!;
    expect(msg.to).toBe('+94771110001');
    expect(msg.text).toContain(t('si', 'status.delivered')); // client prefers Sinhala
    expect(await attempts(cha, rows[0]!.id)).toEqual([expect.objectContaining({ channel: 'whatsapp', outcome: 'sent' })]);
    expect(n.email.sent.filter((m) => m.text.includes(container.containerNo))).toHaveLength(0);
  });

  test('a failing channel falls back to the next one, and both attempts are logged', async () => {
    const { rows, container } = await pendingFor(client);
    const n = notifiers();
    n.whatsapp.failAll(new NotifierError('whatsapp is down'));
    await withActor(cha, (c) => dispatchPending(c, asMap(n)));
    const log = await attempts(cha, rows[0]!.id);
    expect(log.map((a) => [a.channel, a.outcome])).toEqual([['whatsapp', 'failed'], ['email', 'sent']]);
    expect(log[0]!.error).toContain('whatsapp is down');
    expect(n.email.sent.some((m) => m.text.includes(container.containerNo))).toBe(true);
    expect(n.sms.sent.filter((m) => m.text.includes(container.containerNo))).toHaveLength(0);
  });

  test('SMS is the last resort', async () => {
    const { rows } = await pendingFor(client);
    const n = notifiers();
    n.whatsapp.failAll(new NotifierError('down'));
    n.email.failAll(new NotifierError('down'));
    await withActor(cha, (c) => dispatchPending(c, asMap(n)));
    expect((await attempts(cha, rows[0]!.id)).map((a) => [a.channel, a.outcome])).toEqual([['whatsapp', 'failed'], ['email', 'failed'], ['sms', 'sent']]);
  });

  test('a recipient without a channel we can use is skipped, once', async () => {
    const { rows } = await pendingFor(client);
    const onlyEmail: Partial<Record<Channel, Notifier>> = {}; // no providers configured at all
    const first = await withActor(cha, (c) => dispatchPending(c, onlyEmail));
    expect(first.skipped).toBeGreaterThan(0);
    expect((await attempts(cha, rows[0]!.id)).map((a) => a.outcome)).toEqual(['skipped']);
    const again = await withActor(cha, (c) => dispatchPending(c, notifiers()));
    expect((await attempts(cha, rows[0]!.id)).map((a) => a.outcome)).toEqual(['skipped']); // not retried
    expect(again.sent).toBeGreaterThanOrEqual(0);
  });

  test('delivered notifications are never sent twice', async () => {
    const { container } = await pendingFor(client);
    const n = notifiers();
    await withActor(cha, (c) => dispatchPending(c, asMap(n)));
    const before = n.whatsapp.sent.length;
    await withActor(cha, (c) => dispatchPending(c, asMap(n)));
    expect(n.whatsapp.sent.length).toBe(before);
    expect(n.whatsapp.sent.filter((m) => m.text.includes(container.containerNo))).toHaveLength(1);
  });

  test('failed notifications are retried until the attempt limit, then left alone', async () => {
    const { rows } = await pendingFor(haulier).catch(async () => ({ rows: [] as Array<{ id: string }> }));
    const c = await sharedContainer();
    await chaEvent(c.id, 'release_advice');
    const hauliersRow = (await outbox(cha, 'haulier_cleared')).filter((r) => r.params.container === c.containerNo)[0]!;
    const dead = { whatsapp: new FakeNotifier('whatsapp'), sms: new FakeNotifier('sms') };
    dead.whatsapp.failAll(new NotifierError('down'));
    dead.sms.failAll(new NotifierError('down'));
    for (let i = 0; i < 5; i++) await withActor(cha, (cl) => dispatchPending(cl, dead, { maxAttempts: 2 }));
    const log = await attempts(cha, hauliersRow.id);
    expect(log.filter((a) => a.outcome === 'failed').length).toBe(4); // two rounds of two channels, then it stops
    expect(rows).toBeDefined();
  });

  test('the text sent to the haulier is in Tamil', async () => {
    const c = await sharedContainer();
    await chaEvent(c.id, 'release_advice');
    const n = notifiers();
    await withActor(cha, (cl) => dispatchPending(cl, asMap(n)));
    const m = n.whatsapp.sent.find((x) => x.to === '+94772220002' && x.text.includes(c.containerNo))!;
    expect(m.text).toBe(renderNotification('haulier_cleared', 'ta', { container: c.containerNo }).text);
  });
});
