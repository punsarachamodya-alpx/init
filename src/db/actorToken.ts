import { createHmac } from 'node:crypto';
import { actorSecretHex } from './config.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new Error(`${name} must be a UUID`);
}

export interface ActorScope {
  companyId: string;
  /** Absent for the company-only bootstrap context. */
  userId?: string;
}

export interface SignOptions {
  nowSeconds?: number;
  ttlSeconds?: number;
  secretHex?: string;
}

export const TOKEN_TTL_SECONDS = 300;

/**
 * The database does not trust app.company_id / app.user_id any more. It trusts only this token:
 * `v1.<company>.<user or ->.<expiry>.<HMAC-SHA256>`, verified inside verified_actor_parts()
 * (db/migrations/0007_actor_context.sql) against a key the application role cannot read.
 * Only code that holds ACTOR_CONTEXT_SECRET can mint one, and it must take the ids from a
 * verified session, never from request input.
 */
export function signActor(scope: ActorScope, opts: SignOptions = {}): string {
  assertUuid(scope.companyId, 'companyId');
  if (scope.userId !== undefined) assertUuid(scope.userId, 'userId');
  const exp = (opts.nowSeconds ?? Math.floor(Date.now() / 1000)) + (opts.ttlSeconds ?? TOKEN_TTL_SECONDS);
  const message = `v1.${scope.companyId.toLowerCase()}.${scope.userId?.toLowerCase() ?? '-'}.${exp}`;
  const signature = createHmac('sha256', Buffer.from(opts.secretHex ?? actorSecretHex(), 'hex')).update(message).digest('hex');
  return `${message}.${signature}`;
}
