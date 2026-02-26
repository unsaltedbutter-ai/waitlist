#!/usr/bin/env bash
# Move a non-terminal job to 'failed' status.
# Run on VPS: ./scripts/job-set-failed.sh --job <UUID>
set -euo pipefail

usage() {
    echo "Usage: $0 --job <job-uuid>"
    exit 1
}

JOB_ID=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --job) JOB_ID="$2"; shift 2 ;;
        *) usage ;;
    esac
done

[[ -z "$JOB_ID" ]] && usage

# Validate UUID format
if ! [[ "$JOB_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: Invalid UUID format: $JOB_ID"
    exit 1
fi

PSQL="sudo -u postgres psql -d unsaltedbutter -tAc"

# Check current status
CURRENT=$($PSQL "SELECT status FROM jobs WHERE id = '$JOB_ID'")
if [[ -z "$CURRENT" ]]; then
    echo "ERROR: No job found with id $JOB_ID"
    exit 1
fi

TERMINAL="completed_paid completed_eventual completed_reneged user_skip user_abandon implied_skip failed"
for s in $TERMINAL; do
    if [[ "$CURRENT" == "$s" ]]; then
        echo "Job $JOB_ID is already terminal (status=$CURRENT). Nothing to do."
        exit 0
    fi
done

echo "Job $JOB_ID: $CURRENT -> failed"

$PSQL "
  WITH do_update AS (
      UPDATE jobs
         SET status = 'failed', status_updated_at = NOW()
       WHERE id = '$JOB_ID'
       RETURNING id
  )
  INSERT INTO job_status_history (job_id, from_status, to_status, changed_by)
  SELECT '$JOB_ID', '$CURRENT', 'failed', 'operator'
    FROM do_update;
" > /dev/null

# Confirm
NEW=$($PSQL "SELECT status FROM jobs WHERE id = '$JOB_ID'")
echo "Confirmed: $JOB_ID is now $NEW"
