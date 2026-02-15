-- SCHEMA.sql — UnsaltedButter Database Schema (v2 — Solo/Duo, Gift Card Only)
-- Run: psql -h <host> -U butter -d unsaltedbutter -f scripts/schema.sql
--
-- ENCRYPTION: Each _enc BYTEA field stores 12-byte IV || ciphertext || 16-byte GCM auth tag.
-- No standalone iv column. The crypto module handles prepend/strip transparently.
--
-- CLEAN INSTALL: This script DROPs all tables first. Only run on empty or disposable databases.

-- ============================================================
-- DROP EVERYTHING (reverse dependency order)
-- ============================================================

DROP TABLE IF EXISTS notification_log CASCADE;
DROP TABLE IF EXISTS gift_card_purchases CASCADE;
DROP TABLE IF EXISTS btc_prepayments CASCADE;
DROP TABLE IF EXISTS credit_transactions CASCADE;
DROP TABLE IF EXISTS service_credits CASCADE;
DROP TABLE IF EXISTS user_consents CASCADE;
DROP TABLE IF EXISTS operator_alerts CASCADE;
DROP TABLE IF EXISTS action_metrics CASCADE;
DROP TABLE IF EXISTS action_logs CASCADE;
DROP TABLE IF EXISTS agent_jobs CASCADE;
DROP TABLE IF EXISTS playbooks CASCADE;
DROP TABLE IF EXISTS waitlist CASCADE;
DROP TABLE IF EXISTS service_plans CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS rotation_slots CASCADE;
DROP TABLE IF EXISTS service_account_balances CASCADE;
DROP TABLE IF EXISTS rotation_queue CASCADE;
DROP TABLE IF EXISTS streaming_credentials CASCADE;
DROP TABLE IF EXISTS signup_questions CASCADE;
DROP TABLE IF EXISTS membership_pricing CASCADE;
DROP TABLE IF EXISTS membership_payments CASCADE;
DROP TABLE IF EXISTS streaming_services CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nostr_npub            TEXT UNIQUE,                          -- primary auth (Nostr public key)
    email                 TEXT UNIQUE,                          -- fallback auth
    password_hash         TEXT,                                 -- bcrypt, only if email auth
    telegram_handle       TEXT,                                 -- optional, for notifications
    status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'expiring', 'churned')),
    membership_plan       TEXT NOT NULL DEFAULT 'solo'          -- solo = 1 rotation, duo = 2 simultaneous
                          CHECK (membership_plan IN ('solo', 'duo')),
    billing_period        TEXT NOT NULL DEFAULT 'monthly'
                          CHECK (billing_period IN ('monthly', 'annual')),
    membership_expires_at TIMESTAMPTZ,                          -- when current paid period ends
    free_days_remaining   INT DEFAULT 0,                        -- manually allocated by operator
    signup_answers_enc    BYTEA,                                -- AES-256-GCM encrypted JSON: {question_id: answer}
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SIGNUP QUESTIONS (DB-driven list of questions streaming services ask during signup)
-- ============================================================

CREATE TABLE signup_questions (
    id           TEXT PRIMARY KEY,              -- e.g. 'zip_code', 'birthdate', 'full_name', 'gender'
    label        TEXT NOT NULL,                 -- display label: 'Zip Code', 'Birthdate (MM/DD/YYYY)', etc.
    field_type   TEXT NOT NULL DEFAULT 'text'   -- 'text', 'date', 'select'
                 CHECK (field_type IN ('text', 'date', 'select')),
    options      TEXT[],                        -- for 'select' type: e.g. {'Male','Female','Prefer Not To Say'}
    placeholder  TEXT,                          -- input placeholder text
    display_order INT NOT NULL DEFAULT 0
);

INSERT INTO signup_questions (id, label, field_type, options, placeholder, display_order) VALUES
    ('full_name',  'Full Name',              'text',   NULL, 'Your full name', 10),
    ('zip_code',   'Zip Code',               'text',   NULL, '00000', 20),
    ('birthdate',  'Birthdate (MM/DD/YYYY)', 'text',   NULL, 'MM/DD/YYYY', 30),
    ('gender',     'Gender',                 'select', '{"Male","Female","Prefer Not To Say"}', NULL, 40);

-- ============================================================
-- STREAMING SERVICES (catalog)
-- ============================================================

CREATE TABLE streaming_services (
    id                            TEXT PRIMARY KEY,             -- slug: 'netflix', 'hulu', etc.
    display_name                  TEXT NOT NULL,
    signup_url                    TEXT NOT NULL,
    cancel_url                    TEXT,                         -- direct cancel page if known
    monthly_price_cents           INT NOT NULL,                 -- default tier price in cents
    plan_name                     TEXT NOT NULL DEFAULT 'Standard',
    gift_card_supported           BOOLEAN NOT NULL DEFAULT TRUE,
    gift_card_provider            TEXT NOT NULL DEFAULT 'bitrefill'
                                  CHECK (gift_card_provider IN ('bitrefill', 'manual')),
    gift_card_denominations_cents INT[],                        -- available card amounts in cents
    gift_card_product_id          TEXT,                         -- Bitrefill product ID
    standalone                    BOOLEAN NOT NULL DEFAULT TRUE,-- FALSE = bundle-only (ESPN+)
    supported                     BOOLEAN NOT NULL DEFAULT TRUE,-- can we automate this service?
    logo_url                      TEXT,
    notes                         TEXT,
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed data — all services we support (prices as of early 2026)
INSERT INTO streaming_services
    (id, display_name, signup_url, monthly_price_cents, plan_name,
     gift_card_supported, gift_card_provider, gift_card_denominations_cents,
     standalone, notes)
VALUES
    ('netflix',     'Netflix',      'https://www.netflix.com/signup',
     1799, 'Standard',      TRUE, 'bitrefill', '{2500,5000,10000}',
     TRUE, 'reCAPTCHA on signup page — #1 risk'),

    ('apple_tv',    'Apple TV+',    'https://tv.apple.com/',
     1299, 'Standard',      TRUE, 'bitrefill', '{1000,2500,5000}',
     TRUE, 'Apple gift cards, custom amounts'),

    ('prime_video', 'Prime Video',  'https://www.amazon.com/gp/video/offers',
     899,  'w/ Ads',        TRUE, 'bitrefill', '{2500,5000,10000}',
     TRUE, 'Amazon gift cards. No Ads = $11.98'),

    ('hulu',        'Hulu',         'https://www.hulu.com/welcome',
     1899, 'No Ads',        TRUE, 'bitrefill', '{2500,5000}',
     TRUE, NULL),

    ('disney_plus', 'Disney+',      'https://www.disneyplus.com/sign-up',
     1899, 'Premium',       TRUE, 'bitrefill', '{2500,5000,10000}',
     TRUE, NULL),

    ('espn_plus',   'ESPN+',        'https://plus.espn.com/',
     0,    'Bundle Only',   TRUE, 'bitrefill', NULL,
     FALSE, 'Only available via Disney bundles'),

    ('paramount',   'Paramount+',   'https://www.paramountplus.com/signup/',
     1399, 'w/ Showtime',   TRUE, 'bitrefill', '{2500}',
     TRUE, '$25 min card, ~$11 residual per cycle'),

    ('peacock',     'Peacock',      'https://www.peacocktv.com/plans',
     1099, 'Premium',       TRUE, 'bitrefill', '{2500,5000}',
     TRUE, NULL);

-- ============================================================
-- SERVICE PLANS (all available tiers for plan selection UI)
-- ============================================================

CREATE TABLE service_plans (
    id                    TEXT PRIMARY KEY,                     -- e.g. 'netflix_standard_ads'
    service_id            TEXT NOT NULL REFERENCES streaming_services(id),
    display_name          TEXT NOT NULL,                        -- 'Standard w/ Ads'
    monthly_price_cents   INT NOT NULL,
    has_ads               BOOLEAN DEFAULT FALSE,
    is_bundle             BOOLEAN DEFAULT FALSE,
    bundle_services       TEXT[],                               -- service IDs in bundle, e.g. {'disney_plus','hulu','espn_plus'}
    display_order         INT NOT NULL DEFAULT 0,
    active                BOOLEAN DEFAULT TRUE
);

INSERT INTO service_plans
    (id, service_id, display_name, monthly_price_cents, has_ads, is_bundle, bundle_services, display_order)
VALUES
    -- Netflix
    ('netflix_standard_ads',  'netflix',     'Standard w/ Ads',           799, TRUE,  FALSE, NULL, 10),
    ('netflix_standard',      'netflix',     'Standard',                 1799, FALSE, FALSE, NULL, 11),
    ('netflix_premium',       'netflix',     'Premium',                  2499, FALSE, FALSE, NULL, 12),
    -- Apple TV+
    ('apple_tv_standard',     'apple_tv',    'Apple TV+',               1299, FALSE, FALSE, NULL, 20),
    -- Prime Video
    ('prime_video_ads',       'prime_video', 'w/ Ads',                   899, TRUE,  FALSE, NULL, 30),
    ('prime_video_no_ads',    'prime_video', 'No Ads',                  1198, FALSE, FALSE, NULL, 31),
    -- Hulu
    ('hulu_ads',              'hulu',        'w/ Ads',                  1199, TRUE,  FALSE, NULL, 40),
    ('hulu_no_ads',           'hulu',        'No Ads',                  1899, FALSE, FALSE, NULL, 41),
    -- Disney+
    ('disney_basic',          'disney_plus', 'Basic w/ Ads',            1199, TRUE,  FALSE, NULL, 50),
    ('disney_premium',        'disney_plus', 'Premium',                 1899, FALSE, FALSE, NULL, 51),
    -- Disney bundles
    ('disney_hulu',           'disney_plus', 'Disney+ & Hulu',          1299, FALSE, TRUE, '{disney_plus,hulu}', 52),
    ('disney_hulu_espn',      'disney_plus', 'Disney+ & Hulu & ESPN+',  1999, FALSE, TRUE, '{disney_plus,hulu,espn_plus}', 53),
    ('disney_hulu_max',       'disney_plus', 'Disney+ & Hulu & Max',    1999, FALSE, TRUE, '{disney_plus,hulu}', 54),
    -- Paramount+
    ('paramount_ads',         'paramount',   'w/ Ads',                   899, TRUE,  FALSE, NULL, 60),
    ('paramount_showtime',    'paramount',   'Paramount+ & Showtime',   1399, FALSE, TRUE,  NULL, 61),
    -- Peacock
    ('peacock_select',        'peacock',     'Select',                   799, TRUE,  FALSE, NULL, 70),
    ('peacock_premium',       'peacock',     'Premium',                 1099, FALSE, FALSE, NULL, 71),
    ('peacock_premium_plus',  'peacock',     'Premium Plus',            1699, FALSE, FALSE, NULL, 72);

-- ============================================================
-- MEMBERSHIP PRICING (operator-set, sats-denominated)
-- ============================================================

CREATE TABLE membership_pricing (
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
    ('duo',  'annual',  5850);

-- ============================================================
-- STREAMING CREDENTIALS (encrypted, destroyed on membership end)
-- ============================================================

CREATE TABLE streaming_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL REFERENCES streaming_services(id),
    email_enc       BYTEA NOT NULL,                            -- AES-256-GCM (IV || ciphertext || tag)
    password_enc    BYTEA NOT NULL,                            -- AES-256-GCM (IV || ciphertext || tag)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id)
);

-- ============================================================
-- ROTATION QUEUE (ordered list of services user wants to cycle through)
-- ============================================================

CREATE TABLE rotation_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL REFERENCES streaming_services(id),
    position        INT NOT NULL,                              -- 1 = next up
    plan_id         TEXT REFERENCES service_plans(id),         -- which tier/plan for this service
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id),
    UNIQUE(user_id, position)
);

-- ============================================================
-- ROTATION SLOTS (active service slots — 1 for Solo, 2 for Duo)
-- Each slot independently tracks its current service and locked-in next service.
-- ============================================================

CREATE TABLE rotation_slots (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_number               INT NOT NULL CHECK (slot_number IN (1, 2)),
    current_service_id        TEXT REFERENCES streaming_services(id),
    current_subscription_id   UUID,                            -- FK added after subscriptions table
    next_service_id           TEXT REFERENCES streaming_services(id),
    next_plan_id              TEXT REFERENCES service_plans(id),
    next_gift_card_code_enc   BYTEA,                           -- AES-256-GCM encrypted, set at lock-in
    locked_at                 TIMESTAMPTZ,                      -- when lock-in occurred (day 14)
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, slot_number)
);

-- ============================================================
-- SERVICE ACCOUNT BALANCES (gift card balance remaining at each streaming service)
-- Agent reads this after cancel. Informs whether next rotation needs a new gift card.
-- ============================================================

CREATE TABLE service_account_balances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL REFERENCES streaming_services(id),
    balance_cents   INT NOT NULL DEFAULT 0,                    -- remaining balance at the streaming service
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id)
);

-- ============================================================
-- SUBSCRIPTIONS (current and historical)
-- ============================================================

CREATE TABLE subscriptions (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id            TEXT NOT NULL REFERENCES streaming_services(id),
    slot_number           INT,                                 -- which rotation slot (1 or 2)
    plan_id               TEXT REFERENCES service_plans(id),   -- which tier
    status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN (
                              'queued',              -- waiting in rotation queue
                              'signup_scheduled',    -- agent job created
                              'active',              -- subscribed and streaming
                              'cancel_scheduled',    -- cancel job created (7-14 days after signup)
                              'cancelled',           -- cancel confirmed by agent
                              'cancel_failed',       -- cancel attempt failed
                              'signup_failed'        -- signup attempt failed
                          )),
    signed_up_at          TIMESTAMPTZ,
    cancel_scheduled_at   TIMESTAMPTZ,                         -- when we plan to cancel
    cancel_confirmed_at   TIMESTAMPTZ,                         -- when agent confirmed the cancel
    subscription_end_date TIMESTAMPTZ,                         -- billing cycle end (from cancel confirmation)
    gift_card_amount_cents INT,                                -- gift card used for this subscription
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add FK from rotation_slots to subscriptions now that both tables exist
ALTER TABLE rotation_slots
    ADD CONSTRAINT fk_rotation_slots_subscription
    FOREIGN KEY (current_subscription_id) REFERENCES subscriptions(id);

-- ============================================================
-- MEMBERSHIP PAYMENTS (BTC/Lightning — for the UnsaltedButter subscription itself)
-- ============================================================

CREATE TABLE membership_payments (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    btcpay_invoice_id TEXT NOT NULL UNIQUE,
    amount_sats       BIGINT NOT NULL,
    amount_usd_cents  INT NOT NULL,                            -- approximate USD value at payment time (via live BTC/USD rate)
    period_start      TIMESTAMPTZ NOT NULL,
    period_end        TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'expired', 'refunded')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SERVICE CREDITS (BTC balance per user — for gift card purchases)
-- ============================================================

CREATE TABLE service_credits (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    credit_sats     BIGINT NOT NULL DEFAULT 0 CHECK (credit_sats >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CREDIT TRANSACTIONS (ledger — every credit movement)
-- ============================================================

CREATE TABLE credit_transactions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type               TEXT NOT NULL
                       CHECK (type IN (
                           'prepayment',          -- user added BTC credits
                           'zap_topup',           -- credits via Nostr zap
                           'lock_in_debit',       -- credits deducted at day-14 lock-in (gift card purchase)
                           'membership_fee',      -- monthly/annual membership charge
                           'refund'               -- refund back to user
                       )),
    amount_sats        BIGINT NOT NULL,            -- positive = credit, negative = debit
    balance_after_sats BIGINT NOT NULL,
    reference_id       UUID,                       -- FK to prepayment/gift_card_purchase/etc.
    description        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BTC PREPAYMENTS (Lightning invoices for adding service credits)
-- ============================================================

CREATE TABLE btc_prepayments (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    btcpay_invoice_id     TEXT NOT NULL UNIQUE,
    requested_amount_sats BIGINT,                              -- null = open amount
    received_amount_sats  BIGINT,                              -- set when paid
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'paid', 'expired')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- GIFT CARD PURCHASES (company property, earmarked for user's service)
-- Gift cards are owned by the company. User never sees the code.
-- Purchased at lock-in, redeemed at subscribe time.
-- ============================================================

CREATE TABLE gift_card_purchases (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id          TEXT NOT NULL REFERENCES streaming_services(id),
    slot_number         INT,                                   -- which rotation slot this is for
    provider            TEXT NOT NULL DEFAULT 'bitrefill'
                        CHECK (provider IN ('bitrefill', 'manual')),
    denomination_cents  INT NOT NULL,                          -- face value of the card
    cost_sats           BIGINT NOT NULL,                       -- BTC cost at time of purchase
    gift_card_code_enc  BYTEA,                                 -- AES-256-GCM encrypted code
    external_order_id   TEXT,                                  -- Bitrefill order ID
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                            'pending',      -- purchase initiated
                            'purchased',    -- code received, stored encrypted
                            'redeemed',     -- applied to streaming service account
                            'failed',       -- purchase failed
                            'refunded'      -- refunded (if possible)
                        )),
    purchased_at        TIMESTAMPTZ,
    redeemed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AGENT JOBS (work items for the Mac Mini agent)
-- ============================================================

CREATE TABLE agent_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL REFERENCES streaming_services(id),
    subscription_id UUID REFERENCES subscriptions(id),
    slot_number     INT,                                       -- which rotation slot
    flow_type       TEXT NOT NULL
                    CHECK (flow_type IN (
                        'signup',              -- create account / resume subscription + redeem gift card
                        'cancel',              -- cancel subscription 7-14 days after signup
                        'gift_card_purchase'   -- buy gift card via Bitrefill during lock-in window
                    )),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'in_progress',
                                      'completed', 'failed', 'dead_letter')),
    scheduled_for   DATE NOT NULL,                             -- which day to execute
    scheduled_hour  INT,                                       -- preferred hour (0-23), nullable
    attempt_count   INT DEFAULT 0,
    max_attempts    INT DEFAULT 3,
    claimed_at      TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    error_message   TEXT,
    result_data     JSONB,                                     -- flow-specific output (e.g. cancel end date, balance)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ACTION LOG (audit trail of every agent action)
-- ============================================================

CREATE TABLE action_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID NOT NULL REFERENCES agent_jobs(id),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id       TEXT NOT NULL REFERENCES streaming_services(id),
    flow_type        TEXT NOT NULL,
    success          BOOLEAN NOT NULL,
    duration_seconds INT,
    step_count       INT,
    inference_count  INT,
    playbook_version INT,
    error_message    TEXT,
    screenshots      JSONB,                                    -- [{step, timestamp, path}] — PII redacted
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ACTION METRICS (aggregated stats per service per flow, for capacity planning)
-- ============================================================

CREATE TABLE action_metrics (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id           TEXT NOT NULL REFERENCES streaming_services(id),
    flow_type            TEXT NOT NULL,
    avg_duration_seconds FLOAT,
    avg_steps            FLOAT,
    p95_duration_seconds FLOAT,
    success_rate         FLOAT,                                -- 0.0 to 1.0
    sample_count         INT DEFAULT 0,
    last_updated         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(service_id, flow_type)
);

-- ============================================================
-- PLAYBOOKS (cached agent steps per service per flow)
-- ============================================================

CREATE TABLE playbooks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id     TEXT NOT NULL REFERENCES streaming_services(id),
    flow_type      TEXT NOT NULL                               -- matches agent_jobs.flow_type
                   CHECK (flow_type IN ('signup', 'cancel', 'gift_card_purchase')),
    version        INT NOT NULL DEFAULT 1,
    steps          JSONB NOT NULL,                             -- array of step objects
    dom_hashes     JSONB,                                      -- expected hashes per step
    status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'needs_review', 'deprecated')),
    last_validated TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(service_id, flow_type, version)
);

-- ============================================================
-- WAITLIST (simple: contact info + invite status)
-- ============================================================

CREATE TABLE waitlist (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT,
    nostr_npub  TEXT,
    invited     BOOLEAN DEFAULT FALSE,
    invited_at  TIMESTAMPTZ,
    invite_code TEXT UNIQUE,                                   -- generated by operator, used at signup
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (email IS NOT NULL OR nostr_npub IS NOT NULL)        -- at least one contact method
);

-- ============================================================
-- OPERATOR ALERTS
-- ============================================================

CREATE TABLE operator_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type      TEXT NOT NULL,                             -- 'cancel_failed', 'playbook_stale', 'hardware_down', etc.
    severity        TEXT NOT NULL DEFAULT 'warning'
                    CHECK (severity IN ('info', 'warning', 'critical')),
    title           TEXT NOT NULL DEFAULT '',
    message         TEXT NOT NULL,
    related_job_id  UUID REFERENCES agent_jobs(id),
    related_user_id UUID REFERENCES users(id),
    acknowledged    BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USER CONSENTS (legal — authorization capture)
-- ============================================================

CREATE TABLE user_consents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    consent_type TEXT NOT NULL
                 CHECK (consent_type IN ('authorization', 'confirmation')),
    ip_address   TEXT NOT NULL,
    user_agent   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATION LOG (dedup outbound DM notifications from Nostr bot)
-- ============================================================

CREATE TABLE notification_log (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL CHECK (notification_type IN ('lock_in_approaching', 'membership_due', 'credit_topup')),
    reference_id      TEXT,           -- e.g. service_id or period identifier, for dedup
    sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_log_dedup ON notification_log(user_id, notification_type, reference_id);

-- ============================================================
-- INDEXES
-- ============================================================

-- Users
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_expires ON users(membership_expires_at);

-- Rotation
CREATE INDEX idx_rotation_queue_user ON rotation_queue(user_id, position);
CREATE INDEX idx_rotation_slots_user ON rotation_slots(user_id);

-- Subscriptions
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_subscriptions_end_date ON subscriptions(subscription_end_date)
    WHERE status IN ('active', 'cancel_scheduled', 'cancelled');

-- Agent jobs
CREATE INDEX idx_agent_jobs_pending ON agent_jobs(scheduled_for, status) WHERE status = 'pending';
CREATE INDEX idx_agent_jobs_user ON agent_jobs(user_id);

-- Action logs
CREATE INDEX idx_action_logs_user ON action_logs(user_id);
CREATE INDEX idx_action_logs_created ON action_logs(created_at);

-- Credits
CREATE INDEX idx_credit_transactions_user ON credit_transactions(user_id, created_at DESC);

-- Prepayments
CREATE INDEX idx_btc_prepayments_user ON btc_prepayments(user_id);
CREATE INDEX idx_btc_prepayments_invoice ON btc_prepayments(btcpay_invoice_id);

-- Gift cards
CREATE INDEX idx_gift_card_purchases_user ON gift_card_purchases(user_id);
CREATE INDEX idx_gift_card_purchases_active ON gift_card_purchases(status)
    WHERE status IN ('pending', 'purchased');

-- Waitlist
CREATE INDEX idx_waitlist_email ON waitlist(email) WHERE email IS NOT NULL;
CREATE INDEX idx_waitlist_npub ON waitlist(nostr_npub) WHERE nostr_npub IS NOT NULL;

-- Operator alerts
CREATE INDEX idx_operator_alerts_unacked ON operator_alerts(acknowledged, created_at)
    WHERE acknowledged = FALSE;

-- User consents
CREATE INDEX idx_user_consents_user ON user_consents(user_id);

-- Service account balances
CREATE INDEX idx_service_account_balances_user ON service_account_balances(user_id);
