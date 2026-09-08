#!/bin/zsh
# launchd entrypoint: rebuild the published record and ship it.
#
# The archive only advances when someone runs this. On 2026-09-07 it sat frozen for seven hours while the collector
# kept working, and it surfaced because a human asked whether the number was changing. This is the stopgap until the
# cloud collector can build its own record and the service pulls it without anyone present.
#
# Ordering is the safety property, not a convenience:
#   servicedb   build from the collector's database
#   site        regenerate the pages that describe that database
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
# The loop shipped the database and never rebuilt the pages that describe it, so every generated page was frozen at
# whenever someone last ran this by hand. On 2026-09-08 data.html advertised "record.db, 45.6 MB, 153,444 launches"
# above a download of a 68.1 MB file holding 162,262 — understating the archive by 8,818 on the one page whose whole
# job is to hand it over. The same fault was corrected by hand on 09-07 and came straight back, because nothing in
# the loop regenerated it. It is structural, not an oversight, and this line is the fix.
#
# Runs AFTER servicedb, so the pages describe the record they ship alongside, and BEFORE the deploy, so a failed
# build stops the release instead of publishing stale pages over a fresh database. Takes ~7 min against the live
# collector database on the laptop (measured, 406s: it assesses every graduation in the window while the collector
# writes to the same file) — not the sub-second it takes against a quiet one. Budget for it.
if ! npm run --silent site >> "$LOG" 2>&1; then say "FAILED at site, nothing deployed"; exit 1; fi
if ! npm run --silent preflight >> "$LOG" 2>&1; then say "REFUSED by preflight, nothing deployed"; exit 1; fi
if ! railway up --detach  >> "$LOG" 2>&1; then say "FAILED at railway up"; exit 1; fi

# The deploy is asynchronous. Wait for the service to come back before claiming anything about it.
for i in $(seq 1 40); do sleep 15; npm run --silent freshness >/dev/null 2>&1 && break; done

if ! npm run --silent smoke >> "$LOG" 2>&1; then say "DEPLOYED BUT SMOKE FAILED - check the site"; exit 1; fi
if ! npm run --silent freshness >> "$LOG" 2>&1; then say "DEPLOYED BUT STILL STALE - the published archive did not advance"; exit 1; fi

# Re-deposit to the DOI mirror. Depositing was a thing someone did by hand, twice, and then stopped: by 2026-09-08 the
# citable copy held 51,359,744 bytes against a published 72,982,528, about fifty thousand launches behind, while the
# data page told every reader "if this site is gone, the record is not". A deposit that drifts is worse than none,
# because it looks like insurance. It belongs next to the thing that builds the record, not in someone's memory.
#
# LAST, and deliberately after freshness: the mirror should carry a record the live site has already accepted and
# served. Non-fatal to the deploy, because a failed deposit does not make a good deploy bad — but it is said loudly,
# because the deposit silently not happening is the exact failure being fixed.
if ! python3 scripts/deposit.py >> "$LOG" 2>&1; then
  say "DEPLOYED AND SERVING, BUT THE DOI DEPOSIT FAILED - the citable copy is now behind the site"
fi
say "refresh complete and verified"
