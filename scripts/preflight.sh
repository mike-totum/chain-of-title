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
# ---------------------------------------------------------------------------------------------------------------
# CODE, BEFORE DATA. Added 2026-09-12, the morning after a deploy shipped a file that could not be parsed.
#
# What happened: `tsc --noEmit` and `npm test` both passed. Then a second session's half-written provenance.ts
# landed in this shared directory, `git add -A` swept it into an unrelated commit, and `railway up` uploaded the
# tree minutes later. The file had unescaped backticks inside a template literal, so the collector could not boot
# at all. It crash-looped, and because serve.ts refuses to serve without a record pull from the collector, it
# surfaced as a site 502 rather than a collector alarm.
#
# The checks were not missing. They were run against bytes that were no longer the bytes being shipped. That is
# why this exists and why `--deploy` exists below: a gate that cannot hold the tree still between checking and
# shipping is advice, not a gate.
#
# NOT included here, deliberately: `npm run health`. It reads config.dbPath - the LOCAL collector's database - so
# from a laptop it would gate a production deploy on whether the laptop's collector is alive. It is the right
# check on the wrong machine. It belongs on a scheduler next to the collector, which is tracked separately.
# ---------------------------------------------------------------------------------------------------------------
DEPLOY=no
[ "$1" = "--deploy" ] && { DEPLOY=yes; shift; }

# The whole point. `npm run preflight && railway up` is two commands and the tree can move between them - that is
# exactly what happened, minutes apart, and it took the site down. With --deploy the checks and the upload are one
# command with nothing in between that can edit a file.
finish() {
  if [ "$DEPLOY" = "yes" ]; then
    echo
    echo "deploy railway up   (gate passed at $(date -u '+%H:%M:%S UTC'), tree unchanged since)"
    exec railway up
  fi
  exit 0
}

if [ -d .git ]; then
  SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
  DIRT=$(git status --porcelain 2>/dev/null)
  echo "code   $BRANCH @ $SHA"
  if [ -n "$DIRT" ]; then
    echo "$DIRT" | sed 's/^/       /'
    if [ "${ALLOW_DIRTY:-0}" = "1" ]; then
      echo "WARN  deploying a DIRTY tree because ALLOW_DIRTY=1. What ships is not $SHA and cannot be named later."
    else
      echo "FAIL  the working tree is dirty, so the code about to ship has no name."
      echo "      Three sessions share this checkout and \`railway up\` uploads the DIRECTORY, not the commit."
      echo "      Commit or stash first. ALLOW_DIRTY=1 to override, which records the dirt above rather than"
      echo "      hiding it - an emergency deploy is legitimate, an unrecorded one is not."
      exit 1
    fi
  fi
  UNPUSHED=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l | tr -d " ")
  [ "${UNPUSHED:-0}" -gt 0 ] && echo "WARN  $UNPUSHED commit(s) here are not on the remote. Production will run code nobody else can fetch."
fi

# Parse every source file with the SAME transform production runs under. tsc is a different checker from tsx and
# they do not agree in general; the failure above was a parse error, which is the class this catches. Parsing, not
# importing: importing executes top-level code, and in this tree that opens databases and starts a collector.
echo "build  parsing $(ls src/*.ts src/feed/*.ts src/signals/*.ts 2>/dev/null | wc -l | tr -d " ") source files under esbuild"
if ! npx esbuild src/*.ts src/feed/*.ts src/signals/*.ts --outdir=/tmp/preflight-parse --log-level=error >/dev/null 2>/tmp/preflight-esbuild.err; then
  echo "FAIL  source does not parse under the production transform:"
  sed 's/^/       /' /tmp/preflight-esbuild.err | head -12
  exit 1
fi
rm -rf /tmp/preflight-parse

npx tsc --noEmit >/tmp/preflight-tsc.err 2>&1 || {
  echo "FAIL  typecheck:"; sed 's/^/       /' /tmp/preflight-tsc.err | head -10; exit 1; }

npm test >/tmp/preflight-test.err 2>&1 || {
  echo "FAIL  tests:"; grep -E "^# (tests|pass|fail)|not ok" /tmp/preflight-test.err | head -10 | sed 's/^/       /'; exit 1; }
echo "tests  $(grep -E "^# pass" /tmp/preflight-test.err | grep -oE "[0-9]+") passing"

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
  echo "WARN  could not read the live count. The code gate above passed, but the archive comparison did not run."
  echo "      Not shipping on --deploy: a size guard that could not read the live size has not guarded anything."
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
    finish
  else
    echo "FAIL  deploying would cut the public archive from $live_n to $local_n (floor $floor)."
    echo "      The archive only ever grows. Something upstream is wrong - a half-seeded"
    echo "      collector, the wrong DB_PATH, or a truncated rebuild. Do not override casually."
    exit 1
  fi
fi
echo "PASS  archive grows or holds ($local_n >= $floor). Safe to deploy."
finish
