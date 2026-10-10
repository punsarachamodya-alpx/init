-- 0011_intake_persistence: suggestions and the decisions about them are stored, immutable, and decided once.
--   * intake_suggestions: what extraction proposed (status, event type, extracted fields, issues) pointing at
--     exactly one piece of company-private evidence (a message or a document). Immutable.
--   * intake_decisions: one row per suggestion at most (UNIQUE (suggestion_id)): confirmed (pointing at the
--     event this person recorded) or rejected (with a reason). A second or concurrent confirm cannot succeed:
--     the unique index makes the loser's whole transaction roll back, event included.
-- Both are company-private like messages/documents. The server loads a suggestion's status and evidence from
-- here; a browser never supplies them.
-- Migrations are immutable once applied. Add a new file for any change.

CREATE TABLE intake_suggestions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                   bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  company_id            uuid NOT NULL REFERENCES companies (company_id),
  message_id            uuid,
  document_id           uuid,
  status                text NOT NULL CONSTRAINT intake_suggestions_status CHECK (status IN ('ready', 'needs_review', 'rejected', 'failed')),
  event_type            text CONSTRAINT intake_suggestions_event_type CHECK (event_type IN (
    'vessel_discharged', 'do_received', 'cusdec_lodged', 'channel_assigned', 'exam',
    'release_advice', 'gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned')),
  doc_type              text CONSTRAINT intake_suggestions_doc_type CHECK (doc_type IN ('delivery_order', 'delivery_advice', 'cusdec_summary', 'other')),
  language              text,
  fields                jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT intake_suggestions_fields CHECK (jsonb_typeof(fields) = 'object'),
  issues                jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT intake_suggestions_issues CHECK (jsonb_typeof(issues) = 'array'),
  suggested_occurred_at timestamptz,
  extractor             text NOT NULL CONSTRAINT intake_suggestions_extractor CHECK (char_length(extractor) BETWEEN 1 AND 80),
  created_by_user_id    uuid NOT NULL DEFAULT app_user_id() REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intake_suggestions_one_evidence CHECK ((message_id IS NOT NULL) <> (document_id IS NOT NULL)),
  CONSTRAINT intake_suggestions_message_fk  FOREIGN KEY (company_id, message_id)  REFERENCES messages (company_id, id),
  CONSTRAINT intake_suggestions_document_fk FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id),
  UNIQUE (company_id, id)
);

CREATE TABLE intake_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies (company_id),
  suggestion_id      uuid NOT NULL,
  decision           text NOT NULL CONSTRAINT intake_decisions_decision CHECK (decision IN ('confirmed', 'rejected')),
  event_id           uuid REFERENCES events (id),
  final_fields       jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT intake_decisions_fields CHECK (jsonb_typeof(final_fields) = 'object'),
  reason             text CONSTRAINT intake_decisions_reason CHECK (char_length(reason) <= 200),
  decided_by_user_id uuid NOT NULL DEFAULT app_user_id() REFERENCES users (id),
  decided_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intake_decisions_suggestion_fk FOREIGN KEY (company_id, suggestion_id) REFERENCES intake_suggestions (company_id, id),
  CONSTRAINT intake_decisions_one UNIQUE (suggestion_id),
  CONSTRAINT intake_decisions_shape CHECK (
    (decision = 'confirmed' AND event_id IS NOT NULL) OR
    (decision = 'rejected' AND event_id IS NULL AND reason IS NOT NULL AND length(trim(reason)) > 0)
  )
);

-- Immutable (the same statement-level triggers as the evidence tables).
CREATE TRIGGER intake_suggestions_no_update_delete BEFORE UPDATE OR DELETE ON intake_suggestions
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER intake_suggestions_no_truncate BEFORE TRUNCATE ON intake_suggestions
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER intake_decisions_no_update_delete BEFORE UPDATE OR DELETE ON intake_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER intake_decisions_no_truncate BEFORE TRUNCATE ON intake_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();

ALTER TABLE intake_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_suggestions FORCE ROW LEVEL SECURITY;
ALTER TABLE intake_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY actor_select ON intake_suggestions FOR SELECT USING (company_id = app_company_id() AND app_role() IS NOT NULL);
CREATE POLICY actor_insert ON intake_suggestions FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() IS NOT NULL AND created_by_user_id = app_user_id()
);

CREATE POLICY actor_select ON intake_decisions FOR SELECT USING (company_id = app_company_id() AND app_role() IS NOT NULL);
CREATE POLICY actor_insert ON intake_decisions FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() IS NOT NULL AND decided_by_user_id = app_user_id()
  AND (
    decision = 'rejected'
    OR EXISTS (  -- a confirmed decision must point at an event THIS person just recorded
      SELECT 1 FROM events e
      WHERE e.id = intake_decisions.event_id
        AND e.recorded_by_company_id = app_company_id()
        AND e.confirmed_by_user_id = app_user_id())
  )
);

GRANT SELECT ON intake_suggestions, intake_decisions TO colombo_app;
-- id, seq, created_by_user_id, created_at, decided_by_user_id and decided_at are server-generated.
GRANT INSERT (company_id, message_id, document_id, status, event_type, doc_type, language, fields, issues,
              suggested_occurred_at, extractor) ON intake_suggestions TO colombo_app;
GRANT INSERT (company_id, suggestion_id, decision, event_id, final_fields, reason) ON intake_decisions TO colombo_app;

ALTER FUNCTION evidence_reject_mutation() SET search_path = pg_catalog, public, pg_temp;
