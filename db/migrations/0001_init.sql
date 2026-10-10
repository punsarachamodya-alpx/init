-- 0001_init: tenants, containers, evidence (messages/documents) and the append-only event ledger.
--
-- Rules enforced here (see CLAUDE.md):
--   * every table carries company_id and has row-level security ENABLED and FORCED;
--   * the app role (colombo_app) can only SELECT and INSERT, and only for the company set
--     in the transaction-local setting app.company_id (no setting => no rows, no inserts);
--   * events is append-only: no UPDATE/DELETE/TRUNCATE privilege for the app role, plus
--     statement triggers that reject them for everyone else, the table owner included;
--   * container numbers must pass the ISO 6346 check digit;
--   * every event records its source and its evidence.
-- Migrations are immutable once applied. Add a new file for any change.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'colombo_app') THEN
    CREATE ROLE colombo_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO colombo_app;

-- Company context -------------------------------------------------------------------------

CREATE FUNCTION app_company_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

-- ISO 6346 --------------------------------------------------------------------------------
-- Mirrors src/domain/iso6346.ts and scripts/check-iso6346.mjs. Stored numbers are upper case,
-- 4 letters + 7 digits, last digit = check digit.

CREATE FUNCTION iso6346_valid(container_no text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS
$$
DECLARE
  total integer := 0;
  ch text;
  idx integer;
  val integer;
  i integer;
BEGIN
  IF container_no !~ '^[A-Z]{4}[0-9]{7}$' THEN
    RETURN false;
  END IF;
  FOR i IN 1..10 LOOP
    ch := substr(container_no, i, 1);
    IF ch ~ '[0-9]' THEN
      val := ch::integer;
    ELSE
      idx := ascii(ch) - ascii('A');
      -- letter values start at 10 and skip multiples of 11 (11, 22, 33)
      val := 10 + idx + (CASE WHEN idx >= 1 THEN 1 ELSE 0 END)
                      + (CASE WHEN idx >= 11 THEN 1 ELSE 0 END)
                      + (CASE WHEN idx >= 21 THEN 1 ELSE 0 END);
    END IF;
    total := total + val * (1 << (i - 1));
  END LOOP;
  RETURN ((total % 11) % 10) = substr(container_no, 11, 1)::integer;
END
$$;

-- Tables ----------------------------------------------------------------------------------

CREATE TABLE companies (
  company_id uuid PRIMARY KEY,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  kind       text NOT NULL CONSTRAINT companies_kind CHECK (kind IN ('cha', 'client', 'haulier')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE containers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies (company_id),
  container_no text NOT NULL
    CONSTRAINT containers_container_no_iso6346 CHECK (iso6346_valid(container_no)),
  cargo_type   text NOT NULL DEFAULT 'FCL'
    CONSTRAINT containers_cargo_type CHECK (cargo_type IN ('FCL', 'LCL')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, container_no)
);

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies (company_id),
  channel     text NOT NULL CONSTRAINT messages_channel CHECK (channel IN ('whatsapp', 'email', 'sms', 'web')),
  language    text NOT NULL DEFAULT 'en',
  body        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies (company_id),
  doc_type     text NOT NULL
    CONSTRAINT documents_doc_type CHECK (doc_type IN ('delivery_order', 'delivery_advice', 'cusdec_summary', 'other')),
  text_content text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE TABLE events (
  id                uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  company_id        uuid NOT NULL REFERENCES companies (company_id),
  container_id      uuid NOT NULL,
  event_type        text NOT NULL
    CONSTRAINT events_event_type_chain CHECK (event_type IN (
      'vessel_discharged', 'do_received', 'cusdec_lodged', 'channel_assigned', 'exam',
      'release_advice', 'gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned')),
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  source_type       text NOT NULL CONSTRAINT events_source_type CHECK (source_type IN ('person', 'system')),
  source_ref        text NOT NULL CONSTRAINT events_source_ref CHECK (length(trim(source_ref)) > 0),
  evidence_type     text NOT NULL,
  message_id        uuid,
  document_id       uuid,
  evidence_note     text,
  corrects_event_id uuid,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT events_evidence CHECK (
    (evidence_type = 'message'  AND message_id  IS NOT NULL AND document_id IS NULL AND evidence_note IS NULL) OR
    (evidence_type = 'document' AND document_id IS NOT NULL AND message_id  IS NULL AND evidence_note IS NULL) OR
    (evidence_type = 'manual'   AND evidence_note IS NOT NULL AND length(trim(evidence_note)) > 0
                                AND message_id IS NULL AND document_id IS NULL)
  ),
  UNIQUE (company_id, id),
  UNIQUE (company_id, container_id, id),
  -- Composite foreign keys keep every reference inside one company.
  CONSTRAINT events_container_fk FOREIGN KEY (company_id, container_id) REFERENCES containers (company_id, id),
  CONSTRAINT events_message_fk   FOREIGN KEY (company_id, message_id)   REFERENCES messages (company_id, id),
  CONSTRAINT events_document_fk  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id),
  -- A correction targets an event of the same company and the same container.
  CONSTRAINT events_corrects_fk  FOREIGN KEY (company_id, container_id, corrects_event_id)
    REFERENCES events (company_id, container_id, id)
);

-- An event can be corrected once; correct the correction to change it again.
CREATE UNIQUE INDEX events_one_correction ON events (corrects_event_id) WHERE corrects_event_id IS NOT NULL;
CREATE INDEX events_container_seq ON events (company_id, container_id, seq);

-- Append-only ledger ----------------------------------------------------------------------

CREATE FUNCTION events_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'events is append-only: % is not allowed; append a correction event instead', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

-- Statement-level so they fire even when RLS hides every row from the caller.
CREATE TRIGGER events_no_update_delete BEFORE UPDATE OR DELETE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_reject_mutation();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_reject_mutation();

-- Row-level security ----------------------------------------------------------------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies', 'containers', 'messages', 'documents', 'events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (company_id = app_company_id())', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (company_id = app_company_id())', t);
    -- Deliberately no UPDATE or DELETE policy and no such privilege for the app role.
    EXECUTE format('GRANT SELECT, INSERT ON %I TO colombo_app', t);
  END LOOP;
END
$$;

-- Current status (derived, never stored) ----------------------------------------------------
-- The furthest chain status among events that have not been superseded by a correction;
-- ties go to the most recently recorded event. security_invoker keeps RLS in force.

CREATE VIEW container_current_status WITH (security_invoker = true) AS
SELECT DISTINCT ON (e.company_id, e.container_id)
       e.company_id, e.container_id, e.id AS event_id, e.event_type, e.occurred_at, e.recorded_at,
       e.source_type, e.source_ref, e.evidence_type
FROM events e
WHERE NOT EXISTS (SELECT 1 FROM events c WHERE c.corrects_event_id = e.id)
ORDER BY e.company_id, e.container_id,
         array_position(ARRAY['vessel_discharged', 'do_received', 'cusdec_lodged', 'channel_assigned', 'exam',
                              'release_advice', 'gate_pass', 'truck_dispatched', 'picked_up', 'delivered',
                              'empty_returned'], e.event_type) DESC,
         e.seq DESC;

GRANT SELECT ON container_current_status TO colombo_app;
