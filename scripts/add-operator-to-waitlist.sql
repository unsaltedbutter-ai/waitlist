-- Add operator npub to waitlist as pre-invited.
-- Run: sudo -u postgres psql -d unsaltedbutter -f scripts/add-operator-to-waitlist.sql
--
-- npub: ***REDACTED***
-- hex:  2f9d3db9d5adc5a7d9a327b7bcc76085bcb368f127d5a4be745a8bfb9badf7ee

INSERT INTO waitlist (nostr_npub, invited, invited_at, invite_code, invite_dm_pending)
VALUES (
    '2f9d3db9d5adc5a7d9a327b7bcc76085bcb368f127d5a4be745a8bfb9badf7ee',
    TRUE,
    NOW(),
    'OPERATOR1',
    FALSE
)
ON CONFLICT (nostr_npub) DO UPDATE SET
    invited           = TRUE,
    invited_at        = NOW(),
    invite_code       = COALESCE(waitlist.invite_code, EXCLUDED.invite_code),
    invite_dm_pending = FALSE;
