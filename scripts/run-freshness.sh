#!/bin/zsh
# Independent freshness probe: is the published archive still advancing, and does anyone find out when it stops?
#
# WHY THIS IS A SEPARATE JOB. `freshness` already existed and was already correct, but the only thing that ran it was
# `run-refresh.sh` — the publish job itself. So it could not fire during the failure it exists to catch: if the build
# failed, or preflight refused, or the timer came due while the machine was asleep, freshness never executed and
# nothing was said. A check reachable only through the path that breaks is the shape this whole project is about, and
# it had been rebuilt one layer up from the seven-hour freeze of 2026-09-07 that prompted writing freshness at all.
#
# WHAT THIS DOES NOT COVER, stated plainly because a probe believed to cover more than it does is worse than none:
# this runs on the same laptop that publishes. A closed lid silences the publisher and this probe together, which is
# precisely the scenario where publishing stops. What it catches is the publish job running and failing while the
# machine is awake, and the archive ageing past tolerance for any other reason. Covering the sleeping laptop needs a
# probe that is not on the laptop — the web service knows its own `built_at` and is always up, which is the right home
# for that check. Until then, this covers the common case and lies about nothing.
#
# Hourly, against an 8 h tolerance: the publish interval is 6 h, so a single missed run is detected inside the window
# it opens rather than at the next scheduled attempt 12 h later.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

U="${1:-https://chainoftitle.org}"
MAX_H="${2:-8}"
LOG="data/freshness.log"
STATE="data/freshness.state"          # holds the epoch of the last alert sent, or "ok"
REALERT_S=21600                       # while still broken, repeat at most every 6 h

say() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG"; }

notify() {
  # WHERE AN ALARM ACTUALLY REACHES SOMEONE. Measured 2026-09-08: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  # TELEGRAM_API_ID and TELEGRAM_API_HASH are all empty, so `telegramNotifier` returns a no-op and
  # `notify-summary.ts` exits 0 without sending. This project currently has NO working notification channel, and
  # `daily.sh` has been reporting success into it. Building an alarm on that would have reproduced the bug this
  # probe exists to fix, one layer further out again.
  #
  # So the primary channel is the local desktop notification, which needs no configuration and cannot silently
  # no-op: osascript reports a non-zero status if it fails. Telegram is attempted as well and stays a no-op until
  # someone fills the variables in — logged either way, so the log says which channels actually carried the alarm.
  local reached=""
  if osascript -e "display notification \"$2\" with title \"Chain of Title\" subtitle \"$3\"" >/dev/null 2>&1; then
    reached="desktop"
  else
    say "NOTIFY FAILED (desktop notification rejected)"
  fi
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=$1" \
      --data-urlencode "disable_web_page_preview=true")
    if [ "$code" = "200" ]; then reached="${reached:+$reached+}telegram"; else say "NOTIFY FAILED (telegram http $code)"; fi
  fi
  if [ -n "$reached" ]; then
    say "NOTIFIED via $reached"
  else
    # Every channel failed. Leave the loudest trace available to a shell script, so the next person at this terminal
    # trips over it rather than reading a clean log.
    say "NOT NOTIFIED BY ANY CHANNEL — nobody was told. Configure a channel."
    printf '%s\n' "$1" > data/UNDELIVERED-ALERT.txt
  fi
}

# Three attempts before believing it. A transient network blip must not raise an alarm, because an alarm that cries
# wolf gets ignored, and an ignored alarm is indistinguishable from no alarm at all.
# Read the Telegram credentials the way src/config.ts does: a real environment variable wins over the file, and the
# FIRST occurrence in the file wins over any later one. That last rule is not a detail — on 2026-09-08 an empty
# `TELEGRAM_BOT_TOKEN=` earlier in .env shadowed the real token further down, and every consumer read it as
# unconfigured. If this ever reports "no bot token" while you can see one in the file, look for a duplicate key.
if [ -f .env ]; then
  [ -n "$TELEGRAM_BOT_TOKEN" ] || TELEGRAM_BOT_TOKEN=$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' .env | head -1 | tr -d "\"' ")
  [ -n "$TELEGRAM_CHAT_ID" ]   || TELEGRAM_CHAT_ID=$(sed -n 's/^TELEGRAM_CHAT_ID=//p' .env | head -1 | tr -d "\"' ")
fi

attempt=1
while [ $attempt -le 3 ]; do
  out=$(sh scripts/freshness.sh "$U" "$MAX_H" 2>&1)
  rc=$?
  [ $rc -eq 0 ] && break
  [ $attempt -lt 3 ] && sleep 20
  attempt=$((attempt + 1))
done

last=$(cat "$STATE" 2>/dev/null || echo "ok")
now=$(date +%s)

if [ $rc -eq 0 ]; then
  say "PASS  $(printf '%s' "$out" | sed -n 's/^published archive: //p')"
  # Recovery notice, so a silence that follows an alert can be told apart from an alarm that stopped working.
  if [ "$last" != "ok" ]; then
    rec=$(printf '%s' "$out" | sed -n 's/^published archive: //p')
    notify "✅ chainoftitle.org is publishing again — $rec" "$rec" "publishing again"
    rm -f data/UNDELIVERED-ALERT.txt
  fi
  echo "ok" > "$STATE"
  exit 0
fi

say "FAIL  after $((attempt - 1)) attempts: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"

# Repeat while broken, but not hourly: the first message is the useful one, and the rest are for not forgetting.
if [ "$last" = "ok" ] || [ $((now - last)) -ge $REALERT_S ]; then
  detail=$(printf '%s' "$out" | sed -n 's/^FAIL  //p' | head -1)
  notify "🔴 chainoftitle.org archive is stale.
$(printf '%s' "$out" | head -3)

The site is up and nothing looks broken — it is serving old counts as current.
  cd ~/coin && zsh scripts/run-refresh.sh" "${detail:-the published archive has stopped advancing}" "archive is stale"
  echo "$now" > "$STATE"
fi
exit 1
