-- 0002_ledger_hardening: findings from the Prompt 2 domain review.
--   * ledger order and time can no longer be supplied by the app role (id, seq, recorded_at
--     always come from column defaults), seq is unique, and an event cannot supersede itself;
--   * messages and documents (the evidence) are append-only like events;
--   * every event records the person who confirmed it (CLAUDE.md: a person confirms every
--     extracted field). source_* stays the reporter (driver, intake, staff); confirmed_by is the
--     human. NOT NULL is safe to add: the pilot has no data yet, and event rows cannot be
--     backfilled because they are immutable.
-- Migrations are immutable once applied. Add a new file for any change.

-- Human confirmation -------------------------------------------------------------------------

ALTER TABLE events
  ADD COLUMN confirmed_by text NOT NULL
    CONSTRAINT events_confirmed_by CHECK (length(trim(confirmed_by)) > 0);

-- Ordering integrity ---------------------------------------------------------------------------

ALTER TABLE events ADD CONSTRAINT events_seq_unique UNIQUE (seq);
ALTER TABLE events ADD CONSTRAINT events_no_self_correction CHECK (corrects_event_id IS DISTINCT FROM id);

-- The app role may set only these columns; id, seq and recorded_at are server-generated.
REVOKE INSERT ON events FROM colombo_app;
GRANT INSERT (company_id, container_id, event_type, occurred_at, source_type, source_ref,
              evidence_type, message_id, document_id, evidence_note, corrects_event_id, payload,
              confirmed_by)
  ON events TO colombo_app;

-- Evidence is append-only -----------------------------------------------------------------------

CREATE FUNCTION evidence_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

-- Statement-level so they fire even when RLS hides every row from the caller.
CREATE TRIGGER messages_no_update_delete BEFORE UPDATE OR DELETE ON messages
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER messages_no_truncate BEFORE TRUNCATE ON messages
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER documents_no_update_delete BEFORE UPDATE OR DELETE ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
