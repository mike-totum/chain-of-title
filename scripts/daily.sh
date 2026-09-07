#!/bin/zsh
# Daily analysis: writes data/reports/YYYY-MM-DD.txt and sends a short summary to Telegram Saved Messages.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
day=$(date +%F)
out="data/reports/$day.txt"
{
  echo "pump-monitor daily report — $day"
  npm run --silent report 24
  echo; echo "########## WALLETS ##########"
  npm run --silent wallets -- --hours 24
  echo; echo "########## BACKTEST (sweep, sorted by real-runner precision) ##########"
  NODE_OPTIONS=--max-old-space-size=12288 npm run --silent backtest -- --hours 24 --sweep --exit-sweep --sort real --top 25
  echo; echo "########## SOCIAL LEAD/LAG ##########"
  npm run --silent leadlag -- --hours 24
  echo; echo "########## POST-GRADUATION ##########"
  npm run --silent postgrad -- --hours 24
  echo; echo "########## HABITS (prospective: creator / early-wallet records vs next launch) ##########"
  npm run --silent habits -- --hours 72
  echo; echo "########## COPY-TRADE LATENCY / SCALP ##########"
  npm run --silent latency -- --hours 72
  echo; echo "########## PUMPSWAP REPLAY (entry x exit grid on decoded AMM paths) ##########"
  npm run --silent ammreplay -- --hours 96
  echo; echo "########## PATTERNS ##########"
  npm run --silent patterns -- --hours 24
  echo; echo "########## RETENTION (working data past its analysis window) ##########"
  npm run --silent prune -- --days 14 --apply
  echo; echo "########## PROVENANCE ARCHIVE (portable product asset + coverage/gaps) ##########"
  npm run --silent archive
  echo; echo "########## LIVE DETECTORS (movement / buyout signals graded by forward return) ##########"
  npm run --silent movements -- --hours 48
  echo; echo "########## CURVE BUYOUTS (every large curve buy, bucketed) ##########"
  npm run --silent buyouts -- --hours 96
  echo; echo "########## OPERATOR CLUSTERS (buyout seeds -> funders -> farms; feeds cluster-follow) ##########"
  npm run --silent clusters -- --limit 150 2>&1 | tail -60
  echo; echo "########## HISTORY REBUILD (chain reconstruction of \$1M+ tokens) ##########"
  npm run --silent history -- --report 2>&1 | head -40
  echo; echo "########## X CREDITS ##########"
  K=$(grep '^TWITTERAPI_IO_KEY=' .env | cut -d= -f2)
  [ -n "$K" ] && curl -s -H "X-API-Key: $K" "https://api.twitterapi.io/oapi/my/info" && echo
  echo "tweets stored last 24h: $(sqlite3 data/pump.db "SELECT COUNT(*) FROM tweets WHERE fetched_at >= (strftime('%s','now')-86400)*1000")"
} > "$out" 2>&1
npx tsx --no-warnings=ExperimentalWarning scripts/notify-summary.ts "$out" 2>/dev/null || true
echo "wrote $out"
