#!/usr/bin/env bash
# Cron wrapper: fetch CJ links and merge them into data/coupons.json.
# Usage (cron, every 6 hours):
#   0 */6 * * * /home/user/nipcoupon/scripts/cj-cron.sh >> /home/user/nipcoupon/logs/cj-cron.log 2>&1
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

mkdir -p logs backups

# Load .env without leaking secrets into the process list
set -a
[ -f .env ] && . ./.env
set +a

echo "──────── $(date -u +%Y-%m-%dT%H:%M:%SZ) · CJ sync ────────"

# Lock so overlapping runs can never corrupt the data files
LOCK="$ROOT/.cj-fetch.lock"
exec 9>"$LOCK"
if ! flock -n 9; then echo "another sync is already running — skipping"; exit 0; fi

# 1. fetch + merge (exit 2 = connected but CJ returned no links: not a failure)
set +e
node scripts/fetch-cj.js --json
STATUS=$?
set -e

if [ "$STATUS" -eq 2 ]; then
  echo "CJ returned no links this run (see diagnostics above). Data left untouched."
  exit 0
fi
if [ "$STATUS" -ne 0 ]; then
  echo "CJ fetch FAILED with exit $STATUS"
  exit "$STATUS"
fi

# 2. verify the merged data before anything else touches it
node scripts/validate.js --strict
node scripts/predeploy.js | tail -2

echo "sync complete"
