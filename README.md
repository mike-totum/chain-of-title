# Chain of Title

**A public archive of launch-time provenance for Solana tokens** — `chainoftitle.org`, free and CC0.

In property law, a chain of title is the unbroken documented history of ownership from origin: what you establish
before believing a claim about what something is. The facts that identify a manufactured token — what share of supply
the creator took in the first block, how many outside wallets actually bought, how the curve filled — are visible only
while it happens, and present-tense inspection cannot recover them once the float has been spread. So this records
them as they occur, and answers questions against that record.

Token pages carry that history; wallet pages are headed **Priors**, the operator's own record. `BRAND` in
`src/site.ts` is the single place the name appears.

The collector began as a real-time launch monitor with paper trading, and the sections below still describe that
machinery — the trading thesis was tested against 139 entry/exit rules and is dead (`ASSUMPTIONS.md`), but the
instrument that measured it is the same one that now records provenance. It answers two questions:

1. **Can it find tokens?** Every pump.fun launch is picked up within ~1 s by decoding
   the pump.fun program's own events from a Solana RPC websocket (free public endpoint by
   default, or your own `SOLANA_WS_URL`), then its trades are followed for an hour.
   PumpPortal is available as an alternative source (`TRADE_SOURCE=pumpportal`) but its
   trade stream needs an API key funded with 0.02 SOL.
2. **If it bought, what would have happened?** Several strategies paper-trade every
   launch against the live bonding curve, with real fill math (constant-product
   curve, the live per-token fee taken from each trade event, priority fee, fill latency). Results land in SQLite.

## Running as a service (macOS)

Two launchd agents are installed in `~/Library/LaunchAgents/`:

- `com.pumpmonitor.monitor` — runs `npm start` under `caffeinate -i` (prevents idle sleep while it runs),
  starts at login, restarts on crash. Logs to `data/run.log`.
- `com.pumpmonitor.daily` — runs `scripts/daily.sh` at 07:00: report, wallet analysis and backtest sweep
  for the last 24 h → `data/reports/YYYY-MM-DD.txt`, with a summary sent to your Telegram Saved Messages.
- `com.pumpmonitor.curvepoll` — `npm run curvepoll`: reads every launch's bonding-curve account for 24 h
  (getMultipleAccounts, adaptive 2–60 min cadence) into `curve_snapshots`, independent of the websocket tracker, so the
  hour-1-to-hour-6 phase of slow tokens is recorded. Marks graduations it sees in `tokens`. Log: `~/Library/Logs/pumpmonitor/curvepoll.log`.
- `com.pumpmonitor.history` — `npm run history -- --daemon`: rebuilds the full curve life of historical winners
  (pump.fun's top coins by current and all-time-high market cap, ≥ $1M within 120 days, plus our own late graduators as
  controls) from chain history into `hist_tokens` / `hist_activity` / `hist_trades`. `npm run history -- --report` shows
  progress. Both use `SOLANA_RPC_URLS` (default: publicnode, then the official endpoint) with per-endpoint back-off.

```bash
launchctl print gui/$(id -u)/com.pumpmonitor.monitor | grep -E "state|pid"   # is it running?
launchctl kickstart -k gui/$(id -u)/com.pumpmonitor.monitor                  # restart (after code/config changes)
launchctl bootout gui/$(id -u)/com.pumpmonitor.monitor                       # stop
zsh scripts/daily.sh                                                          # run the daily report now
```

The project lives in `~/coin` (`~/Desktop/coin` is a symlink): launchd cannot read files under Desktop without a manual privacy grant. Closing the lid still sleeps the machine; keep it open or plugged in with sleep disabled for overnight collection.
Alerts (kol-signal / smart-wallet paper trades, channel signals) go to your Telegram Saved Messages automatically
once `npm run telegram:login` has been done; a bot token is optional.

## Deploying to a server (Railway or a VPS)

The laptop works while the lid is open; a server removes that dependency and gives a steadier network.
A `Dockerfile` and `railway.json` are included.

**Railway**: create a project from this repo, attach a **volume mounted at `/data`** (the SQLite database
grows ~1 GB/day before pruning; start with 10 GB), and set the variables from your `.env`
(`TWITTER_PROVIDER`, `TWITTERAPI_IO_KEY`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `X_LISTEN_SECONDS`, …).
Copy `data/telegram.session` to the volume as `/data/telegram.session` (one-off, e.g. via `railway ssh`
or a first deploy that runs `npm run telegram:login` interactively) — never run the same Telegram session
on the laptop and the server at the same time. Stop the laptop agent first:
`launchctl bootout gui/$(id -u)/com.pumpmonitor.monitor`. Run the daily report as a Railway cron service
using the same image with command `zsh scripts/daily.sh` (or `bash`), or keep running it locally against a
copy of the database.

**Any VPS** (Hetzner/DigitalOcean, 2 vCPU / 4 GB is plenty): install Node 22, clone, `npm install`, copy
`.env` and `data/telegram.session`, then run under systemd:

```
[Service]
WorkingDirectory=/opt/coin
ExecStart=/usr/bin/npm start
Restart=always
```

and a cron entry `0 7 * * * cd /opt/coin && bash scripts/daily.sh`. The public Solana RPC is used by default;
a private RPC (`SOLANA_WS_URL`, `PUMPSWAP_WS_URL`) is more reliable from a datacenter.

## Run (by hand)

```bash
npm install
cp .env.example .env        # optional, defaults work
npm start                   # leave running; Ctrl-C closes open paper positions
npm run report              # whole database
npm run report 6            # last 6 hours only
```

## Strategies (src/strategies/index.ts)

| name | entry | why it exists |
|---|---|---|
| `baseline-all` | buy every launch at creation | the base rate everything must beat |
| `early-momentum` | 8+ distinct buyers in 60 s, sells < 1/3 of buys, dev ≤ 6 %, not bundled | "organic early demand" heuristic |
| `strict-momentum` | 15+ buyers in 120 s, price ≥ 1.3× launch, dev ≤ 4 % | later, more evidence |
| `kol-signal` | a watched X account or Telegram channel posts the mint / link / matching $TICKER | the "trusted caller" idea |
| `smart-wallet` | a wallet ranked by `npm run wallets` buys within 10 min of launch | insiders leave footprints in wallets |
| `filtered-all` | every launch passing the kill filters, at 30 s | measures the filter set itself |
| `team-wallet` | two members of a known operator team (`npm run patterns`) buy within 60 s; fast exit | crews repeat the same play |
| `grad-runner` | fast graduation + dev buy ≥5 SOL + ≤20 buyers; enter on PumpSwap on the first 15 % pullback above graduation price | real runners are filled by insiders; the outsider entry is after graduation |
| `cluster-follow` | an operator-cluster wallet (`npm run clusters`) buys out a curve (≥ 40 SOL) or ≥ 3 cluster wallets buy on the AMM within 1 h; enter at the first trusted AMM price ≤ 2× the price at first cluster activity; 35 % trail armed at 1.5×, stop 0.6, 12 h | the two verified $10M+ winners were dormant curves bought out by funder-seeded wallet farms that then accumulated on PumpSwap for hours; follow the farm, not the token |
| `survivor-trail` | graduated token trading ≥ 2.5× the graduation cap (~$200k+), dev < 50 % of supply, ≥ 30 buyers; enter on the next outside buy ≥ 0.5 SOL; 30 % trail armed at 1.3×, stop 0.7, 6 h | the 2026-09-03 PumpSwap replay: entries in this band are ~fair, and this exit turned 0.57× (held) into 1.13× on 41k samples; the edge is cutting losers, not picking |

**Rip-cord exits** (kol-signal and grad-runner, from 2026-09-02 ~00:00 UTC): bank half at 2×, then let the rest
ride on flow — exit when the dev sells, when SOL sold ≥ 2× SOL bought over 30 s while price is 25 % off its high, or on a
45 % dump inside 10 s; floor 0.4×, 45 % trail after banking, 90 min time stop. Rationale: on 111 graduated tokens,
runners and faders dipped almost identically before their peak, so a price stop cannot separate them; flow and time can.
Partial exits are recorded in `positions.partial_sol_out / partial_at` and included in `sol_out` at close.

**Kill filters** (from `npm run patterns`, 2026-09-02): launch-bot metadata hosts, round-number dev buys,
mid-sized dev buys (0.5–5 SOL), dev already sold, sells ≥ buys in the first 30 s. Applied by every strategy
except `baseline-all`; `filtered-all` shows what they are worth on their own.

Default exits: take profit 2×, stop loss 0.5×, trailing stop (35 % off peak once 1.5× reached),
30 min time stop, exit when the dev sells, exit at graduation. Each position also records what
holding for 5 / 15 / 60 min would have returned, so exit rules can be tuned from data.

## Token provenance (`npm run check -- <mint>`)

The product question: **what was this token at birth, and does what you are shown now match the chain?**

The facts that identify a manufactured token are only visible while it happens. WOFI (2026-09-06) was created with the
creator taking **79.3 % of supply and zero outside buyers**, then graduated. Hours later its pool held 2,043 real SOL
against the 2,027 that constant product predicts for its 581x cap, and its largest holder was 4 % of supply. Every
present-tense check passes. Liquidity reasoning, holder concentration, mint/freeze authority checks — all clean. The
operator funded the pool with real SOL and spread the float, and the evidence of manufacture is simply gone.

So the archive is the asset, not the checker. `npm run check` reports:

1. **AT LAUNCH** — recorded live: creator share of supply, outside buyers on the curve, first-30s and same-block
   buyers, seconds to graduation, whether the creator sold. Only obtainable by watching at the time.
2. **NOW** — read from chain: pool reserves, implied cap, and what share of that cap is actually in the pool.
3. **Verdict** — with the evidence for each line.

Where we did not watch the launch, it says so and returns `UNKNOWN` rather than a clean result, because a manufactured
token is indistinguishable from a real one once its float has been spread. Coverage begins 2026-09-02 and is printed on
every lookup. `npm run verdict -- --hours 24` scores the whole recent universe the same way.

**Launch facts are permanent; pool balances are not.** HOOD and HCAT held 2,677 and 2,050 SOL when the collector last
read them and about $20 each a few hours later. A pool balance is therefore only ever quoted with the time it was read
(`tokens.vault_at`, written at the moment of the read and never inferred from another timestamp), and any claim resting
on one — "a position can be sold near this price" — is made only against a balance read for that answer. `npm run check`
reads the pool live; `npm run site` re-reads the pool of every token it is about to certify and leaves out any it could
not read; a balance with no recorded read time is not quoted at all.

## Are the clean criteria any good? (`npm run labels`)

The criteria live in one place, `src/provenance.ts`, so the site, the validator and anything built on top run the same
code — a test that re-implements the rules it checks proves nothing about what visitors are shown.

```bash
npm run labels -- --build   # rebuild data/labels.json from independent evidence
npm run labels              # check; exits 1 if any known-manufactured token is certified clean
```

The gate is one-sided on purpose: a missed warning costs nothing, a wrong all-clear costs everything. Labels come from
**creator-wallet reuse**, an axis none of the criteria read — a ticker family of 15+ graduated mints where each launch
burns a fresh creator wallet (WOFI: 146 mints, 140 creators, 1.18 launches per creator). Creator share, buyer counts,
graduation speed and pool balances play no part in assigning a label.

Current: **664 tokens across 13 factory families — 659 flagged DANGER, 5 silent, 0 certified clean.** The five silent
ones are recall gaps and are listed by the tool. Re-run `--build` as new families appear; the set is drawn from our own
database, so it is a precision test, not a census.

## The archive (`npm run archive`)

The research database is ~5.3 GB, almost all of it `trades` and `wallet_token_stats`, which the product never reads.
What the product needs — what each token *was* at birth — is **~34 MB for 123k launches**, roughly 10 MB/day. `npm run
archive` writes that to a standalone `data/archive.db`: `launches`, `operators`, `operator_policy`, `pools`, and
`coverage`. The public service can then serve a 34 MB file and never touch the heavy database, so a research query
cannot take the site down.

**Coverage is part of the data, not an operational detail.** Launch-time facts are unrecoverable, so a token that
launched while the collector was down has no provenance and must not be answered confidently. The monitor refreshes
`runs.stopped_at` every 60 s, so coverage is the union of run intervals and everything else is a gap; `archive` prints
both, and `check` reports a launch inside a gap as unobserved. Before the heartbeat existed, `stopped_at` was written
only on a clean shutdown and 13,383 launches were wrongly classified as unobserved.

## Detectors: how a token gets our attention

The monitor watches every pump.fun launch from creation, but the verified winners did not happen at creation — they
happened hours or days later, on a curve we had already dropped or on PumpSwap after graduation. Three detectors now
cover that, and all three write to `signals` so the daily report grades them like any caller.

| detector | fires on | why |
|---|---|---|
| `[buyout]` | a buy >= `BUYOUT_MIN_SOL` (40) on a bonding curve we are **not** tracking | every launch is tracked from creation, so an untracked mint taking a large single buy *is* a dormant-curve buyout — the shape of Kshama, Squads, Simba, Axolotl and onoda. Detection is by behaviour; the farms burn a fresh wallet each time, so the wallet list caught only 13 of 988 buyouts in 72 h |
| `[movement]` | any PumpSwap pool where net buying >= `MOVE_MIN_NET_SOL` (25) from >= `MOVE_MIN_BUYERS` (8) distinct buyers lifts the price between `MOVE_MIN_LIFT` (1.5x) and `MOVE_MAX_LIFT` (20x) inside 5 minutes, with no single wallet above `MOVE_MAX_TOP_SHARE` (60 %) of the buy volume | the AMM websocket already carries every trade on every pool (~5.3 M events per run) and only ~2 % were used. This sees a token that starts running after we dropped it, which nothing else could |
| `[lategrad]` | an untracked bonding curve reading `LATE_GRAD_VSOL` (100) to `LATE_GRAD_VSOL_MAX` (140) vSOL, against ~115 at graduation | 15 of 19 reconstructed organic $1M+ winners had no large buy at all; they filled gradually, several over days (ZTH 6 d, WSOLP 7.6 d), long after the 6 h tracker window dropped them |
| `[cluster]` | a wallet from a known operator farm (`npm run clusters`) buys | identity, not behaviour: useful for grading a farm and for the `avoid` policy, but it cannot lead |

A hit restores the token into the tracker (12 h cap for movement, 24 h for operator activity), so pricing, vault checks
and every paper strategy pick it up from that moment. `pool_map` (filled from PumpSwap's own `CreatePoolEvent`, and
preloaded at startup) means a restored token has its pool immediately rather than waiting on the lookup queue.

```bash
npm run movements -- --hours 48   # grade [movement] and [buyout] signals by forward return
npm run buyouts   -- --hours 96   # grade every large curve buy, bucketed by age, dormancy, dev share and size
```

Neither new detector is traded yet. `npm run movements` is the gate: a "1.5x in 5 minutes" trigger is exactly the
chasing entry the PumpSwap replay measured at 0.96x, so it has to earn its entry rule from its own forward returns.

## Operator clusters (`npm run clusters`)

Traces the wallet that graduated each reconstructed winner (`npm run history`) and every live curve buy ≥ 40 SOL back to
its funder (payer of its first incoming SOL), then samples the funder's outgoing transfers to enumerate its wallet farm.
`operator_wallets` / `operator_funders` feed the live `cluster-follow` strategy (reloaded every 10 min); the scorecard
(`--report`) shows per funder how many $1M+ winners its wallets graduated and how its plays in our own data turned out.
Cluster activity is logged as `[cluster]` lines, sent to Telegram, and stored in `signals` with source `cluster`, so the
daily report's per-account table scores each cluster like a caller.

`npm run tracecurve -- <mint>` answers "who bought out this curve": decodes the last curve trades from chain history, names the
wallet behind any buy ≥ 40 SOL, checks it against `operator_wallets`, and traces and seeds its funder if it is new.

## Wallet tracker (`npm run wallets`)

The monitor persists **every trade on every tracked token** (`trades`: wallet, side, SOL, tokens,
price, slot, seconds since launch, buyer rank) and, when a token's watch ends, aggregates each wallet's
activity on it into `wallet_token_stats` (first-buy rank/age/slot-delta, SOL in/out, realized and
unrealized PnL, hold time, whether the token graduated, its peak multiple). Raw trades are kept in
full for tokens that graduated, hit 2×, or had a signal; for duds only the first 60 trades are kept.

```bash
npm run wallets -- --hours 48
```

prints: the wallet universe and how concentrated it is; **bundlers** (wallets that buy in the creation
block across many tokens) and whether their tokens graduate more; **smart wallets** — early buyers whose
graduation rate is a multiple of the base rate, with positive PnL and low "coverage" (a wallet that
touches 20 %+ of all launches is an indiscriminate bot, not an insider); **creators** with repeat
launches; and the **anatomy of graduations** — who the first 10 buyers were and whether they are repeat
players. The top wallets are saved to `smart_wallets`, and the live `smart-wallet` strategy paper-buys
whenever one of them buys within 10 minutes of a launch. Re-run the analysis daily; the strategy
reloads the set every 10 minutes.

## Finding the accounts worth watching (`npm run discover`)

Don't guess who the trusted callers are; measure it. After the monitor has run for a day:

```bash
npm run discover -- --hours 24 --winners 40 --control 40
```

It takes the launches that ran (peak ≥ 3× or graduated) plus a random control sample of
duds, searches Twitter for every tweet containing each mint address, and ranks accounts by how
often they posted winners **early** (≤ 10 min old, or before launch) versus how often they also
posted the duds. Aggregator bots that post every mint get ~50 % precision and sink to the
bottom; a genuinely early, selective account rises. Costs about $0.30 per run on twitterapi.io.
Copy the accounts you trust into `kols.txt`.

## Telegram channels (free, and the history is gradable)

Callers usually post to Telegram first, and unlike X the full history of a channel can be read
for free. Setup, once:

1. Create an app at https://my.telegram.org → *API development tools*; put `api_id` / `api_hash`
   in `.env` as `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
2. `npm run telegram:login` — enter your phone number and the code Telegram sends. The session is
   saved to `data/telegram.session` (gitignored). Nobody else needs this file; treat it like a password.
3. Add channel usernames to `channels.txt`.

Then:

```bash
npm run telegram:history -- --days 30     # grade every channel's past calls
npm start                                 # live: channel posts become kol-signal entries
```

The history scorecard shows, per channel: distinct mints called, share that graduated (base rate
is ~3–4 % of all launches), share still above $100k market cap, share called within 10 minutes of
launch, and the median lead time (negative = the channel posted before the token existed).
Outcomes come from the pump.fun API with DexScreener as fallback and are cached.

## Ear on the street

Three listening layers feed the same signal handler; none is trusted, all are measured per account in the
report's "KOL-SIGNAL OUTCOMES BY ACCOUNT" table:

1. **Telegram channels** in `channels.txt` — by default every channel `npm run telegram:find` found posting.
2. **X accounts** in `kols.txt` — batched since-time search every `KOL_POLL_SECONDS`.
3. **X street stream** — several broad searches (`X_LISTEN_QUERIES`, `|`-separated; defaults cover
   pump.fun mentions, Solana memecoin chatter, pre-launch language, trench talk, bonding-curve talk and
   "100x / gem / runner" posts, retweets excluded) polled every `X_LISTEN_SECONDS`. **Every tweet is stored**
   in `tweets` (author, followers, engagement, mints, cashtags, hashtags) for pattern analysis.
   Worst case ~20 tweets × 6 queries × 720 polls/day ≈ $13/day on twitterapi.io; real usage is lower.
4. **Buzz detection** — rolling counts per $TICKER / #hashtag. When `BUZZ_MIN_AUTHORS` distinct accounts
   mention a term within 10 minutes at ≥ `BUZZ_MIN_LIFT` × its 3-hour baseline, it fires: if a token with
   that symbol exists it becomes a signal, otherwise a 6-hour expectation that buys the first matching launch.
   `npm run buzz` shows what is rising now, which launches followed, and which accounts drive each term.

After graduation tokens trade on PumpSwap. The monitor decodes the PumpSwap program directly
(`PUMPSWAP_WS_URL`, its own websocket), attributing buys and sells to wallets for every graduated token it
tracks (stored with `venue='amm'`), so post-graduation prices, dev sells and wallet flows are live. DexScreener
polling (`EXT_PRICE_SECONDS`) remains as a fallback for called tokens whose pool is not yet mapped.

## KOL watcher

Put usernames in `kols.txt` and set a provider in `.env`:

- `TWITTER_PROVIDER=twitterapi` + `TWITTERAPI_IO_KEY` — twitterapi.io, pay-as-you-go, no
  subscription. The watcher uses one batched search per poll interval (20 accounts per request)
  that returns only tweets newer than the last poll, so most requests hit the minimum charge
  (~$0.00015). At the default 60 s interval that is roughly **$0.20/day per 20 accounts**, plus
  $0.15 per 1 000 tweets actually returned. Do not lower `KOL_POLL_SECONDS` below ~30.
- `TWITTER_PROVIDER=x` + `X_BEARER_TOKEN` — official X API v2. Read volume needs a paid tier.

Three ways a watched account's post becomes a `kol-signal` entry:

1. **Direct** — the post contains a pump.fun mint or link → buy now.
2. **Pre-announced** — the post contains `$TICKER` but no such token exists yet → remembered for
   6 h; the first launch with that symbol is bought at creation. This is the "be in place before
   the hitter lands" case.
3. **Metadata link** — a new launch's own metadata points at a watched account's X profile or
   tweet → buy at creation.

Signals from tokens that launched before the monitor started are handled too: the watcher
subscribes to that mint and enters at the first trade it sees.

## Simulation assumptions (be honest with yourself)

See **ASSUMPTIONS.md** for the full list of definitions, modelling choices and known biases.

- Fills happen `FILL_LATENCY_MS` after the decision at the curve as it is then. Real bots
  land in 0.5–3 s depending on priority fees and congestion.
- Sells are simulated into the curve at the moment of the exit signal. Real sells into a
  crashing curve can be worse (failed txs, front-running).
- Graduated tokens are marked as exited at the graduation price. Real upside after
  graduation is not modelled, so `baseline-all` slightly understates big winners.
- Paper results do not include your own buys' effect on other traders' behaviour.

## Licence

Two licences, because the code and the record are different things and should be
reusable on different terms.

**The code is AGPL-3.0-or-later** (`LICENSE`). Copyleft, including over a network:
anyone who runs a modified version as a service owes their users the modified
source. This is deliberate. The value of a verification tool rests entirely on
whether its criteria can be inspected, and a closed fork of this code answering
questions about tokens would be exactly the thing the project exists to argue
against.

**The record is CC0-1.0** (`LICENSE-DATA`): public domain, no conditions, no
attribution required. Every launch record, the bulk database at
`chainoftitle.org/data/record.db`, and `data/labels.json` are covered by it. Use
them in a commercial product, a competing scanner, a paper, or a court filing
without asking. Citation is welcome and never required; `CITATION.cff` has the
form.

The split is the point. Copyleft on the instrument keeps it honest. Public domain
on the record means nobody has to depend on this project continuing to exist in
order to keep what it has already published.

