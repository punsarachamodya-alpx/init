-- 0010_search_path_hardening: close the temp-table shadowing hole and make identity failures loud.
--
-- Problem (found by review): app_role(), correction_target_type() and correction_target_kind() read
-- `users` / `events` by UNQUALIFIED name with no pinned search_path, and colombo_app could create TEMP
-- tables. Postgres searches pg_temp first for relations, so SQL running as the application role could
-- `CREATE TEMP TABLE users (...)` with its own cha_ops row and be treated as a CHA (and the temp table
-- would survive on a pooled connection). The signed actor token was never affected; everything
-- downstream of it was.
--
-- Fixes: every function we own pins `search_path = pg_catalog, public, pg_temp` (pg_temp LAST) and the
-- table-reading ones qualify `public.`; the application role (and PUBLIC) lose TEMPORARY on the database;
-- the verifier no longer swallows genuine faults (only data errors), checks pgcrypto is where it expects,
-- and expiry is compared on whole seconds; actor_key gets row-level security with no policy as defence in
-- depth against a future blanket GRANT.
-- Migrations are immutable once applied. Add a new file for any change.

DO $$
BEGIN
  IF to_regprocedure('public.hmac(bytea,bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto hmac(bytea,bytea,text) must be installed in schema public';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION verified_actor_parts() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS
$$
DECLARE
  token   text := current_setting('app.actor', true);
  p       text[];
  k       bytea;
  message text;
BEGIN
  IF token IS NULL OR token = '' THEN RETURN NULL; END IF;
  p := string_to_array(token, '.');
  IF array_length(p, 1) <> 5 OR p[1] <> 'v1' THEN RETURN NULL; END IF;
  IF p[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  IF p[3] <> '-' AND p[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  IF p[4] !~ '^[0-9]{1,12}$' OR p[5] !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;

  SELECT a.key INTO k FROM public.actor_key a WHERE a.id;
  IF k IS NULL THEN RETURN NULL; END IF;

  message := p[1] || '.' || p[2] || '.' || p[3] || '.' || p[4];
  IF encode(public.hmac(convert_to(message, 'UTF8'), k, 'sha256'), 'hex') <> p[5] THEN RETURN NULL; END IF;
  IF p[4]::bigint < floor(extract(epoch FROM now()))::bigint THEN RETURN NULL; END IF;  -- expiry (transaction start)

  RETURN ARRAY[p[2], CASE WHEN p[3] = '-' THEN '' ELSE p[3] END];
EXCEPTION WHEN data_exception THEN
  RETURN NULL;   -- a malformed value; genuine faults (missing table, lock timeout) are NOT swallowed
END
$$;

CREATE OR REPLACE FUNCTION app_company_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT (public.verified_actor_parts())[1]::uuid $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT nullif((public.verified_actor_parts())[2], '')::uuid $$;

CREATE OR REPLACE FUNCTION app_role() RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT u.role FROM public.users u WHERE u.id = public.app_user_id() AND u.company_id = public.app_company_id() $$;

CREATE OR REPLACE FUNCTION correction_target_type(target uuid) RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS
$$
DECLARE
  found text;
BEGIN
  SELECT t.event_type INTO found FROM public.events t WHERE t.id = target;
  RETURN found;
END
$$;

CREATE OR REPLACE FUNCTION correction_target_kind(target uuid) RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS
$$
DECLARE
  found text;
BEGIN
  SELECT t.correction_kind INTO found FROM public.events t WHERE t.id = target;
  RETURN found;
END
$$;

-- Every other function we own: pin the path too.
ALTER FUNCTION iso6346_valid(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION event_allowed(text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION payload_ok(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION events_reject_mutation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION evidence_reject_mutation() SET search_path = pg_catalog, public, pg_temp;

-- No temporary tables for anyone but the owner.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM colombo_app', current_database());
END
$$;

-- Defence in depth: even a blanket GRANT SELECT could not expose the key (the owner-run verifier is exempt).
ALTER TABLE actor_key ENABLE ROW LEVEL SECURITY;
