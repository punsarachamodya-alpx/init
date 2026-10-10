-- 0008_voids: undo a false event without deleting it, and stop the correction check failing open.
--   * events.correction_kind: NULL (ordinary event), 'replace' (supersedes another event with a new one) or
--     'void' (retracts another event, no replacement). A void carries the voided event's own type, evidence
--     (the reason) and no payload. container_current_status ignores voided events and the void rows.
--   * Who may void: the OWNING CHA may void any event on its own ledger, including a trucking event it
--     could not record (e.g. a false 'delivered' from a haulier that is no longer assigned); everyone else
--     only what their role may record (the same scope as a correction). A void cannot be voided or replaced.
--   * The correction check no longer fails open: a missing or invisible target is refused with the same
--     row-level-security error, so events_one_correction cannot answer "has event X been corrected?".
-- Migrations are immutable once applied. Add a new file for any change.

ALTER TABLE events
  ADD COLUMN correction_kind text CONSTRAINT events_correction_kind CHECK (correction_kind IN ('replace', 'void'));
ALTER TABLE events
  ADD CONSTRAINT events_kind_needs_target CHECK (correction_kind IS NULL OR corrects_event_id IS NOT NULL),
  ADD CONSTRAINT events_void_has_no_payload CHECK (correction_kind IS DISTINCT FROM 'void' OR payload = '{}'::jsonb);

GRANT INSERT (correction_kind) ON events TO colombo_app;

-- Invoker-rights lookup of the target's kind (RLS applies), like correction_target_type().
CREATE FUNCTION correction_target_kind(target uuid) RETURNS text
LANGUAGE plpgsql STABLE AS
$$
DECLARE
  found text;
BEGIN
  SELECT t.correction_kind INTO found FROM events t WHERE t.id = target;
  RETURN found;
END
$$;

DROP POLICY actor_insert ON events;
CREATE POLICY actor_insert ON events FOR INSERT WITH CHECK (
  recorded_by_company_id = app_company_id()
  AND confirmed_by_user_id = app_user_id()
  AND (
    company_id = app_company_id()
    OR EXISTS (
      SELECT 1 FROM active_container_access a
      WHERE a.owner_company_id = events.company_id AND a.container_id = events.container_id
        AND a.grantee_company_id = app_company_id())
  )
  AND CASE
    WHEN correction_kind = 'void' THEN
      corrects_event_id IS NOT NULL
      AND event_type = correction_target_type(corrects_event_id)
      AND correction_target_kind(corrects_event_id) IS DISTINCT FROM 'void'
      AND ((company_id = app_company_id() AND app_role() = 'cha_ops') OR event_allowed(app_role(), event_type))
    ELSE
      event_allowed(app_role(), event_type)
      AND (
        corrects_event_id IS NULL
        OR (event_allowed(app_role(), correction_target_type(corrects_event_id))
            AND correction_target_kind(corrects_event_id) IS DISTINCT FROM 'void')
      )
  END
);

CREATE OR REPLACE VIEW container_current_status WITH (security_invoker = true) AS
SELECT DISTINCT ON (e.company_id, e.container_id)
       e.company_id, e.container_id, e.id AS event_id, e.event_type, e.occurred_at, e.recorded_at,
       e.source_type, e.source_ref, e.evidence_type
FROM events e
WHERE NOT EXISTS (SELECT 1 FROM events c WHERE c.corrects_event_id = e.id)
  AND e.correction_kind IS DISTINCT FROM 'void'
ORDER BY e.company_id, e.container_id,
         array_position(ARRAY['vessel_discharged', 'do_received', 'cusdec_lodged', 'channel_assigned', 'exam',
                              'release_advice', 'gate_pass', 'truck_dispatched', 'picked_up', 'delivered',
                              'empty_returned'], e.event_type) DESC,
         e.seq DESC;
