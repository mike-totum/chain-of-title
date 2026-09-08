#!/bin/sh
# Is the published archive still advancing?
#
# The site is honest about its own age: every page states when the record it reads was built, and
# /api/v1/status carries the same timestamp. That honesty is worthless if nobody reads it. On
# 2026-09-07 the published archive sat frozen for seven hours while the collector kept working, and
# it surfaced only because a human happened to ask whether the number was changing.
#
# Nothing about that failure was visible from inside the service. The site was up, every route
# answered, smoke passed, and the number it served was simply old. This is the same shape as the
# heartbeat that proved a process was alive while it ingested nothing: a check that cannot fail
# during the failure it exists to catch.
#
# So this asks the only question that matters from outside: how old is the data the public is being
# given, and is that older than we are willing to be wrong for.
#   sh scripts/freshness.sh [url] [max-hours]
U="${1:-https://chainoftitle.org}"
MAX_H="${2:-8}"

# Collapsed to one line first: asOf is a nested object, and sed matches within a line only.
status=$(curl -s --max-time 20 "$U/api/v1/status" | tr -d '\n' | tr -s ' ')
[ -n "$status" ] || { echo "FAIL  $U/api/v1/status unreachable"; exit 1; }

as_of=$(printf '%s' "$status" | sed -n 's/.*"asOf": *{ *"ms": *\([0-9]*\).*/\1/p')
launches=$(printf '%s' "$status" | sed -n 's/.*"launches": *\([0-9]*\).*/\1/p')
[ -n "$as_of" ] || { echo "FAIL  could not read asOf from $U/api/v1/status"; exit 1; }

now=$(date +%s)
age_s=$(( now - as_of / 1000 ))
age_h=$(( age_s / 3600 ))
age_m=$(( (age_s % 3600) / 60 ))

echo "published archive: ${launches:-unknown} launches, built ${age_h}h ${age_m}m ago"

if [ "$age_s" -lt 0 ]; then
  echo "FAIL  the archive claims to have been built in the future. Check the clock on the builder."
  exit 1
fi
if [ "$age_h" -ge "$MAX_H" ]; then
  echo "FAIL  the public archive has not advanced in ${age_h}h (limit ${MAX_H}h)."
  echo "      The site is not down and nothing will look broken. It is serving old counts as"
  echo "      current, which is the failure that hides. Rebuild and deploy:"
  echo "        npm run servicedb && npm run preflight && railway up"
  exit 1
fi
echo "PASS  published archive is ${age_h}h old (limit ${MAX_H}h)."
