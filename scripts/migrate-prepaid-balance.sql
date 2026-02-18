-- migrate-prepaid-balance.sql
-- Migration: Solo/Duo tiers + membership billing -> prepaid sats balance
--
-- Run against dev DB:
--   psql -h 192.168.5.188 -U butter -d unsaltedbutter -f scripts/migrate-prepaid-balance.sql
--
-- Run against prod:
--   scp to VPS, then: sudo -u postgres psql -d unsaltedbutter -f migrate-prepaid-balance.sql

BEGIN;

-- ============================================================
-- 1. DROP tables that no longer exist
-- ============================================================

DROP TABLE IF EXISTS membership_payments CASCADE;
DROP TABLE IF EXISTS membership_pricing CASCADE;

-- ============================================================
-- 2. ALTER users: drop old columns, add new ones, change status CHECK
-- ============================================================

-- Drop old columns
ALTER TABLE users DROP COLUMN IF EXISTS membership_plan;
ALTER TABLE users DROP COLUMN IF EXISTS billing_period;
ALTER TABLE users DROP COLUMN IF EXISTS membership_expires_at;
ALTER TABLE users DROP COLUMN IF EXISTS free_days_remaining;

-- Add new columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

-- Change status CHECK constraint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
    CHECK (status IN ('active', 'paused', 'auto_paused'));

-- Change default status for new users
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'auto_paused';

-- Migrate existing active users to auto_paused (they need to re-onboard or deposit)
UPDATE users SET status = 'auto_paused' WHERE status IN ('active', 'expiring', 'churned');

-- Drop old index that references membership_expires_at
DROP INDEX IF EXISTS idx_users_expires;

-- ============================================================
-- 3. ALTER rotation_slots: restrict to slot_number = 1 only
-- ============================================================

ALTER TABLE rotation_slots DROP CONSTRAINT IF EXISTS rotation_slots_slot_number_check;
ALTER TABLE rotation_slots ADD CONSTRAINT rotation_slots_slot_number_check
    CHECK (slot_number = 1);

-- Delete any slot_number = 2 rows (Duo slots)
DELETE FROM rotation_slots WHERE slot_number = 2;

-- ============================================================
-- 4. ALTER notification_log: update allowed types
-- ============================================================

ALTER TABLE notification_log DROP CONSTRAINT IF EXISTS notification_log_notification_type_check;
ALTER TABLE notification_log ADD CONSTRAINT notification_log_notification_type_check
    CHECK (notification_type IN ('lock_in_approaching', 'low_balance', 'auto_paused', 'credit_topup'));

-- Migrate old membership_due entries (historical, just update type)
UPDATE notification_log SET notification_type = 'low_balance'
    WHERE notification_type = 'membership_due';

-- ============================================================
-- 4b. ALTER credit_transactions: rename membership_fee to platform_fee
-- ============================================================

ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
    CHECK (type IN ('prepayment', 'zap_topup', 'lock_in_debit', 'platform_fee', 'refund'));

UPDATE credit_transactions SET type = 'platform_fee' WHERE type = 'membership_fee';

-- ============================================================
-- 5. CREATE platform_config table
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_config (key, value) VALUES ('platform_fee_sats', '4400')
    ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 6. INSERT operator account
-- ============================================================
-- ***REDACTED***
-- Bech32 decode: 2f9d3b6e56b5c53ecd348f6f738ec0859e599a3c93eab497e8b5147f9bade7ee

INSERT INTO users (nostr_npub, status, onboarded_at)
VALUES (
    '2f9d3b6e56b5c53ecd348f6f738ec0859e599a3c93eab497e8b5147f9bade7ee',
    'active',
    NOW()
)
ON CONFLICT (nostr_npub) DO UPDATE SET
    status = 'active',
    onboarded_at = COALESCE(users.onboarded_at, NOW()),
    updated_at = NOW();

COMMIT;
