import type { CompanyClient } from '../db/withCompany.ts';

// Sharing a container with a client or a haulier. Only cha_ops of the owning company can write;
// the log is append-only, so a revoke is a new row. Reads go through active_container_access.

export type AccessKind = 'client' | 'haulier';

export interface AccessInput {
  containerId: string;
  granteeCompanyId: string;
  /** Must match the grantee company's kind (the database checks this). */
  kind: AccessKind;
}

export interface ActiveAccess {
  ownerCompanyId: string;
  containerId: string;
  granteeCompanyId: string;
  kind: AccessKind;
  grantedByUserId: string;
  since: Date;
}

async function append(c: CompanyClient, input: AccessInput, action: 'grant' | 'revoke'): Promise<void> {
  await c.query(
    `INSERT INTO container_access (company_id, container_id, grantee_company_id, access_kind, action)
     VALUES (app_company_id(), $1, $2, $3, $4)`,
    [input.containerId, input.granteeCompanyId, input.kind, action],
  );
}

export function grantAccess(c: CompanyClient, input: AccessInput): Promise<void> {
  return append(c, input, 'grant');
}

export function revokeAccess(c: CompanyClient, input: AccessInput): Promise<void> {
  return append(c, input, 'revoke');
}

/** Current grants visible to the acting company (the owner sees all; a grantee sees its own). */
export async function listActiveAccess(c: CompanyClient, containerId?: string): Promise<ActiveAccess[]> {
  const { rows } = await c.query<{
    owner_company_id: string;
    container_id: string;
    grantee_company_id: string;
    access_kind: AccessKind;
    granted_by_user_id: string;
    created_at: Date;
  }>(
    `SELECT owner_company_id, container_id, grantee_company_id, access_kind, granted_by_user_id, created_at
     FROM active_container_access WHERE ($1::uuid IS NULL OR container_id = $1) ORDER BY created_at`,
    [containerId ?? null],
  );
  return rows.map((r) => ({
    ownerCompanyId: r.owner_company_id,
    containerId: r.container_id,
    granteeCompanyId: r.grantee_company_id,
    kind: r.access_kind,
    grantedByUserId: r.granted_by_user_id,
    since: r.created_at,
  }));
}
