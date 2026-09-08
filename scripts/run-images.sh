#!/bin/zsh
# launchd entrypoint: fetch the launch images we have not kept yet.
#
# The collector records the image URL; this keeps the bytes before the pin is dropped. Separate from the collector on
# purpose, so slow gateways can never stall the process whose only job is unbroken coverage. Bounded per run, and
# resumable, so a run that is killed halfway costs nothing.
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
exec /usr/local/bin/npm run --silent images -- --limit 800 >> data/images.log 2>&1
