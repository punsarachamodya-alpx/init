import type { CompanyClient } from '../db/withCompany.ts';
import { isLocale } from '../i18n/index.ts';
import type { Locale } from '../i18n/index.ts';
import { renderNotification } from './render.ts';
import { CHANNEL_ORDER } from './types.ts';
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
}

interface Contact {
  whatsapp: string | null;
  email: string | null;
  sms: string | null;
  language: string;
}

const MAX_ERROR = 200;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR);

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
    `SELECT n.id, n.kind, n.params, n.recipient_user_id, coalesce(max(a.round), 0)::int AS rounds
     FROM notifications n LEFT JOIN notification_attempts a ON a.notification_id = n.id
     GROUP BY n.id
     HAVING NOT coalesce(bool_or(a.outcome IN ('sent', 'skipped')), false) AND coalesce(max(a.round), 0) < $1
     ORDER BY n.seq`,
    [maxAttempts],
  );

  for (const n of pending) {
    const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [n.id]);
    if (!lock.rows[0]?.ok) continue;
    const round = n.rounds + 1;
    const record = (outcome: 'sent' | 'failed' | 'skipped', channel: Channel | null, providerRef: string | null, error: string | null) =>
      c.query(
        `INSERT INTO notification_attempts (company_id, notification_id, round, channel, outcome, provider_ref, error)
         VALUES (app_company_id(), $1, $2, $3, $4, $5, $6)`,
        [n.id, round, channel, outcome, providerRef, error],
      );

    const { rows } = await c.query<Contact>('SELECT whatsapp, email, sms, language FROM user_contacts WHERE user_id = $1', [n.recipient_user_id]);
    const contact = rows[0];
    const usable = contact ? CHANNEL_ORDER.filter((ch) => contact[ch] && notifiers[ch]) : [];
    if (!contact || usable.length === 0) {
      await record('skipped', null, null, contact ? 'no configured channel with an address' : 'no contact on file');
      summary.skipped++;
      continue;
    }

    const locale: Locale = isLocale(contact.language) ? contact.language : 'en';
    const { subject, text } = renderNotification(n.kind, locale, n.params);
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
