-- Migration: Nostr DM-based OTP auth + invite DM pending flag
-- Run: psql -h <host> -U butter -d unsaltedbutter -f scripts/migrate-nostr-auth.sql

BEGIN;

CREATE TABLE IF NOT EXISTS nostr_otp (
    npub_hex    TEXT PRIMARY KEY,       -- one active OTP per npub (upsert)
    code        TEXT NOT NULL UNIQUE,   -- 12-digit numeric, displayed as XXXXXX-XXXXXX
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nostr_otp_code ON nostr_otp(code);

ALTER TABLE waitlist
    ADD COLUMN IF NOT EXISTS invite_dm_pending BOOLEAN DEFAULT FALSE;

COMMIT;
