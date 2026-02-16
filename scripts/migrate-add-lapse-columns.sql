-- Add lapse tracking columns to subscriptions table.
-- Safe to run multiple times (IF NOT EXISTS).
-- Run: psql -d unsaltedbutter -f scripts/migrate-add-lapse-columns.sql

BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS estimated_lapse_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS actual_lapsed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_subscriptions_lapse
    ON subscriptions(estimated_lapse_at) WHERE status = 'lapsing';

COMMIT;
