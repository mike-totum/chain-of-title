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

Recommended: `SOLANA_RPC_URLS`, `CURVEPOLL_RPC_URLS`, `CONFIRM_RPC_URLS` (comma-separated HTTP endpoints for vault
reads, curve polling and the graduation-confirmation sweep).

All three are read **in priority order**, not round-robin: `rpc-http.ts` takes the first endpoint that is not
currently penalised, and a 429 or 5xx penalises it and falls through to the next. So a keyed endpoint belongs
**first** and a public one after it as the fallback — listing the public endpoint first spends the key only after
the free node has already failed the request.

`CONFIRM_RPC_URLS` is the one that is easy to miss and the most valuable: `confirmGraduations` reads
`getMultipleAccounts` at a hundred addresses per call, the public endpoints cap that far below a hundred, and the
collector's in-process confirm loop deliberately inherits `SOLANA_RPC_URLS` rather than reconfiguring the shared
list. Keying `SOLANA_RPC_URLS` therefore fixes the sweep too; `CONFIRM_RPC_URLS` only matters for `npm run confirm`
run directly.

`HELIUS_MIN_GAP_MS` defaults to 110 ms — the free tier's 10 req/s — and is matched on the hostname. **On a paid plan
this must be set**, or the limiter caps the key at the free-tier rate and the purchased capacity is never used.

**Divide the gap by the number of processes that share the key.** `minGapMs` is enforced per process, in that
process's own `eps` array, and the processes do not coordinate. Production runs **two** consumers on one key —
`collector` (feeds, vault reads, and the in-process confirm loop) and `chainmints` (the `getBlock` scanner, ~7.55
blocks/s) — so the aggregate rate is twice what the single-process arithmetic suggests. `web` holds
`SOLANA_RPC_URLS` but currently imports only `rpcStats` and issues no calls; it starts counting the day it does.

Measured against a counting server, two processes, 2.5 s each:

| `HELIUS_MIN_GAP_MS` | one process | two processes |
|---|---|---|
| 25 | 39.2 req/s | **78.2 req/s** |
| 40 | — | 49.5 req/s |
| 50 | — | 40.2 req/s |

So on Developer (50 req/s) the per-process value is **50 ms**, not the 25 ms that the rate alone implies: 25 ms
across two processes is 78 req/s, over the cap by half, and 40 ms lands exactly on it with no headroom. The gap is a
floor on spacing rather than a target rate, so this only bites when a process saturates — which is precisely the
confirm backlog sweep, the one case where the throughput was the reason for buying the key.

**Leave the Twitter and Telegram variables unset.** The collector starts cleanly without them, logging `watcher
disabled`. Nothing in the archive comes from Twitter - creator share, buyer counts, graduation timing and operator
clusters are all on-chain. The X listener exists for `kol-signal`, which returned **-13.8 % over 543 entries**, and for
lead/lag research that is finished. It stores ~18,600 tweets/day and costs credits, bandwidth and database growth for
a feature the product does not use.

Unset: `TWITTER_PROVIDER`, `TWITTERAPI_IO_KEY`, `X_BEARER_TOKEN`.

**`TELEGRAM_*` is two different families and this line used to conflate them.** Corrected 2026-09-12, after the
worklist carried "unset the TELEGRAM_ vars" as one decision:

| family | vars | effect of unsetting |
|---|---|---|
| channel archiver | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION`, `TELEGRAM_ARCHIVE` | the watcher logs `watcher disabled` and stops. Loses nothing that exists: **0 `tg_messages` on the collector**, measured on the volume 2026-09-12. |
| alert delivery | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | **silences every alarm.** `notify()` becomes a no-op, the site watch at `src/index.ts` logs instead of telling anyone, and `scripts/run-freshness.sh` reports a successful notification with nobody on the other end. |

The second row is why this page must not be read as "unset all of them". Alerting was wired after this paragraph was
written; the paragraph is what was stale, not the alerting. Keep `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set.

The archiver family is a live question and not a technical one: `TELEGRAM.md` records that the owner decided to
collect the channel corpus, so switching it off is a change to that decision. The technical state is already off —
the session was killed by a duplicate on 2026-09-09T14:22Z and every boot since has presented a dead credential.

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

- `npm run health` - heartbeat freshness, launch rate, trade decoding, pool map, vault pricing. Non-zero exit = coverage
  is being lost right now. Good as a cron check.
- `npm run archive` - rebuilds the portable 34 MB archive and prints coverage windows and gaps.
- `scripts/daily.sh` at 07:00 runs the report, retention and archive.

Note: `health` tolerates a 180 s stale heartbeat so a restart does not trip it, which means it will not detect an
outage shorter than three minutes. Coverage windows merge across gaps under three minutes for the same reason.
