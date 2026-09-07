#!/bin/zsh
# launchd entry point for the historical winner reconstruction daemon (com.pumpmonitor.history)
cd "$(dirname "$0")/.." || exit 1   # repo root, wherever it is checked out
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/local/bin/npm run --silent history -- --daemon --days 120 --min-ath-usd 1000000 --limit 25 --db-late-grads
