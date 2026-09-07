#!/bin/zsh
# The product pipeline. Runs once a day and leaves behind a publishable archive, a rebuilt site, and a report.
#
#   zsh scripts/daily.sh
#
# **The ordering is load-bearing, not stylistic.**
#
#   1. clusters and servicedb read `trades`.
#   2. `prune` deletes `trades` past the retention window.
#
# `servicedb` computes `tokens.curve_buyers` — the distinct outside-buyer count that the whole "launched clean"
# judgement rests on — by scanning those trade rows. A launch whose trades are pruned before that number is computed
# can never have it computed again: the rows are gone, and the count becomes permanently unrecoverable for that
# window. So retention runs last, and only last. The previous version of this script pruned in the middle.
#
# `labels` is a gate, not a report. If a single known-manufactured token is ever certified clean, the run stops before
# rebuilding the site and exits non-zero, leaving yesterday's pages up. A stale site is a small problem; a site that
# certifies a manufactured launch is the only problem this project cannot recover from.
set -u
# NB: `status` cannot be used as a variable name here — zsh reserves it as a read-only alias for $?.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
day=$(date +%F)
mkdir -p data/reports
out="data/reports/$day.txt"
rc=0

{
  echo "Chain of Title — daily pipeline — $day"
  echo

  echo "########## 1. COLLECTOR HEALTH ##########"
  # Coverage is the product's only real claim, so this is the first thing to know and the loudest thing to miss.
  if npm run --silent health; then
    echo "collector healthy"
  else
    echo "!! COLLECTOR IS NOT COLLECTING — every minute of this is a permanent hole in the archive"
    rc=1
  fi

  echo; echo "########## 2. OPERATOR CLUSTERS (needs trades — before retention) ##########"
  # Not `cmd | tail`: a pipeline reports the exit status of its LAST command, so tail's success would mask a failure.
  npm run --silent clusters -- --limit 150 > /tmp/cot-clusters.out 2>&1 || { echo "!! clusters failed"; rc=1; }
  tail -40 /tmp/cot-clusters.out

  echo; echo "########## 3. RECORD DATABASE (needs trades — before retention) ##########"
  # Also populates tokens.curve_buyers, which is why this cannot move after prune.
  if npm run --silent servicedb; then :; else echo "!! servicedb failed — not publishing"; rc=1; fi

  echo; echo "########## 4. VALIDATION GATE ##########"
  if npm run --silent labels; then
    echo "gate passed — no known-manufactured token is certified clean"
  else
    echo "!! GATE FAILED — a known-manufactured launch would be shown as clean."
    echo "!! The site was NOT rebuilt. Yesterday's pages are still up and still correct."
    rc=2
  fi

  if [ $rc -ne 2 ]; then
    echo; echo "########## 5. SITE ##########"
    npm run --silent site || { echo "!! site build failed"; rc=1; }

    echo; echo "########## 6. PORTABLE ARCHIVE + COVERAGE ##########"
    npm run --silent archive || { echo "!! archive failed"; rc=1; }
  fi

  echo; echo "########## 7. WHAT THE DETECTORS SAW ##########"
  npm run --silent movements -- --hours 48 > /tmp/cot-moves.out 2>&1 || true
  head -30 /tmp/cot-moves.out

  echo; echo "########## 8. RETENTION — LAST, and only last ##########"
  npm run --silent prune -- --days 14 --apply || { echo "!! prune failed"; rc=1; }

  echo; echo "########## SUMMARY ##########"
  sqlite3 data/pump.db "
    SELECT 'launches on file      ' || COUNT(*) FROM tokens WHERE late_discovery=0
    UNION ALL SELECT 'graduated, last 24h   ' || COUNT(*) FROM tokens
      WHERE graduated=1 AND created_at > (strftime('%s','now')-86400)*1000
    UNION ALL SELECT 'operator wallets      ' || COUNT(*) FROM operator_wallets
    UNION ALL SELECT 'rebuilt from chain    ' || COUNT(*) FROM tokens WHERE rebuilt_complete=1;" 2>/dev/null
  echo "exit status           $rc"
} > "$out" 2>&1

npx tsx --no-warnings=ExperimentalWarning scripts/notify-summary.ts "$out" 2>/dev/null || true
echo "wrote $out (status $rc)"
# Deployment stays manual on purpose: publishing is an outward-facing act, and `npm run smoke` has to pass first.
[ $rc -eq 0 ] && echo "ready to publish: railway up --service web && npm run smoke"
exit $rc
