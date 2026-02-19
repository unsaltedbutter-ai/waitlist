BEGIN;

CREATE TABLE operator_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO operator_settings (key, value) VALUES ('action_price_sats', '3000');

COMMIT;
