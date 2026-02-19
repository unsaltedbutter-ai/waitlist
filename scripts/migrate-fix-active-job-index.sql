-- Fix idx_jobs_active_user_service: add 'failed' to terminal statuses.
--
-- The original migration (migrate-v4-security-fixes.sql) omitted 'failed'
-- from the exclusion list. This means a failed job blocks creating a new
-- job for the same user+service, preventing retry after failure.
--
-- The canonical SCHEMA.sql includes 'failed'. This migration brings
-- production in line with the schema.
--
-- Run: sudo -u postgres psql -d unsaltedbutter -f migrate-fix-active-job-index.sql

BEGIN;

DROP INDEX IF EXISTS idx_jobs_active_user_service;

CREATE UNIQUE INDEX idx_jobs_active_user_service
ON jobs (user_id, service_id)
WHERE status NOT IN (
  'completed_paid', 'completed_eventual', 'completed_reneged',
  'user_skip', 'user_abandon', 'implied_skip', 'failed'
);

COMMIT;
