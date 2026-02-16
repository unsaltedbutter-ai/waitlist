-- Migration: 2026-02-15
-- Covers: signup_questions, signup_answers_enc, membership_pricing,
--         pending_refunds, operator_alerts.title, credit_transactions type check
-- Run: psql -U butter -d unsaltedbutter -f scripts/migrate-2026-02-15.sql

BEGIN;

-- 1. signup_answers_enc column on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_answers_enc BYTEA;

-- 2. signup_questions table
CREATE TABLE IF NOT EXISTS signup_questions (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    field_type   TEXT NOT NULL DEFAULT 'text'
                 CHECK (field_type IN ('text', 'date', 'select')),
    options      TEXT[],
    placeholder  TEXT,
    display_order INT NOT NULL DEFAULT 0
);

INSERT INTO signup_questions (id, label, field_type, options, placeholder, display_order) VALUES
    ('full_name',  'Full Name',              'text',   NULL, 'Your full name', 10),
    ('zip_code',   'Zip Code',               'text',   NULL, '00000', 20),
    ('birthdate',  'Birthdate (MM/DD/YYYY)', 'text',   NULL, 'MM/DD/YYYY', 30),
    ('gender',     'Gender',                 'select', '{"Male","Female","Prefer Not To Say"}', NULL, 40)
ON CONFLICT (id) DO NOTHING;

-- 3. membership_pricing table
CREATE TABLE IF NOT EXISTS membership_pricing (
    plan       TEXT NOT NULL CHECK (plan IN ('solo', 'duo')),
    period     TEXT NOT NULL CHECK (period IN ('monthly', 'annual')),
    price_sats INT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plan, period)
);

INSERT INTO membership_pricing (plan, period, price_sats) VALUES
    ('solo', 'monthly', 4400),
    ('solo', 'annual',  3500),
    ('duo',  'monthly', 7300),
    ('duo',  'annual',  5850)
ON CONFLICT (plan, period) DO NOTHING;

-- 4. pending_refunds table
CREATE TABLE IF NOT EXISTS pending_refunds (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact      TEXT NOT NULL,
    amount_sats  BIGINT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. operator_alerts.title column
ALTER TABLE operator_alerts ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

-- 6. credit_transactions type check (drop + re-add with zap_topup)
ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
  CHECK (type IN ('prepayment', 'zap_topup', 'gift_card_purchase', 'membership_fee', 'refund'));

COMMIT;
