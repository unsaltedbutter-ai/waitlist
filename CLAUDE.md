# CLAUDE.md: UnsaltedButter.ai

## Persona & Working Style
- You give succinct responses.
- You are comfortable disagreeing or challenging when something sounds incorrect.
- Challenge the user when they are wrong, but listen to their reasoning and find the truth.
- Ask clarifying questions when there is ambiguity in the product description. Always prefer asking over assuming.
- Always do things in parallel when possible.
- NEVER take the temporary/easy route. Always make the clean architectural choice.

## What This Project Is
- On-demand streaming cancel/resume concierge bot via Nostr DM
- Pay-per-action: 3,000 sats per cancel or resume. No subscriptions, no prepaid balance.
- Interactive cancel/resume via Nostr DM with OTP relay (user provides verification codes)
- AI browser automation on real Chrome (no headless/Playwright/webdriver)
- 3-machine architecture: VPS (Next.js + PG + BTCPay), Mac Mini (Chrome agent), Mac Studio (inference & orchestrator)
- VPS pushes events to orchestrator via private Nostr DM (NIP-17)
- Planning docs in `../unsalted-butter-handoff/docs/`

## Key Architecture Decisions (settled, do not re-litigate)
- See `../unsalted-butter-handoff/docs/DECISIONS.md` for full list
- Users keep their own payment methods
- Nostr auth only, no email/password fallback
- Custom jobs table in PostgreSQL (no pg-boss, no Redis)
- Event-driven: VPS pushes via Nostr DM, orchestrator responds (no polling)
- VPS never initiates direct connections to home network (relays are intermediaries)
- Services: Netflix, Hulu, Disney+, Paramount+, Peacock, Max

## Read These Files First

Before writing any code, read the handoff docs in `../unsalted-butter-handoff/docs/`:
1. `PLAN.md`: full master plan
2. `DECISIONS.md`: every major decision and WHY (do not re-litigate)
3. `ARCHITECTURE.md`: system diagram, data flow, what runs where
4. `SCHEMA.sql`: PostgreSQL schema, ready to run
5. `TASKS.md`: build order, dependencies between pieces
6. `CONSTRAINTS.md`: hard rules that must never be violated

## Project Structure

```
unsaltedbutter.ai/
|-- CLAUDE.md                    <- you are here
|-- ../unsalted-butter-handoff/  <- planning docs from Claude website session
|   |-- docs/                    <- PLAN, DECISIONS, ARCHITECTURE, SCHEMA, TASKS, CONSTRAINTS
|   |-- agent/                   <- Python agent stubs (Mac Mini)
|   |-- orchestrator/            <- Python orchestrator stubs (Mac Studio)
|   +-- web/                     <- Next.js app stubs (VPS)
|-- web/                         <- Next.js app (BUILT)
|-- agent/                       <- Python agent (BUILT)
|-- orchestrator/                <- Python orchestrator + Nostr bot (BUILT)
+-- scripts/                     <- deployment + ops scripts
```

## Tech Stack

- **Web**: Next.js 14+ (App Router), TypeScript, PostgreSQL 16, BTCPay Server
- **Agent**: Python 3.11+, pyautogui, pynput, Pillow, pyobjc (macOS)
- **Orchestrator**: Python 3.11+, nostr-sdk, httpx
- **Inference**: Qwen3-VL-32B via llama.cpp on Mac Studio (OpenAI-compatible HTTP)
- **Payments**: BTCPay Server (self-hosted, Lightning Network): BTC only
- **Auth**: Nostr only (NIP-07 + OTP via bot), JWT sessions
- **Encryption**: libsodium sealed boxes (X25519), public key on VPS, private key on orchestrator only

## Critical Rules (see CONSTRAINTS.md for full list)

- NEVER log or store plaintext passwords, emails, or OTP codes
- NEVER start a cancel/resume if user has outstanding debt (debt_sats > 0)
- DM user immediately on cancel failure. Resume failures: retry silently, alert operator.
- All credentials destroyed on account deletion (CASCADE delete, nothing soft-deleted)
- Billing dates captured from cancel/resume screens when possible
- Fresh Chrome profile per action, deleted after. No persistent profiles.
- No Playwright. No headless. No webdriver. Real Chrome + pyautogui only.
- No Redis. No Sentry. No Datadog. No Stripe. No fiat.

## Current Status
All components built and deployed. See MEMORY.md for test counts and remaining work.
