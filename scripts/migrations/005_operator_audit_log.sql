-- 005_operator_audit_log.sql
-- Operator audit log for tracking manual member management actions.

CREATE TABLE IF NOT EXISTS operator_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_created ON operator_audit_log (created_at DESC);
