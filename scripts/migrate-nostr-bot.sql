-- Nostr Bot Migration: zap_topup credit type + zap_receipts idempotency table
-- Run: psql -h 192.168.5.188 -U butter -d unsaltedbutter -f scripts/migrate-nostr-bot.sql

BEGIN;

-- 1. Add 'zap_topup' to credit_transactions type constraint
ALTER TABLE credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_type_check
  CHECK (type IN ('prepayment', 'gift_card_purchase', 'membership_fee', 'refund', 'zap_topup'));

-- 2. Idempotency table — prevent double-crediting zaps
CREATE TABLE IF NOT EXISTS zap_receipts (
    event_id    TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_npub TEXT NOT NULL,
    amount_sats BIGINT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zap_receipts_user ON zap_receipts(user_id);

COMMIT;
