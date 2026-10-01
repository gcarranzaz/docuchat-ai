-- Migration: append-only audit log
-- Purpose: answer "who did what, to what, when, with which model" (docs/AI-DATA.md).
--
-- - actor_user_id has NO foreign key on purpose: the trail must outlive the account it
--   describes (deleting an account removes the user's data, not the record that it happened).
--   It holds an opaque id, not an email or a name.
-- - metadata holds facts about the event (model, prompt version, token counts, outcome codes),
--   never message text. The audit service redacts and truncates it as a second line of defence.
-- - Append-only is enforced by the database, not by convention: UPDATE, DELETE and TRUNCATE
--   are refused by a trigger. The only way rows disappear is the retention job, which sets
--   a transaction-local flag. In production, give the application role INSERT/SELECT only on
--   this table and run retention under a separate maintenance role (docs/DEPLOYMENT.md).

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_user_id UUID,
    action VARCHAR(64) NOT NULL,
    outcome VARCHAR(16) NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'denied', 'error')),
    resource_type VARCHAR(32),
    resource_id VARCHAR(64),
    request_id VARCHAR(64),
    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log (occurred_at);

CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
    -- The retention job opts in for the length of its own transaction
    IF TG_OP IN ('DELETE', 'TRUNCATE') AND current_setting('app.audit_purge', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NULL;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_rows ON audit_log;
CREATE TRIGGER trg_audit_log_rows
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_guard();

DROP TRIGGER IF EXISTS trg_audit_log_truncate ON audit_log;
CREATE TRIGGER trg_audit_log_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
