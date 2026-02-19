-- 008: Add 'failed' to jobs status CHECK constraint and billing_date index.
--
-- The v3-to-v4 migration created the jobs table without 'failed' in the
-- status CHECK. SCHEMA.sql was updated but this was never migrated.
--
-- Run: ssh butter@178.156.253.212
--      sudo -u postgres psql -d unsaltedbutter -f /tmp/008-add-failed-status.sql

BEGIN;

-- 1. Replace jobs_status_check to include 'failed'
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN (
    'pending', 'dispatched',
    'outreach_sent', 'snoozed',
    'active', 'awaiting_otp',
    'completed_paid', 'completed_eventual', 'completed_reneged',
    'user_skip', 'user_abandon', 'implied_skip',
    'failed'
));

-- 2. Recreate idx_jobs_billing_date to exclude 'failed' from active set
DROP INDEX IF EXISTS idx_jobs_billing_date;
CREATE INDEX idx_jobs_billing_date ON jobs(billing_date) WHERE status NOT IN (
    'completed_paid', 'completed_eventual', 'completed_reneged',
    'user_skip', 'user_abandon', 'implied_skip', 'failed'
);

COMMIT;
