-- 0005_container_access: the owning CHA shares a container with a client and/or a haulier.
--   * container_access is an append-only log of grants and revokes (revoke = new row);
--   * grantee kind must match the grantee company kind (composite FK); grants stay inside the
--     owner's containers (composite FK); only cha_ops of the owner can write;
--   * active_container_access (security_invoker view) = latest row per container+grantee that is a grant;
--   * extra permissive SELECT policies let a grantee read the container, its events and the owning
--     company row. No SECURITY DEFINER anywhere. Messages and documents are NOT shared.
-- Writing events by grantees (clients, hauliers) arrives in 0006; until then they can only read.
-- Migrations are immutable once applied. Add a new file for any change.

CREATE TABLE container_access (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  company_id         uuid NOT NULL REFERENCES companies (company_id),       -- the owning CHA
  container_id       uuid NOT NULL,
  grantee_company_id uuid NOT NULL,
  access_kind        text NOT NULL CONSTRAINT container_access_kind CHECK (access_kind IN ('client', 'haulier')),
  action             text NOT NULL CONSTRAINT container_access_action CHECK (action IN ('grant', 'revoke')),
  granted_by_user_id uuid NOT NULL DEFAULT app_user_id() REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT container_access_container_fk FOREIGN KEY (company_id, container_id) REFERENCES containers (company_id, id),
  -- access_kind equals the grantee company kind ('client' | 'haulier')
  CONSTRAINT container_access_grantee_fk FOREIGN KEY (grantee_company_id, access_kind) REFERENCES companies (company_id, kind),
  CONSTRAINT container_access_not_self CHECK (grantee_company_id <> company_id)
);

CREATE INDEX container_access_lookup ON container_access (company_id, container_id, grantee_company_id, seq);
CREATE INDEX container_access_grantee ON container_access (grantee_company_id, container_id);

CREATE TRIGGER container_access_no_update_delete BEFORE UPDATE OR DELETE ON container_access
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER container_access_no_truncate BEFORE TRUNCATE ON container_access
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();

ALTER TABLE container_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE container_access FORCE ROW LEVEL SECURITY;
CREATE POLICY actor_select ON container_access FOR SELECT
  USING (app_role() IS NOT NULL AND (company_id = app_company_id() OR grantee_company_id = app_company_id()));
CREATE POLICY actor_insert ON container_access FOR INSERT
  WITH CHECK (company_id = app_company_id() AND app_role() = 'cha_ops' AND granted_by_user_id = app_user_id());
GRANT SELECT ON container_access TO colombo_app;
-- id, seq, created_at and granted_by_user_id are server-generated.
GRANT INSERT (company_id, container_id, grantee_company_id, access_kind, action) ON container_access TO colombo_app;

CREATE VIEW active_container_access WITH (security_invoker = true) AS
SELECT latest.company_id AS owner_company_id, latest.container_id, latest.grantee_company_id,
       latest.access_kind, latest.granted_by_user_id, latest.created_at
FROM (
  SELECT DISTINCT ON (company_id, container_id, grantee_company_id)
         company_id, container_id, grantee_company_id, access_kind, action, granted_by_user_id, created_at
  FROM container_access
  ORDER BY company_id, container_id, grantee_company_id, seq DESC
) latest
WHERE latest.action = 'grant';
GRANT SELECT ON active_container_access TO colombo_app;

-- Read side of sharing (permissive policies are OR-ed with the owner policies) ------------------

CREATE POLICY shared_select ON containers FOR SELECT USING (
  app_role() IS NOT NULL AND EXISTS (
    SELECT 1 FROM active_container_access a
    WHERE a.owner_company_id = containers.company_id AND a.container_id = containers.id
      AND a.grantee_company_id = app_company_id())
);

CREATE POLICY shared_select ON events FOR SELECT USING (
  app_role() IS NOT NULL AND EXISTS (
    SELECT 1 FROM active_container_access a
    WHERE a.owner_company_id = events.company_id AND a.container_id = events.container_id
      AND a.grantee_company_id = app_company_id())
);

-- A party can see the other company on a grant (owner <-> grantee), nothing more.
CREATE POLICY shared_select ON companies FOR SELECT USING (
  app_role() IS NOT NULL AND EXISTS (
    SELECT 1 FROM container_access a
    WHERE (a.company_id = companies.company_id AND a.grantee_company_id = app_company_id())
       OR (a.grantee_company_id = companies.company_id AND a.company_id = app_company_id()))
);
