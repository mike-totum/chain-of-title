#!/bin/zsh
# launchd entry point for the 24 h bonding-curve poller (com.pumpmonitor.curvepoll)
cd "$(dirname "$0")/.." || exit 1   # repo root, wherever it is checked out
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/local/bin/npm run --silent curvepoll
