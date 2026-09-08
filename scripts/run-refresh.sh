#!/bin/zsh
# launchd entrypoint: rebuild the published record and ship it.
#
# The archive only advances when someone runs this. On 2026-09-07 it sat frozen for seven hours while the collector
# kept working, and it surfaced because a human asked whether the number was changing. This is the stopgap until the
# cloud collector can build its own record and the service pulls it without anyone present.
#
# Ordering is the safety property, not a convenience:
#   servicedb   build from the collector's database
#   preflight   refuse anything that would shrink the public archive, comparing against what production serves now
#   railway up  ship it
#   smoke       every route the deployed site needs
#   freshness   prove the thing we just published is actually what the world can see
# Any step failing stops the rest. A deploy that is not verified is not a deploy.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
LOG="data/refresh.log"
say() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG"; }

say "refresh starting"
if ! npm run --silent servicedb >> "$LOG" 2>&1; then say "FAILED at servicedb, nothing deployed"; exit 1; fi
if ! npm run --silent preflight >> "$LOG" 2>&1; then say "REFUSED by preflight, nothing deployed"; exit 1; fi
if ! railway up --detach  >> "$LOG" 2>&1; then say "FAILED at railway up"; exit 1; fi

# The deploy is asynchronous. Wait for the service to come back before claiming anything about it.
for i in $(seq 1 40); do sleep 15; npm run --silent freshness >/dev/null 2>&1 && break; done

if ! npm run --silent smoke >> "$LOG" 2>&1; then say "DEPLOYED BUT SMOKE FAILED - check the site"; exit 1; fi
if ! npm run --silent freshness >> "$LOG" 2>&1; then say "DEPLOYED BUT STILL STALE - the published archive did not advance"; exit 1; fi
say "refresh complete and verified"
