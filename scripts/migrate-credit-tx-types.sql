-- Add 'zap_topup' to credit_transactions type CHECK constraint
-- Run: psql -U butter -d unsaltedbutter -f scripts/migrate-credit-tx-types.sql

BEGIN;

ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
  CHECK (type IN ('prepayment', 'zap_topup', 'gift_card_purchase', 'membership_fee', 'refund'));

COMMIT;
