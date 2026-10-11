-- 0013_notification_params_per_kind: a notification row must carry the parameters its template needs.
-- notification_params_ok() (0012) only limits WHICH keys may appear; {} passed for every kind, which let a row exist
-- that cannot be rendered. Rows are immutable, so such a row would stay pending forever.
-- Migrations are immutable once applied. Add a new file for any change.

ALTER TABLE notifications ADD CONSTRAINT notifications_params_for_kind CHECK (
  CASE kind
    WHEN 'client_status' THEN params ?& ARRAY['container', 'status']
    WHEN 'haulier_assigned' THEN params ? 'container'
    WHEN 'haulier_cleared' THEN params ? 'container'
    WHEN 'suggestion_reminder' THEN params ? 'count'
    ELSE false
  END
);
