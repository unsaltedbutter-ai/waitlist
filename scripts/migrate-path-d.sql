-- Path D Migration: Gift Card Only, No Credit Card Storage
-- Run: psql -h 192.168.5.188 -U butter -d unsaltedbutter -f scripts/migrate-path-d.sql
-- WARNING: Destructive — drops card columns and cancel lifecycle columns.

BEGIN;

-- ============================================================
-- 1. streaming_credentials: drop card columns
-- ============================================================
ALTER TABLE streaming_credentials DROP COLUMN IF EXISTS card_number_enc;
ALTER TABLE streaming_credentials DROP COLUMN IF EXISTS card_expiry_enc;
ALTER TABLE streaming_credentials DROP COLUMN IF EXISTS card_cvv_enc;
ALTER TABLE streaming_credentials DROP COLUMN IF EXISTS billing_zip_enc;

-- ============================================================
-- 2. streaming_services: add gift card provider info, drop cancel_url
-- ============================================================
ALTER TABLE streaming_services DROP COLUMN IF EXISTS cancel_url;
ALTER TABLE streaming_services ADD COLUMN gift_card_provider TEXT
    CHECK (gift_card_provider IN ('bitrefill', 'giftly', 'tbc'));
ALTER TABLE streaming_services ADD COLUMN gift_card_denominations_cents INT[];
ALTER TABLE streaming_services ADD COLUMN gift_card_product_id TEXT;
ALTER TABLE streaming_services ADD COLUMN lapse_calculation TEXT NOT NULL DEFAULT 'proportional'
    CHECK (lapse_calculation IN ('proportional', 'calendar_month'));

UPDATE streaming_services SET gift_card_supported = TRUE, gift_card_provider = 'bitrefill'
    WHERE name IN ('netflix', 'hulu', 'disney_plus', 'apple_tv', 'prime_video');
UPDATE streaming_services SET gift_card_supported = TRUE, gift_card_provider = 'giftly'
    WHERE name IN ('max', 'paramount', 'peacock');

-- ============================================================
-- 3. subscriptions: replace cancel lifecycle with lapse lifecycle
-- ============================================================
ALTER TABLE subscriptions DROP COLUMN IF EXISTS cancel_scheduled_at;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS cancel_confirmed_at;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS billing_cycle_end;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
    CHECK (status IN ('queued', 'signup_scheduled', 'active', 'lapsing', 'lapsed', 'signup_failed'));
ALTER TABLE subscriptions ADD COLUMN gift_card_amount_cents INT;
ALTER TABLE subscriptions ADD COLUMN estimated_lapse_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN actual_lapsed_at TIMESTAMPTZ;

-- ============================================================
-- 4. agent_jobs: replace cancel with giftly purchase
-- ============================================================
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_flow_type_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_flow_type_check
    CHECK (flow_type IN ('signup', 'gift_card_purchase_giftly'));

-- ============================================================
-- 5. rotation_queue: add extend flag
-- ============================================================
ALTER TABLE rotation_queue ADD COLUMN extend_current BOOLEAN DEFAULT FALSE;

-- ============================================================
-- 6. New tables
-- ============================================================

CREATE TABLE service_credits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    credit_sats     BIGINT NOT NULL DEFAULT 0 CHECK (credit_sats >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            TEXT NOT NULL
                    CHECK (type IN ('prepayment', 'gift_card_purchase', 'membership_fee', 'refund')),
    amount_sats     BIGINT NOT NULL,
    balance_after_sats BIGINT NOT NULL,
    reference_id    UUID,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE btc_prepayments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    btcpay_invoice_id TEXT NOT NULL UNIQUE,
    requested_amount_sats BIGINT,
    received_amount_sats BIGINT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'expired')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE gift_card_purchases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    subscription_id UUID REFERENCES subscriptions(id),
    provider        TEXT NOT NULL
                    CHECK (provider IN ('bitrefill', 'giftly', 'tbc')),
    amount_cents    INT NOT NULL,
    cost_sats       BIGINT NOT NULL,
    gift_card_code_enc BYTEA,
    external_order_id TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'purchased', 'redeemed', 'failed', 'refunded')),
    purchased_at    TIMESTAMPTZ,
    redeemed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 7. Indexes for new tables
-- ============================================================
CREATE INDEX idx_credit_transactions_user ON credit_transactions(user_id, created_at);
CREATE INDEX idx_btc_prepayments_user ON btc_prepayments(user_id);
CREATE INDEX idx_btc_prepayments_invoice ON btc_prepayments(btcpay_invoice_id);
CREATE INDEX idx_gift_card_purchases_user ON gift_card_purchases(user_id);
CREATE INDEX idx_gift_card_purchases_status ON gift_card_purchases(status) WHERE status IN ('pending', 'purchased');
CREATE INDEX idx_subscriptions_lapse ON subscriptions(estimated_lapse_at) WHERE status = 'lapsing';

COMMIT;
