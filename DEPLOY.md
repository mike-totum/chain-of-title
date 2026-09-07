# Deploying the collector

The product's only claim is unbroken coverage. Launch-time facts are unrecoverable, so every minute the collector is
down is a permanent hole in the archive. That makes deployment a data-integrity task, not an ops chore.

## Before you push

**1. A private RPC is not optional.** The default `wss://api.mainnet-beta.solana.com` is Solana's free public endpoint.
It already returns 429s from a residential IP, and public endpoints throttle datacenter ranges harder. Deploying onto it
converts continuous coverage into gaps. Helius's free tier covers this workload. Set both:

```
SOLANA_WS_URL=wss://<your-endpoint>
PUMPSWAP_WS_URL=wss://<your-endpoint>
SOLANA_RPC_URLS=https://<your-endpoint>,https://api.mainnet-beta.solana.com
```

**2. Size the volume.** Mount at `/data` (the Dockerfile sets `DB_PATH=/data/pump.db`). The database grows ~1 GB/day
before pruning. `scripts/daily.sh` runs `npm run prune -- --days 14 --apply`, so steady state is roughly 15 GB. Start at
25 GB. The 34 MB archive is a separate file and is what you actually serve.

**3. Never run two collectors against one database.** They will write conflicting state.

## Environment

Required:

| var | value |
|---|---|
| `SOLANA_WS_URL` | your RPC websocket |
| `PUMPSWAP_WS_URL` | your RPC websocket |
| `DB_PATH` | `/data/pump.db` (already set in the Dockerfile) |

Recommended: `SOLANA_RPC_URLS`, `CURVEPOLL_RPC_URLS` (comma-separated HTTP endpoints for vault reads and curve polling).

**Leave the Twitter and Telegram variables unset.** The collector starts cleanly without them, logging `watcher
disabled`. Nothing in the archive comes from Twitter — creator share, buyer counts, graduation timing and operator
clusters are all on-chain. The X listener exists for `kol-signal`, which returned **-13.8 % over 543 entries**, and for
lead/lag research that is finished. It stores ~18,600 tweets/day and costs credits, bandwidth and database growth for
a feature the product does not use.

Unset: `TWITTER_PROVIDER`, `TWITTERAPI_IO_KEY`, `X_BEARER_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

(Worth keeping in mind for later: "this token was manufactured and these accounts promoted it" is a good feature for a
warning product. Build it aimed at already-flagged tokens, not as a broad firehose.)

Verified: with Twitter and Telegram absent it boots, connects, decodes launches and paper-trades with zero errors.
`.env` is in `.dockerignore`, so the image has none and container env vars are the only source.

## Cutover without a gap

```bash
# 1. deploy on its own volume, then confirm it is actually collecting
npm run health                 # exits non-zero if not; heartbeat needs ~60s after boot

# 2. only once healthy, stop the laptop
launchctl bootout gui/$(id -u)/com.pumpmonitor.monitor
```

Overlapping for a few hours costs nothing. A gap is permanent. The two collectors must use separate databases.

## After deploying

- `npm run health` — heartbeat freshness, launch rate, trade decoding, pool map, vault pricing. Non-zero exit = coverage
  is being lost right now. Good as a cron check.
- `npm run archive` — rebuilds the portable 34 MB archive and prints coverage windows and gaps.
- `scripts/daily.sh` at 07:00 runs the report, retention and archive.

Note: `health` tolerates a 180 s stale heartbeat so a restart does not trip it, which means it will not detect an
outage shorter than three minutes. Coverage windows merge across gaps under three minutes for the same reason.
