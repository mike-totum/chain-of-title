#!/bin/sh
# Refuse a deploy that would publish a smaller archive than the one already live.
#
# `serve.ts` guards the *pull* path: a record fetched from the collector is rejected if it holds under 90% of what is
# already there, on launches and on every other dimension. Since 2026-09-08 that pull is live and is how the archive
# normally reaches production - the collector rebuilds every 3 h and the web service pulls every 3 h - so a deploy is
# no longer the mechanism that keeps the site current. Do not `railway up` to move data; it will be replaced by the
# next pull anyway.
#
# This script still matters, because `railway up` ALSO ships whatever data/record.db happens to be on the deploying
# machine's disk, and that path has no guard beyond refusing a file with under 1000 launches. A laptop whose record is
# behind can therefore swing the served archive backwards between pulls. Two people deploying from two checkouts makes
# that a live hazard rather than a theoretical one.
#
# So compare against the thing that actually matters: what production is serving right now.
#   sh scripts/preflight.sh [url]
U="${1:-https://chainoftitle.org}"
REC="${REC:-data/record.db}"

[ -f "$REC" ] || { echo "FAIL  $REC does not exist"; exit 1; }

# Does this deploy actually carry the record? It stopped doing so when the web service moved to fetching one from
# the collector, and the two ignore files are what enforce that - .railwayignore governs the upload, .dockerignore
# governs what COPY puts in the image, and they are documented as having to agree. While the record is excluded, a
# stale local copy cannot swing the public archive and the size comparison below is advice rather than a gate.
#
# Derived, not assumed. If anyone re-includes the file, SHIPS_RECORD goes back to yes on its own and the comparison
# hardens back into a refusal - which is the whole reason this is a test rather than a paragraph saying it is fine.
SHIPS_RECORD=yes
grep -qE '^data/record\.db\*?$' .dockerignore 2>/dev/null && SHIPS_RECORD=no
grep -qE '^!data/record\.db' .railwayignore 2>/dev/null && SHIPS_RECORD=yes

integrity=$(sqlite3 "$REC" "PRAGMA integrity_check;" 2>&1 | head -1)
[ "$integrity" = "ok" ] || { echo "FAIL  $REC integrity_check: $integrity"; exit 1; }

local_n=$(sqlite3 "$REC" "SELECT COUNT(*) FROM tokens;" 2>/dev/null)
# The FIRST launches key only. /api/v1/status gained a nested chainWide.launches, so this matched twice and the
# comparison below became `269722\n6498 -lt ...`, which is a syntax error - a deploy guard that cannot run. It failed
# loudly rather than passing, which is the better half of the fault, but it still could not do its job.
live_n=$(curl -s --max-time 20 "$U/api/v1/status" | sed -n 's/.*"launches": *\([0-9]*\).*/\1/p' | head -1)

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
  if [ "$SHIPS_RECORD" = "no" ]; then
    echo "WARN  the local record holds $local_n against $live_n live, so this copy is behind."
    echo "      Not a blocker: data/record.db is excluded by .dockerignore and is not in this"
    echo "      deploy, and the web service fetches its record from the collector. Read it as"
    echo "      'your laptop is stale', not 'the archive is about to shrink'."
    # And stop here rather than falling through to the PASS below, which would print
    # "archive grows or holds (206018 >= 242749)" - a line asserting the comparison it
    # had just been told is false. A guard that ends by contradicting itself teaches
    # people to read past it.
    echo "PASS  nothing in this deploy can shrink the public archive."
    exit 0
  else
    echo "FAIL  deploying would cut the public archive from $live_n to $local_n (floor $floor)."
    echo "      The archive only ever grows. Something upstream is wrong - a half-seeded"
    echo "      collector, the wrong DB_PATH, or a truncated rebuild. Do not override casually."
    exit 1
  fi
fi
echo "PASS  archive grows or holds ($local_n >= $floor). Safe to deploy."
