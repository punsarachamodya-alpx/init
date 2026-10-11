import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withActor } from '../../src/db/withActor.ts';
import type { Actor } from '../../src/db/withActor.ts';
import { ROLES } from '../../src/domain/statusChain.ts';
import type { RoleName } from '../../src/domain/statusChain.ts';
import { DEFAULT_LOCALE, isLocale, t } from '../../src/i18n/index.ts';
import type { Locale, MessageKey } from '../../src/i18n/index.ts';
import { SESSION_COOKIE, sessionSecret, verifySession } from '../../src/web/session.ts';

export const LOCALE_COOKIE = 'locale';

export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;
export const translator = (locale: Locale): Translate => (key, vars) => t(locale, key, vars);

export interface Viewer {
  actor: Actor;
  displayName: string;
  role: RoleName;
  companyName: string;
  locale: Locale;
  tr: Translate;
}

/** The actor from the signed session cookie, or null. The ONLY way an Actor is built in the web app. */
export async function getActor(): Promise<Actor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySession(token, sessionSecret());
}

/**
 * The signed-in user with their role and company read from the database (never from the cookie), or null when there
 * is no valid cookie, the user no longer exists, or the database rejects the actor token (rotated key, clock skew).
 */
export async function getViewer(): Promise<Viewer | null> {
  const actor = await getActor();
  if (!actor) return null;
  let row: { display_name: string; role: string; name: string } | undefined;
  try {
    row = await withActor(actor, async (c) => {
      const { rows } = await c.query<{ display_name: string; role: string; name: string }>(
        'SELECT u.display_name, u.role, co.name FROM users u JOIN companies co ON co.company_id = u.company_id WHERE u.id = app_user_id()',
      );
      return rows[0];
    });
  } catch (err) {
    // The database refused the signed token (ActorContextError, by name: src/db/actorToken is not importable here).
    if (err instanceof Error && err.name === 'ActorContextError') return null;
    throw err;
  }
  if (!row || !(ROLES as readonly string[]).includes(row.role)) return null;
  const locale = await getLocale();
  return { actor, displayName: row.display_name, role: row.role as RoleName, companyName: row.name, locale, tr: translator(locale) };
}

/** Signed-in viewer, else to /login. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect('/login');
  return viewer;
}
