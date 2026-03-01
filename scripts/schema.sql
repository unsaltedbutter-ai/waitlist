-- schema.sql -- UnsaltedButter Database Schema (v4: Pay-Per-Action Concierge Model)
-- Run: psql -h <host> -U butter -d unsaltedbutter -f scripts/schema.sql
--
-- ENCRYPTION: Each _enc BYTEA field stores a libsodium sealed box ciphertext.
-- Only the orchestrator holds the private key; the VPS can only encrypt.
--
-- CLEAN INSTALL: This script DROPs all tables first. Only run on empty or disposable databases.

-- ============================================================
-- DROP EVERYTHING (reverse dependency order)
-- ============================================================

DROP TABLE IF EXISTS audio_purchases CASCADE;
DROP TABLE IF EXISTS audio_jobs CASCADE;
DROP TABLE IF EXISTS audio_cache CASCADE;
DROP TABLE IF EXISTS system_heartbeats CASCADE;
DROP TABLE IF EXISTS operator_audit_log CASCADE;
DROP TABLE IF EXISTS revenue_ledger CASCADE;
DROP TABLE IF EXISTS reneged_emails CASCADE;
DROP TABLE IF EXISTS job_status_history CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS operator_alerts CASCADE;
DROP TABLE IF EXISTS action_logs CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
DROP TABLE IF EXISTS user_consents CASCADE;
DROP TABLE IF EXISTS nostr_otp CASCADE;
DROP TABLE IF EXISTS waitlist CASCADE;
DROP TABLE IF EXISTS service_plans CASCADE;
DROP TABLE IF EXISTS rotation_queue CASCADE;
DROP TABLE IF EXISTS streaming_credentials CASCADE;
DROP TABLE IF EXISTS streaming_services CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- ============================================================
-- USERS
-- ============================================================

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nostr_npub      TEXT NOT NULL UNIQUE,                     -- primary auth (Nostr hex pubkey)
    debt_sats       INT NOT NULL DEFAULT 0,                   -- outstanding unpaid amount
    abandon_count   INT NOT NULL DEFAULT 0,                   -- consecutive user_abandon jobs (reset on success)
    last_abandon_at TIMESTAMPTZ,                              -- timestamp of most recent abandon
    onboarded_at    TIMESTAMPTZ,                              -- set when user completes onboarding
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- STREAMING SERVICES (catalog)
-- ============================================================

CREATE TABLE streaming_services (
    id              TEXT PRIMARY KEY,                          -- slug: 'netflix', 'hulu', etc.
    display_name    TEXT NOT NULL,
    signup_url      TEXT NOT NULL,
    cancel_url      TEXT,                                     -- direct cancel page if known
    supported       BOOLEAN NOT NULL DEFAULT TRUE,            -- can we automate this service?
    logo_url        TEXT,
    notes           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed data
INSERT INTO streaming_services (id, display_name, signup_url, cancel_url, supported, notes) VALUES
    ('netflix',     'Netflix',      'https://www.netflix.com/signup',          'https://www.netflix.com/cancelplan', TRUE, 'reCAPTCHA on signup page'),
    ('hulu',        'Hulu',         'https://www.hulu.com/welcome',            NULL, TRUE, 'Also available in Disney bundles'),
    ('disney_plus', 'Disney+',      'https://www.disneyplus.com/sign-up',      NULL, TRUE, NULL),
    ('paramount',   'Paramount+',   'https://www.paramountplus.com/signup/',    NULL, TRUE, NULL),
    ('peacock',     'Peacock',      'https://www.peacocktv.com/plans',          NULL, TRUE, NULL),
    ('max',         'Max',          'https://www.max.com/',                     NULL, TRUE, 'Formerly HBO Max. Also available in Disney bundles.');

-- ============================================================
-- SERVICE PLANS (reference catalog for resume flow)
-- ============================================================

CREATE TABLE service_plans (
    id                    TEXT PRIMARY KEY,                    -- e.g. 'netflix_standard_ads'
    service_id            TEXT NOT NULL REFERENCES streaming_services(id),
    display_name          TEXT NOT NULL,                       -- 'Standard w/ Ads'
    monthly_price_cents   INT NOT NULL,
    has_ads               BOOLEAN DEFAULT FALSE,
    is_bundle             BOOLEAN DEFAULT FALSE,
    bundle_services       TEXT[],                              -- service IDs in bundle
    display_order         INT NOT NULL DEFAULT 0,
    active                BOOLEAN DEFAULT TRUE
);

INSERT INTO service_plans
    (id, service_id, display_name, monthly_price_cents, has_ads, is_bundle, bundle_services, display_order)
VALUES
    -- Netflix (as of Jan 2025)
    ('netflix_standard_ads',  'netflix',     'Standard with Ads',         799, TRUE,  FALSE, NULL, 10),
    ('netflix_standard',      'netflix',     'Standard',                 1799, FALSE, FALSE, NULL, 11),
    ('netflix_premium',       'netflix',     'Premium',                  2499, FALSE, FALSE, NULL, 12),
    -- Hulu (as of Oct 2025)
    ('hulu_ads',              'hulu',        'Hulu (With Ads)',          1199, TRUE,  FALSE, NULL, 40),
    ('hulu_no_ads',           'hulu',        'Hulu (No Ads)',            1899, FALSE, FALSE, NULL, 41),
    -- Disney+ (as of Oct 2025)
    ('disney_basic',          'disney_plus', 'Disney+ Basic',            1199, TRUE,  FALSE, NULL, 50),
    ('disney_premium',        'disney_plus', 'Disney+ Premium',          1899, FALSE, FALSE, NULL, 51),
    -- Disney bundles (with-ads bundles)
    ('disney_hulu',           'disney_plus', 'Disney+ & Hulu',          1299, TRUE,  TRUE, '{disney_plus,hulu}', 52),
    ('disney_hulu_max',       'disney_plus', 'Disney+, Hulu, & Max',    1999, TRUE,  TRUE, '{disney_plus,hulu,max}', 54),
    -- Paramount+ (as of Jan 15, 2026)
    ('paramount_essential',   'paramount',   'Essential',                 899, TRUE,  FALSE, NULL, 60),
    ('paramount_premium',     'paramount',   'Premium',                  1399, FALSE, FALSE, NULL, 61),
    -- Peacock (current as of 2025)
    ('peacock_select',        'peacock',     'Select',                    799, TRUE,  FALSE, NULL, 70),
    ('peacock_premium',       'peacock',     'Premium',                  1099, TRUE,  FALSE, NULL, 71),
    ('peacock_premium_plus',  'peacock',     'Premium Plus',             1699, FALSE, FALSE, NULL, 72),
    -- Max (as of 2025 price increase)
    ('max_basic_ads',         'max',         'Basic with Ads',           1099, TRUE,  FALSE, NULL, 80),
    ('max_standard',          'max',         'Standard',                 1849, FALSE, FALSE, NULL, 81),
    ('max_premium',           'max',         'Premium',                  2299, FALSE, FALSE, NULL, 82);

-- ============================================================
-- STREAMING CREDENTIALS (encrypted, destroyed on account deletion)
-- ============================================================

CREATE TABLE streaming_credentials (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id          TEXT NOT NULL REFERENCES streaming_services(id),
    email_enc           BYTEA NOT NULL,                       -- libsodium sealed box (VPS encrypts, orchestrator decrypts)
    password_enc        BYTEA NOT NULL,                       -- libsodium sealed box (VPS encrypts, orchestrator decrypts)
    email_hash          VARCHAR(64),                          -- SHA-256 of normalized email (for blocklist checks)
    credential_failures INT NOT NULL DEFAULT 0,               -- consecutive login failures (reset on cred update)
    last_failure_at     TIMESTAMPTZ,                          -- timestamp of most recent credential failure
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id)
);

-- ============================================================
-- ROTATION QUEUE (ordered list of services user wants to cycle through)
-- ============================================================

CREATE TABLE rotation_queue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL REFERENCES streaming_services(id),
    position        INT NOT NULL,                             -- 1 = next up
    plan_id         TEXT REFERENCES service_plans(id),        -- which tier/plan for resume flow
    next_billing_date DATE,                                   -- next renewal date, set on state changes
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, service_id),
    UNIQUE(user_id, position)
);

-- ============================================================
-- JOBS (work items: one cancel or one resume per user per service)
-- ============================================================

CREATE TABLE jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id        TEXT NOT NULL REFERENCES streaming_services(id),
    action            TEXT NOT NULL CHECK (action IN ('cancel', 'resume')),
    trigger           TEXT NOT NULL CHECK (trigger IN ('scheduled', 'on_demand', 'onboarding')),
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                          'pending', 'dispatched',
                          'outreach_sent', 'snoozed',
                          'active', 'awaiting_otp',
                          'completed_paid', 'completed_eventual', 'completed_reneged',
                          'user_skip', 'user_abandon', 'implied_skip',
                          'failed'
                      )),
    status_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    billing_date      DATE,                                   -- renewal date we're trying to beat
    access_end_date   DATE,                                   -- captured from cancel confirmation screen
    access_end_date_approximate BOOLEAN NOT NULL DEFAULT false, -- true when using +14 day fallback
    outreach_count    INT NOT NULL DEFAULT 0,
    next_outreach_at  TIMESTAMPTZ,
    amount_sats       INT,                                    -- frozen when work completes
    invoice_id        TEXT,                                    -- BTCPay invoice ID
    email_hash        TEXT,                                    -- SHA-256 of credential email at time of reneg
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TRANSACTIONS (operator bookkeeping)
-- ============================================================

CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL REFERENCES streaming_services(id),
    action          TEXT NOT NULL CHECK (action IN ('cancel', 'resume')),
    amount_sats     INT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'invoice_sent'
                    CHECK (status IN ('invoice_sent', 'paid', 'reneged', 'eventual')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at         TIMESTAMPTZ
);

-- ============================================================
-- ACTION LOG (audit trail)
-- ============================================================

CREATE TABLE action_logs (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id           UUID NOT NULL REFERENCES jobs(id),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id       TEXT NOT NULL REFERENCES streaming_services(id),
    flow_type        TEXT NOT NULL CHECK (flow_type IN ('cancel', 'resume')),
    success          BOOLEAN NOT NULL,
    duration_seconds INT,
    step_count       INT,
    inference_count  INT,
    otp_required     BOOLEAN NOT NULL DEFAULT FALSE,
    error_code       TEXT DEFAULT NULL,
    error_message    TEXT,
    screenshots      JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- WAITLIST (Nostr only)
-- ============================================================

CREATE TABLE waitlist (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nostr_npub        TEXT NOT NULL UNIQUE,
    invited           BOOLEAN DEFAULT FALSE,
    invited_at        TIMESTAMPTZ,
    invite_code       TEXT UNIQUE,
    invite_dm_pending BOOLEAN DEFAULT FALSE,
    redeemed_at       TIMESTAMPTZ DEFAULT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- NOSTR OTP (one-time login codes)
-- ============================================================

CREATE TABLE nostr_otp (
    npub_hex    TEXT PRIMARY KEY,
    code_hash   TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- OPERATOR ALERTS
-- ============================================================

CREATE TABLE operator_alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type      TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'warning'
                    CHECK (severity IN ('info', 'warning', 'critical')),
    title           TEXT NOT NULL DEFAULT '',
    message         TEXT NOT NULL,
    related_job_id  UUID REFERENCES jobs(id) ON DELETE SET NULL,
    related_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    acknowledged    BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USER CONSENTS (legal)
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
-- RENEGED EMAILS (anti-fraud: tracks email hashes across npubs)
-- ============================================================

CREATE TABLE reneged_emails (
    email_hash      TEXT PRIMARY KEY,                         -- SHA-256 of normalized email
    total_debt_sats INT NOT NULL DEFAULT 0,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- REVENUE LEDGER (append-only, no FK to users, survives account deletion)
-- ============================================================

CREATE TABLE revenue_ledger (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id       TEXT NOT NULL,
    action           TEXT NOT NULL,
    amount_sats      INT NOT NULL,
    payment_status   TEXT NOT NULL CHECK (payment_status IN ('paid', 'eventual')),
    source           TEXT NOT NULL DEFAULT 'concierge',           -- 'concierge' or 'audio'
    job_completed_at TIMESTAMPTZ NOT NULL,
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- OPERATOR AUDIT LOG (tracks manual operator actions)
-- ============================================================

CREATE TABLE operator_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action          TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    target_id       TEXT,
    detail          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- OPERATOR SETTINGS (key-value config editable from dashboard)
-- ============================================================

CREATE TABLE operator_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO operator_settings (key, value) VALUES ('action_price_sats', '3000');

-- ============================================================
-- SYSTEM HEARTBEATS (health monitoring for home network components)
-- ============================================================

CREATE TABLE system_heartbeats (
    component       TEXT PRIMARY KEY,                            -- 'orchestrator', 'agent', 'inference'
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload         JSONB,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- JOB STATUS HISTORY (audit trail for all job status transitions)
-- ============================================================

CREATE TABLE job_status_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status   TEXT NOT NULL,
    changed_by  TEXT NOT NULL DEFAULT 'system',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AUDIO CACHE (extracted tweet text + optional MP3)
-- ============================================================

CREATE TABLE audio_cache (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tweet_id          TEXT NOT NULL UNIQUE,        -- snowflake ID (internal only, never in URLs)
    tweet_url         TEXT NOT NULL,
    tweet_text        TEXT NOT NULL,               -- extracted text (populated on first extraction)
    tweet_author      TEXT,
    char_count        INT NOT NULL,                -- cached for pricing without re-counting
    file_path         TEXT,                        -- NULL until TTS runs; relative: audio/{uuid}.mp3
    file_size_bytes   INT,                         -- NULL until TTS runs
    duration_seconds  INT,                         -- NULL until TTS runs
    tts_model         TEXT,
    tts_voice         TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AUDIO JOBS (one per purchase request)
-- ============================================================

CREATE TABLE audio_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_npub    TEXT NOT NULL,
    tweet_id          TEXT NOT NULL,
    tweet_url         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending_payment'
                      CHECK (status IN (
                          'pending_payment', 'paid',
                          'synthesizing', 'completed',
                          'failed', 'refunded'
                      )),
    invoice_id        TEXT,
    amount_sats       INT NOT NULL,
    was_cached        BOOLEAN NOT NULL DEFAULT FALSE,
    audio_cache_id    UUID REFERENCES audio_cache(id),
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- AUDIO PURCHASES (listen tokens, one per paid job)
-- ============================================================

CREATE TABLE audio_purchases (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token             TEXT NOT NULL UNIQUE,         -- opaque URL-safe base62, 16 chars
    audio_job_id      UUID NOT NULL REFERENCES audio_jobs(id),
    audio_cache_id    UUID NOT NULL REFERENCES audio_cache(id),
    requester_npub    TEXT NOT NULL,
    plays_remaining   INT NOT NULL DEFAULT 3,
    max_plays         INT NOT NULL DEFAULT 3,
    refill_invoice_id TEXT,                        -- set when user requests a refill, cleared on payment
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_played_at    TIMESTAMPTZ
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Users
CREATE INDEX idx_users_debt ON users(debt_sats) WHERE debt_sats > 0;

-- Rotation (UNIQUE(user_id, position) constraint already creates an index)

-- Jobs
CREATE INDEX idx_jobs_pending ON jobs(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_jobs_user ON jobs(user_id);
CREATE INDEX idx_jobs_user_service ON jobs(user_id, service_id, status);
CREATE INDEX idx_jobs_billing_date ON jobs(billing_date) WHERE status NOT IN (
    'completed_paid', 'completed_eventual', 'completed_reneged',
    'user_skip', 'user_abandon', 'implied_skip', 'failed'
);
CREATE INDEX idx_jobs_next_outreach ON jobs(next_outreach_at) WHERE next_outreach_at IS NOT NULL;
CREATE UNIQUE INDEX idx_jobs_active_user_service ON jobs(user_id, service_id)
    WHERE status NOT IN (
        'completed_paid', 'completed_eventual', 'completed_reneged',
        'user_skip', 'user_abandon', 'implied_skip', 'failed'
    );
CREATE INDEX idx_jobs_invoice_id ON jobs(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_jobs_created_at ON jobs(created_at);

-- Transactions
CREATE INDEX idx_transactions_job ON transactions(job_id);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_status ON transactions(status, created_at);

-- Action logs
CREATE INDEX idx_action_logs_user ON action_logs(user_id);
CREATE INDEX idx_action_logs_created ON action_logs(created_at);

-- Waitlist (nostr_npub covered by UNIQUE constraint on column definition)

-- Nostr OTP (UNIQUE constraint on code already creates an index)

-- Operator alerts
CREATE INDEX idx_operator_alerts_unacked ON operator_alerts(acknowledged, created_at)
    WHERE acknowledged = FALSE;

-- User consents
CREATE INDEX idx_user_consents_user ON user_consents(user_id);

-- Revenue ledger
CREATE INDEX idx_revenue_ledger_date ON revenue_ledger(recorded_at);
CREATE INDEX idx_revenue_ledger_service ON revenue_ledger(service_id, action);

-- Operator audit log
CREATE INDEX idx_audit_log_created ON operator_audit_log(created_at DESC);

-- Job status history
CREATE INDEX idx_job_history_job ON job_status_history(job_id, created_at);

-- Audio cache
CREATE INDEX idx_audio_cache_lru ON audio_cache(last_accessed_at);

-- Audio jobs
CREATE INDEX idx_audio_jobs_invoice ON audio_jobs(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_audio_jobs_tweet ON audio_jobs(tweet_id);
CREATE INDEX idx_audio_jobs_requester ON audio_jobs(requester_npub, status);

-- Audio purchases
CREATE INDEX idx_audio_purchases_token ON audio_purchases(token);
CREATE INDEX idx_audio_purchases_cache ON audio_purchases(audio_cache_id);
