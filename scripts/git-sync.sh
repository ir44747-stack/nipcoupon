#!/usr/bin/env bash
#
# git-sync.sh — commit and push site changes to GitHub.
#
#   ./scripts/git-sync.sh "update coupon copy"      # commit everything, push
#   ./scripts/git-sync.sh --dry-run                 # show what would be pushed
#   ./scripts/git-sync.sh                           # interactive commit message
#
# Safety gates, in order:
#   1. refuses to run if .env or backups/ are staged
#   2. runs scripts/purge-secrets.js — aborts if a live secret is in tracked files
#   3. refuses to push if the working tree is dirty afterwards
#
# Auth comes from ~/.git-credentials (mode 600), which lives OUTSIDE the repo
# so it can never be committed. Configure once:
#
#   printf 'https://<user>:<token>@github.com\n' > ~/.git-credentials
#   chmod 600 ~/.git-credentials
#   git config --global credential.helper store
#
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=0
MSG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) MSG="$arg" ;;
  esac
done

echo "NipCoupon → GitHub sync"
echo "────────────────────────────────────────────────────────"
echo "  branch : $(git rev-parse --abbrev-ref HEAD)"
echo "  repo   : $(git remote get-url origin)"
echo

# ── Gate 1: nothing sensitive staged ─────────────────────────────────────────
git add -A
STAGED="$(git diff --cached --name-only)"
if echo "$STAGED" | grep -qE '(^|/)\.env$|^backups/|/(cj-feed|cj-links|sovrn-links)\.json$'; then
  echo "  ✗ refusing: sensitive path staged"
  echo "$STAGED" | grep -E '(^|/)\.env$|^backups/|/(cj-feed|cj-links|sovrn-links)\.json$'
  exit 1
fi

if [ -z "$STAGED" ]; then
  echo "  · nothing to commit — working tree clean"
  exit 0
fi

# ── Gate 2: secret scan ──────────────────────────────────────────────────────
if ! node scripts/purge-secrets.js >/dev/null 2>&1; then
  echo "  ✗ refusing: scripts/purge-secrets.js found a live secret"
  node scripts/purge-secrets.js || true
  exit 1
fi
echo "  ✓ secret scan clean"

# ── Report ───────────────────────────────────────────────────────────────────
echo
echo "  files to commit:"
echo "$STAGED" | sed 's/^/    /'
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "  --dry-run: stopping before commit"
  git reset -q
  exit 0
fi

# ── Commit ───────────────────────────────────────────────────────────────────
if [ -z "$MSG" ]; then
  printf "  commit message: "
  read -r MSG
  [ -z "$MSG" ] && MSG="Update site content"
fi

git commit -q -m "$MSG"
echo "  ✓ committed $(git rev-parse --short HEAD)"

# ── Push ─────────────────────────────────────────────────────────────────────
git push origin "$(git rev-parse --abbrev-ref HEAD)"
echo
echo "  ✓ pushed → https://github.com/ir44747-stack/nipcoupon"
