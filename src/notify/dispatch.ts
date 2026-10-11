import type { CompanyClient } from '../db/withCompany.ts';
import { isLocale } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';
import { renderNotification } from './render.ts';
import { CHANNEL_ORDER, NotifierError } from './types.ts';
import type { Channel, NotificationKind, NotificationParams, Notifier } from './types.ts';

export interface DispatchSummary {
  sent: number;
  failed: number;
  skipped: number;
}

interface Pending {
  id: string;
  kind: NotificationKind;
  params: NotificationParams;
  recipient_user_id: string;
  rounds: number;
  /** The event this notification announces has since been replaced or voided. */
  stale: boolean;
}

interface Contact {
  whatsapp: string | null;
  email: string | null;
  sms: string | null;
  language: string;
}

const MAX_ERROR = 200;
// Only a NotifierError's message is kept (a provider says what it wants stored); anything else may carry an address,
// a URL or a token from a client library, so it is reduced to a fixed text.
const errorText = (err: unknown) => (err instanceof NotifierError ? err.message.slice(0, MAX_ERROR) : 'provider error');

/**
 * Send the acting company's pending notifications. A notification is pending until a 'sent' or 'skipped' attempt
 * exists and fewer than `maxAttempts` rounds have failed. Each round tries WhatsApp, then email, then SMS, using
 * only channels the recipient has an address for and a provider is configured for, and logs every attempt.
 * 'skipped' (nothing usable) is final. A notification another dispatcher holds is left to it (advisory lock, held
 * to the end of the caller's transaction). Providers are called inside the caller's transaction: fine for a stub,
 * move sending out of the transaction before a real provider is added.
 */
export async function dispatchPending(
  c: CompanyClient,
  notifiers: Partial<Record<Channel, Notifier>>,
  opts: { maxAttempts?: number } = {},
): Promise<DispatchSummary> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const summary: DispatchSummary = { sent: 0, failed: 0, skipped: 0 };

  const { rows: pending } = await c.query<Pending>(
    `SELECT n.id, n.kind, n.params, n.recipient_user_id, coalesce(max(a.round), 0)::int AS rounds,
            (n.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM events x WHERE x.corrects_event_id = n.event_id)) AS stale
     FROM notifications n LEFT JOIN notification_attempts a ON a.notification_id = n.id
     GROUP BY n.id
     HAVING NOT coalesce(bool_or(a.outcome IN ('sent', 'skipped')), false) AND coalesce(max(a.round), 0) < $1
     ORDER BY n.seq`,
    [maxAttempts],
  );

  for (const n of pending) {
    const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [n.id]);
    if (!lock.rows[0]?.ok) continue;
    // The list above was read before the lock: another dispatcher may have finished this one in between.
    const done = await c.query("SELECT coalesce(max(round), 0)::int AS rounds, coalesce(bool_or(outcome IN ('sent', 'skipped')), false) AS final FROM notification_attempts WHERE notification_id = $1", [n.id]);
    if (done.rows[0]?.final === true || (done.rows[0]?.rounds ?? 0) >= maxAttempts) continue;
    const round = (done.rows[0]?.rounds ?? n.rounds) + 1;
    const record = (outcome: 'sent' | 'failed' | 'skipped', channel: Channel | null, providerRef: string | null, error: string | null) =>
      c.query(
        `INSERT INTO notification_attempts (company_id, notification_id, round, channel, outcome, provider_ref, error)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6)`,
        [n.id, round, channel, outcome, providerRef, error],
      );

    if (n.stale) {
      // Announcing a voided or replaced event ("cleared to collect") would tell someone something untrue.
      await record('skipped', null, null, 'event no longer current');
      summary.skipped++;
      continue;
    }

    const { rows } = await c.query<Contact>('SELECT whatsapp, email, sms, language FROM user_contacts WHERE user_id = $1', [n.recipient_user_id]);
    const contact = rows[0];
    const usable = contact ? CHANNEL_ORDER.filter((ch) => contact[ch] && notifiers[ch]) : [];
    if (!contact || usable.length === 0) {
      await record('skipped', null, null, contact ? 'no configured channel with an address' : 'no contact on file');
      summary.skipped++;
      continue;
    }

    const locale: Locale = isLocale(contact.language) ? contact.language : 'en';
    let rendered: { subject: string; text: string };
    try {
      rendered = renderNotification(n.kind, locale, n.params);
    } catch {
      // One unrenderable row must not abort the run (and roll back the sends already made).
      await record('skipped', null, null, 'cannot render');
      summary.skipped++;
      continue;
    }
    const { subject, text } = rendered;
    let delivered = false;
    for (const channel of usable) {
      try {
        const { providerRef } = await notifiers[channel]!.send({ to: contact[channel]!, subject, text, idempotencyKey: `${n.id}:${round}:${channel}` });
        await record('sent', channel, providerRef.slice(0, 120), null);
        delivered = true;
        break;
      } catch (err) {
        await record('failed', channel, null, errorText(err));
      }
    }
    if (delivered) summary.sent++;
    else summary.failed++;
  }
  return summary;
}
