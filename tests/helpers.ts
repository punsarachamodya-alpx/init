import { randomUUID } from 'node:crypto';
import { checkDigit } from '../scripts/check-iso6346.mjs';
import { withCompany } from '../src/db/withCompany.ts';

let counter = 100000;
/** A fresh, valid, synthetic container number (ZZZU is not a registered owner code). */
export function validContainerNo(): string {
  const prefix = `ZZZU${String(counter++).padStart(6, '0')}`;
  return `${prefix}${checkDigit(prefix)}`;
}

/** A company creates its own row under its own context (synthetic names only). */
export async function seedCompany(kind: 'cha' | 'client' | 'haulier' = 'cha'): Promise<string> {
  const id = randomUUID();
  await withCompany(id, (c) =>
    c.query('INSERT INTO companies (company_id, name, kind) VALUES ($1, $2, $3)', [id, `SYNTHETIC ${kind} ${id.slice(0, 8)}`, kind]),
  );
  return id;
}

export async function seedMessage(companyId: string, body = 'ZZZU1234564 DO kittu'): Promise<string> {
  return withCompany(companyId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO messages (company_id, channel, language, body) VALUES ($1, 'whatsapp', 'si-latin', $2) RETURNING id",
      [companyId, body],
    );
    return rows[0]!.id;
  });
}

export async function seedDocument(companyId: string, text = 'SYNTHETIC DELIVERY ORDER'): Promise<string> {
  return withCompany(companyId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO documents (company_id, doc_type, text_content) VALUES ($1, 'delivery_order', $2) RETURNING id",
      [companyId, text],
    );
    return rows[0]!.id;
  });
}
