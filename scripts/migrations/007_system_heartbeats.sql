-- 007_system_heartbeats.sql
-- Heartbeat monitoring for home network components (orchestrator, agent, inference)

CREATE TABLE IF NOT EXISTS system_heartbeats (
  component TEXT PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
