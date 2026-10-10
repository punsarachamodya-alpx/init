-- 0003_evidence_grants: messages and documents keep server-generated ids and timestamps.
-- Same rule as events (0002): the app role sets only the content columns, never id or
-- received_at. Follow-up from the Prompt 2 re-review.
-- Migrations are immutable once applied. Add a new file for any change.

REVOKE INSERT ON messages, documents FROM colombo_app;
GRANT INSERT (company_id, channel, language, body) ON messages TO colombo_app;
GRANT INSERT (company_id, doc_type, text_content) ON documents TO colombo_app;
