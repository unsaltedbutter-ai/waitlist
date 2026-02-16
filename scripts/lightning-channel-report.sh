#!/usr/bin/env bash
# =============================================================================
# lightning-channel-report.sh
#
# Lists all channels with liquidity breakdown, sorted by lowest inbound first.
# This tells you which channels are close to being unable to receive payments.
# Run ON THE VPS as butter.
# =============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lightning-common.sh"

CHANNELS=$($LNCLI listchannels)

# Build a map of pubkey -> alias for all channel peers
PEER_ALIASES=$(echo "$CHANNELS" | python3 -c "
import sys, json, subprocess, shlex
data = json.load(sys.stdin)
channels = data.get('channels', [])
seen = set()
aliases = {}
lncli = '$LNCLI'
for ch in channels:
    pk = ch.get('remote_pubkey', '')
    if not pk or pk in seen:
        continue
    seen.add(pk)
    try:
        cmd = shlex.split(lncli) + ['getnodeinfo', '--pub_key', pk]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            info = json.loads(result.stdout)
            alias = info.get('node', {}).get('alias', '')
            if alias:
                aliases[pk] = alias
    except Exception:
        pass
import json as j
print(j.dumps(aliases))
" 2>/dev/null || echo "{}")

CHANNEL_COUNT=$(echo "$CHANNELS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('channels',[])))" 2>/dev/null || echo "0")

if [ "$CHANNEL_COUNT" = "0" ]; then
    echo "No channels found."
    echo ""
    echo "Open a channel with: ./lightning-open-channel.sh <pubkey>@<host>:<port> <amount_sats>"
    exit 0
fi

echo "$CHANNELS" | PEER_ALIASES="$PEER_ALIASES" python3 -c "
import sys, json, os

aliases = json.loads(os.environ.get('PEER_ALIASES', '{}'))
data = json.load(sys.stdin)
channels = data.get('channels', [])

# Collect channel info
rows = []
for ch in channels:
    capacity = int(ch.get('capacity', 0))
    local = int(ch.get('local_balance', 0))
    remote = int(ch.get('remote_balance', 0))
    active = ch.get('active', False)
    peer = ch.get('remote_pubkey', '')
    chan_id = ch.get('chan_id', '')
    chan_point = ch.get('channel_point', '')
    htlcs = len(ch.get('pending_htlcs', []))

    inbound_pct = (remote / capacity * 100) if capacity > 0 else 0

    rows.append({
        'peer': peer,
        'chan_id': chan_id,
        'chan_point': chan_point,
        'capacity': capacity,
        'local': local,
        'remote': remote,
        'inbound_pct': inbound_pct,
        'active': active,
        'htlcs': htlcs,
    })

# Sort by inbound % ascending (lowest inbound first = most at risk)
rows.sort(key=lambda r: r['inbound_pct'])

total_local = sum(r['local'] for r in rows)
total_remote = sum(r['remote'] for r in rows)
total_capacity = sum(r['capacity'] for r in rows)
total_inbound_pct = (total_remote / total_capacity * 100) if total_capacity > 0 else 0

print(f'Channels: {len(rows)}    Total capacity: {total_capacity:,} sats')
print(f'Outbound (local): {total_local:,} sats    Inbound (remote): {total_remote:,} sats    ({total_inbound_pct:.0f}% inbound)')
print()

# Bar width for the visual indicator
BAR_WIDTH = 30

for r in rows:
    status = 'ACTIVE' if r['active'] else 'INACTIVE'
    peer_short = r['peer'][:12] + '...' + r['peer'][-6:]

    # Build a simple bar: [=====>          ]
    # Left = local, right = remote
    if r['capacity'] > 0:
        local_blocks = round(r['local'] / r['capacity'] * BAR_WIDTH)
    else:
        local_blocks = 0
    remote_blocks = BAR_WIDTH - local_blocks
    bar = '=' * local_blocks + '|' + '.' * remote_blocks

    # Color the inbound percentage based on health
    inbound = r['inbound_pct']
    if inbound < 15:
        health = 'LOW'
    elif inbound < 30:
        health = 'MED'
    else:
        health = 'OK'

    htlc_str = f'  HTLCs: {r[\"htlcs\"]}' if r['htlcs'] > 0 else ''

    alias = aliases.get(r['peer'], '')
    alias_str = f'  ({alias})' if alias else ''
    print(f'  {peer_short}{alias_str}  [{status:8s}]')
    print(f'    Capacity: {r[\"capacity\"]:>10,}    Local: {r[\"local\"]:>10,}    Remote: {r[\"remote\"]:>10,}    Inbound: {inbound:>5.1f}% [{health}]{htlc_str}')
    print(f'    [{bar}]')
    print(f'    Chan: {r[\"chan_id\"]}  Point: {r[\"chan_point\"]}')
    print()
"
