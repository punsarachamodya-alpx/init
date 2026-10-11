-- 0006_shared_events: clients and hauliers record their own stages in the owning CHA's ledger.
--   * events.company_id stays the owning CHA (whose ledger it is); recorded_by_company_id is the
--     company that recorded it (default = acting company, not insertable);
--   * evidence and the confirming user belong to the RECORDER (composite FKs on recorded_by_company_id);
--   * event_allowed(role, type) is the single permission matrix (mirrored in src/domain/statusChain.ts,
--     parity-tested): cha_ops = clearance stages, client = clearance stages on shared containers,
--     haulier_dispatcher = trucking stages on assigned containers (SPEC section 2);
--   * a correction may supersede only a stage type the corrector could record;
--   * payload is non-commercial by construction because hauliers read events: only whitelisted keys,
--     scalar values. Adding a key takes a migration.
-- Migrations are immutable once applied. Add a new file for any change.

-- Recorder ------------------------------------------------------------------------------------

ALTER TABLE events
  ADD COLUMN recorded_by_company_id uuid NOT NULL DEFAULT app_company_id() REFERENCES companies (company_id);
-- Not in the INSERT column grant: always the acting company, via the default.

ALTER TABLE events DROP CONSTRAINT events_message_fk;
ALTER TABLE events DROP CONSTRAINT events_document_fk;
ALTER TABLE events
  ADD CONSTRAINT events_message_fk  FOREIGN KEY (recorded_by_company_id, message_id)  REFERENCES messages (company_id, id),
  ADD CONSTRAINT events_document_fk FOREIGN KEY (recorded_by_company_id, document_id) REFERENCES documents (company_id, id),
  ADD CONSTRAINT events_confirmer_fk FOREIGN KEY (recorded_by_company_id, confirmed_by_user_id) REFERENCES users (company_id, id);

-- Permission matrix -------------------------------------------------------------------------------

CREATE FUNCTION event_allowed(role text, event_type text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS
$$
  SELECT CASE role
    WHEN 'cha_ops' THEN event_type IN
      ('vessel_discharged', 'do_received', 'cusdec_lodged', 'channel_assigned', 'exam', 'release_advice')
    WHEN 'client' THEN event_type IN
      ('do_received', 'cusdec_lodged', 'channel_assigned', 'exam', 'release_advice')
    WHEN 'haulier_dispatcher' THEN event_type IN
      ('gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned')
    ELSE false
  END
$$;

-- Non-commercial payload ------------------------------------------------------------------------------

CREATE FUNCTION payload_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS
$$
  SELECT jsonb_typeof(p) = 'object'
     AND (p - ARRAY['yard', 'result', 'note', 'scheduled_at', 'pickup_window', 'reference']) = '{}'::jsonb
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(p) e WHERE jsonb_typeof(e.value) IN ('object', 'array'))
$$;

ALTER TABLE events ADD CONSTRAINT events_payload_keys CHECK (payload_ok(payload));

-- Correction scope ---------------------------------------------------------------------------------
-- Type of the event being superseded, as visible to the caller (invoker rights: RLS applies). It is a
-- plpgsql function so the policy below can use it without recursing into the events policies.

CREATE FUNCTION correction_target_type(target uuid) RETURNS text
LANGUAGE plpgsql STABLE AS
$$
DECLARE
  found text;
BEGIN
  SELECT t.event_type INTO found FROM events t WHERE t.id = target;
  RETURN found;
END
$$;

-- Write policy ----------------------------------------------------------------------------------------

DROP POLICY actor_insert ON events;
CREATE POLICY actor_insert ON events FOR INSERT WITH CHECK (
  recorded_by_company_id = app_company_id()
  AND confirmed_by_user_id = app_user_id()
  AND event_allowed(app_role(), event_type)
  AND (
    company_id = app_company_id()
    OR EXISTS (
      SELECT 1 FROM active_container_access a
      WHERE a.owner_company_id = events.company_id AND a.container_id = events.container_id
        AND a.grantee_company_id = app_company_id())
  )
  -- A correction may supersede only a stage the corrector could record. If the target is missing or
  -- invisible, reference integrity (composite FK) rejects it instead.
  AND (
    corrects_event_id IS NULL
    OR coalesce(event_allowed(app_role(), correction_target_type(corrects_event_id)), true)
  )
);
