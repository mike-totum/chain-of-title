# Assumptions, definitions and known biases

Read this alongside any report before drawing conclusions. Everything here was checked on 2026-09-02.

## Market model

- **Bonding curve.** Constant product on virtual reserves (30 SOL / 1.073B tokens at creation, 1B supply,
  graduation when virtual SOL reaches ~115, i.e. ~411 SOL market cap). Verified against live create
  events to <1 token of error (`src/curve.test.ts`).
- **Fees.** Pump.fun's fee is dynamic (higher at low market cap). The paper broker uses the fee reported
  on each token's latest on-chain trade event (protocol + creator fee, observed 0.3–1.25 %). The backtester
  uses the worst case 1.25 % plus a 0.30 % slippage allowance, both sides.
- **Fills.** Paper fills happen `FILL_LATENCY_MS` (1.5 s) after the decision at the curve state then, with
  full price impact via the curve formula. Backtest fills use the first stored trade ≥1.5 s after the
  deciding trade; impact is approximated by the slippage allowance (0.1 SOL into a ≥30 SOL curve moves
  price ~0.3 %).
- **Priority fees.** A flat `PRIO_FEE_SOL` (0.001) per transaction, buy and sell. Real fees vary with congestion.
- **Post-graduation.** Since 2026-09-02 ~21:00 UTC the monitor also decodes the PumpSwap AMM program, so
  graduated tokens we track keep receiving per-wallet trades (`trades.venue = 'amm'`) and live prices for up to
  6 h after launch. Prices are execution prices (fees included) from the user's SOL over tokens; pool reserves
  are treated as approximate because one of the two event layouts in the wild misaligns them. Pool→mint mapping
  comes from PumpSwap pool-creation events and the pump.fun API, so a token's first seconds on the AMM can be
  missed while the pool address is looked up. DexScreener polling remains as a fallback for called tokens.
- **Failed transactions, MEV, front-running, and the effect of our own orders on other traders are not
  modelled.** Paper results are an upper bound on what a live bot of this design would achieve.

## Labels

- **graduated** = left the bonding curve (virtual SOL ≥ 115, or a non-pump pool appeared).
- **real runner** = graduated at least 60 min before analysis time AND currently ≥ 822 SOL market cap
  (2× graduation) per pump.fun API / DexScreener. This is "did not round-trip back to the curve price",
  not "made money for everyone". A token judged 61 min after graduation may still fade later; the daily
  report judges most tokens many hours after graduation.
- **dev sold** = the creator wallet made any sell during the watch window.
- **bundled** = a distinct non-dev buyer's first buy landed in the creation slot or the next slot.

## Statistics and their pitfalls

- **Base rates differ by denominator.** The report's universe is every launch seen; the backtester's is
  launches with at least one non-dev trade (dev-only launches are excluded from both numerator and
  denominator). Compare a rule only with the base rate printed next to it.
- **Restarts.** Each restart force-closes open paper positions with exit reason `shutdown`; these are excluded
  from win rate and PnL but counted in `entries`. Tokens mid-watch at a restart are recovered at the next start
  (last/peak price and checkpoints rebuilt from stored trades, graduation inferred from price), so their
  checkpoints are exact only up to their last stored trade.
- **Smart-wallet look-ahead.** `npm run wallets` ranks wallets using the same period's outcomes. A backtest of
  the `smart-wallet-buy` rule over that same period is therefore partly circular. The honest test is the
  **live** `smart-wallet` paper strategy, which only ever uses the set as it existed at decision time, and a
  backtest over a *later* day than the one the set was built from.
- **Exit sweep is in-sample.** Best parameters are fitted to the same entries they are scored on. Use them as
  a direction (short holds vs long, trail vs fixed TP), not as settings, until confirmed on a later day.
- **"if held" columns** in the report are token price at N minutes after *launch* divided by our entry price,
  ignoring sell impact and fees. They answer "was the exit rule helping" not "what would I have banked".
- **Channel/account grading** uses each call's *first* mention and outcome *now*; a channel posting a token
  after it graduated shows a high graduation rate with a long lead time. Always read graduation rate together
  with median lead.
- **Buzz detection** counts distinct authors, not tweets, but bots with many accounts can still trigger it.
  Muted flood accounts are listed in `data/x-mute.json`.
- **Multiple comparisons.** The sweep tests ~300 rules; at 5 % significance about 15 will look good by chance.
  Require the same rule to hold on a second, later day before believing it.

## Wash-printed prices (found 2026-09-03)

- Operator tokens that graduate instantly with the dev holding most of the supply can carry an absurd *reported*
  price on DexScreener and pump.fun's API (WOFI showed a $240M market cap while its PumpSwap pool held 951M tokens
  and 1.24 SOL). Both indexers were fooled; our decoded PumpSwap trades were right. Consequences:
  - The post-graduation label is now **verified on-chain** from the pool's vault balances (`token_outcomes.verified`,
    `pool_sol`); a "real runner" needs >= 822 SOL market cap **and** >= 40 SOL actually in the pool. Unverified API
    prices never count. Yesterday's "32 real runners" were mostly this artifact and should be disregarded.
  - DexScreener prices are only used for tokens with no live AMM trades; they never override PumpSwap trade prices.
  - Paper positions closing above 50x are flagged `suspect` and excluded from every report table (9 so far, all
    from API prices). Nothing on a bonding curve can exceed ~15x, so this flag costs no real trades.

## PumpSwap pool trust (2026-09-03)

- For some pools (typically operator tokens with the dev holding most supply) the decoded PumpSwap trade amounts are
  wrong by orders of magnitude — the same pools where DexScreener and pump.fun also report nonsense. Every mapped pool
  is now checked once against its on-chain vault balances (`tokens.vault_sol`); decoded trades are used only if the
  first trade price is within 0.2–5x of the vault-implied price (`tokens.amm_trusted`). Untrusted pools are priced
  from their vaults every 60 s instead. Paper trades on untrusted pools before this fix (up to ~11:40 UTC 3 Sep) may
  carry distorted prices even where the multiple stayed under 50x.

## Price sanity

- pump.fun-created tokens have 6 decimals; a late-discovered token (named by a post, not seen at launch) can have
  other decimals, which made one PumpSwap price 1000x too low on 2026-09-03 and produced a fake 986x paper trade
  (deleted). Decimals are now looked up per late token, dust AMM trades (<1,000 tokens or <0.0005 SOL) are ignored
  for pricing, and any price that jumps >10x against the last accepted price is held until a second sample agrees.
  Report tables should still be read with an eye for a single absurd multiple.

## Pattern-derived rules

- The kill filters and the team/dev-buy rules were derived from 2026-09-02 data. They are hypotheses until they
  repeat on later days; the daily report re-tests each of them. Hosts in the kill list can change as
  launch bots move providers — re-run `npm run patterns` and update `KILL_HOSTS` when a new host dominates.
- `grad-runner` prices from DexScreener (20 s polling), so its fills are coarser than curve-phase fills and its
  paper results should be read with an extra slippage margin.

## Data completeness

- Trade capture started 2026-09-02 16:23 UTC; tokens before that have no per-trade or wallet data.
- Raw trades are kept in full for tokens that graduated, hit 2×, had a signal, had ≥8 buyers, or were entered
  by a non-baseline strategy; other tokens keep their first 100 trades. Wallet aggregates exist for all.
- The public Solana RPC occasionally drops the socket; reconnects are logged with the `reconnects=` counter
  in the status line. Gaps of a few seconds lose trades but not launches (creates are re-derived from later
  trades only if a create event was seen; a launch that happened entirely inside a gap is missed).

## Fixes of 2026-09-03 (afternoon)

- **Indexer prices.** A DexScreener price is now used only for tokens with no known pool, only from an AMM pair, and
  only when it agrees (0.2–5x) with the price implied by that pair's own reported reserves; rejected prices are logged
  once per token (`[ext] rejected`). Once a pool is known the token is priced from its on-chain vault balances every
  60 s and indexer prices are ignored. Pools are found from pump.fun or, failing that, DexScreener's pumpswap pair
  address. Before this, two kol-signal paper trades on 3 Sep printed 460,000x and 10,000,000x from a bad indexer price
  that the 10x-jump guard could not catch because the indexer repeated it.
- **Re-discovered tokens.** A post naming a mint the monitor tracked earlier restores that token's real creation time,
  graduation state and pool from the database. Before, it was treated as a brand-new launch ("age 11 s") and the
  kol-signal strategy entered a day-old token as if it were a launch.
- **Wallet stats.** `wallet_token_stats.first_buy_*` now describe the wallet's first bonding-curve buy only; wallets
  whose only buys were on the PumpSwap AMM have NULLs there and cannot qualify as smart wallets. Rows written before
  the fix were backfilled by nulling first-buy fields where the first buy was at or after graduation and no curve buy
  exists. Smart-wallet scoring and wallet-team scoring credit a graduation only if it took >= 60 s after creation:
  instant graduations are dev-funded operator launches, and their AMM buyers were the whole "100 % graduation, 19.5x
  lift" smart set of the 3 Sep morning report. The live smart-wallet and team-wallet strategies no longer enter after
  graduation.
- **Real-runner coverage.** Verification needs the pool address; pump.fun's API usually omits it, so only 148 of
  2,098 graduated tokens (3 Sep) could be verified and "0 real runners" was a coverage gap. The outcome lookup now
  falls back to DexScreener for the pool address and retries the RPC on rate limits. Real-runner counts before this
  fix are not comparable with later ones.

## Pool-capital washes (found 2026-09-03 afternoon)

- An operator with capital defeats the "SOL in pool" check: buy the whole curve (85 SOL for 79.3 % of supply, instant
  graduation, zero outside buyers), then buy ~99 % of the pool's tokens with thousands of their own SOL. The pool then
  holds 1,000–12,000 real SOL and prints a market cap of 5,000–15,000x graduation that nobody can sell into. One
  factory relaunches the same tickers all day (WOTF, RST, WOFI, USWS, LQX, GOAF, USMS…). These were 150 of the 160
  "verified real runners" of the first 3 Sep rerun.
- A real runner now also needs **organic demand**: dev buy < 50 % of supply and >= 30 distinct outside buyers on the
  curve or the AMM (`REAL_MIN_BUYERS`, `REAL_MAX_DEV_PCT`). Tokens not watched from launch are judged on AMM buyers only.
  With that, the 3 Sep universe of ~30k watched launches contained 7 organic runners, all graduating 1–16 h after launch
  with 1,000+ AMM buyers.
- The paper broker's fills on dev-owned instant graduations are fictitious (the curve is already complete at 2 s); the
  `suspect` flag catches the >50x ones, but every strategy's baseline should be read excluding `dev_pct >= 50`.

## survivor-trail (live paper from 2026-09-04 ~01:30 UTC)

- Entry: graduated token with a trusted AMM price at >= 2.5x the graduation cap, dev < 50 % of supply, >= 30 distinct buyers,
  on the next outside buy >= 0.5 SOL. Exit: 30 % trail armed at 1.3x, stop 0.7, 6 h, no take-profit, no dev-sell exit.
- Source: `npm run ammfollow` on 96 h of decoded PumpSwap paths — 41k entries in that band averaged 1.13x under this exit
  (median 0.95, 42 % winners, 5 % >= 2x) versus 0.57x when held to the end of the data. The exit was chosen among six on
  the same data, so the 1.13x is in-sample; the paper strategy and the day-by-day table in ammfollow are the out-of-sample
  test. Profit, if real, accrues over many trades (the median trade loses slightly); size accordingly.
- The live version adds ">= 30 buyers" (the replay only excluded dev >= 50 %) to keep the pool-capital wash factory out.
- **2026-09-04 update.** The first live day (18 closed, 2 wins, 0.68x) bought spikes: the rule fired on the first 0.5 SOL buy after
  a fresh graduation crossed 2.5x. Replaying the exact live rule gave 1.04x over three days, and the replay's "chasing" split
  explained the gap (entries > 1.15x the price 2 min earlier: 0.96x; others: 1.12x). The live rule now requires 2 min of prints
  and price <= 1.15x its level 2 min ago. Sep 4 was negative for every survivor bucket (band under the trail: 0.77x), so the
  two positive days remain the only evidence; the strategy stays on paper.
- The vault price path now refuses pools with < 1M tokens or < 0.5 SOL in reserves and any vault price above 1000x the
  graduation price without live AMM trades (two kol-signal trades printed 800,000x from a pool still being seeded).
- **2026-09-04 evening.** First read of the hourly snapshots (20 h, small n): among survivors first seen with a >= 100 SOL pool,
  those with 100-300 SOL averaged 0.68x six hours later (30 % halved, 42 % of pools gone); 300-1000 SOL averaged 1.01x (none
  halved, all pools alive); 1000+ SOL 1.44x on 15 tokens. Three-hour momentum predicted nothing. survivor-trail now requires
  >= 300 SOL in the pool (vault re-read every 60 s for tokens in the band). Several of its earlier entries had 2-4 SOL pools.

## Chain-history reconstruction and 24 h curve polling (2026-09-04 evening)

- **Winner sample.** The live database held ~12 organic runners in 80k launches and saw only 3 from launch; the daily
  feature sweep's "real" column was 0.0 % in every bucket for that reason. `npm run history` now rebuilds the bonding-curve
  life of every pump.fun coin that reached $1M (1,127 candidates in 120 days at first collection; the ATH-sorted list is
  polluted by wash-printed pools, so ATHs above $5B are dropped and every candidate is verified by its own curve trades).
- **Failed transactions dominate.** On Squads 3,898 of 4,083 curve transactions failed (bot slippage errors); on Kshama
  6,854 of 7,360. Failed signatures carry no events and are not fetched; `hist_activity.failed` records them per hour,
  since bot pressure is a feature in its own right.
- **The two verified winners were not organic on the curve.** Kshama and Squads both had a first-hour flurry that
  round-tripped to zero (every buyer sold, virtual SOL back to 30), then 5–13 dead hours, then a single 85 SOL buy from a
  fresh wallet took the entire curve and graduated it; the 1,000+ buyers came on PumpSwap afterwards. The 24 h poller
  catches exactly this transition (a dormant curve going `complete` between two reads); the live tracker had dropped both
  tokens as dead. Whether "dormant-curve buyout" predicts a run, and how often it happens per day, is the first question to
  answer from `curve_snapshots` once a day of data exists.
- **Curve constant drains.** Heavily wash-traded dead tokens end with virtual SOL below 30 and virtual tokens above the
  initial 1.073B (k drops on every round trip under the current fee model). Prices read from reserves stay correct; the
  constant-product fill math in `curve.ts` is slightly off for such tokens.
- **Endpoints.** publicnode refuses `getMultipleAccounts` above 10 keys and batches of more than one `getTransaction`;
  the official endpoint answers 429 under the monitor's own load. `src/rpc-http.ts` learns per-endpoint refusals at run time.

## Operator clusters and cluster-follow (2026-09-04 night)

- Kshama's and Squads' 85 SOL curve buyers were seeded in 20-wallet batches by one funder each (FC9BqG…, Bwpr1KP…). 32 of 32
  sampled FC9BqG siblings traded Kshama, BISON, CART and WOFI on PumpSwap; one of the four ran. On Kshama the farm began
  drip-buying within a minute of graduation and the price was flat for ~3 h before the run. `data/operator-clusters.json`
  holds the hand-traced set; `npm run clusters` generalises it from the history rebuild.
- `cluster-follow` restores a dropped token aged from the moment of discovery (the tracker finalizes anything past the 6 h
  cap at the next tick); its paper positions therefore live at most ~6 h even though the exit allows 12 h, and the reported
  entry age is discovery age, not launch age. The token's real creation time stays in `tokens.created_at`.
- The strategy trusts the cluster list; a farm's *losing* plays (BISON, CART) are entered too. Its edge, if any, is the
  farm's hit rate times the payoff, and the daily per-account table (source `cluster`) is where that is measured. n = 2
  winners, 1 confirmed cluster at the time of writing.
- Funder sampling reads 60 of a funder's transactions; a farm larger than that is only partly listed and the buyout wallet of
  an unlisted sibling is missed until the next `npm run clusters` (seeds every live curve buy ≥ 40 SOL, so buyouts by unknown
  wallets become seeds the next day). The wash factory (one wallet graduated 22 of the rebuilt "$1M" tokens) is in the same
  tables; its cluster will show up with many wins and no organic buyers, and should become an exclusion, not a signal.

## Cluster policy and the operator leash (2026-09-05)

- Farms differ: FC9BqG holds for hours after a buyout (Kshama, Simba); Bwpr1K sells within minutes to hours (Squads 283 SOL in
  30 min, onoda drained the same afternoon). `operator_policy` carries follow / watch / avoid per cluster, derived from the
  30-day behaviour table (follow: >= 2 hold plays and >= 60 %; avoid: >= 2 distributions and >= 67 %; else watch) with hand-set rows
  (`manual = 1`) never overwritten. cluster-follow never enters an avoid cluster; watch entries are paper and tagged `[watch]` in the
  reason so the report can split them from `[follow]`.
- Tokens with operator activity get a 24 h tracker cap instead of 6 h and are not dropped for a quiet pool while a position is open.
  Their paper positions can therefore run to the 12 h exit; the `farm-sell` exit is the intended close.
- Every known farm buyout (17) lands 00:23–11:25 UTC, core 04:00–08:30. The 24 h curve poller sees only same-day dormant curves;
  farms also buy curves days or a month old (Axolotl, Simba). Detection is by wallet, not by the poller.

## Detection rebuilt: the monitor was blind to its own thesis (2026-09-05 evening)

Three measurements on the live database prompted this; each is reproducible.

- **Wallet-list following cannot work.** Of 988 curve buys of >= 40 SOL in the 72 h to 2026-09-05, the buyer was already
  in `operator_wallets` for **13**. 846 were added to the list only *after* their buy (`npm run clusters` seeds every
  live buyout, so the table looks 86 % "known" in hindsight) and 129 were never known. Farms burn a fresh wallet per
  buyout, so `cluster-follow`'s identity gate could only ever fire on the residue — it entered once in 24 h.
- **The buyout detector was measuring the wash factory.** `npm run buyouts` (new) grades every large curve buy by what a
  follower would have made entering at the first AMM print after it. Over 96 h: 1,039 buyouts, 260/day, and **263 of the
  270 with a followable market had dev >= 50 % of supply** — the instant-graduation factory (WOFI, PONS, USMS, RST, LQX,
  GOAF, WOTF) whose 100x-4000x "returns" are the pool-capital wash of 3 Sep, not a market. The 7 organic ones averaged
  0.86x. **Every one of the 270 was under 15 minutes old at the buyout**: not one dormant-curve buyout appears in the
  live data, because a dormant curve is by definition a token we had already dropped, and `tracker.onTrade` returns null
  for an untracked mint. Kshama, Squads, Simba, Axolotl and onoda were all invisible for this reason.
- **92 % of graduations had no post-graduation data.** Of 1,363 tokens that graduated in 24 h, 615 had a pool address,
  112 had any decoded AMM trade and 93 a trusted one. The PumpSwap feed was delivering ~5.3 M trade events per run and
  only ~2 % were attributed, because `amm.on("pool")` recorded the pool -> mint pair *only if the token was tracked at
  that moment*, and the map was in memory only, so every restart discarded it.

Changes, all in `src/index.ts` unless noted:

- **Blind buyout detection.** A buy >= `BUYOUT_MIN_SOL` (40) on a curve we are *not* tracking is now restored, logged as
  `[buyout]`, and stored in `signals` with source `buyout`. Detection is by behaviour, not identity: since every launch is
  tracked from creation, an untracked mint receiving a buyout *is* the dormant-curve event. Cluster identity is still
  attached when known, and is now only used for grading and the `avoid` policy.
- **Movement detection over the whole AMM stream.** `noteMovement` keeps a 5-minute rolling window per pool for every
  PumpSwap trade, with no database writes, and fires when net buying >= `MOVE_MIN_NET_SOL` (25) from >= `MOVE_MIN_BUYERS`
  (8) distinct buyers lifts the price >= `MOVE_MIN_LIFT` (1.5x), at most once per pool per hour. On a hit the token is
  restored with a 12 h cap and stored in `signals` with source `movement`. This is the first detector that can see a
  token which starts running *after* we dropped it — the shape of every verified winner.
- **Pool map is now complete and persistent.** Every `CreatePoolEvent` is recorded regardless of tracking, into the new
  `pool_map` table (`src/db.ts`), and preloaded at startup (3,070 pools on the first run). A token restored hours later
  therefore has its pool immediately instead of waiting on the 400 ms lookup queue — the reason Simba was missed.
- **Retries for the two silent mutes.** `onAmmTrade` discards every trade while `vaultPrice` or `decimals` are unknown,
  and both lookups were fire-and-forget: a single failed RPC call left a restored token mute for its whole watch. The
  60 s loop now retries both for any tracked token with a pool.
- **Wrapped SOL is not a token.** `So111…112` is the quote side of every pump.fun pair; it leaked in as a mint and fired
  movement on the aggregate of all pools ("+4958 SOL from 31 buyers"). Excluded in the pool map, `setPool` and movement.
- **Telegram watcher disabled** in `.env` (session dead with `AUTH_KEY_UNREGISTERED` since 13:17 UTC). Note this also
  means **no alert of any kind is being delivered**: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are empty, so `notify()`
  has been a no-op. The log and the `signals` table are the only channels until one is configured.

**The wash factory found the movement detector within its first hour**, exactly as it had defeated every earlier
price-and-volume test. Its first live hits included TRUMPCARD 388x, HOOD 522x and PONS 333x, each "+1500-1900 SOL net
from 8 buyers" — the pool-capital wash of 3 Sep, where the operator buys ~99 % of its own pool with its own SOL and
prints a market cap nobody can sell into. Two gates were added and kill it without touching a real move: a lift cap
(`MOVE_MAX_LIFT`, 20x — nothing genuine moves 20x in five minutes) and a concentration test (`MOVE_MAX_TOP_SHARE`, 0.6 —
no single wallet may be more than 60 % of the window's buy volume). The signal text now records the top buyer's share so
the gate can be re-tuned from data. Contrast the same hour's organic hit: PILL, +25 SOL from **261** buyers at 1.6x.

`npm run movements` grades the new signal sources by forward return from the first fillable print. Neither is traded
yet and neither should be until it has graded: a 2.6x-in-5-minutes trigger is exactly the "chasing" entry that the 4 Sep
PumpSwap replay measured at 0.96x. Detect, record, measure, then decide.

## The curve cannot pay, the AMM might (2026-09-05 night)

The same measurement on both venues, organic tokens only (`amm_trusted = 1`, `dev_pct < 50`, >= 30 buyers), asking how
often a position ever *reaches* a multiple:

| venue | n | reaches 2x | reaches 5x | reaches 10x | avg peak | round-trip cost |
|---|---|---|---|---|---|---|
| bonding curve (`positions`, baseline-all, 24 h) | 19,412 | 7.6 % | **0.0 %** | 0.0 % | 1.20x | ~3 % |
| post-graduation (decoded AMM paths, 96 h) | 116 | 23.3 % | **3.4 %** | 0.9 % | 1.79x | ~0.25 % |

The curve row is a proof of impossibility, not a weak result: **zero of 19,412 positions ever reached 5x**. Graduation
caps the curve near 15x and nothing approaches it. No structure that pays small bounded losses to catch a large winner
can work on the curve, because the large winner does not exist there. That retro-explains every negative strategy in the
report — they were required to lose, and they lost at almost exactly the fee. It also explains why exit tuning never
helped: average peak is 1.20x against 0.97x realised, and the 0.23 gap is the ordinary cost of not selling the top.

Post-graduation the tail exists and costs a twelfth as much to reach. This is **not** evidence of an edge: peak is
measured with hindsight, and `survivor-trail` lost 10.9 % trying to harvest this exact band. But it lost on 25 trades
under an in-sample rule, which is not a verdict.

**The reframe.** After the organic filters the tradeable universe is roughly **29 tokens per day**, not 27,000 launches.
Nearly all of this project's cost and attention has been aimed at a population that is mathematically incapable of
paying. The well-posed question is whether ~30 candidates a day, at a 3.4 % chance of 5x and a 0.25 % fee, support a
structure with small bounded losses. Answerable in days.

Caveat: n = 116 over four days, drawn from the 8 % of graduations that were visible before tonight's pool-map fix, which
plausibly over-samples the more active pools. Re-run against a full day of complete coverage before trusting the rates.

## Platform funders look exactly like farms (2026-09-06)

The first buyout caught by the blind detector (PONST, 85.0 SOL onto a curve dormant 9.5 h, 04:35 UTC) traced to funder
`AxiomRXZAq1...` — a vanity address spelling **Axiom**, a Solana trading terminal. The 07:00 `npm run clusters` would
have enumerated its retail users into `operator_wallets` as an operator cluster and given `cluster-follow` a permanent
false signal. To the tracer the two are the same shape: one payer seeding many wallets that trade the same tokens. The
tell is the vanity address — operators do not grind a funder to spell a product name.

`traceFunder` now refuses to seed a platform (`isPlatformFunder`, covering Axiom, BullX, Photon, Trojan, GMGN, Bloom,
Nova, Pepeboost, Maestro, Banana). The bad row was removed and the buyout wallet retained with `funder`/`cluster` NULL.

**Open:** the largest existing clusters should be re-checked against this. `3JZLJa` (281 wallets, net -478 SOL) and
`Bm3pPA` (296 wallets, -406 SOL) were read as farms that distribute, but a trading platform's users collectively losing
money and net-selling produces exactly that signature. Any behaviour classification derived from them is suspect.

### First end-to-end capture (same event)

PONST is also the first proof the new chain works. Created 19:07 the previous evening; two buys of 0.04 and 0.07 SOL;
both sold out by 20:17 leaving virtual SOL back at exactly 30.0; eight dead hours; then one 85.01 SOL buy took vSOL
30.0 -> 115.0 and graduated the curve in a single transaction - the Kshama/Squads shape exactly. The buyer was **not**
in `operator_wallets`, so the old identity gate would have seen nothing. Detected 04:35:49, restored, priced, and
`cluster-follow` entered at 04:36:49 at 605 SOL - 60 seconds end to end.

## Movement signals do not pay (2026-09-06, first full grading)

`npm run movegrid` replays every `[movement]` signal against its own AMM path with a take-profit / stop grid, 0.5 %
round-trip fee, 6 h max hold. 132 signals over 48 h.

- **Holding returns 0.42.** These round-trip almost completely; the average last price is 0.37 of the entry.
- **Every disciplined exit lands 0.86-1.06**, clustered just below 1.0 - the fee-and-noise result.
- Best cell is TP 1.5x / SL 0.7 on the concentrated bucket at **1.056**, but that is the best of 72 cells across six
  splits, in-sample, on n = 67. Treat as noise per the multiple-comparisons rule above.
- **The hypothesis-driven split inverted.** The broad-crowd, non-factory subset (top buyer <= 20 %, no factory ticker
  family) was predicted to be cleanest and is the **worst** at 0.86-0.96; the factory ticker families scored marginally
  better. An inverted split is a signature of noise, not structure.

**Conclusion:** movement is a *detector*, not an entry. It earns its place by putting tokens under observation and
filling `trades` with post-graduation paths - the data that was 92 % missing - but no entry rule should be built on the
trigger itself. This was the predicted outcome (a 1.5x-in-5-minutes trigger is the chasing entry the 4 Sep replay
measured at 0.96x) and it took one night to confirm rather than weeks.

**Still open:** `[buyout]` has n = 2, far too small. `[lategrad]` has no followable path yet. The curve-versus-AMM tail
question in the section above is untouched by this result.

## Phase 0: the numbers the site was allowed to print (2026-09-06, evening)

Before any of this is public, two things had to be true: that no figure on a page is older than it claims to be, and
that the clean criteria have been tested against tokens known by independent evidence to be manufactured.

- **`updated_at` was not the measurement time, and the site said it was.** `upsertToken` writes `updated_at` on every
  row update but only replaces `vault_sol` when a pool read actually succeeded (`COALESCE`). Quoting `updated_at` as
  "Measured" therefore advanced the timestamp while the number stood still — a pool read fourteen hours ago could be
  presented as read two minutes ago. `tokens.vault_at` now records when a balance was actually read, is written only
  at that moment (`checkVault`), and moves with `vault_sol` or not at all. Existing rows are NULL: an unknown
  measurement time reads as unknown, never as fresh. **Any pool figure recorded before 2026-09-06 evening has no
  trustworthy measurement time and is not quoted on a page.**
- **Pool balances are re-read at generation time for anything about to be certified.** HOOD and HCAT held 2,677 and
  2,050 SOL when the collector last read them and $21 and $19 hours later, so a stored balance cannot support a
  present-tense claim. `npm run site` now re-reads the pool from chain for every token whose *launch record* would
  certify it (a few dozen, not the thousands that graduate), and a read that fails means no certificate. The clean
  criteria are split accordingly in `src/provenance.ts`: `cleanAtBirth` holds the permanent launch facts, and the
  liquidity gate is applied by the caller against a balance it has just read.
- **The criteria live in one module now.** `src/provenance.ts` holds the thresholds, `assess` and `cleanAtBirth`;
  `site.ts` and `labels.ts` both import it. A validator that re-implements the rules it is checking proves nothing
  about what visitors are shown.

### The labelled set (`npm run labels`)

The gate is one-sided on purpose: a known-manufactured token certified clean fails the build; one we merely fail to
flag is reported and tolerated. A missed warning costs nothing, a wrong all-clear costs everything.

Labels come from **creator-wallet reuse**, an axis none of the criteria read: a *ticker family* of >= 15 graduated
mints, >= 0.9 distinct creators per mint, and <= 2 launches per creator wallet — identity burning at both the family
and the token level. Creator share, curve buyer counts, graduation speed and pool balances play no part in the label.

**The first version of the rule used the ticker alone and mislabelled 5 tokens**, all of which then "failed" the
criteria. Inspection showed the labels were wrong, not the criteria: the `?` and `AMC` families' creators average 34
and 57 launches each — serial launchers reusing a generic name, not an operation burning identities. WOFI's creators
average 1.18, WOTF's 1.10. Adding the creator-launch bound removed both families and the failures with them. Worth
recording because the instinct on a red test is to loosen the criteria, which here would have been exactly wrong.

Current result over 664 tokens in 13 verified factory families (WOFI, WOTF, PONS, RST, HOOD, BEAST, LQX, WWR, NTDA,
GTA 6 Coin, LEGO, Redbull, Anthropic) plus the hand-verified pins: **659 flagged DANGER (99.2 %), 5 silent, 0
certified clean.** The five silent ones are recall gaps and are listed by the tool.

Known limits: the set is drawn from our own database, so it inherits its coverage window and cannot contain a factory
that launches under a different ticker each time. It is a precision test, not a census, and `--build` should be re-run
as new families appear.

### A failed read is not a finding (same evening)

The first site build with live pool re-reads lost **133 of 249** and duly reported *"0 launched clean in the last 24 h
of 1,404 graduations"*. The zero was not a measurement. `poolReserves` pins the single public node
(`SOLANA_WS_URL` -> https, default `api.mainnet-beta.solana.com`) that our own collector keeps saturated; a direct
probe returns `HTTP 429 "Too many requests for a specific RPC call"`. `check.ts` had already worked around this and
said so in a comment; the batch path had not.

Two consequences, both fixed:

- **Batch reads now go through the managed endpoint pool** (`poolReservesPooled`, using `rpc()` from `rpc-http.ts` with
  `SOLANA_RPC_URLS` and per-endpoint back-off). `poolReserves` stays as-is for the live collector, which reads one
  token at a time and is paced for it.
- **"Could not check" is now reported separately from "not clean."** Failing closed is right, but a headline of
  "0 clean" implies we looked and found none, which is the same species of false claim as quoting a stale balance —
  just pointing the other way. The front page carries a `could not check` figure beside the clean count, and the clean
  table says plainly that absence from it means unchecked, not manufactured. `api/summary.json` gains `unverified24h`.

Worth stating as a rule, since this is the third instance in two days: **infrastructure failures must never enter the
data as findings.** A rate-limited RPC once printed "no warning" on a wash token; a missing `hist_trades` lookup
certified Squads; a 429 storm printed "0 clean". Each time the failure was silent and each time it read as a result.


## Phase 2: on-demand backfill (`npm run backfill`, 2026-09-07)

**The moat was overstated and is now correctly described.** Launch-time facts are *not* physically unrecoverable. A
pump.fun bonding curve is one account whose entire transaction history is bounded and, on an archival endpoint, fully
readable: Helius returned all 1,000 signature pages for a curve created 120 days ago. Anyone with an archival key can
rebuild creator share, curve buyers, fill time, buyout and dev sells for any token. What is genuinely unrecoverable is
narrower — the off-chain launch metadata (name, image, socials behind an IPFS `uri`) that an operator can repoint or
unpin. The real advantage is economics and speed: 126k launches already indexed and answerable in milliseconds against
a per-token walk costing minutes and RPC spend, plus the operator graph, which needs corpus-wide analysis rather than
per-token lookups. Do not claim "a competitor can never obtain yesterday" — it is false and checkable.

`npm run backfill -- <mint>` rebuilds a launch record from chain and stores it with `tokens.rebuilt_at` /
`rebuilt_complete`. Reconstructed trades go to `hist_trades`, never the live `trades` table, so observation and
reconstruction stay physically separable.

**Two bugs found while validating it, both the house failure mode (an empty answer read as a real one):**

- **`rpc()` returns `j.result`, which is `null` when a node does not hold the transaction — no exception.** Treating
  that as a successful fetch made a rebuild missing 1,300 of 1,925 transactions report itself *complete*, and silently
  dropped the creator's own opening buy: it named the wrong creator and reported 0.0% creator supply against a true
  9.8%. A null is now a failed read.
- **The endpoint pool contains non-archival nodes**, which answer `null` rather than erroring for anything past their
  retention. Retries are now pinned to archival endpoints. Before: 741 of 1,925 unreadable. After: 0.

Validated against `hist_tokens` ground truth on SCI-BOT (created 2026-05-10, 2,135 signatures): creator, creator share
(9.8% vs 9.75% recorded), creation time and graduation (10.6 vs 10.7 min) all agree, while the rebuild found **1,812
curve trades and 586 outside buyers against the stored 560 and 238**.

**That prompted an audit of `hist_tokens`: 188 of 2,729 rows (6.9%) were stored as `status = "done"` on an incomplete
fetch** (mean fetch ratio across the corpus is 0.958, so this is not systemic — but SCI-BOT was at 0.32). `history.ts`
now marks any rebuild that could not read every transaction as `partial`. Any analysis resting on `hist_tokens` buyer
counts or dev share — operator clustering, the reconstructed-winner set — should exclude `partial` rows and be re-run.

**Performance is a product constraint, not a detail.** SCI-BOT took 324 s: 2,135 signatures, ~1,900 transactions, eight
in flight. That is a $1M winner, the busiest kind of curve, and the median launch is far smaller — but it settles the
architecture. On-demand backfill is a **queued job**, not a synchronous request behind a search box. Cache forever:
provenance, once rebuilt completely, never changes.


### Wiring backfill into the 404 path (`npm run serve`)

`src/serve.ts` serves the generated site and, for a mint it has no page for, queues a rebuild instead of returning a
dead end: the visitor gets a page explaining what is being read and why it takes minutes, which polls `/api/job/<mint>`
and reloads when the record exists. A completed rebuild is written into `site/t/`, so the static tree self-heals and
the next request never reaches this code. One worker at a time; the RPC endpoint is the constraint, not the CPU.
Queue depth is capped at 40 — beyond that it says it is busy rather than promising work it will not do.

Page rendering moved to `src/render.ts` so the generator and the service cannot drift; `provenance.ts` already held the
criteria. Three bugs found by testing the path end to end, all of the same family:

- **A rebuild could not correct a previous bad rebuild.** `store()` used `COALESCE(tokens.creator, excluded.creator)`,
  which correctly protects a live observation but also preserved the *first, wrong* rebuild forever — SCI-BOT kept the
  wrong creator and 0.0% creator supply through a `--force` re-run. A complete rebuild now replaces a prior rebuilt
  row, and still never overwrites a watched launch.
- **Rebuilt tokens showed "outside buyers: unknown" and could never be judged.** `assess` counts curve buyers from
  `trades`, and a rebuild writes to `hist_trades`; it now falls back to the count taken over the complete rebuilt
  history when `rebuilt_complete` is set.
- **A rebuilt wash-factory token displayed no warnings at all.** `serve.ts` flipped `watched` *after* `assess` had
  already returned early for an unjudgeable token, so none of the danger checks ran: USWS (graduated instantly, one
  buyer) rendered with an informational banner and nothing else. `assess` now decides judgeability itself, from
  coverage **or** a complete rebuild. Verified: USWS now carries both expected DANGER flags.

Also: the largest buy of every rebuild was being written into `hist_trades` as a curve buyout regardless of size,
inventing buyout records — including one that rounded to 0 SOL — which feed the wallet profiles on operator pages.
Only buys of at least `BUYOUT_SOL` are recorded now, and the two bad rows were deleted.

Note that a page already written into `site/t/` is served as-is, so a fix reaches existing pages only at the next
`npm run site`. That is the intended trade (a stale page beats an outage) but it does mean a corrected rule is not
retroactive until the generator runs.


### Limits on the rebuild path (2026-09-07)

Every on-demand rebuild spends archival RPC calls — thousands for a busy curve — on a request from the open internet,
against the same quota the collector depends on. Unbounded, one visitor can occupy the single worker indefinitely.
The limits are generous for a person and useless for a script, and every refusal says plainly what happened and when
to come back, because a refusal is an operational state and must never read as a finding about the token.

- `PER_IP_PER_HOUR` 5, `GLOBAL_PER_HOUR` 60, `GLOBAL_PER_DAY` 400. Sliding windows, pruned on read.
- **Order of checks is cheapest-refusal-first**: an existing job (free) -> `--no-rebuild` -> global budget -> per-IP ->
  a one-call probe that the bonding curve exists at all -> queue. A mint with no curve (an SPL token launched
  elsewhere, a wallet, a typo) is refused for one RPC call instead of thousands.
- `MAX_SIGS_ON_DEMAND` 8,000 caps a single rebuild; the CLI is uncapped. Over the cap the record is marked incomplete
  with the count, not silently truncated.
- Jobs are evicted after 6 h (or 5,000 entries) — results live in the database, not the queue.
- `TRUST_PROXY=1` makes the service read `cf-connecting-ip` / `x-forwarded-for`. Off by default: those headers are
  caller-supplied, so trusting them when nothing is in front hands every visitor an unlimited supply of identities.

**A gap found while testing these.** Any `late_discovery` row short-circuited to an UNKNOWN page and never reached the
rebuild path. Holding a *row* for a mint is not the same as holding its launch: tokens named by a post or found by a
detector have no curve history, and they are exactly the ones a rebuild helps most. The short-circuit now requires a
record we can actually judge (`rebuilt_complete`, or watched live inside coverage); everything else attempts a rebuild
and falls back to rendering whatever we do hold.

Still open: `tokens` contains mints that are not pump.fun launches at all (Wrapped SOL, USDC), picked up as late
discoveries from posts. They render an honest UNKNOWN, but they should not be in the launch table.


## The record database and why pages are no longer pre-rendered (2026-09-07)

Pre-rendering a page per token does not survive contact with the launch rate. At **~24,000 launches and ~1,465
graduations a day**, rendering every launch is 8.8 M pages a year and graduations alone are 535 k. Seven days of
graduations already produced **19,104 files and 112 MB** — past Cloudflare Pages' 20,000-file deployment cap, so the
approach had roughly a week left regardless of anything else.

`serve.ts` already renders a page from a database row on request, so the static tree was an imitation of a cache. It is
now an actual cache: pages are rendered per request and cached at the edge (`max-age=3600, stale-while-revalidate=86400`
for a settled record, `no-store` while a rebuild is pending or the answer is UNKNOWN — a visitor must not be pinned to
an answer we are in the middle of improving). `npm run site` writes **3 files, 32 KB**: the front page, the 404 and the
summary JSON. `--pages` still writes the full tree for a portable offline copy of a bounded window.

### `npm run servicedb` -> `data/record.db`

| | |
|---|---|
| collector database | 6.9 GB (13.2 M trade rows: 3.3 GB of data, 1.7 GB of indexes) |
| record database | **39.9 MB — 323 bytes per launch** |

At 323 bytes a launch, ten million launches is ~3.2 GB and a hundred million ~32 GB. The per-row figure is the one that
matters; the per-day figure only tells you how fast you reach it.

It fits because nothing on the serving path needs trade rows any more: `tokens.curve_buyers` stores the distinct
outside-buyer count so `assess` never scans `trades`, and `findBuyout` needs only curve buys of 40 SOL or more —
**1,485 rows out of 13.2 million**. Table names match the source, so `serve.ts` runs against either file unmodified.
Deliberately not carried: per-trade history, wallet aggregates, tweets, paper positions, price checkpoints. Those are
how the record was derived, not the record.

### Two failures caught on the way, both the house pattern

- **A record database carrying only buyouts made an exculpatory claim.** `profile()` derives a wallet's open-market
  behaviour from all of its trades, so with only the buyouts present a Priors page reported *"sold on the market: 0 —
  not yet a net seller"* about a wallet that had sold **3,512 SOL into buyers**. A precomputed `wallet_flow` table (one
  row per curve-taking wallet) now carries it, and `profile()` prefers that row and never falls back to a zero.
  Verified: the 40 MB record returns numbers identical to the 6.9 GB source, correctly flagged DANGER.
- **An empty database served "no record" for every token on Solana.** `.railwayignore` used `data/*` with a
  `!data/record.db` negation; the file was silently left out, `openDb` created its tables on an empty file, and the
  first deploy answered every lookup with a clean 200 saying we hold nothing. `serve.ts` now refuses to start when the
  archive holds fewer than 1,000 launches, and the ignore file names the heavy databases explicitly instead of relying
  on negation. Being down is recoverable; being authoritatively wrong about every token is not.

### Deployment

Railway project `pump-provenance`, service `web`, sharing the collector's image with `SERVICE=web` selecting the role
in the Dockerfile CMD. `TRUST_PROXY=1` so the per-IP limits key on the real visitor rather than the platform proxy.
The record database is baked into the image, which means on-demand rebuilds performed by the running service are lost
on the next deploy — acceptable while rebuilds are cheap and re-runnable, but the reason to move it to a volume shared
with the collector once the rebuild queue carries real traffic.
