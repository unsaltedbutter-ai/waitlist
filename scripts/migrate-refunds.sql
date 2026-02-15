-- Pending Refunds: snapshot contact + credit balance before account deletion
-- Run: psql -U butter -d unsaltedbutter -f scripts/migrate-refunds.sql

BEGIN;

CREATE TABLE IF NOT EXISTS pending_refunds (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact      TEXT NOT NULL,
    amount_sats  BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
