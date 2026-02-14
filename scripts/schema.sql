-- SCHEMA.sql — UnsaltedButter Database Schema
-- Run: psql -h <linux-ip> -U butter -d unsaltedbutter -f scripts/schema.sql
--
-- IV FIX: Each _enc BYTEA field stores 12-byte IV || ciphertext || 16-byte auth tag.
-- No standalone iv column. The crypto module handles prepend/strip transparently.

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nostr_npub      TEXT UNIQUE,                          -- primary auth (Nostr public key)
    email           TEXT UNIQUE,                          -- fallback auth
    password_hash   TEXT,                                 -- bcrypt, only if email auth
    telegram_handle TEXT,                                 -- optional, for notifications
    status          TEXT NOT NULL DEFAULT 'active'        -- active | expiring | churned
                    CHECK (status IN ('active', 'expiring', 'churned')),
    membership_type TEXT NOT NULL DEFAULT 'monthly'       -- monthly | annual
                    CHECK (membership_type IN ('monthly', 'annual')),
    membership_expires_at TIMESTAMPTZ,                    -- when current paid period ends
    free_days_remaining   INT DEFAULT 0,                  -- manually allocated by operator
    max_concurrent  INT NOT NULL DEFAULT 1                -- 1 = basic, 2 = plus, 3 = pro
                    CHECK (max_concurrent BETWEEN 1 AND 3),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- STREAMING SERVICES (catalog)
-- ============================================================

CREATE TABLE streaming_services (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,                 -- 'netflix', 'hulu', etc.
    display_name    TEXT NOT NULL,                        -- 'Netflix', 'Hulu', etc.
    signup_url      TEXT NOT NULL,
    cancel_url      TEXT,                                 -- direct link to cancel page if known
    monthly_price_cents INT NOT NULL,                     -- ad-free tier in cents (e.g., 1799)
    plan_name       TEXT NOT NULL DEFAULT 'Standard',     -- which plan we sign up for
    gift_card_supported BOOLEAN DEFAULT FALSE,
    supported       BOOLEAN DEFAULT TRUE,                 -- can we automate this service?
    logo_url        TEXT,
    notes           TEXT,                                 -- e.g., "has reCAPTCHA on signup"
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed data
INSERT INTO streaming_services (name, display_name, signup_url, monthly_price_cents, plan_name, gift_card_supported, notes) VALUES
('netflix',     'Netflix',         'https://www.netflix.com/signup',       1799, 'Standard',      TRUE,  'reCAPTCHA on signup page — #1 risk'),
('hulu',        'Hulu',            'https://www.hulu.com/welcome',         1899, 'No Ads',        TRUE,  NULL),
('disney_plus', 'Disney+',         'https://www.disneyplus.com/sign-up',   1699, 'No Ads',        TRUE,  'Gift cards work well here'),
('max',         'Max',             'https://www.max.com/sign-up',          1699, 'Ad-Free',       FALSE, 'No gift card available'),
('paramount',   'Paramount+',      'https://www.paramountplus.com/signup/', 1399, 'No Ads',        FALSE, 'Gift card min $25, awkward fit'),
('peacock',     'Peacock',         'https://www.peacocktv.com/plans',      1399, 'Premium',       FALSE, 'No gift card available'),
('apple_tv',    'Apple TV+',       'https://tv.apple.com/',                 999, 'Standard',      TRUE,  'Apple gift cards, custom amounts'),
('prime_video', 'Prime Video',     'https://www.amazon.com/gp/video/offers', 899, 'Standard',     TRUE,  'Amazon gift cards');

-- ============================================================
-- STREAMING CREDENTIALS (encrypted, destroyed on membership end)
-- ============================================================
-- IV FIX: No standalone iv column. Each _enc field stores:
--   12-byte IV || ciphertext || 16-byte GCM auth tag
-- A unique IV is generated per encrypt() call, so each field
-- gets its own IV even within the same row.

CREATE TABLE streaming_credentials (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    email_enc       BYTEA NOT NULL,                      -- 12-byte IV || ciphertext || 16-byte tag
    password_enc    BYTEA NOT NULL,                      -- 12-byte IV || ciphertext || 16-byte tag
    card_number_enc BYTEA NOT NULL,                      -- 12-byte IV || ciphertext || 16-byte tag
    card_expiry_enc BYTEA NOT NULL,                      -- 12-byte IV || ciphertext || 16-byte tag
    card_cvv_enc    BYTEA NOT NULL,                      -- 12-byte IV || ciphertext || 16-byte tag
    billing_zip_enc BYTEA,                               -- 12-byte IV || ciphertext || 16-byte tag (optional)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id)
);

-- ============================================================
-- ROTATION QUEUE
-- ============================================================

CREATE TABLE rotation_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    position        INT NOT NULL,                        -- order in queue (1 = next up)
    never_rotate    BOOLEAN DEFAULT FALSE,               -- user wants this service always on
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id),
    UNIQUE(user_id, position)
);

-- ============================================================
-- SUBSCRIPTIONS (current and historical)
-- ============================================================

CREATE TABLE subscriptions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'signup_scheduled', 'active',
                                      'cancel_scheduled', 'cancelled', 'cancel_failed')),
    signed_up_at    TIMESTAMPTZ,
    cancel_scheduled_at TIMESTAMPTZ,                     -- when we plan to cancel
    cancel_confirmed_at TIMESTAMPTZ,                     -- when cancel was verified
    billing_cycle_end   TIMESTAMPTZ,                     -- when the paid period ends
    plan_tier       TEXT,                                 -- 'Standard', 'No Ads', etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- MEMBERSHIP PAYMENTS (BTC/Lightning)
-- ============================================================

CREATE TABLE membership_payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    btcpay_invoice_id TEXT NOT NULL UNIQUE,
    amount_sats     BIGINT NOT NULL,
    amount_usd_cents INT NOT NULL,                       -- 999 = $9.99, 9588 = $95.88
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'expired', 'refunded')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AGENT JOBS (pg-boss manages these, but we define the shape)
-- ============================================================

CREATE TABLE agent_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    subscription_id UUID REFERENCES subscriptions(id),
    flow_type       TEXT NOT NULL                         -- 'signup' | 'cancel'
                    CHECK (flow_type IN ('signup', 'cancel')),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'in_progress',
                                      'completed', 'failed', 'dead_letter')),
    scheduled_for   DATE NOT NULL,                       -- which day to execute
    scheduled_hour  INT,                                 -- preferred hour (0-23), nullable
    attempt_count   INT DEFAULT 0,
    max_attempts    INT DEFAULT 3,
    claimed_at      TIMESTAMPTZ,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    error_message   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_jobs_pending ON agent_jobs(scheduled_for, status) WHERE status = 'pending';
CREATE INDEX idx_agent_jobs_user ON agent_jobs(user_id);

-- ============================================================
-- ACTION LOG (audit trail)
-- ============================================================

CREATE TABLE action_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES agent_jobs(id),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    flow_type       TEXT NOT NULL,
    success         BOOLEAN NOT NULL,
    duration_seconds INT,
    step_count      INT,
    inference_count INT,
    playbook_version INT,
    error_message   TEXT,
    screenshots     JSONB,                               -- array of {step, timestamp, path} — PII redacted
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ACTION METRICS (aggregated, for capacity planning)
-- ============================================================

CREATE TABLE action_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    flow_type       TEXT NOT NULL,
    avg_duration_seconds FLOAT,
    avg_steps       FLOAT,
    p95_duration_seconds FLOAT,
    success_rate    FLOAT,                               -- 0.0 to 1.0
    sample_count    INT DEFAULT 0,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(service_id, flow_type)
);

-- ============================================================
-- REFERRAL CODES
-- ============================================================

CREATE TABLE referral_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code            TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'used', 'expired', 'revoked')),
    used_by_id      UUID REFERENCES users(id),
    failed_attempts INT DEFAULT 0,                       -- if > 10, code was posted publicly
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PLAYBOOKS (cached agent steps per service)
-- ============================================================

CREATE TABLE playbooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id      UUID NOT NULL REFERENCES streaming_services(id),
    flow_type       TEXT NOT NULL,                        -- 'signup' | 'cancel'
    version         INT NOT NULL DEFAULT 1,
    steps           JSONB NOT NULL,                      -- array of step objects
    dom_hashes      JSONB,                               -- expected hashes per step
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'needs_review', 'deprecated')),
    last_validated  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(service_id, flow_type, version)
);

-- ============================================================
-- WAITLIST
-- ============================================================

CREATE TABLE waitlist (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT,
    nostr_npub      TEXT,
    current_services TEXT[],                              -- array of service names
    monthly_spend_cents INT,                              -- self-reported
    referral_source TEXT,
    invited         BOOLEAN DEFAULT FALSE,
    invited_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- OPERATOR ALERTS
-- ============================================================

CREATE TABLE operator_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type      TEXT NOT NULL,                        -- 'cancel_failed', 'playbook_stale', 'hardware_down', etc.
    severity        TEXT NOT NULL DEFAULT 'warning'
                    CHECK (severity IN ('info', 'warning', 'critical')),
    message         TEXT NOT NULL,
    related_job_id  UUID REFERENCES agent_jobs(id),
    related_user_id UUID REFERENCES users(id),
    acknowledged    BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_expires ON users(membership_expires_at);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_rotation_queue_user ON rotation_queue(user_id, position);
CREATE INDEX idx_action_logs_user ON action_logs(user_id);
CREATE INDEX idx_action_logs_created ON action_logs(created_at);
CREATE INDEX idx_referral_codes_code ON referral_codes(code);
CREATE INDEX idx_waitlist_email ON waitlist(email);
CREATE INDEX idx_operator_alerts_unacked ON operator_alerts(acknowledged, created_at) WHERE acknowledged = FALSE;
