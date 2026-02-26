#!/usr/bin/env bash
# Move non-terminal jobs to 'failed' status.
# Run on VPS:
#   ./scripts/job-set-failed.sh --job <UUID>
#   ./scripts/job-set-failed.sh --npub <npub1...>
set -euo pipefail

PSQL="sudo -u postgres psql -d unsaltedbutter"
Q="$PSQL -tAc"

TERMINAL_LIST="'completed_paid','completed_eventual','completed_reneged','user_skip','user_abandon','implied_skip','failed'"

usage() {
    echo "Usage: $0 [--job <uuid> | --npub <npub1...>]"
    exit 1
}

fail_job() {
    local job_id="$1" current="$2"
    $Q "
      WITH do_update AS (
          UPDATE jobs
             SET status = 'failed', status_updated_at = NOW()
           WHERE id = '$job_id'
           RETURNING id
      )
      INSERT INTO job_status_history (job_id, from_status, to_status, changed_by)
      SELECT '$job_id', '$current', 'failed', 'operator'
        FROM do_update;
    " > /dev/null
    echo "  $job_id: $current -> failed"
}

JOB_ID=""
NPUB=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --job)  JOB_ID="$2"; shift 2 ;;
        --npub) NPUB="$2"; shift 2 ;;
        *) usage ;;
    esac
done

[[ -z "$JOB_ID" && -z "$NPUB" ]] && usage

if [[ -n "$JOB_ID" ]]; then
    # --- Single job by UUID ---
    if ! [[ "$JOB_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        echo "ERROR: Invalid UUID: $JOB_ID"
        exit 1
    fi
    CURRENT=$($Q "SELECT status FROM jobs WHERE id = '$JOB_ID'")
    if [[ -z "$CURRENT" ]]; then
        echo "ERROR: No job found with id $JOB_ID"
        exit 1
    fi
    if echo "$TERMINAL_LIST" | grep -q "'$CURRENT'"; then
        echo "Job $JOB_ID is already terminal ($CURRENT). Nothing to do."
        exit 0
    fi
    fail_job "$JOB_ID" "$CURRENT"

elif [[ -n "$NPUB" ]]; then
    # --- All non-terminal jobs for npub ---
    if ! [[ "$NPUB" =~ ^npub1 ]]; then
        echo "ERROR: Expected npub1... format, got: $NPUB"
        exit 1
    fi
    USER_ID=$($Q "SELECT id FROM users WHERE nostr_npub = '$NPUB'")
    if [[ -z "$USER_ID" ]]; then
        echo "ERROR: No user found with npub $NPUB"
        exit 1
    fi

    # Show all jobs for context
    echo "Jobs for $NPUB:"
    $PSQL -c "
        SELECT id, service_id, action, status, created_at::date
          FROM jobs
         WHERE user_id = '$USER_ID'
         ORDER BY created_at DESC
         LIMIT 10;
    "

    # Find non-terminal jobs
    JOBS=$($Q "
        SELECT id || '|' || status
          FROM jobs
         WHERE user_id = '$USER_ID'
           AND status NOT IN ($TERMINAL_LIST)
         ORDER BY created_at;
    ")
    if [[ -z "$JOBS" ]]; then
        echo "No non-terminal jobs to fail."
        exit 0
    fi

    COUNT=$(echo "$JOBS" | wc -l | tr -d ' ')
    echo ""
    echo "Failing $COUNT non-terminal job(s):"
    while IFS='|' read -r jid jstatus; do
        fail_job "$jid" "$jstatus"
    done <<< "$JOBS"
fi

echo "Done."
