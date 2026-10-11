import type { CompanyClient } from '../db/withCompany.ts';
import type { EventType } from '../domain/statusChain.ts';
import { listStaleUndecided } from '../intake/store.ts';
import type { LedgerEvent } from '../ledger/ledger.ts';
import type { NotificationKind, NotificationParams } from './types.ts';

export interface EnqueueInput {
  kind: NotificationKind;
  recipientCompanyId: string;
  recipientUserId: string;
  params: NotificationParams;
  eventId?: string;
}

/**
 * Put a notification in the outbox. The database enforces who may be addressed (own company or a current
 * grantee) and that params hold only a container number, a status and a count. Returns null when the same
 * (event, recipient, kind) was already queued.
 */
export async function enqueueNotification(c: CompanyClient, input: EnqueueInput): Promise<{ id: string } | null> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO notifications (company_id, recipient_company_id, recipient_user_id, kind, params, event_id)
     VALUES (app_company_id(), $1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [input.recipientCompanyId, input.recipientUserId, input.kind, JSON.stringify(input.params), input.eventId ?? null],
  );
  return rows[0] ?? null;
}

/** Which events tell the client, which tell the assigned haulier. Everything else is silent. */
const TELL_CLIENT: ReadonlySet<EventType> = new Set(['channel_assigned', 'release_advice', 'delivered', 'empty_returned']);
const TELL_HAULIER: ReadonlySet<EventType> = new Set(['release_advice']);

type Recipient = { companyId: string; userId: string };

async function actingRole(c: CompanyClient): Promise<string | null> {
  const { rows } = await c.query<{ role: string | null }>('SELECT app_role() AS role');
  return rows[0]?.role ?? null;
}

/** The container's number, if the acting company owns it (only the owner may notify about it). */
async function ownedContainerNo(c: CompanyClient, containerId: string): Promise<string | null> {
  const { rows } = await c.query<{ container_no: string }>(
    'SELECT container_no FROM containers WHERE id = $1 AND company_id = app_company_id()',
    [containerId],
  );
  return rows[0]?.container_no ?? null;
}

/** Users with a saved contact, in companies that currently hold the given kind of access to the container. */
async function granteeRecipients(c: CompanyClient, containerId: string, accessKind: 'client' | 'haulier', onlyCompanyId?: string): Promise<Recipient[]> {
  const { rows } = await c.query<{ company_id: string; user_id: string }>(
    `SELECT DISTINCT uc.company_id, uc.user_id
     FROM active_container_access a
     JOIN user_contacts uc ON uc.company_id = a.grantee_company_id
     WHERE a.container_id = $1 AND a.access_kind = $2 AND ($3::uuid IS NULL OR a.grantee_company_id = $3)
     ORDER BY uc.user_id`,
    [containerId, accessKind, onlyCompanyId ?? null],
  );
  return rows.map((r) => ({ companyId: r.company_id, userId: r.user_id }));
}

async function enqueueAll(c: CompanyClient, kind: NotificationKind, to: Recipient[], params: NotificationParams, eventId?: string): Promise<string[]> {
  const ids: string[] = [];
  for (const r of to) {
    const made = await enqueueNotification(c, { kind, recipientCompanyId: r.companyId, recipientUserId: r.userId, params, ...(eventId ? { eventId } : {}) });
    if (made) ids.push(made.id);
  }
  return ids;
}

type Announced = Pick<LedgerEvent, 'id' | 'containerId' | 'eventType' | 'correctionKind'>;

/**
 * Queue the notifications an ordinary event calls for: the client hears about the channel, release, delivery and
 * empty return; the assigned haulier hears "cleared to collect" on release. Only the OWNING CHA runs this (it is the
 * only role that may read its grantees' contacts), for events recorded by anyone; for any other role it does nothing.
 * Corrections (replace/void) and superseded events are not announced. Returns the new notification ids; running it
 * twice for the same event queues nothing the second time.
 */
export async function notifyAfterEvent(c: CompanyClient, event: Announced): Promise<string[]> {
  if (event.correctionKind !== null) return [];
  const tellClient = TELL_CLIENT.has(event.eventType);
  const tellHaulier = TELL_HAULIER.has(event.eventType);
  if (!tellClient && !tellHaulier) return [];
  if ((await actingRole(c)) !== 'cha_ops') return [];
  const containerNo = await ownedContainerNo(c, event.containerId);
  if (!containerNo) return [];
  const superseded = await c.query('SELECT 1 FROM events WHERE corrects_event_id = $1 LIMIT 1', [event.id]);
  if ((superseded.rowCount ?? 0) > 0) return [];

  const ids: string[] = [];
  if (tellClient) {
    ids.push(...(await enqueueAll(c, 'client_status', await granteeRecipients(c, event.containerId, 'client'), { container: containerNo, status: event.eventType }, event.id)));
  }
  if (tellHaulier) {
    ids.push(...(await enqueueAll(c, 'haulier_cleared', await granteeRecipients(c, event.containerId, 'haulier'), { container: containerNo }, event.id)));
  }
  return ids;
}

/**
 * Catch up on events recorded since `since` by other parties (a haulier's "delivered" is announced to the client by
 * the CHA's side). Idempotent: events already announced queue nothing. Run it from a worker or when the CHA opens the board.
 */
export async function notifyPendingEvents(c: CompanyClient, since: Date): Promise<string[]> {
  if ((await actingRole(c)) !== 'cha_ops') return [];
  const types = [...TELL_CLIENT, ...TELL_HAULIER];
  const { rows } = await c.query<{ id: string; container_id: string; event_type: EventType }>(
    `SELECT e.id, e.container_id, e.event_type FROM events e
     WHERE e.company_id = app_company_id() AND e.correction_kind IS NULL AND e.recorded_at >= $1 AND e.event_type = ANY($2)
     ORDER BY e.seq`,
    [since, types],
  );
  const ids: string[] = [];
  for (const e of rows) ids.push(...(await notifyAfterEvent(c, { id: e.id, containerId: e.container_id, eventType: e.event_type, correctionKind: null })));
  return ids;
}

/** Tell a haulier company's contacts that a container was assigned to them (the CHA grants access first). */
export async function notifyHaulierAssigned(c: CompanyClient, containerId: string, granteeCompanyId: string): Promise<string[]> {
  if ((await actingRole(c)) !== 'cha_ops') return [];
  const containerNo = await ownedContainerNo(c, containerId);
  if (!containerNo) return [];
  return enqueueAll(c, 'haulier_assigned', await granteeRecipients(c, containerId, 'haulier', granteeCompanyId), { container: containerNo });
}

/** One reminder per ops contact of the acting CHA when suggestions older than `olderThan` are still undecided. Carries only the count. */
export async function enqueueSuggestionReminders(c: CompanyClient, olderThan: Date): Promise<string[]> {
  if ((await actingRole(c)) !== 'cha_ops') return [];
  const stale = await listStaleUndecided(c, olderThan);
  if (stale.length === 0) return [];
  const { rows } = await c.query<{ company_id: string; user_id: string }>(
    `SELECT uc.company_id, uc.user_id FROM user_contacts uc JOIN users u ON u.id = uc.user_id
     WHERE uc.company_id = app_company_id() AND u.role = 'cha_ops' ORDER BY uc.user_id`,
  );
  return enqueueAll(c, 'suggestion_reminder', rows.map((r) => ({ companyId: r.company_id, userId: r.user_id })), { count: String(stale.length) });
}
