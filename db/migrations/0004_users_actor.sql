-- 0004_users_actor: people, roles and the acting-user context.
--   * users (cha_ops | client | haulier_dispatcher), role tied to the company kind;
--   * app_user_id() / app_role(): the role is read from users under RLS, never supplied by the caller;
--   * containers become consignments: bl_no added, unique per (company, container number, BL), so a
--     recycled container number (or an LCL box) can appear again with a different BL;
--   * the confirming person is a user, filled by the database from the acting user: the free-text
--     confirmed_by column is replaced by confirmed_by_user_id (no pilot data exists; events cannot be
--     backfilled because they are immutable);
--   * containers/events/messages/documents require an acting user; only cha_ops create containers
--     and events (sharing with clients and hauliers arrives in 0005 and 0006).
-- Migrations are immutable once applied. Add a new file for any change.

-- Users ---------------------------------------------------------------------------------------

ALTER TABLE companies ADD CONSTRAINT companies_id_kind_unique UNIQUE (company_id, kind);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  company_kind text NOT NULL,
  role         text NOT NULL CONSTRAINT users_role CHECK (role IN ('cha_ops', 'client', 'haulier_dispatcher')),
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_company_fk FOREIGN KEY (company_id, company_kind) REFERENCES companies (company_id, kind),
  CONSTRAINT users_role_matches_kind CHECK (
    (company_kind = 'cha' AND role = 'cha_ops') OR
    (company_kind = 'client' AND role = 'client') OR
    (company_kind = 'haulier' AND role = 'haulier_dispatcher')
  ),
  UNIQUE (company_id, id)
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON users FOR SELECT USING (company_id = app_company_id());
CREATE POLICY tenant_insert ON users FOR INSERT WITH CHECK (company_id = app_company_id());
-- id and created_at are server-generated. No UPDATE/DELETE: deactivation arrives with authentication.
GRANT SELECT ON users TO colombo_app;
GRANT INSERT (company_id, company_kind, role, display_name) ON users TO colombo_app;

-- Actor context -------------------------------------------------------------------------------

CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- NULL unless the acting user really belongs to the acting company (users is itself under RLS).
CREATE FUNCTION app_role() RETURNS text
LANGUAGE sql STABLE AS
$$ SELECT u.role FROM users u WHERE u.id = app_user_id() AND u.company_id = app_company_id() $$;

-- Consignment identity -------------------------------------------------------------------------

ALTER TABLE containers ADD COLUMN bl_no text NOT NULL CONSTRAINT containers_bl_no CHECK (length(trim(bl_no)) > 0);
ALTER TABLE containers DROP CONSTRAINT containers_company_id_container_no_key;
ALTER TABLE containers ADD CONSTRAINT containers_consignment_unique UNIQUE (company_id, container_no, bl_no);

-- Confirming person ---------------------------------------------------------------------------

ALTER TABLE events DROP COLUMN confirmed_by;
ALTER TABLE events
  ADD COLUMN confirmed_by_user_id uuid NOT NULL DEFAULT app_user_id() REFERENCES users (id);
-- Not in the INSERT column grant: always the acting user, via the default.

-- Role-aware policies ---------------------------------------------------------------------------

DROP POLICY tenant_select ON containers;
DROP POLICY tenant_insert ON containers;
CREATE POLICY actor_select ON containers FOR SELECT USING (company_id = app_company_id() AND app_role() IS NOT NULL);
CREATE POLICY actor_insert ON containers FOR INSERT WITH CHECK (company_id = app_company_id() AND app_role() = 'cha_ops');

DROP POLICY tenant_select ON events;
DROP POLICY tenant_insert ON events;
CREATE POLICY actor_select ON events FOR SELECT USING (company_id = app_company_id() AND app_role() IS NOT NULL);
CREATE POLICY actor_insert ON events FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() = 'cha_ops' AND confirmed_by_user_id = app_user_id()
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages', 'documents'] LOOP
    EXECUTE format('DROP POLICY tenant_select ON %I', t);
    EXECUTE format('DROP POLICY tenant_insert ON %I', t);
    EXECUTE format('CREATE POLICY actor_select ON %I FOR SELECT USING (company_id = app_company_id() AND app_role() IS NOT NULL)', t);
    EXECUTE format('CREATE POLICY actor_insert ON %I FOR INSERT WITH CHECK (company_id = app_company_id() AND app_role() IS NOT NULL)', t);
  END LOOP;
END
$$;
