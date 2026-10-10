-- 0012_notifications: contacts, an outbox of what to tell whom, and an append-only log of delivery attempts.
--   * user_contacts: WhatsApp / email / SMS addresses and a preferred language per user (insert-only for now;
--     synthetic in tests). A user's own company reads them; so does a CHA for the companies it CURRENTLY SHARES a
--     container with (active grants) (it needs them to notify clients and hauliers). Nobody else.
--   * notifications: the outbox. Immutable rows: kind, recipient, template key and NON-COMMERCIAL parameters only
--     (container number, status, a count). company_id is the sender (the acting company); a sender may notify its
--     own users and the companies it has shared a container with.
--   * notification_attempts: append-only log (channel, sent / failed / skipped, provider reference, error).
--     A notification is pending until a 'sent' attempt exists.
-- No real provider and no queue worker yet: src/notify has the interface, a fake and a logging provider, and a
-- dispatcher function a worker can call.
-- Migrations are immutable once applied. Add a new file for any change.

CREATE TABLE user_contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (company_id),
  user_id    uuid NOT NULL,
  whatsapp   text CONSTRAINT user_contacts_whatsapp CHECK (whatsapp ~ '^\+?[0-9]{7,15}$'),
  email      text CONSTRAINT user_contacts_email CHECK (char_length(email) <= 120 AND email ~ '^[^@\s]+@[^@\s]+$'),
  sms        text CONSTRAINT user_contacts_sms CHECK (sms ~ '^\+?[0-9]{7,15}$'),
  language   text NOT NULL DEFAULT 'en' CONSTRAINT user_contacts_language CHECK (language IN ('en', 'si', 'ta')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_contacts_has_channel CHECK (whatsapp IS NOT NULL OR email IS NOT NULL OR sms IS NOT NULL),
  CONSTRAINT user_contacts_user_fk FOREIGN KEY (company_id, user_id) REFERENCES users (company_id, id),
  CONSTRAINT user_contacts_one_per_user UNIQUE (user_id),
  UNIQUE (company_id, id)
);

-- Safe parameters only: a container number, a chain status, a small count.
CREATE FUNCTION notification_params_ok(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS
$$
  SELECT CASE WHEN jsonb_typeof(p) = 'object' THEN
    (p - ARRAY['container', 'status', 'count']) = '{}'::jsonb
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(p) e
      WHERE jsonb_typeof(e.value) <> 'string'
         OR NOT (
           CASE e.key
             WHEN 'container' THEN (e.value #>> '{}') ~ '^[A-Z]{4}[0-9]{7}$'
             WHEN 'status' THEN (e.value #>> '{}') IN ('vessel_discharged', 'do_received', 'cusdec_lodged', 'channel_assigned', 'exam',
               'release_advice', 'gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned')
             WHEN 'count' THEN (e.value #>> '{}') ~ '^[0-9]{1,4}$'
             ELSE false
           END
         )
    )
  ELSE false END
$$;

CREATE TABLE notifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                  bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  company_id           uuid NOT NULL REFERENCES companies (company_id),   -- the sender (acting company)
  recipient_company_id uuid NOT NULL,
  recipient_user_id    uuid NOT NULL,
  kind                 text NOT NULL CONSTRAINT notifications_kind CHECK (kind IN ('client_status', 'haulier_assigned', 'haulier_cleared', 'suggestion_reminder')),
  params               jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT notifications_params CHECK (notification_params_ok(params)),
  event_id             uuid REFERENCES events (id),
  created_by_user_id   uuid NOT NULL DEFAULT app_user_id() REFERENCES users (id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_recipient_fk FOREIGN KEY (recipient_company_id, recipient_user_id) REFERENCES users (company_id, id),
  UNIQUE (company_id, id)
);

CREATE TABLE notification_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  company_id      uuid NOT NULL REFERENCES companies (company_id),
  notification_id uuid NOT NULL,
  round           integer NOT NULL DEFAULT 1 CONSTRAINT notification_attempts_round CHECK (round BETWEEN 1 AND 50),
  -- NULL only for 'skipped' (no usable channel, so nothing was tried)
  channel         text CONSTRAINT notification_attempts_channel CHECK (channel IN ('whatsapp', 'email', 'sms')),
  outcome         text NOT NULL CONSTRAINT notification_attempts_outcome CHECK (outcome IN ('sent', 'failed', 'skipped')),
  provider_ref    text CONSTRAINT notification_attempts_ref CHECK (char_length(provider_ref) <= 120),
  error           text CONSTRAINT notification_attempts_error CHECK (char_length(error) <= 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_attempts_channel_needed CHECK (channel IS NOT NULL OR outcome = 'skipped'),
  CONSTRAINT notification_attempts_notification_fk FOREIGN KEY (company_id, notification_id) REFERENCES notifications (company_id, id)
);
-- One notification per (event, recipient, kind): re-running the trigger or a sweep cannot double-notify.
CREATE UNIQUE INDEX notifications_one_per_event ON notifications (event_id, recipient_user_id, kind) WHERE event_id IS NOT NULL;
CREATE INDEX notification_attempts_by_notification ON notification_attempts (notification_id, seq);

-- Immutable.
CREATE TRIGGER user_contacts_no_update_delete BEFORE UPDATE OR DELETE ON user_contacts
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER user_contacts_no_truncate BEFORE TRUNCATE ON user_contacts
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER notifications_no_update_delete BEFORE UPDATE OR DELETE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON notifications
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER notification_attempts_no_update_delete BEFORE UPDATE OR DELETE ON notification_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();
CREATE TRIGGER notification_attempts_no_truncate BEFORE TRUNCATE ON notification_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_reject_mutation();

ALTER TABLE user_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_attempts FORCE ROW LEVEL SECURITY;

-- Contacts: own company; and a CHA reads the contacts of companies it has shared a container with.
CREATE POLICY actor_select ON user_contacts FOR SELECT USING (
  app_role() IS NOT NULL AND (
    company_id = app_company_id()
    OR (app_role() = 'cha_ops' AND EXISTS (
      SELECT 1 FROM active_container_access a WHERE a.owner_company_id = app_company_id() AND a.grantee_company_id = user_contacts.company_id))
  )
);
CREATE POLICY actor_insert ON user_contacts FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() IS NOT NULL AND (user_id = app_user_id() OR app_role() = 'cha_ops')
);

-- Outbox: sender's own rows. A sender may address its own users and the companies it has shared a container with.
CREATE POLICY actor_select ON notifications FOR SELECT USING (company_id = app_company_id() AND app_role() IS NOT NULL);
CREATE POLICY actor_insert ON notifications FOR INSERT WITH CHECK (
  company_id = app_company_id() AND app_role() IS NOT NULL AND created_by_user_id = app_user_id()
  AND (
    recipient_company_id = app_company_id()
    OR EXISTS (SELECT 1 FROM active_container_access a WHERE a.owner_company_id = app_company_id() AND a.grantee_company_id = notifications.recipient_company_id)
  )
);

CREATE POLICY actor_select ON notification_attempts FOR SELECT USING (company_id = app_company_id() AND app_role() IS NOT NULL);
CREATE POLICY actor_insert ON notification_attempts FOR INSERT WITH CHECK (company_id = app_company_id() AND app_role() IS NOT NULL);

GRANT SELECT ON user_contacts, notifications, notification_attempts TO colombo_app;
GRANT INSERT (company_id, user_id, whatsapp, email, sms, language) ON user_contacts TO colombo_app;
GRANT INSERT (company_id, recipient_company_id, recipient_user_id, kind, params, event_id) ON notifications TO colombo_app;
GRANT INSERT (company_id, notification_id, round, channel, outcome, provider_ref, error) ON notification_attempts TO colombo_app;
