-- Migration: Add service_plans + user_consents tables
-- These exist in handoff SCHEMA.sql but were missed in scripts/schema.sql
-- Run: psql -h localhost -U butter -d unsaltedbutter -f scripts/migrate-service-plans.sql

BEGIN;

-- ============================================================
-- SERVICE PLANS (all available tiers, for onboarding + pricing)
-- ============================================================

CREATE TABLE IF NOT EXISTS service_plans (
    id              TEXT PRIMARY KEY,
    service_group   TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    monthly_price_cents INT NOT NULL,
    has_ads         BOOLEAN DEFAULT FALSE,
    is_bundle       BOOLEAN DEFAULT FALSE,
    display_order   INT NOT NULL DEFAULT 0,
    active          BOOLEAN DEFAULT TRUE
);

INSERT INTO service_plans (id, service_group, display_name, monthly_price_cents, has_ads, is_bundle, display_order) VALUES
('netflix_standard_ads',  'netflix',  'Standard w/ Ads',          799, TRUE,  FALSE, 10),
('netflix_standard',      'netflix',  'Standard',                1799, FALSE, FALSE, 11),
('netflix_premium',       'netflix',  'Premium',                 2400, FALSE, FALSE, 12),
('hulu_ads',              'hulu',     'w/ Ads',                  1199, TRUE,  FALSE, 20),
('hulu_no_ads',           'hulu',     'No Ads',                  1899, FALSE, FALSE, 21),
('disney_basic',          'disney',   'Basic w/ Ads',            1199, TRUE,  FALSE, 30),
('disney_premium',        'disney',   'Premium',                 1899, FALSE, FALSE, 31),
('disney_hulu',           'disney',   'Disney+ & Hulu',          1299, FALSE, TRUE,  32),
('disney_hulu_espn',      'disney',   'Disney+ & Hulu & ESPN+',  1999, FALSE, TRUE,  33),
('disney_hulu_max',       'disney',   'Disney+ & Hulu & Max',    1999, FALSE, TRUE,  34),
('max_basic',             'max',      'Basic w/ Ads',            1099, TRUE,  FALSE, 40),
('max_standard',          'max',      'Standard',                1849, FALSE, FALSE, 41),
('max_premium',           'max',      'Premium',                 2299, FALSE, FALSE, 42),
('paramount_ads',         'paramount','w/ Ads',                   899, TRUE,  FALSE, 50),
('paramount_showtime',    'paramount','Paramount+ & Showtime',   1399, FALSE, TRUE,  51),
('peacock_select',        'peacock',  'Select',                   799, TRUE,  FALSE, 60),
('peacock_premium',       'peacock',  'Premium',                 1099, FALSE, FALSE, 61),
('peacock_premium_plus',  'peacock',  'Premium Plus',            1699, FALSE, FALSE, 62),
('apple_tv',              'apple',    'Apple TV+',               1299, FALSE, FALSE, 70),
('prime_video_ads',       'prime',    'w/ Ads',                   899, TRUE,  FALSE, 80),
('prime_video_no_ads',    'prime',    'No Ads',                  1198, FALSE, FALSE, 81)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- USER CONSENTS (legal CYA — authorization capture)
-- ============================================================

CREATE TABLE IF NOT EXISTS user_consents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    consent_type    TEXT NOT NULL
                    CHECK (consent_type IN ('authorization', 'confirmation')),
    ip_address      TEXT NOT NULL,
    user_agent      TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_consents_user ON user_consents(user_id);

COMMIT;
