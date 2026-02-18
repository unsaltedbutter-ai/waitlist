-- migrate-v3-to-v4.sql
-- Migration: Prepaid balance model (v3) -> Pay-per-action concierge model (v4)
--
-- What changes:
--   - No more gift cards, prepaid credits, subscriptions, rotation slots, or platform fees
--   - Users keep their own payment methods on streaming services
--   - We cancel/resume on demand, charge per action via Lightning invoice
--   - Email/password auth removed (Nostr only)
--   - Prime Video and ESPN+ dropped from service catalog
--   - Max (formerly HBO Max) added as standalone service
--   - New "jobs" table replaces agent_jobs
--   - New "transactions" table replaces credit_transactions / btc_prepayments
--
-- Run against dev DB:
--   psql -h 192.168.5.188 -U butter -d unsaltedbutter -f scripts/migrate-v3-to-v4.sql
--
-- Run against prod:
--   scp to VPS, then: sudo -u postgres psql -d unsaltedbutter -f migrate-v3-to-v4.sql

BEGIN;

-- ============================================================
-- 1. DROP OLD TABLES (reverse dependency order)
-- ============================================================
-- These tables are entirely removed in v4. None contain user data we
-- need to preserve. Credentials, rotation_queue, users, consents,
-- waitlist, nostr_otp are kept.

DROP TABLE IF EXISTS zap_receipts CASCADE;
DROP TABLE IF EXISTS pending_refunds CASCADE;
DROP TABLE IF EXISTS notification_log CASCADE;
DROP TABLE IF EXISTS gift_card_purchases CASCADE;
DROP TABLE IF EXISTS btc_prepayments CASCADE;
DROP TABLE IF EXISTS credit_transactions CASCADE;
DROP TABLE IF EXISTS service_credits CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;
DROP TABLE IF EXISTS rotation_slots CASCADE;
DROP TABLE IF EXISTS service_account_balances CASCADE;
DROP TABLE IF EXISTS playbooks CASCADE;
DROP TABLE IF EXISTS password_reset_tokens CASCADE;
DROP TABLE IF EXISTS signup_questions CASCADE;
DROP TABLE IF EXISTS platform_config CASCADE;

-- agent_jobs has FKs from action_logs and operator_alerts, so we must
-- drop those FKs first (handled in section 7/9), then drop agent_jobs.
-- For now, CASCADE handles the FK deps on the table itself.
DROP TABLE IF EXISTS agent_jobs CASCADE;

-- ============================================================
-- 2. DROP OLD INDEXES (ones that reference removed columns or tables)
-- ============================================================
-- Indexes on dropped tables are already gone. Drop indexes on
-- columns we are about to remove from surviving tables.

DROP INDEX IF EXISTS idx_users_status;
DROP INDEX IF EXISTS idx_waitlist_email;

-- Old partial index on waitlist npub had a WHERE clause; drop it so
-- we can recreate it without the partial filter.
DROP INDEX IF EXISTS idx_waitlist_npub;

-- Old indexes on tables whose structure is changing
DROP INDEX IF EXISTS idx_rotation_slots_user;
DROP INDEX IF EXISTS idx_subscriptions_user;
DROP INDEX IF EXISTS idx_subscriptions_status;
DROP INDEX IF EXISTS idx_subscriptions_end_date;
DROP INDEX IF EXISTS idx_subscriptions_lapse;
DROP INDEX IF EXISTS idx_agent_jobs_pending;
DROP INDEX IF EXISTS idx_agent_jobs_user;
DROP INDEX IF EXISTS idx_credit_transactions_user;
DROP INDEX IF EXISTS idx_btc_prepayments_user;
DROP INDEX IF EXISTS idx_btc_prepayments_invoice;
DROP INDEX IF EXISTS idx_gift_card_purchases_user;
DROP INDEX IF EXISTS idx_gift_card_purchases_active;
DROP INDEX IF EXISTS idx_zap_receipts_user;
DROP INDEX IF EXISTS idx_service_account_balances_user;
DROP INDEX IF EXISTS idx_notification_log_dedup;
DROP INDEX IF EXISTS idx_prt_token_hash;
DROP INDEX IF EXISTS idx_prt_user_id;

-- ============================================================
-- 3. ALTER users TABLE
-- ============================================================
-- Remove: email auth, password, signup answers, telegram, status, paused_at
-- Add: debt_sats
-- Make nostr_npub NOT NULL (Nostr-only auth now)

-- Drop columns that no longer exist in v4
ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
ALTER TABLE users DROP COLUMN IF EXISTS signup_answers_enc;
ALTER TABLE users DROP COLUMN IF EXISTS telegram_handle;
ALTER TABLE users DROP COLUMN IF EXISTS paused_at;

-- Drop the status CHECK constraint before dropping the column
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users DROP COLUMN IF EXISTS status;

-- Add debt tracking column
ALTER TABLE users ADD COLUMN IF NOT EXISTS debt_sats INT NOT NULL DEFAULT 0;

-- Make nostr_npub required (was nullable for email-only users)
-- Any users without nostr_npub cannot exist in v4. Fail loudly if any exist.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE nostr_npub IS NULL) THEN
        RAISE EXCEPTION 'Cannot migrate: % users have NULL nostr_npub. Fix these before running migration.',
            (SELECT count(*) FROM users WHERE nostr_npub IS NULL);
    END IF;
END $$;

ALTER TABLE users ALTER COLUMN nostr_npub SET NOT NULL;

-- New index for debt tracking
CREATE INDEX IF NOT EXISTS idx_users_debt ON users(debt_sats) WHERE debt_sats > 0;

-- ============================================================
-- 4. ALTER streaming_services TABLE
-- ============================================================
-- Remove gift-card and pricing columns. Keep display_name, signup_url,
-- cancel_url, supported, logo_url, notes, updated_at.

ALTER TABLE streaming_services DROP COLUMN IF EXISTS monthly_price_cents;
ALTER TABLE streaming_services DROP COLUMN IF EXISTS plan_name;
ALTER TABLE streaming_services DROP COLUMN IF EXISTS gift_card_supported;
ALTER TABLE streaming_services DROP COLUMN IF EXISTS gift_card_provider;
ALTER TABLE streaming_services DROP COLUMN IF EXISTS gift_card_denominations_cents;
ALTER TABLE streaming_services DROP COLUMN IF EXISTS gift_card_product_id;
ALTER TABLE streaming_services DROP COLUMN IF EXISTS standalone;

-- NOTE: prime_video and espn_plus are deleted in section 13, after all
-- dependent rows (service_plans, rotation_queue, credentials, action_metrics)
-- have been cleaned up.

-- Insert Max (if not already present from a partial migration)
INSERT INTO streaming_services (id, display_name, signup_url, cancel_url, supported, notes)
VALUES ('max', 'Max', 'https://www.max.com/', NULL, TRUE, 'Formerly HBO Max. Also available in Disney bundles.')
ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    signup_url = EXCLUDED.signup_url,
    notes = EXCLUDED.notes;

-- Update cancel URLs for services that have them in v4
UPDATE streaming_services SET cancel_url = 'https://www.netflix.com/cancelplan'
    WHERE id = 'netflix' AND cancel_url IS NULL;

-- ============================================================
-- 5. ALTER rotation_queue TABLE
-- ============================================================
-- Remove the extend_current flag (no longer applicable)

ALTER TABLE rotation_queue DROP COLUMN IF EXISTS extend_current;

-- ============================================================
-- 6. ALTER waitlist TABLE
-- ============================================================
-- Remove email column (Nostr-only). Make nostr_npub NOT NULL.
-- Drop the CHECK constraint that allowed email OR nostr_npub.

-- Drop the old CHECK constraint (email IS NOT NULL OR nostr_npub IS NOT NULL)
ALTER TABLE waitlist DROP CONSTRAINT IF EXISTS waitlist_check;

-- Remove any waitlist entries that have no nostr_npub (email-only signups)
DELETE FROM waitlist WHERE nostr_npub IS NULL;

ALTER TABLE waitlist DROP COLUMN IF EXISTS email;
ALTER TABLE waitlist ALTER COLUMN nostr_npub SET NOT NULL;

-- Recreate index without partial WHERE clause
CREATE INDEX IF NOT EXISTS idx_waitlist_npub ON waitlist(nostr_npub);

-- ============================================================
-- 7. CREATE jobs TABLE
-- ============================================================
-- Replaces agent_jobs with the v4 pay-per-action workflow states.

CREATE TABLE IF NOT EXISTS jobs (
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
                          'user_skip', 'user_abandon', 'implied_skip'
                      )),
    status_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    billing_date      DATE,
    access_end_date   DATE,
    outreach_count    INT NOT NULL DEFAULT 0,
    next_outreach_at  TIMESTAMPTZ,
    amount_sats       INT,
    invoice_id        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Jobs indexes
CREATE INDEX IF NOT EXISTS idx_jobs_pending ON jobs(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_user_service ON jobs(user_id, service_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_billing_date ON jobs(billing_date) WHERE status NOT IN (
    'completed_paid', 'completed_eventual', 'completed_reneged',
    'user_skip', 'user_abandon', 'implied_skip'
);
CREATE INDEX IF NOT EXISTS idx_jobs_next_outreach ON jobs(next_outreach_at) WHERE next_outreach_at IS NOT NULL;

-- ============================================================
-- 8. CREATE transactions TABLE
-- ============================================================
-- Replaces credit_transactions, btc_prepayments. Operator bookkeeping.

CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID NOT NULL REFERENCES jobs(id),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id      TEXT NOT NULL REFERENCES streaming_services(id),
    action          TEXT NOT NULL CHECK (action IN ('cancel', 'resume')),
    amount_sats     INT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'invoice_sent'
                    CHECK (status IN ('invoice_sent', 'paid', 'reneged', 'eventual')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at         TIMESTAMPTZ
);

-- Transactions indexes
CREATE INDEX IF NOT EXISTS idx_transactions_job ON transactions(job_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status, created_at);

-- ============================================================
-- 9. ALTER action_logs TABLE
-- ============================================================
-- The old FK pointed to agent_jobs(id). Now it must point to jobs(id).
-- Also restrict flow_type to 'cancel'/'resume' only (no more 'signup'
-- or 'gift_card_purchase').

-- Drop the old FK to agent_jobs (CASCADE on agent_jobs drop may have
-- already removed it, but be safe)
ALTER TABLE action_logs DROP CONSTRAINT IF EXISTS action_logs_job_id_fkey;

-- Clean up old action_log rows BEFORE adding constraints.
-- Historical signup/gift_card_purchase entries have no corresponding
-- job in the new jobs table and violate the new flow_type CHECK.
DELETE FROM action_logs WHERE flow_type NOT IN ('cancel', 'resume');

-- Also delete any action_logs whose job_id references an old agent_job
-- that no longer exists (the new FK requires a match in jobs).
DELETE FROM action_logs
    WHERE job_id NOT IN (SELECT id FROM jobs);

-- Now safe to add the new FK to jobs table
ALTER TABLE action_logs
    ADD CONSTRAINT action_logs_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES jobs(id);

-- Update flow_type CHECK: only cancel and resume in v4
ALTER TABLE action_logs DROP CONSTRAINT IF EXISTS action_logs_flow_type_check;
ALTER TABLE action_logs ADD CONSTRAINT action_logs_flow_type_check
    CHECK (flow_type IN ('cancel', 'resume'));

-- ============================================================
-- 10. ALTER action_metrics TABLE
-- ============================================================
-- Restrict flow_type to cancel/resume only.

-- Remove old metric rows BEFORE adding the new CHECK constraint
DELETE FROM action_metrics WHERE flow_type NOT IN ('cancel', 'resume');

ALTER TABLE action_metrics DROP CONSTRAINT IF EXISTS action_metrics_flow_type_check;
ALTER TABLE action_metrics ADD CONSTRAINT action_metrics_flow_type_check
    CHECK (flow_type IN ('cancel', 'resume'));

-- ============================================================
-- 11. ALTER operator_alerts TABLE
-- ============================================================
-- Old FK pointed to agent_jobs(id). Now points to jobs(id).

ALTER TABLE operator_alerts DROP CONSTRAINT IF EXISTS operator_alerts_related_job_id_fkey;

-- Null out orphaned job references BEFORE adding the new FK.
-- Old agent_jobs IDs do not exist in the new jobs table.
UPDATE operator_alerts SET related_job_id = NULL
    WHERE related_job_id IS NOT NULL
    AND related_job_id NOT IN (SELECT id FROM jobs);

-- Now safe to add the new FK to jobs table
ALTER TABLE operator_alerts
    ADD CONSTRAINT operator_alerts_related_job_id_fkey
    FOREIGN KEY (related_job_id) REFERENCES jobs(id);

-- ============================================================
-- 12. UPDATE service_plans
-- ============================================================
-- Remove plans for deleted services, add Max plans, fix bundles.

-- Delete plans for services that no longer exist
DELETE FROM service_plans WHERE service_id IN ('prime_video', 'espn_plus');

-- Delete the disney_hulu_espn bundle (ESPN+ is gone)
DELETE FROM service_plans WHERE id = 'disney_hulu_espn';

-- Insert Max plans (the service was just added above)
-- NOTE: Plan IDs and names updated Feb 2026 to match current Max tiers.
-- Old IDs (max_with_ads, max_no_ads, max_ultimate) are replaced by
-- max_basic_ads, max_standard, max_premium. If running against a DB that
-- already has the old IDs, delete them first (see migrate-plan-refresh.sql).
INSERT INTO service_plans
    (id, service_id, display_name, monthly_price_cents, has_ads, is_bundle, bundle_services, display_order)
VALUES
    ('max_basic_ads', 'max', 'Basic with Ads', 1099, TRUE,  FALSE, NULL, 80),
    ('max_standard',  'max', 'Standard',       1849, FALSE, FALSE, NULL, 81),
    ('max_premium',   'max', 'Premium',        2299, FALSE, FALSE, NULL, 82)
ON CONFLICT (id) DO UPDATE SET
    service_id = EXCLUDED.service_id,
    display_name = EXCLUDED.display_name,
    monthly_price_cents = EXCLUDED.monthly_price_cents,
    has_ads = EXCLUDED.has_ads,
    display_order = EXCLUDED.display_order;

-- Update the disney_hulu_max bundle to include max in bundle_services
UPDATE service_plans
    SET bundle_services = '{disney_plus,hulu,max}'
    WHERE id = 'disney_hulu_max';

-- ============================================================
-- 13. CLEAN UP and DELETE removed services (prime_video, espn_plus)
-- ============================================================
-- Must delete all dependent rows before removing from streaming_services
-- (FK constraints on rotation_queue, streaming_credentials, service_plans,
-- action_metrics all reference streaming_services.id).

DELETE FROM rotation_queue WHERE service_id IN ('prime_video', 'espn_plus');
DELETE FROM streaming_credentials WHERE service_id IN ('prime_video', 'espn_plus');
DELETE FROM action_metrics WHERE service_id IN ('prime_video', 'espn_plus');
DELETE FROM action_logs WHERE service_id IN ('prime_video', 'espn_plus');

-- Now safe to remove the services themselves
DELETE FROM streaming_services WHERE id IN ('prime_video', 'espn_plus');

COMMIT;
