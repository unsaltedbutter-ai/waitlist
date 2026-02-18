-- 002_fix_fk_cascades_and_indexes.sql
-- Migration: fix FK cascades, add missing indexes, remove redundant indexes, add updated_at
--
-- Run: psql -U butter -d unsaltedbutter -f scripts/migrations/002_fix_fk_cascades_and_indexes.sql
--
-- All statements are idempotent where possible (IF EXISTS / IF NOT EXISTS).
-- Safe to re-run.

BEGIN;

-- ============================================================
-- 1. Fix FK cascade on operator_alerts.related_job_id (HIGH)
-- ============================================================
-- Problem: Deleting a user cascades to delete their jobs, but operator_alerts
-- still references those jobs with no cascade rule, causing a FK violation.
-- Fix: SET NULL on delete so the alert survives but loses its job reference.

ALTER TABLE operator_alerts DROP CONSTRAINT IF EXISTS operator_alerts_related_job_id_fkey;
ALTER TABLE operator_alerts ADD CONSTRAINT operator_alerts_related_job_id_fkey
  FOREIGN KEY (related_job_id) REFERENCES jobs(id) ON DELETE SET NULL;

-- ============================================================
-- 2. Fix FK cascade on transactions.job_id (HIGH)
-- ============================================================
-- Problem: Deleting a job independently (not via user cascade) fails if
-- transactions still reference it. Transactions should follow their job.
-- Fix: CASCADE on delete so transactions are removed with their job.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_job_id_fkey;
ALTER TABLE transactions ADD CONSTRAINT transactions_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;

-- ============================================================
-- 3. Add missing index on jobs.invoice_id (MEDIUM)
-- ============================================================
-- Problem: The agent invoices endpoint queries WHERE invoice_id = $1.
-- Without an index this is a sequential scan on the jobs table.
-- Partial index: most jobs have NULL invoice_id until payment is created.

CREATE INDEX IF NOT EXISTS idx_jobs_invoice_id ON jobs(invoice_id)
  WHERE invoice_id IS NOT NULL;

-- ============================================================
-- 4. Add missing index on jobs.created_at (MEDIUM)
-- ============================================================
-- Problem: The operator metrics endpoint queries jobs by creation date.
-- Will degrade as the jobs table grows.

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);

-- ============================================================
-- 5. Remove redundant indexes (LOW)
-- ============================================================
-- The UNIQUE constraint on nostr_otp.code already creates an implicit index.
-- The UNIQUE(user_id, position) on rotation_queue already creates an implicit index.
-- Explicit indexes on the same columns are redundant.

DROP INDEX IF EXISTS idx_nostr_otp_code;
DROP INDEX IF EXISTS idx_rotation_queue_user;

-- ============================================================
-- 6. Add updated_at to streaming_credentials (LOW)
-- ============================================================
-- Problem: No way to know when credentials were last updated.
-- The upsert should set updated_at on every write.

ALTER TABLE streaming_credentials ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMIT;
