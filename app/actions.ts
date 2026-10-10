'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withActor } from '../src/db/withActor.ts';
import { isEventType } from '../src/domain/statusChain.ts';
import { isLocale } from '../src/i18n/index.ts';
import { fromColomboInput } from '../src/i18n/format.ts';
import { confirmSuggestionById, intakeAndStore, recordManualEvent, rejectSuggestionById } from '../src/intake/index.ts';
import type { Fields } from '../src/intake/index.ts';
import { FIELD_NAMES } from '../src/intake/types.ts';
import { LoggingNotifier, dispatchPending, notifyAfterEvent, notifyPendingEvents } from '../src/notify/index.ts';
import { loadDemoUsers } from '../src/web/demoUsers.ts';
import { safeReturnTo, uiErrorCode } from '../src/web/errors.ts';
import { extractorLabel, selectExtractor } from '../src/web/extractor.ts';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSession, sessionSecret } from '../src/web/session.ts';
import { LOCALE_COOKIE, requireViewer } from './lib/context.ts';

// Every action runs the acting user's work through withActor: the database decides what they may do. Errors are
// reduced to a fixed code (src/web/errors.ts) and shown through /locales; nothing from the database reaches the page.

const str = (fd: FormData, name: string) => String(fd.get(name) ?? '').trim();

type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };
async function attempt<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    const code = uiErrorCode(err);
    if (code === 'unexpected') console.error('unexpected error in a server action', err instanceof Error ? err.name : typeof err);
    return { ok: false, code };
  }
}

export async function loginAction(fd: FormData): Promise<void> {
  const userId = str(fd, 'userId');
  // The ids come from the server's own demo user list, never from the posted form.
  const user = loadDemoUsers().find((u) => u.userId === userId);
  if (!user) redirect('/login');
  const token = createSession({ companyId: user.companyId, userId: user.userId }, sessionSecret());
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SESSION_TTL_SECONDS });
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

export async function setLocaleAction(fd: FormData): Promise<void> {
  const locale = str(fd, 'locale');
  if (isLocale(locale)) (await cookies()).set(LOCALE_COOKIE, locale, { sameSite: 'lax', path: '/', maxAge: 365 * 86400 });
  redirect(safeReturnTo(str(fd, 'returnTo')));
}

export async function submitIntakeAction(fd: FormData): Promise<void> {
  const viewer = await requireViewer();
  const text = str(fd, 'text');
  if (!text || text.length > 20_000) redirect('/inbox?error=invalid_field');
  const out = await attempt(() =>
    withActor(viewer.actor, (c) => intakeAndStore(c, selectExtractor(), { kind: 'message', channel: 'web', text }, extractorLabel())),
  );
  redirect(out.ok ? '/inbox?flash=suggestion_ready' : `/inbox?error=${out.code}`);
}

function fieldsFrom(fd: FormData): Fields {
  const fields: Record<string, string | boolean> = {};
  for (const name of FIELD_NAMES) {
    const raw = fd.get(`field_${name}`);
    if (raw === null) continue;
    const value = String(raw).trim();
    fields[name] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return fields as Fields;
}

export async function confirmSuggestionAction(fd: FormData): Promise<void> {
  const viewer = await requireViewer();
  const eventType = str(fd, 'eventType');
  const occurredAt = fromColomboInput(str(fd, 'occurredAt'));
  if (!isEventType(eventType)) redirect('/inbox?error=event_type_required');
  if (!occurredAt) redirect('/inbox?error=occurred_at_invalid');
  const out = await attempt(() =>
    withActor(viewer.actor, async (c) => {
      const done = await confirmSuggestionById(c, str(fd, 'id'), { eventType, occurredAt, fields: fieldsFrom(fd), createContainer: fd.get('createContainer') === 'on' });
      await notifyAfterEvent(c, done.event); // same transaction: the update and who-to-tell are recorded together
      return done;
    }),
  );
  if (!out.ok) redirect(`/inbox?error=${out.code}`);
  redirect(`/?flash=confirmed&container=${out.value.container.containerNo}&status=${out.value.event.eventType}`);
}

export async function rejectSuggestionAction(fd: FormData): Promise<void> {
  const viewer = await requireViewer();
  const out = await attempt(() => withActor(viewer.actor, (c) => rejectSuggestionById(c, str(fd, 'id'), str(fd, 'reason'))));
  redirect(out.ok ? '/inbox?flash=rejected' : `/inbox?error=${out.code}`);
}

export async function manualEntryAction(fd: FormData): Promise<void> {
  const viewer = await requireViewer();
  const eventType = str(fd, 'eventType');
  const occurredAt = fromColomboInput(str(fd, 'occurredAt'));
  if (!isEventType(eventType)) redirect('/inbox?error=event_type_required');
  if (!occurredAt) redirect('/inbox?error=occurred_at_invalid');
  const blNo = str(fd, 'blNo');
  const out = await attempt(() =>
    withActor(viewer.actor, async (c) => {
      const done = await recordManualEvent(c, {
        containerNo: str(fd, 'containerNo'),
        ...(blNo ? { blNo } : {}),
        eventType,
        occurredAt,
        reason: str(fd, 'reason'),
        createContainer: fd.get('createContainer') === 'on',
      });
      await notifyAfterEvent(c, done.event);
      return done;
    }),
  );
  if (!out.ok) redirect(`/inbox?error=${out.code}`);
  redirect(`/?flash=manual_done&container=${out.value.container.containerNo}&status=${out.value.event.eventType}`);
}

/** CHA only (the database returns nothing for other roles): queue what is owed, then send through the logging stubs. */
export async function sendNotificationsAction(): Promise<void> {
  const viewer = await requireViewer();
  const providers = { whatsapp: new LoggingNotifier('whatsapp'), email: new LoggingNotifier('email'), sms: new LoggingNotifier('sms') };
  const out = await attempt(() =>
    withActor(viewer.actor, async (c) => {
      await notifyPendingEvents(c, new Date(Date.now() - 7 * 86_400_000));
      return dispatchPending(c, providers);
    }),
  );
  if (!out.ok) redirect(`/?error=${out.code}`);
  redirect(`/?flash=notifications&sent=${out.value.sent}&failed=${out.value.failed}&skipped=${out.value.skipped}`);
}
