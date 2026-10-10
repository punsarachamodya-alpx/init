import type pg from 'pg';
import { runScoped } from './withCompany.ts';
import type { CompanyClient } from './withCompany.ts';

/** The authenticated person acting for a company. Roles are looked up in the database, never passed in. */
export interface Actor {
  companyId: string;
  userId: string;
}

/**
 * Run `fn` as a user of a company. Policies derive the role from the `users` table, so a
 * user id that does not belong to the company grants nothing.
 *
 * SECURITY: the authentication layer is the only code that may build an Actor, and it must
 * take both ids from a verified session, never from request input.
 */
export function withActor<T>(actor: Actor, fn: (client: CompanyClient) => Promise<T>, pool?: pg.Pool): Promise<T> {
  return runScoped({ companyId: actor.companyId, userId: actor.userId }, fn, pool);
}
