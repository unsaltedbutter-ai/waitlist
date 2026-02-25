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
|   Chrome + pyautogui, VLM-driven  |            | Nostr DMs (NIP-17/NIP-04)
|                                   |            | HTTPS
| Inference (Mac Studio)            |            |
|   Qwen3-VL-32B local              |     [ Users via web browser ]
+-----------------------------------+
```

Four machines, three components:

| Component | Runs on | Stack |
|-----------|---------|-------|
| **Web** | VPS | Next.js 14, TypeScript, PostgreSQL 16, BTCPay Server |
| **Orchestrator** | Mac Mini | Python 3.13, nostr-sdk, SQLite, httpx |
| **Agent** | Mac Mini | Python 3.13, pyautogui, pynput, Pillow |
| **Inference** | Mac Studio | OpenAI-compatible API |

## Project Structure

```
unsaltedbutter.ai/
├── web/                    Next.js app (VPS)
├── agent/                  Python browser agent (Mac Mini)
├── orchestrator/           Python orchestrator + Nostr bot (Mac Mini)
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
- `orchestrator.env`, `agent.env` (component overrides)

See `env-examples/` for templates.

```bash
# Orchestrator
cd orchestrator && pip install -r requirements.txt
python -m orchestrator

# Agent
cd agent && pip install -r requirements.txt
python -m agent run <service> <action>
```

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
```

## Key Constraints

- No Playwright, no headless, no webdriver. Real Chrome + pyautogui only.
- No Redis, no Sentry, no Datadog, no Stripe.
- All BTC held by company. Diamond hands.
- Fresh Chrome profile per action, deleted after.
- Credentials encrypted at rest (AES-256-GCM), destroyed on account deletion.

## License

Proprietary. All rights reserved.
