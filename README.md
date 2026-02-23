# UnsaltedButter.ai

On-demand streaming cancel/resume concierge. Users interact via Nostr DM. We cancel and resume their streaming subscriptions using AI browser automation on real Chrome, charging 3,000 sats per action via Lightning Network.

## Architecture

```
Home Network                              VPS (Hetzner)
+-----------------------------------+     +---------------------------+
| Orchestrator (Mac Mini)           |     | Next.js app + API         |
|   Nostr bot, job dispatch,        |     | PostgreSQL                |
|   conversation state (SQLite)     |     | BTCPay Server (Lightning) |
|                                   |     +---------------------------+
| Agent (Mac Mini)             LAN  |            ^
|   Chrome + pyautogui, VLM-driven  |            | Nostr DMs (NIP-17)
|                                   |            | HTTPS
| Inference (Mac Studio)            |            |
|   Qwen3-VL-32B local             |     [ Users via web browser ]
+-----------------------------------+
```

Four machines, three components:

| Component | Runs on | Stack |
|-----------|---------|-------|
| **Web** | Hetzner VPS | Next.js 14, TypeScript, PostgreSQL 16, BTCPay Server |
| **Orchestrator** | Mac Mini | Python 3.13, nostr-sdk, SQLite, httpx |
| **Agent** | Mac Mini | Python 3.13, pyautogui, pynput, Pillow |
| **Inference** | Mac Studio | Qwen3-VL-32B via llama.cpp (OpenAI-compatible API) |

## Project Structure

```
unsaltedbutter.ai/
├── web/                    Next.js app (VPS)
├── agent/                  Python browser agent (Mac Mini)
├── orchestrator/           Python orchestrator + Nostr bot (Mac Mini)
├── nostr-bot/              Nostr DM bot (Mac Mini, runs inside orchestrator)
├── scripts/                Deployment, cron jobs, ops scripts
├── env-examples/           Template env files
└── unsalted-butter-handoff/
    └── docs/               Planning docs (PLAN, DECISIONS, ARCHITECTURE, SCHEMA, etc.)
```

## Setup

### VPS (web + database)

```bash
# First deploy: initialize server, database, BTCPay, nginx
./scripts/deploy.sh <VPS_IP> --init

# Install cron jobs (update-checker, health-check, backups, daily-cron)
./scripts/deploy.sh <VPS_IP> --setup-bots

# Subsequent deploys
./scripts/deploy.sh <VPS_IP>
```

### Home network (orchestrator + agent)

Environment files live in `~/.unsaltedbutter/`:
- `shared.env` (loaded by all components)
- `orchestrator.env`, `nostr-bot.env`, `agent.env` (component overrides)

See `env-examples/` for templates.

```bash
# Orchestrator
cd orchestrator && pip install -r requirements.txt
python -m orchestrator

# Agent
cd agent && pip install -r requirements.txt
python -m agent run <service> <action>
```

## Cron Jobs (VPS)

Installed via `deploy.sh --setup-bots`. All times UTC.

| Job | Schedule | Purpose |
|-----|----------|---------|
| `cron-daily.sh` | 10:00 daily | Job scheduling + 180-day data pruning |
| `update-checker.py` | 10:00 daily | Software update check + Nostr DM report |
| `health-check.sh` | Every 15 min | Disk, memory, Docker, PM2, nginx |
| `lnd-balance.sh` | 06:00 daily | LND balance log + inbound liquidity alert |
| `backup-daily.sh` | 03:00 daily | PG, BTCPay PG, LND SCB, nginx config |
| `backup-offsite.sh` | 04:00 daily | Sync to Hetzner Storage Box |
| `lightning-backup.sh` | Every 6 hours | Verified LND SCB export via lncli |

## Data Retention

The daily cron (`/api/cron/daily`) prunes audit and log tables after **180 days**:

| Table | What it stores | Retention |
|-------|---------------|-----------|
| `action_logs` | Agent execution audit trail (per-job) | 180 days |
| `job_status_history` | Job status transitions | 180 days |
| `operator_alerts` | Stuck job / capacity / debt alerts | 180 days |
| `operator_audit_log` | Manual operator actions | 180 days |
| `system_heartbeats` | Component health (upsert, 1 row each) | Not pruned |
| `revenue_ledger` | Financial records (append-only) | Never deleted |

The orchestrator (SQLite) has its own cleanup loop running hourly:
- Message log: 90 days
- Fired timers: 7 days
- Terminal jobs: deleted on each sweep

## Payments

BTC only via BTCPay Server (self-hosted Lightning Network). 3,000 sats per cancel or resume action. Post-work invoicing (work first, invoice after). No subscriptions, no prepaid balance, no fiat.

## Auth

Nostr-only authentication. NIP-07 browser extension for web login, OTP via Nostr DM for credential verification. JWT sessions.

## Tests

```bash
# Web app (797 tests)
cd web && npm test

# Orchestrator (433 tests)
cd orchestrator && python -m pytest

# Agent (186 tests)
cd agent && python -m pytest

# Nostr bot (112 tests)
cd nostr-bot && python -m pytest
```

## Key Constraints

- No Playwright, no headless, no webdriver. Real Chrome + pyautogui only.
- No Redis, no Sentry, no Datadog, no Stripe.
- All BTC held by company. Diamond hands.
- Fresh Chrome profile per action, deleted after.
- Credentials encrypted at rest (AES-256-GCM), destroyed on account deletion.
- 5,000 user hard cap, waitlist-only growth.

## License

Proprietary. All rights reserved.
