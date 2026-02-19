-- migrate-v4-security-fixes.sql
-- Security audit fixes: FK behavior, missing constraints, duplicate job prevention
--
-- What this fixes:
--   H5: operator_alerts.related_user_id FK missing ON DELETE SET NULL,
--       which blocks user deletion if any alert references them
--   M4: waitlist.nostr_npub lacks a UNIQUE constraint, allowing duplicate
--       entries via concurrent inserts (TOCTOU race)
--   L6: No partial unique index on jobs to prevent duplicate active jobs
--       per user+service from concurrent cron runs
--
-- Idempotent: safe to run multiple times.
--
-- Run against dev DB:
--   psql -h 192.168.5.188 -U butter -d unsaltedbutter -f scripts/migrate-v4-security-fixes.sql
--
-- Run against prod:
--   scp to VPS, then: sudo -u postgres psql -d unsaltedbutter -f migrate-v4-security-fixes.sql

BEGIN;

-- ============================================================
-- H5: Fix operator_alerts FK to allow user deletion
-- ============================================================
-- The old FK on related_user_id defaulted to ON DELETE RESTRICT,
-- meaning any alert referencing a user blocks that user's deletion.
-- This violates the constraint that all user data is destroyed on
-- membership end. SET NULL preserves the alert for operator history
-- while allowing the user row to be deleted.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'operator_alerts_related_user_id_fkey'
    AND table_name = 'operator_alerts'
  ) THEN
    ALTER TABLE operator_alerts DROP CONSTRAINT operator_alerts_related_user_id_fkey;
    ALTER TABLE operator_alerts ADD CONSTRAINT operator_alerts_related_user_id_fkey
      FOREIGN KEY (related_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- M4: Add UNIQUE constraint on waitlist.nostr_npub
-- ============================================================
-- The old schema had a plain index (idx_waitlist_npub) but no UNIQUE
-- constraint, so concurrent inserts could create duplicate waitlist
-- entries for the same npub. The unique constraint replaces the index.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'waitlist_nostr_npub_unique'
  ) THEN
    -- Drop existing non-unique index if present
    DROP INDEX IF EXISTS idx_waitlist_npub;
    ALTER TABLE waitlist ADD CONSTRAINT waitlist_nostr_npub_unique UNIQUE (nostr_npub);
  END IF;
END $$;

-- ============================================================
-- L6: Prevent duplicate active jobs per user+service
-- ============================================================
-- Two concurrent cron runs can create duplicate pending jobs for the
-- same user+service because the idempotency check is application-level
-- only. This partial unique index enforces it at the database level.
-- "Active" means any status that is not a terminal state.

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_user_service
ON jobs (user_id, service_id)
WHERE status NOT IN (
  'completed_paid', 'completed_eventual', 'completed_reneged',
  'user_skip', 'user_abandon', 'implied_skip', 'failed'
);

COMMIT;
