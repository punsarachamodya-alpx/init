-- 0009_payload_rules: constrain the free text hauliers can read.
-- Hauliers (and clients) read events of the containers shared with them, including payload, source_ref and
-- evidence_note. Key names alone are not a safeguard, so now VALUES are constrained too:
--   yard in the three exam yards; result in the four customs channels; scheduled_at and pickup_window ISO 8601
--   in UTC ('Z' only: timestamps are stored in UTC); reference identifier characters only (a BL-like token);
--   note at most 140 characters; every value a string; payload an object with whitelisted keys only.
--   evidence_note <= 200 and source_ref <= 100 characters.
-- This limits SHAPE, not meaning: a person can still type something silly into a note or reference.
-- Free text is human-entered and visible to hauliers: never enter prices or charges there. Commercial data
-- belongs in tables whose policies require cha_ops or client.
-- Migrations are immutable once applied. Add a new file for any change.

CREATE OR REPLACE FUNCTION payload_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS
$$
  SELECT CASE WHEN jsonb_typeof(p) = 'object' THEN
    (p - ARRAY['yard', 'result', 'note', 'scheduled_at', 'pickup_window', 'reference']) = '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) e
      WHERE jsonb_typeof(e.value) <> 'string'
         OR NOT (
           CASE e.key
             WHEN 'yard' THEN (e.value #>> '{}') IN ('RCT', 'Grayline 1', 'Grayline 2')
             WHEN 'result' THEN (e.value #>> '{}') IN ('green', 'yellow', 'red', 'blue')
             WHEN 'scheduled_at' THEN (e.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
             WHEN 'pickup_window' THEN (e.value #>> '{}') ~
               '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$'
             WHEN 'reference' THEN (e.value #>> '{}') ~ '^[A-Za-z0-9._/-]{1,64}$'
             WHEN 'note' THEN char_length(e.value #>> '{}') <= 140
             ELSE false
           END
         )
    )
  ELSE false END
$$;

-- Re-add the constraint so existing rows are validated against the stricter function.
ALTER TABLE events DROP CONSTRAINT events_payload_keys;
ALTER TABLE events ADD CONSTRAINT events_payload_keys CHECK (payload_ok(payload));

ALTER TABLE events
  ADD CONSTRAINT events_evidence_note_length CHECK (evidence_note IS NULL OR char_length(evidence_note) <= 200),
  ADD CONSTRAINT events_source_ref_length CHECK (char_length(source_ref) <= 100);
