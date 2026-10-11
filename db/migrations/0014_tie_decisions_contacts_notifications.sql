-- 0014: close gaps the database left to application code (found in review).
--   * intake_decisions: a confirmed decision must point at an event made from THIS suggestion's own evidence (the
--     same message or document), not another suggestion's event or a manual entry; and an event can be claimed by
--     one decision only.
--   * user_contacts: a user adds only their OWN contact. The table holds one immutable row per user, so letting a
--     colleague insert it first would squat (and could redirect) the owner's contact. Append-only versions with an
--     erasure tombstone are a PDPA design decision to make before real data (see SPEC).
--   * notifications: an event reference must be an event the sender can see (row-level security applies to the
--     lookup), so the foreign key cannot be used to probe for events of other companies.
-- Migrations are immutable once applied. Add a new file for any change.

CREATE UNIQUE INDEX intake_decisions_one_per_event ON intake_decisions (event_id) WHERE event_id IS NOT NULL;

DROP POLICY actor_insert ON intake_decisions;
CREATE POLICY actor_insert ON intake_decisions FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() IS NOT NULL AND decided_by_user_id = app_user_id()
  AND (
    decision = 'rejected'
    OR EXISTS (  -- a confirmed decision points at an event THIS person just recorded from THIS suggestion's evidence
      SELECT 1
      FROM events e
      JOIN intake_suggestions s ON s.id = intake_decisions.suggestion_id
      WHERE e.id = intake_decisions.event_id
        AND e.recorded_by_company_id = app_company_id()
        AND e.confirmed_by_user_id = app_user_id()
        AND e.message_id IS NOT DISTINCT FROM s.message_id
        AND e.document_id IS NOT DISTINCT FROM s.document_id)
  )
);

DROP POLICY actor_insert ON user_contacts;
CREATE POLICY actor_insert ON user_contacts FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() IS NOT NULL AND user_id = app_user_id()
);

DROP POLICY actor_insert ON notifications;
CREATE POLICY actor_insert ON notifications FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() IS NOT NULL AND created_by_user_id = app_user_id()
  AND (
    recipient_company_id = app_company_id()
    OR EXISTS (SELECT 1 FROM active_container_access a WHERE a.owner_company_id = app_company_id() AND a.grantee_company_id = notifications.recipient_company_id)
  )
  AND (event_id IS NULL OR EXISTS (SELECT 1 FROM events e WHERE e.id = notifications.event_id))
);
