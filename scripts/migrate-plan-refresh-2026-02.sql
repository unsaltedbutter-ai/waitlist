-- migrate-plan-refresh-2026-02.sql
-- Refreshes service_plans to match actual streaming service plan names and
-- prices as of February 2026.
--
-- Changes:
--   Netflix:     "Standard w/ Ads" -> "Standard with Ads" (official name)
--   Hulu:        "w/ Ads" -> "Hulu (With Ads)", "No Ads" -> "Hulu (No Ads)"
--   Disney+:     "Basic w/ Ads" -> "Disney+ Basic", "Premium" -> "Disney+ Premium"
--   Disney bundles: mark as has_ads=TRUE (both bundles are with-ads tiers),
--                   fix display name for trio bundle
--   Paramount+:  "w/ Ads" -> "Essential" (new ID: paramount_essential),
--                "Paramount+ & Showtime" -> "Premium" (new ID: paramount_premium),
--                no longer marked as bundle (Showtime is integrated, not a separate service)
--   Peacock:     Premium has_ads corrected to TRUE (Premium has ads; Premium Plus is ad-free)
--   Max:         All three plans renamed with new IDs and prices:
--                "With Ads" ($9.99)    -> "Basic with Ads" ($10.99)
--                "No Ads" ($16.99)     -> "Standard" ($18.49)
--                "Ultimate" ($20.99)   -> "Premium" ($22.99)
--
-- Run against dev:
--   psql -h 192.168.5.188 -U butter -d unsaltedbutter -f scripts/migrate-plan-refresh-2026-02.sql
--
-- Run against prod:
--   scp to VPS, then: sudo -u postgres psql -d unsaltedbutter -f migrate-plan-refresh-2026-02.sql

BEGIN;

-- ============================================================
-- 1. Netflix: fix display name
-- ============================================================
UPDATE service_plans SET display_name = 'Standard with Ads' WHERE id = 'netflix_standard_ads';

-- ============================================================
-- 2. Hulu: use official plan names
-- ============================================================
UPDATE service_plans SET display_name = 'Hulu (With Ads)' WHERE id = 'hulu_ads';
UPDATE service_plans SET display_name = 'Hulu (No Ads)' WHERE id = 'hulu_no_ads';

-- ============================================================
-- 3. Disney+: use official plan names
-- ============================================================
UPDATE service_plans SET display_name = 'Disney+ Basic' WHERE id = 'disney_basic';
UPDATE service_plans SET display_name = 'Disney+ Premium' WHERE id = 'disney_premium';

-- Disney bundles: both are with-ads bundles, fix has_ads and trio display name
UPDATE service_plans SET has_ads = TRUE WHERE id = 'disney_hulu';
UPDATE service_plans SET display_name = 'Disney+, Hulu, & Max', has_ads = TRUE WHERE id = 'disney_hulu_max';

-- ============================================================
-- 4. Paramount+: rename plans, change IDs
-- ============================================================
-- Deactivate old plan IDs (keep for FK integrity on existing rotation_queue rows)
UPDATE service_plans SET active = FALSE WHERE id IN ('paramount_ads', 'paramount_showtime');

-- Insert new plan IDs
INSERT INTO service_plans
    (id, service_id, display_name, monthly_price_cents, has_ads, is_bundle, bundle_services, display_order)
VALUES
    ('paramount_essential', 'paramount', 'Essential',  899, TRUE,  FALSE, NULL, 60),
    ('paramount_premium',   'paramount', 'Premium',   1399, FALSE, FALSE, NULL, 61)
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    monthly_price_cents = EXCLUDED.monthly_price_cents,
    has_ads = EXCLUDED.has_ads,
    is_bundle = EXCLUDED.is_bundle,
    display_order = EXCLUDED.display_order,
    active = TRUE;

-- Migrate rotation_queue references from old to new plan IDs
UPDATE rotation_queue SET plan_id = 'paramount_essential' WHERE plan_id = 'paramount_ads';
UPDATE rotation_queue SET plan_id = 'paramount_premium' WHERE plan_id = 'paramount_showtime';

-- Now safe to delete old plan rows
DELETE FROM service_plans WHERE id IN ('paramount_ads', 'paramount_showtime');

-- ============================================================
-- 5. Peacock: fix has_ads on Premium (Premium has ads; Premium Plus is ad-free)
-- ============================================================
UPDATE service_plans SET has_ads = TRUE WHERE id = 'peacock_premium';

-- ============================================================
-- 6. Max: rename plans, change IDs and prices
-- ============================================================
-- Deactivate old plan IDs (keep for FK integrity on existing rotation_queue rows)
UPDATE service_plans SET active = FALSE WHERE id IN ('max_with_ads', 'max_no_ads', 'max_ultimate');

-- Insert new plan IDs with correct names and prices
INSERT INTO service_plans
    (id, service_id, display_name, monthly_price_cents, has_ads, is_bundle, bundle_services, display_order)
VALUES
    ('max_basic_ads', 'max', 'Basic with Ads', 1099, TRUE,  FALSE, NULL, 80),
    ('max_standard',  'max', 'Standard',       1849, FALSE, FALSE, NULL, 81),
    ('max_premium',   'max', 'Premium',        2299, FALSE, FALSE, NULL, 82)
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    monthly_price_cents = EXCLUDED.monthly_price_cents,
    has_ads = EXCLUDED.has_ads,
    display_order = EXCLUDED.display_order,
    active = TRUE;

-- Migrate rotation_queue references from old to new plan IDs
UPDATE rotation_queue SET plan_id = 'max_basic_ads' WHERE plan_id = 'max_with_ads';
UPDATE rotation_queue SET plan_id = 'max_standard' WHERE plan_id = 'max_no_ads';
UPDATE rotation_queue SET plan_id = 'max_premium' WHERE plan_id = 'max_ultimate';

-- Now safe to delete old plan rows
DELETE FROM service_plans WHERE id IN ('max_with_ads', 'max_no_ads', 'max_ultimate');

COMMIT;
