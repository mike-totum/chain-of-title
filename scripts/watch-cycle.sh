#!/bin/zsh
# Watch one unattended publish cycle and record whether the record stays whole.
#
# Everything built today was verified once, by hand, immediately after it was built. That is the weakest kind of
# evidence this project recognises: checking a property right after establishing it proves nothing about the process
# meant to maintain it. The specific thing at risk is buyout evidence — `trades` should hold at ~2,100 now that
# retention exempts it, and if the exemption does not work the decay is gradual and every count on the site stays
# correct while the proof behind them drains away.
#
# Samples the collector and the published record every 20 minutes and writes one line each time, so the shape over a
# cycle is visible rather than inferred from two endpoints. Nothing here changes anything.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
LOG="data/cycle.log"
U="${1:-https://chainoftitle.org}"

line() {
  local now live pub trades hist
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  live=$(curl -s --max-time 15 "$U/api/v1/live" | sed -n 's/.*"observed": *\([0-9]*\).*/\1/p')
  pub=$(curl -s --max-time 15 "$U/api/v1/status" | tr -d '\n' | sed -n 's/.*"launches": *\([0-9]*\).*/\1/p')
  trades=$(sqlite3 data/pump.db "SELECT COUNT(*) FROM trades WHERE venue='curve' AND side='buy' AND sol>=40;" 2>/dev/null)
  hist=$(sqlite3 data/pump.db "SELECT COUNT(*) FROM hist_trades;" 2>/dev/null)
  meta=$(sqlite3 data/pump.db "SELECT ROUND(100.0*SUM(meta_at IS NOT NULL)/COUNT(*),1) FROM tokens WHERE created_at > (strftime('%s','now')-3600)*1000;" 2>/dev/null)
  echo "[$now] live=${live:-?} published=${pub:-?} buyout_trades=${trades:-?} hist_trades=${hist:-?} meta_1h=${meta:-?}%" >> "$LOG"
}

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] cycle watch started" >> "$LOG"
line
