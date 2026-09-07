#!/bin/sh
# Refuse a deploy that would publish a smaller archive than the one already live.
#
# `serve.ts` guards the *pull* path: a record fetched from the collector is rejected if it holds under 90% of what is
# already there. But the archive currently reaches production a different way - `railway up` ships whatever
# data/record.db happens to be on this disk, and that path has no guard at all beyond refusing a file with under 1000
# launches. Since the collector's own build is broken, the unguarded path is the only one in use.
#
# So compare against the thing that actually matters: what production is serving right now.
#   sh scripts/preflight.sh [url]
U="${1:-https://chainoftitle.org}"
REC="${REC:-data/record.db}"

[ -f "$REC" ] || { echo "FAIL  $REC does not exist"; exit 1; }

integrity=$(sqlite3 "$REC" "PRAGMA integrity_check;" 2>&1 | head -1)
[ "$integrity" = "ok" ] || { echo "FAIL  $REC integrity_check: $integrity"; exit 1; }

local_n=$(sqlite3 "$REC" "SELECT COUNT(*) FROM tokens;" 2>/dev/null)
live_n=$(curl -s --max-time 20 "$U/api/v1/status" | sed -n 's/.*"launches": *\([0-9]*\).*/\1/p')

echo "local  $REC: ${local_n:-unknown} launches"
echo "live   $U: ${live_n:-unreachable} launches"

if [ -z "$live_n" ]; then
  echo "WARN  could not read the live count; deploying blind. Check $U by hand first."
  exit 0
fi
if [ -z "$local_n" ] || [ "$local_n" -lt 1000 ]; then
  echo "FAIL  local archive holds ${local_n:-0} launches, which cannot be real."; exit 1
fi
# 90%, matching the pull guard in serve.ts, so both paths refuse the same thing.
floor=$(( live_n * 9 / 10 ))
if [ "$local_n" -lt "$floor" ]; then
  echo "FAIL  deploying would cut the public archive from $live_n to $local_n (floor $floor)."
  echo "      The archive only ever grows. Something upstream is wrong - a half-seeded"
  echo "      collector, the wrong DB_PATH, or a truncated rebuild. Do not override casually."
  exit 1
fi
echo "PASS  archive grows or holds ($local_n >= $floor). Safe to deploy."
