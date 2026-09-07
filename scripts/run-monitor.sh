#!/bin/zsh
# launchd entrypoint: keep the machine from idle-sleeping while the monitor runs.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
exec /usr/bin/caffeinate -i /usr/local/bin/npm start
