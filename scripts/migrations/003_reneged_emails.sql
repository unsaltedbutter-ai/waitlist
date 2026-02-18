BEGIN;

CREATE TABLE IF NOT EXISTS reneged_emails (
    email_hash      TEXT PRIMARY KEY,
    total_debt_sats INT NOT NULL DEFAULT 0,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS email_hash TEXT;

COMMIT;
