-- 0007_actor_context: the database stops trusting app.company_id / app.user_id.
--
-- Until now the application role could set those two settings itself (set_config), so any SQL it
-- could be made to run (a bug, an injection) could act as any company and user whose ids it knew,
-- and grantees can see CHA company and user ids. Identity is now a SIGNED token:
--   app.actor = v1.<company uuid>.<user uuid or ->.<expiry epoch>.<hex HMAC-SHA256>
-- minted by the application (src/db/actorToken.ts, secret ACTOR_CONTEXT_SECRET) and verified here
-- against a key held in actor_key, which the application role cannot read, write or delete.
-- Verification fails closed: any malformed, tampered, expired, unsigned or key-less token yields NULL,
-- so every policy (all of which call app_company_id() / app_user_id()) sees "nobody".
-- verified_actor_parts() is the ONLY SECURITY DEFINER function; its search_path is pinned.
-- Key provisioning: scripts/set-actor-key.ts as the owner role (the test harness sets a throwaway key).
-- Migrations are immutable once applied. Add a new file for any change.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE actor_key (
  id     boolean PRIMARY KEY DEFAULT true CONSTRAINT actor_key_single_row CHECK (id),
  key    bytea NOT NULL CONSTRAINT actor_key_length CHECK (octet_length(key) >= 32),
  set_at timestamptz NOT NULL DEFAULT now()
);
-- Infrastructure table (like schema_migrations): no company_id, no grants to anyone but the owner.
REVOKE ALL ON actor_key FROM PUBLIC;

CREATE FUNCTION verified_actor_parts() RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
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
  IF p[4]::bigint < extract(epoch FROM now())::bigint THEN RETURN NULL; END IF;  -- expiry (transaction start time)

  RETURN ARRAY[p[2], CASE WHEN p[3] = '-' THEN '' ELSE p[3] END];
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

-- Same names and signatures as before, so every policy and column default keeps working unchanged.
CREATE OR REPLACE FUNCTION app_company_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT (verified_actor_parts())[1]::uuid $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif((verified_actor_parts())[2], '')::uuid $$;
