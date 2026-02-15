-- Add title column to operator_alerts
-- The route and UI expect a separate title field distinct from the message body.
ALTER TABLE operator_alerts ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
