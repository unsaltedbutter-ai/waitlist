# scripts/ Directory

Operations scripts for the UnsaltedButter.ai production VPS.

## Overview

The VPS is a Hetzner CPX31 running Ubuntu 24.04 with:

- **Next.js app** (port 3000, managed by PM2)
- **PostgreSQL 16** (port 5432, app database)
- **BTCPay Server + LND + bitcoind + NBXplorer** (Docker stack, BTCPay on port 23000)
- **nginx** (reverse proxy, TLS termination via Let's Encrypt)
  - `unsaltedbutter.ai` proxies to Next.js `:3000`
  - `pay.unsaltedbutter.ai` proxies to BTCPay `:23000`

SSH access: `ssh butter@<VPS_IP>`. Repo lives at `/home/butter/unsaltedbutter`.

All alerting goes through Nostr DMs to the operator (NIP-04). No Sentry, no Datadog, no external monitoring.

---

## Script Inventory

### Provisioning (run once)

| Script | What it does | Run as | Run where |
|---|---|---|---|
| `setup-vps.sh` | Provisions a blank Ubuntu 24.04 VPS: creates `butter` user, installs Node.js 22, PG 16, nginx, Docker, PM2, certbot, fail2ban, UFW firewall, generates encryption keyfile, creates PG database | root | VPS |
| `setup-btcpay.sh` | Clones btcpayserver-docker, configures mainnet + LND + pruned bitcoind, starts Docker stack | butter | VPS |
| `setup-btcpay-store.sh` | Creates BTCPay store, connects internal LND node, generates API key + webhook, updates `.env.production` | butter | VPS |
| `harden-btcpay.sh` | Rotates BTCPay API key, revokes old key, disables public registration | butter | VPS |
| `setup-offsite-backup.sh` | Generates SSH key for Hetzner Storage Box, installs it, creates remote directory structure, runs initial sync | butter | VPS |
| `setup-nostrbot.sh` | Installs Nostr bot venv + dependencies, creates `~/.unsaltedbutter/nostr.env` from example, optionally installs systemd service | butter or dev user | Orchestrator or dev machine |
| `deploy-schema.sh` | One-time schema deployment (drops all tables, recreates). Self-destructs after running. | butter | VPS |
| `setup-orchestrator.sh` | Creates orchestrator venv + dependencies, creates `~/.unsaltedbutter/shared.env` and `orchestrator.env` from examples, optionally installs systemd service | butter or dev user | Mac Mini |
| `setup-launchagents.sh` | Installs launchd user agents for orchestrator + agent. `RunAtLoad` + `KeepAlive`. Supports `--uninstall` and `--status`. | dev user | Mac Mini |
| `setup-launchagent-inference.sh` | Installs launchd user agent for inference server. Same pattern. Supports `--uninstall` and `--status`. | dev user | Mac Studio |

### Deployment

| Script | What it does | Run as | Run where |
|---|---|---|---|
| `deploy.sh <VPS_IP>` | Standard deploy: rsync web/ and scripts/, npm ci, build, configure nginx, restart PM2, send deploy DM | local user | Local machine |
| `deploy.sh <VPS_IP> --init` | First deploy: also generates `.env.production`, applies DB schema, runs certbot | local user | Local machine |
| `deploy.sh <VPS_IP> --setup-bots` | One-time: installs all 7 cron jobs (including daily-cron) and creates update-checker venv | local user | Local machine |
| `deploy.sh <VPS_IP> --dirty` | Allows deploying with uncommitted git changes (not recommended) | local user | Local machine |

### Backups (automated via cron)

| Script | What it does | Schedule |
|---|---|---|
| `backup-daily.sh` | Dumps app PG, BTCPay PG, copies LND SCB, archives nginx config. Prunes backups older than 14 days. | `0 3 * * *` (03:00 UTC) |
| `backup-scb.sh` | Copies LND `channel.backup` file from Docker container. Keeps last 30 copies. Called by `backup-daily.sh`. | Called by daily backup |
| `backup-offsite.sh` | Rsyncs SCB backups and daily backups to Hetzner Storage Box. SCB synced first (most critical). No `--delete` on SCB to prevent accidental deletion replication. | `0 4 * * *` (04:00 UTC) |
| `lightning-backup.sh` | Exports SCB via `lncli exportchanbackup`, verifies it with `lncli verifychanbackup`, saves timestamped copy. | `0 */6 * * *` (every 6 hours) |

### Monitoring (automated via cron)

| Script | What it does | Schedule |
|---|---|---|
| `health-check.sh` | Checks disk (>85%), memory (>90%), Docker containers (btcpayserver, lnd_bitcoin, nbxplorer, bitcoind), PM2, nginx. Sends Nostr DM alerts on failure. | `*/15 * * * *` (every 15 min) |
| `lnd-balance.sh` | Logs on-chain + channel balances. Alerts if inbound liquidity drops below 250,000 sats (configurable via `INBOUND_THRESHOLD`). | `0 6 * * *` (06:00 UTC) |
| `update-checker.py` | Checks BTCPay, LND, Next.js, Node.js for new releases (GitHub API + npm registry). Checks Ubuntu package updates. Classifies security vs. routine. Sends Nostr DM. | `0 10 * * *` (10:00 UTC) |

### Alerting

| Script | What it does |
|---|---|
| `nostr-alert.py` | Shared CLI alert sender. Sends NIP-04 DMs to operator with per-key cooldown to avoid spam. Used by health-check, lnd-balance, backup-offsite, and any script that needs to alert. |
| `notify-deploy.py` | Sends a deploy notification DM to the operator. Called by `deploy.sh` after successful deploy. |

### Lightning Operations (manual, run on VPS)

| Script | What it does |
|---|---|
| `lightning-common.sh` | Shared config (container name, lncli wrapper, JSON parser). Sourced by all lightning-* scripts. |
| `lightning-status.sh` | Node dashboard: sync status, balances, channels, pending HTLCs. |
| `lightning-channel-report.sh` | Lists all channels sorted by lowest inbound liquidity. Shows visual bar chart per channel. |
| `lightning-open-channel.sh` | Opens a channel to a specified node. Supports `--private` and `--sat-per-vbyte`. |
| `lightning-send-sats.sh` | Sends sats via BOLT11 invoice or Lightning Address (LNURL-pay resolution). Interactive confirmation. |
| `lightning-onchain-receive-address.sh` | Generates a new on-chain address (p2wkh or p2tr) for funding the LND wallet. |
| `lightning-lookup-payment.sh` | Customer support tool: look up payments by hash, decode invoices, show pending/recent invoices. |
| `lightning-close-channel.sh` | Closes a channel (cooperative or force). Interactive confirmation, shows balance summary before closing. |
| `lightning-set-fees.sh` | View or update routing fee policy for channels. |

### Utility

| Script | What it does |
|---|---|
| `preflight-check.sh` | Pre-maintenance readiness check. Checks HTLCs, active jobs, pending channels, containers, LND sync. GO/WAIT verdict. |
| `invite-npub.sh` | Creates a waitlist invite for an npub. With `--operator`, also creates user row and sets `OPERATOR_USER_ID`. |
| `nostr.env.example` | Template for `~/.unsaltedbutter/nostr.env` (Nostr bot identity, relays, operator npub, zap config, DB URL). |
| `nginx/unsaltedbutter.conf` | nginx config: reverse proxy for Next.js and BTCPay, rate limiting (10 req/s per IP on /api/), HSTS, scanner blocking. |

### Migrations (one-time SQL files, applied via `psql`)

All `migrate-*.sql` files in this directory are incremental schema migrations. Apply with:

```bash
ssh butter@<VPS_IP>
PGPASSWORD=$(cat ~/.unsaltedbutter/db_password) psql -h localhost -U butter -d unsaltedbutter -f /home/butter/unsaltedbutter/scripts/<migration>.sql
```

---

## Fresh VPS Setup

Starting from a blank Hetzner CPX31 (Ubuntu 24.04), repo already cloned locally.

### Step 1: Provision the VPS

```bash
# Copy setup script to the VPS (as root)
scp scripts/setup-vps.sh root@<VPS_IP>:~

# Run it
ssh root@<VPS_IP> "chmod +x setup-vps.sh && ./setup-vps.sh"
```

This creates the `butter` user, installs all system packages, generates the encryption keyfile at `/etc/unsaltedbutter/encryption.keyfile`, creates the PostgreSQL database, and saves the DB password to `/home/butter/.unsaltedbutter/db_password`.

**CRITICAL**: Back up `/etc/unsaltedbutter/encryption.keyfile` offline immediately. Loss of this file means all encrypted credentials in the database are irrecoverable.

### Step 2: Verify SSH and harden

```bash
# Verify butter user SSH works
ssh butter@<VPS_IP> "whoami"

# Then harden SSH (disable root login + password auth)
ssh root@<VPS_IP> bash -c '
  sed -i "s/^#\?PermitRootLogin.*/PermitRootLogin no/" /etc/ssh/sshd_config
  sed -i "s/^#\?PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config
  systemctl restart ssh
'
```

### Step 3: Install BTCPay Server

```bash
ssh butter@<VPS_IP>
~/unsaltedbutter/scripts/setup-btcpay.sh
```

Bitcoin initial sync takes 6-24 hours. Everything else can proceed while it syncs.

### Step 4: First deploy (schema + SSL + env)

```bash
# From your local machine, in the project root:
./scripts/deploy.sh <VPS_IP> --init
```

This rsyncs code, generates `.env.production` with random secrets, applies the database schema, installs nginx config, runs certbot for SSL, and starts PM2.

### Step 5: Set up cron jobs and monitoring

```bash
./scripts/deploy.sh <VPS_IP> --setup-bots
```

This installs the update-checker Python venv and all 7 cron jobs (including the daily job-scheduling cron).

### Step 6: Configure nostr.env (for alerting)

```bash
ssh butter@<VPS_IP>
mkdir -p ~/.unsaltedbutter
cp ~/unsaltedbutter/scripts/nostr.env.example ~/.unsaltedbutter/nostr.env
nano ~/.unsaltedbutter/nostr.env
# Set NOSTR_NSEC (VPS alert bot key) and verify OPERATOR_NPUB
chmod 600 ~/.unsaltedbutter/nostr.env
```

Test alerting:

```bash
~/venvs/update-checker/bin/python ~/unsaltedbutter/scripts/nostr-alert.py --dry-run --key test "Test alert"
```

### Step 7: Configure BTCPay store + API key

Wait for Bitcoin sync to finish, then:

1. Visit `https://pay.unsaltedbutter.ai` and create admin account (first account = admin)
2. Create a store in the BTCPay UI

```bash
ssh butter@<VPS_IP>
~/unsaltedbutter/scripts/setup-btcpay-store.sh
# Enter BTCPay password when prompted
```

This connects Lightning, creates an API key, sets up the webhook, and updates `.env.production`.

### Step 8: Harden BTCPay (disable registration, rotate key)

```bash
ssh butter@<VPS_IP>
~/unsaltedbutter/scripts/harden-btcpay.sh
```

### Step 9: Set up offsite backups (Storage Box)

```bash
ssh butter@<VPS_IP>
~/unsaltedbutter/scripts/setup-offsite-backup.sh u547750 u547750.your-storagebox.de
# Enter Storage Box password once (for SSH key install)
```

### Step 10: Invite the operator

```bash
ssh butter@<VPS_IP>
~/unsaltedbutter/scripts/invite-npub.sh npub1... --operator
pm2 restart unsaltedbutter
```

---

## Orchestrator Server Setup

On the orchestrator/agent machine:

- `./scripts/setup-launchagents.sh`

- Logs:
  `tail -f ~/logs/orchestrator-stdout.log`
  `tail -f ~/logs/agent-stdout.log`

Control:
  `launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator`  # restart orchestrator
  `launchctl kickstart -k gui/501/com.unsaltedbutter.agent`  # restart agent
  `./scripts/setup-launchagents.sh --status`           # check state
  `./scripts/setup-launchagents.sh --uninstall`        # remove

---

## Inference Server Setup

The inference server provides VLM inference for browser automation. It supports multiple backends:

- `mock`: Deterministic responses for testing (default)
- `openai`: Any OpenAI-compatible API endpoint (PPQ.ai now, local llama.cpp later)
- `llama_cpp`: Direct llama-cpp-python bindings (requires GPU hardware)
- `mlx`: MLX-VLM on Apple Silicon (requires GPU hardware)

### Quick Start (OpenAI backend via PPQ.ai)

```bash
cd inference
python3.13 -m venv venv
venv/bin/pip install -r requirements.txt

mkdir -p ~/.unsaltedbutter
cp ../env-examples/inference.env.example ~/.unsaltedbutter/inference.env
```

Edit `~/.unsaltedbutter/inference.env`:

```
MODEL_BACKEND=openai
VLM_BASE_URL=https://api.ppq.ai
VLM_API_KEY=<your-ppq-api-key>
VLM_MODEL=qwen3-vl-32b-instruct
```

Run and verify:

```bash
venv/bin/python -m inference.server
curl http://localhost:8420/health
```

### Swapping to Local Inference (Mac Studio)

When the Mac Studio is ready, change two lines in `~/.unsaltedbutter/inference.env`:

```
VLM_BASE_URL=http://localhost:8080
VLM_API_KEY=
```

If `VLM_BASE_URL` points to localhost, the server auto-starts a llama-cpp-python subprocess using `MODEL_PATH` and `GPU_LAYERS` from the same env file. Zero code changes required.

---

## What Is Backed Up

| Data | Method | Retention | Location | Offsite? |
|---|---|---|---|---|
| App PostgreSQL (full dump) | `pg_dump`, gzipped | 14 days | `~/backups/pg_app_*.sql.gz` | Yes (Storage Box) |
| BTCPay PostgreSQL (full dump) | `docker exec pg_dumpall`, gzipped | 14 days | `~/backups/pg_btcpay_*.sql.gz` | Yes (Storage Box) |
| LND Static Channel Backup (SCB) | `docker cp channel.backup` (backup-scb.sh) | 30 copies | `~/scb-backups/channel.backup.*` | Yes (Storage Box, no --delete) |
| LND SCB (verified export) | `lncli exportchanbackup` + `verifychanbackup` | Unlimited (in backup dir) | `~/scb-backups/channel-backup-*.bak` | Yes (Storage Box) |
| nginx config | `tar czf` of `/etc/nginx/` | 14 days | `~/backups/nginx_*.tar.gz` | Yes (Storage Box) |

**Backup schedule**: Local backups at 03:00 UTC, offsite sync at 04:00 UTC, SCB verified export every 6 hours.

**Offsite target**: Hetzner Storage Box (separate failure domain from VPS). SSH key auth via `~/.ssh/storagebox_ed25519`.

---

## What Is NOT Backed Up

These items are **not** included in automated backups. Loss of any of them requires manual reconstruction.

| Item | Why not backed up | Recovery path |
|---|---|---|
| BTCPay Docker volumes (bitcoind chain data, LND full DB) | Too large (~50GB+), reconstructible from network | Re-sync from Bitcoin network (6-24 hours) |
| LND full database (`/data/.lnd/`) | Backed up only as SCB (Static Channel Backup). Full DB is inside Docker volumes. | SCB recovery (force-closes channels). See [SCB Recovery](#lightning-scb-recovery). |
| `.env.production` | Contains generated secrets (JWT, HMAC, Nostr privkey). Not safe to store in backups. | Regenerate with `deploy.sh --init` (loses all existing secrets, requires BTCPay reconfiguration) |
| `/etc/unsaltedbutter/encryption.keyfile` | Must be backed up manually offline. Not in automated backups. | If lost: all encrypted credentials in the database are **permanently irrecoverable**. |
| `~/.unsaltedbutter/nostr.env` | Contains Nostr private key. Manual backup only. | Recreate from `nostr.env.example`, generate or restore nsec. |
| `~/.ssh/storagebox_ed25519` | SSH key for offsite backups. | Regenerate with `setup-offsite-backup.sh` (requires Storage Box password). |
| The OS itself | No full disk snapshots. | Rebuild from `setup-vps.sh`. Hetzner also offers VPS snapshots if you want them. |
| PM2 process list | Recreated by `deploy.sh` on every deploy. | `pm2 start ecosystem.config.cjs && pm2 save` |
| Let's Encrypt certificates | Certbot auto-renews. Stored in `/etc/letsencrypt/`. | `sudo certbot --nginx -d unsaltedbutter.ai -d pay.unsaltedbutter.ai` |

---

## Monitoring and Alerting

### How It Works

Three scripts form the monitoring stack. All alerts are delivered as Nostr DMs (NIP-04) to the operator's npub.

1. **`health-check.sh`** (every 15 minutes): Checks disk usage, memory usage, Docker container status (btcpayserver, lnd_bitcoin, nbxplorer, bitcoind), PM2 app status, and nginx status. Any failure triggers a Nostr DM via `nostr-alert.py`.

2. **`lnd-balance.sh`** (daily at 06:00 UTC): Logs on-chain balance, channel local balance, and inbound liquidity. Alerts if inbound liquidity drops below 250,000 sats (configurable via `INBOUND_THRESHOLD` env var).

3. **`nostr-alert.py`** (shared library, not scheduled): Every alert call specifies a `--key` (e.g., `disk-high`, `container-lnd`, `pm2-down`). The alert is only sent if the key is not within its cooldown window.

### Cooldown System

`nostr-alert.py` prevents alert spam using per-key cooldowns stored in `~/.nostr-alert-state.json`:

| Alert key | Default cooldown |
|---|---|
| `pm2-down` | 1 hour |
| `nginx-down` | 1 hour |
| `container-*` | 1 hour |
| `disk-high` | 6 hours |
| `memory-high` | 6 hours |
| `lnd-down` | 6 hours |
| `inbound-low` | 24 hours |
| Everything else | 6 hours |

Override with `--cooldown N` (hours) or `--force` to bypass.

### What Triggers Alerts

| Condition | Script | Alert key |
|---|---|---|
| Disk usage > 85% | health-check.sh | `disk-high` |
| Memory usage > 90% | health-check.sh | `memory-high` |
| Docker container down | health-check.sh | `container-<name>` |
| PM2 app not online | health-check.sh | `pm2-down` |
| nginx down | health-check.sh | `nginx-down` |
| LND container not running | lnd-balance.sh | `lnd-down` |
| Inbound liquidity < 250k sats | lnd-balance.sh | `inbound-low` |
| Offsite SCB sync failed | backup-offsite.sh | `offsite-scb-fail` |
| Offsite daily sync failed | backup-offsite.sh | `offsite-daily-fail` |

### Configuration

Alerting requires `~/.unsaltedbutter/nostr.env` with at minimum:

```
NOSTR_NSEC=nsec1...
OPERATOR_NPUB=npub1...
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social
```

---

## Cron Schedule

All cron jobs are installed by `deploy.sh --setup-bots`. View with `crontab -l`.

| Schedule | Script | Purpose |
|---|---|---|
| `*/15 * * * *` | `health-check.sh` | System health monitoring |
| `0 3 * * *` | `backup-daily.sh` | Local backups (PG dumps, SCB, nginx) |
| `0 4 * * *` | `backup-offsite.sh` | Offsite sync to Storage Box |
| `0 6 * * *` | `lnd-balance.sh` | Balance logging + inbound liquidity alert |
| `0 10 * * *` | `update-checker.py` | Software update check + DM |
| `0 */6 * * *` | `lightning-backup.sh` | Verified SCB export |
| `0 10 * * *` | `curl /api/cron/daily` | Create pending cancel/resume jobs for users approaching billing dates |

Log locations:

```
~/logs/health.log
~/logs/lnd-balance.log
~/logs/backup.log
~/logs/scb.log
~/logs/offsite-backup.log
~/logs/update-checker.log
```

---

## Restore Procedures

### PostgreSQL Database Loss (App DB)

The app database contains users, credentials, jobs, transactions, waitlist, and operator alerts.

1. Find the most recent backup:

```bash
ls -lt ~/backups/pg_app_*.sql.gz | head -5
```

2. If local backups are lost, pull from offsite:

```bash
rsync -az -e "ssh -p 23 -i ~/.ssh/storagebox_ed25519 -o BatchMode=yes" \
  u547750@u547750.your-storagebox.de:backups/daily/ ~/backups-restore/
ls -lt ~/backups-restore/pg_app_*.sql.gz | head -5
```

3. Drop and recreate the database:

```bash
DB_PASS=$(cat ~/.unsaltedbutter/db_password)
PGPASSWORD="$DB_PASS" psql -h localhost -U butter -d postgres -c "DROP DATABASE unsaltedbutter;"
PGPASSWORD="$DB_PASS" psql -h localhost -U butter -d postgres -c "CREATE DATABASE unsaltedbutter OWNER butter;"
```

4. Restore:

```bash
gunzip -c ~/backups/pg_app_20260219_030001.sql.gz | PGPASSWORD="$DB_PASS" psql -h localhost -U butter -d unsaltedbutter
```

5. Verify:

```bash
PGPASSWORD="$DB_PASS" psql -h localhost -U butter -d unsaltedbutter -c "SELECT count(*) FROM users;"
```

6. Restart the app:

```bash
pm2 restart unsaltedbutter
```

### BTCPay PostgreSQL Loss

BTCPay's PostgreSQL runs inside Docker. It stores store configuration, invoices, and payment history.

1. Find the most recent backup:

```bash
ls -lt ~/backups/pg_btcpay_*.sql.gz | head -5
```

2. Identify the BTCPay Postgres container:

```bash
BTCPAY_PG=$(sudo docker ps --format '{{.Names}}' | grep 'generated_postgres' | head -1)
echo "$BTCPAY_PG"
```

3. Copy the backup into the container and restore:

```bash
gunzip -c ~/backups/pg_btcpay_20260219_030001.sql.gz > /tmp/btcpay_restore.sql
sudo docker cp /tmp/btcpay_restore.sql "$BTCPAY_PG":/tmp/restore.sql
sudo docker exec "$BTCPAY_PG" psql -U postgres -f /tmp/restore.sql
sudo docker exec "$BTCPAY_PG" rm /tmp/restore.sql
rm /tmp/btcpay_restore.sql
```

4. Restart BTCPay stack:

```bash
cd ~/btcpayserver-docker
docker compose restart
```

### LND Database Loss (SCB Recovery)

If the LND database is corrupted or lost but the Docker volume is still intact, LND may recover on its own. If not, SCB recovery is required. **Read the [Lightning SCB Recovery](#lightning-scb-recovery) section before proceeding.**

### Full VPS Loss (Complete Rebuild)

Total VPS destruction: OS, Docker volumes, local backups, everything.

**Prerequisites**:
- Encryption keyfile backup (offline)
- LND wallet seed (24 words, offline)
- Access to Hetzner Storage Box (credentials)
- DNS control for `unsaltedbutter.ai` and `pay.unsaltedbutter.ai`

**Procedure**:

1. Provision a new Hetzner CPX31 with Ubuntu 24.04.

2. Update DNS A records for `unsaltedbutter.ai` and `pay.unsaltedbutter.ai` to point to the new IP.

3. Run `setup-vps.sh` on the new VPS (as root). **Do not let it generate a new encryption keyfile**:

```bash
scp scripts/setup-vps.sh root@<NEW_IP>:~
ssh root@<NEW_IP> "chmod +x setup-vps.sh && ./setup-vps.sh"
```

4. Replace the generated encryption keyfile with your offline backup:

```bash
scp /path/to/backup/encryption.keyfile root@<NEW_IP>:/etc/unsaltedbutter/encryption.keyfile
ssh root@<NEW_IP> "chmod 0400 /etc/unsaltedbutter/encryption.keyfile && chown butter:butter /etc/unsaltedbutter/encryption.keyfile"
```

5. Harden SSH (verify `ssh butter@<NEW_IP>` works first).

6. Install BTCPay Server:

```bash
ssh butter@<NEW_IP>
~/unsaltedbutter/scripts/setup-btcpay.sh
```

7. Wait for Bitcoin sync (6-24 hours). Restore LND wallet from seed during LND initialization.

8. Deploy the app:

```bash
# From local machine
./scripts/deploy.sh <NEW_IP> --init
./scripts/deploy.sh <NEW_IP> --setup-bots
```

9. Restore the app database from offsite backup:

```bash
ssh butter@<NEW_IP>
# Set up offsite backup SSH key
~/unsaltedbutter/scripts/setup-offsite-backup.sh u547750 u547750.your-storagebox.de
# Pull backups
rsync -az -e "ssh -p 23 -i ~/.ssh/storagebox_ed25519 -o BatchMode=yes" \
  u547750@u547750.your-storagebox.de:backups/daily/ ~/backups/
# Restore latest app PG
DB_PASS=$(cat ~/.unsaltedbutter/db_password)
LATEST=$(ls -t ~/backups/pg_app_*.sql.gz | head -1)
gunzip -c "$LATEST" | PGPASSWORD="$DB_PASS" psql -h localhost -U butter -d unsaltedbutter
```

10. Restore BTCPay PostgreSQL from offsite backup (same procedure as BTCPay PG loss above).

11. Perform SCB recovery if there were open Lightning channels (see section below).

12. Reconfigure `.env.production` with BTCPay credentials (run `setup-btcpay-store.sh`).

13. Recreate `~/.unsaltedbutter/nostr.env` for alerting.

14. Verify everything:

```bash
pm2 list
sudo docker ps
~/unsaltedbutter/scripts/health-check.sh
~/unsaltedbutter/scripts/lightning-status.sh
```

---

## Lightning SCB Recovery

**This is a last resort.** SCB (Static Channel Backup) recovery force-closes ALL open Lightning channels. Funds are returned to the on-chain wallet, but only after the channel's timelock expires (typically 144-2016 blocks, which is 1-14 days).

During the timelock period:
- Channel funds are **locked and unusable**
- Lightning payments cannot be sent or received through those channels
- The node cannot earn routing fees

**A human must verify channel states before triggering SCB recovery.** Do not automate this.

### When to Use SCB Recovery

- LND database is corrupted beyond repair
- LND cannot start and logs show database errors
- You have exhausted other recovery options (restarting LND, rebuilding indexes)

### Procedure

1. **Stop LND** to prevent further database corruption:

```bash
cd ~/btcpayserver-docker
docker compose stop lnd_bitcoin
```

2. **Verify you have a recent SCB backup**:

```bash
ls -lt ~/scb-backups/ | head -5
```

If local backups are missing, pull from offsite:

```bash
rsync -az -e "ssh -p 23 -i ~/.ssh/storagebox_ed25519 -o BatchMode=yes" \
  u547750@u547750.your-storagebox.de:backups/scb/ ~/scb-backups-restore/
ls -lt ~/scb-backups-restore/ | head -5
```

3. **Check the current channel state** (if LND can start briefly):

```bash
docker compose start lnd_bitcoin
sleep 10
~/unsaltedbutter/scripts/lightning-channel-report.sh
~/unsaltedbutter/scripts/lightning-status.sh
docker compose stop lnd_bitcoin
```

Document: how many channels, total local balance, total remote balance. This is what you are force-closing.

4. **Delete the corrupted LND database** and restart LND with seed recovery:

```bash
# The LND data lives in a Docker volume. Identify it:
docker volume ls | grep lnd

# Remove the channel database (NOT the wallet):
docker compose run --rm lnd_bitcoin bash -c "rm -rf /data/.lnd/data/graph /data/.lnd/data/chain/bitcoin/mainnet/channel.db"

# Restart LND (it will recreate the database)
docker compose start lnd_bitcoin
sleep 30

# Unlock the wallet (if required)
docker exec -it btcpayserver_lnd_bitcoin lncli -n mainnet unlock
```

5. **Restore from SCB**:

```bash
# Copy the latest SCB into the container
LATEST_SCB=$(ls -t ~/scb-backups/channel-backup-*.bak ~/scb-backups/channel.backup.* 2>/dev/null | head -1)
docker cp "$LATEST_SCB" btcpayserver_lnd_bitcoin:/tmp/restore.backup

# Trigger SCB recovery (this force-closes ALL channels)
docker exec btcpayserver_lnd_bitcoin lncli -n mainnet \
  --macaroonpath=/data/admin.macaroon \
  --tlscertpath=/data/tls.cert \
  restorechanbackup --multi_file=/tmp/restore.backup
```

6. **Monitor force-close progress**:

```bash
# Check pending channels (force-closing)
~/unsaltedbutter/scripts/lightning-status.sh

# Watch for on-chain transactions
docker exec btcpayserver_lnd_bitcoin lncli -n mainnet \
  --macaroonpath=/data/admin.macaroon \
  --tlscertpath=/data/tls.cert \
  pendingchannels
```

7. **After funds are returned** (1-14 days), open new channels:

```bash
~/unsaltedbutter/scripts/lightning-open-channel.sh <pubkey>@<host>:<port> <amount_sats>
```

---

## Human-Required Steps

The following cannot be automated and require manual intervention:

| Step | When | Why |
|---|---|---|
| **BTCPay admin account creation** | After `setup-btcpay.sh` | First account at `pay.unsaltedbutter.ai` becomes admin. Must be done via browser. |
| **DNS A record changes** | After VPS IP changes | Update `unsaltedbutter.ai` and `pay.unsaltedbutter.ai` to new IP. |
| **LND wallet seed backup** | After initial BTCPay setup | The 24-word seed is displayed once during wallet creation. Write it down offline. Verify it exists before any recovery. |
| **Encryption keyfile backup** | After `setup-vps.sh` | Copy `/etc/unsaltedbutter/encryption.keyfile` to offline storage. Loss = permanent credential data loss. |
| **SCB recovery decision** | After LND database loss | A human must verify channel states, assess the impact of force-closing all channels, and decide whether to proceed. |
| **Channel rebalancing after recovery** | After SCB recovery completes | Open new channels, choose peers, set fee policies. Requires manual assessment of liquidity needs. |
| **Storage Box password** | During `setup-offsite-backup.sh` | Needed once to install the SSH key. After that, key auth is used. |
| **nostr.env configuration** | After `--setup-bots` | Set `NOSTR_NSEC` for alerting identity. Cannot be generated automatically. |
| **BTCPay store creation** | Before `setup-btcpay-store.sh` | Create a store in the BTCPay UI first. The script finds and configures it. |
| **SSL certificate renewal verification** | Periodically | Certbot auto-renews, but verify it is working: `sudo certbot renew --dry-run` |

---

## Update Procedures

`update-checker.py` sends a daily DM with available updates, classified by severity. This section explains how to evaluate and perform each type of update.

### Evaluating Updates

| Severity | Meaning | Timeline |
|---|---|---|
| **CRITICAL** | Security CVE in LND, BTCPay, or Node.js. Funds or server security at risk. | Same day. Schedule maintenance window. |
| **UBUNTU SECURITY** | OS-level security patches. | Within 24-48 hours. |
| **routine** | Patch or minor version bump within the same release line. | Next regular maintenance window (weekly). |
| **info** | Major version bump (e.g., Node 22 -> 24). Not urgent. | Plan and test. Only upgrade when current LTS approaches EOL. |

For LND and BTCPay specifically: always read the release notes before updating. Look for:
- Database migration requirements
- Breaking API changes
- Protocol changes that affect channel peers
- Minimum peer version requirements

### BTCPay Server + LND (Docker Stack)

BTCPay Server and LND are deployed together via the btcpayserver-docker stack. Updating BTCPay typically updates LND as well.

**Downtime**: Docker stack restarts. Lightning payments unavailable for 30-60 seconds. No incoming payments can be processed during restart.

**Pre-update checks** (especially with active customers):

```bash
~/unsaltedbutter/scripts/preflight-check.sh
```

This checks pending HTLCs, active/pending jobs, pending channels, Docker container health, LND sync status, and PM2 status. It gives a clear GO or WAIT verdict. Do not proceed until it says GO.

For scripting (e.g., in an update script), use `--quiet` and check the exit code:

```bash
~/unsaltedbutter/scripts/preflight-check.sh --quiet && echo "Safe to proceed" || echo "Not ready"
```

**Update procedure**:

```bash
# 1. Read release notes first
# BTCPay: https://github.com/btcpayserver/btcpayserver/releases
# LND: https://github.com/lightningnetwork/lnd/releases

# 2. Update the Docker stack
cd ~/btcpayserver-docker
sudo su -c '. btcpay-setup.sh'

# 3. Verify containers are running
sudo docker ps

# 4. Verify LND is synced and channels are active
~/unsaltedbutter/scripts/lightning-status.sh

# 5. Verify BTCPay is responding
curl -s https://pay.unsaltedbutter.ai/api/v1/health | python3 -m json.tool
```

### Next.js

**Downtime**: Near-zero. PM2 restarts the process in seconds.

**Update procedure**:

```bash
# 1. On your local machine, update package.json
cd web
npm install next@latest

# 2. Test locally
npm run build && npm run dev

# 3. Deploy
./scripts/deploy.sh <VPS_IP>
```

For major version bumps (e.g., Next.js 15 -> 16), read the migration guide first. Major versions may require code changes.

### Node.js

The update checker only compares within the same LTS major line (e.g., 22.x -> 22.y). It will not flag a new LTS track (e.g., 22 -> 24) as an urgent update.

**When to upgrade major versions**: When the current LTS enters maintenance mode (typically 18 months after release). Check the Node.js release schedule at https://nodejs.org/en/about/previous-releases.

**Downtime**: PM2 restart (seconds).

**Update procedure**:

```bash
# 1. On the VPS, install the new version
ssh butter@<VPS_IP>
sudo n install <version>  # or: sudo n lts

# 2. Verify
node --version

# 3. Rebuild and restart
cd ~/unsaltedbutter/web
npm ci
npm run build
pm2 restart unsaltedbutter
```

For major version bumps, test the build locally with the new Node version first.

### Ubuntu Packages

**Security packages**: Apply within 24-48 hours.

**Non-security packages**: Batch monthly or as convenient.

**Procedure**:

```bash
ssh butter@<VPS_IP>

# Review what will be upgraded
apt list --upgradable

# Apply upgrades
sudo apt upgrade -y

# If kernel was updated, reboot
sudo reboot
```

After reboot, verify services:

```bash
pm2 list
sudo docker ps
~/unsaltedbutter/scripts/health-check.sh
```

### At Scale (500-5000 customers)

With active customers, updates require coordination:

1. **Announce maintenance**: Send a Nostr DM to users at least 1 hour before planned downtime for Docker stack updates.

2. **Pick low-traffic windows**: Schedule Docker stack restarts during low-traffic hours (03:00-05:00 UTC).

3. **Drain active work first**:
   - Wait for all active jobs to complete (no mid-action cancels/resumes)
   - Wait for pending HTLCs to resolve
   - Pause the job queue (set a maintenance flag or stop the cron timer)

4. **Monitor after update**:
   - Watch `~/logs/health.log` for the first few health-check cycles
   - Verify Lightning channels reconnect with peers
   - Verify payment processing works (create a test invoice)

5. **Rollback plan**:
   - For BTCPay/LND: Docker stack can be rolled back by checking out the previous btcpayserver-docker version
   - For Next.js: Redeploy the previous git commit with `deploy.sh`
   - For Node.js: `sudo n install <previous-version>` and rebuild

---

## Private Prompts Package

Service-specific VLM prompts, recording decision trees, and playbook JSON files are extracted into a separate private pip package (`unsaltedbutter-prompts`). The public repo ships with generic stubs that have the correct interface but no real service content.

### What's in the Private Package

| Module | Contents |
|--------|----------|
| `unsaltedbutter_prompts.inference` | VLM system prompts (find_element, checkpoint, infer_action), password guard |
| `unsaltedbutter_prompts.recording` | Recording prompts (sign-in, cancel, resume), SERVICE_HINTS dict |
| `unsaltedbutter_prompts.playbooks` | All service playbook JSON files, `get_playbook_dir()` helper |

### How It Works

The public repo's `inference/prompts.py` and `agent/recording/prompts.py` are thin shims:

```python
try:
    from unsaltedbutter_prompts.inference import (
        FIND_ELEMENT_SYSTEM, build_find_element_prompt, ...
    )
except ImportError:
    # Generic stubs with correct interface
    FIND_ELEMENT_SYSTEM = "You are a visual UI element locator. ..."
    def build_find_element_prompt(description, context=""): ...
```

Playbook resolution in `agent/config.py` follows this priority:
1. `PLAYBOOK_DIR` environment variable (if set and directory exists)
2. `unsaltedbutter_prompts.playbooks.get_playbook_dir()` (if package installed)
3. `agent/playbooks/` (local directory with example stubs)

### Installation (Development)

```bash
# Clone the private repo
git clone git@github.unsaltedbutter:unsaltedbutter-ai/prompts.git ../unsaltedbutter-prompts

# Install as editable in each component's venv
cd agent && source venv/bin/activate && pip install -e ../../unsaltedbutter-prompts
cd inference && source venv/bin/activate && pip install -e ../../unsaltedbutter-prompts
```

### Verification

```bash
# With private package installed: tests exercise real prompts
cd inference && python -m pytest tests/test_prompts.py
cd agent && python -m pytest tests/test_recording.py

# Without private package: stubs load, tests still pass
pip uninstall unsaltedbutter-prompts
python -c "from inference.prompts import FIND_ELEMENT_SYSTEM; print(FIND_ELEMENT_SYSTEM[:50])"
```
