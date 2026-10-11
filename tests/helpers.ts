import { randomUUID } from 'node:crypto';
import { checkDigit } from '../scripts/check-iso6346.mjs';
import { withActor } from '../src/db/withActor.ts';
import type { Actor } from '../src/db/withActor.ts';
import { withCompany } from '../src/db/withCompany.ts';

export type Kind = 'cha' | 'client' | 'haulier';
export type Role = 'cha_ops' | 'client' | 'haulier_dispatcher';
export const ROLE_OF_KIND: Record<Kind, Role> = { cha: 'cha_ops', client: 'client', haulier: 'haulier_dispatcher' };

export interface TestActor extends Actor {
  kind: Kind;
  role: Role;
}

let counter = 100000;
/** A fresh, valid, synthetic container number (ZZZU is not a registered owner code). */
export function validContainerNo(): string {
  const prefix = `ZZZU${String(counter++).padStart(6, '0')}`;
  return `${prefix}${checkDigit(prefix)}`;
}

let blCounter = 1;
/** A fresh synthetic bill of lading number. */
export function newBl(): string {
  return `SYNTHBL${String(blCounter++).padStart(6, '0')}`;
}

/** A company creates its own row under its own context (synthetic names only). */
export async function seedCompany(kind: Kind = 'cha'): Promise<string> {
  const id = randomUUID();
  await withCompany(id, (c) =>
    c.query('INSERT INTO companies (company_id, name, kind) VALUES ($1, $2, $3)', [id, `SYNTHETIC ${kind} ${id.slice(0, 8)}`, kind]),
  );
  return id;
}

/** Bootstrap a user inside an existing company (role follows the company kind). */
export async function seedUser(companyId: string, kind: Kind): Promise<string> {
  return withCompany(companyId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO users (company_id, company_kind, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [companyId, kind, ROLE_OF_KIND[kind], `Synthetic ${kind} user`],
    );
    return rows[0]!.id;
  });
}

/** A company plus one user of the matching role. */
export async function seedActor(kind: Kind = 'cha'): Promise<TestActor> {
  const companyId = await seedCompany(kind);
  const userId = await seedUser(companyId, kind);
  return { companyId, userId, kind, role: ROLE_OF_KIND[kind] };
}

export async function seedMessage(actor: Actor, body = 'ZZZU1234564 DO kittu'): Promise<string> {
  return withActor(actor, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO messages (company_id, channel, language, body) VALUES ($1, 'whatsapp', 'si-latin', $2) RETURNING id",
      [actor.companyId, body],
    );
    return rows[0]!.id;
  });
}

export async function seedDocument(actor: Actor, text = 'SYNTHETIC DELIVERY ORDER'): Promise<string> {
  return withActor(actor, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO documents (company_id, doc_type, text_content) VALUES ($1, 'delivery_order', $2) RETURNING id",
      [actor.companyId, text],
    );
    return rows[0]!.id;
  });
}
