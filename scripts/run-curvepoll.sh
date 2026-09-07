#!/bin/zsh
# launchd entry point for the 24 h bonding-curve poller (com.pumpmonitor.curvepoll)
cd /Users/michaelbomhoff/coin || exit 1
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/local/bin/npm run --silent curvepoll
