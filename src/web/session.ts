import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../db/withActor.ts';

// A signed, httpOnly session cookie. It only carries WHO (company and user ids); the role always comes from the
// users table, inside the database. The ids are trusted by the database, so this is the one place that decides
// they came from a real login: never build an Actor from anything but verifySession.
// Real authentication (passwords / SSO / WhatsApp OTP) replaces the login step, not this cookie.

export const SESSION_COOKIE = 'colombo_session';
export const SESSION_TTL_SECONDS = 12 * 3600;

const VERSION = 'v1';
const DEV_SECRET = 'dev-only-session-secret-not-for-production!!';

/** SESSION_SECRET, at least 32 characters. Outside production a throwaway default is used; in production it is required. */
export function sessionSecret(env: { NODE_ENV?: string; SESSION_SECRET?: string } = process.env): string {
  const secret = env.SESSION_SECRET;
  if (secret !== undefined && secret.length >= 32) return secret;
  if (env.NODE_ENV === 'production' || secret !== undefined) throw new Error('SESSION_SECRET must be set to at least 32 characters');
  return DEV_SECRET;
}

const mac = (body: string, secret: string) => createHmac('sha256', secret).update(`${VERSION}.${body}`).digest('hex');

export function createSession(actor: Actor, secret: string, now: Date = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const body = Buffer.from(JSON.stringify({ c: actor.companyId, u: actor.userId, exp })).toString('base64url');
  return `${VERSION}.${body}.${mac(body, secret)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor in a valid, unexpired cookie, or null. Never throws on bad input. */
export function verifySession(token: string | undefined, secret: string, now: Date = new Date()): Actor | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, body, sig] = parts as [string, string, string];
  const expected = Buffer.from(mac(body, secret), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { c?: unknown; u?: unknown; exp?: unknown };
    if (typeof p.c !== 'string' || typeof p.u !== 'string' || typeof p.exp !== 'number') return null;
    if (!UUID.test(p.c) || !UUID.test(p.u)) return null;
    if (Math.floor(now.getTime() / 1000) >= p.exp) return null;
    return { companyId: p.c, userId: p.u };
  } catch {
    return null;
  }
}
