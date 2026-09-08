# The record database

`record.db` is the published artefact of this project: one immutable row per launch, plus the
supporting tables needed to answer a question about one. It is a SQLite file, released into the
public domain under CC0-1.0 (`LICENSE-DATA`). Use it without asking, including commercially.

**Cite it as `doi:10.57967/hf/10338`.** That identifier resolves to a mirror held on
infrastructure this project does not run, and it cannot be renamed, withdrawn or made private.
The record outlives the site, which is the point of publishing it this way.

Mirror: https://huggingface.co/datasets/chainoftitle/chain-of-title

Row counts below are from the build of 2026-09-07 23:12 UTC and grow with every rebuild. The
authoritative count for any given file is `SELECT COUNT(*) FROM tokens` on that file, and
`meta.built_at` says when it was made.

Released with each version at
[github.com/mike-totum/chain-of-title/releases](https://github.com/mike-totum/chain-of-title/releases),
and served live at `https://chainoftitle.org/data/record.db`.

```
sqlite3 record.db "SELECT mint, symbol, dev_pct, curve_buyers FROM tokens WHERE graduated = 1 LIMIT 5;"
```

---

## Read this before quoting a number

**Coverage is five days, not four months.** The earliest `created_at` in the file is 2026-05-10,
but exactly **two rows** predate 2026-09-02. Continuous observation begins **2026-09-02 12:29 UTC**.
Anyone describing this as four months of history is reading the span and not the coverage.

**Coverage is data, not an operational footnote.** The `runs` table holds the intervals during which
the collector was observing. A launch outside those intervals was not seen, and its absence from the
record is not evidence about the launch. Reconstructed rows are marked (`rebuilt_at`,
`rebuilt_complete`) and are never presented as observations.

**Launch facts are permanent; pool balances are not.** Everything describing the first blocks of a
launch is a fact about a moment and stays true. `vault_sol` is a balance that was read at
`vault_at` and may be wildly wrong now. Two tokens in this dataset held 2,677 and 2,050 SOL when
measured and about $20 each hours later. Never quote `vault_sol` without `vault_at`.

**A null is not a zero.** Throughout this file, missing means unknown. `curve_buyers IS NULL` means
no trade rows were available, not that nobody bought. `graduated_confirmed_by IS NULL` means a
graduation was never confirmed, not that it did not happen.

---

## `tokens` (153,578 rows) — one row per launch

| column | meaning |
|---|---|
| `mint` | token mint address, primary key |
| `name`, `symbol` | as declared in the creation event. Off-chain metadata behind the URI can be changed by the operator afterwards; these are what was declared at launch only for observed rows |
| `creator` | wallet that signed the creation transaction |
| `created_at` | launch time, ms since epoch |
| `late_discovery` | 1 if the token entered the record after its creation (restored by a detector), so its early-window counters are not a complete observation |
| `dev_pct` | share of total supply the creator took **in the creation transaction**, as a percentage. The single most diagnostic field in the file |
| `dev_sold` | 1 if the creator was observed selling |
| `curve_buyers` | distinct non-creator wallets that bought on the bonding curve. NULL means unknown |
| `unique_buyers` | distinct buyers including post-graduation AMM activity. Not the same question as `curve_buyers`; prefer `curve_buyers` for provenance |
| `snap30_buyers` | distinct outside buyers within 30 seconds of creation |
| `bundled_buyers` | distinct non-creator buyers in the creation slot or the next one, a bundling heuristic |
| `graduated` | 1 if the curve was recorded as completing. **See `graduated_confirmed_by` before relying on it** |
| `graduated_at` | when, ms since epoch |
| `graduated_confirmed_by` | how completion was confirmed: `pool` (a PumpSwap pool exists, which cannot happen unless the curve completed), `curve_complete` (the curve account's own flag was read), or NULL for an inference from decoded trade events that was never confirmed. NULL is not disconfirmation |
| `pool` | PumpSwap pool address, when known |
| `vault_sol` | SOL in the pool at the moment it was read |
| `vault_at` | when that balance was read. Written only on an actual read, never inferred |
| `last_price` | last observed price |
| `rebuilt_at` | set if this row was reconstructed from chain history rather than observed live |
| `rebuilt_complete` | 1 if the reconstruction read every transaction. A partial rebuild understates buyers and dev share, always in the direction that makes a manufactured launch look ordinary, and certifies nothing |
| `venue` | launch venue. `pumpfun` throughout this release; the column exists because the record format is venue-neutral |
| `updated_at` | last write to this row |

## `runs` (59 rows) — when the collector was watching

`started_at`, `stopped_at`, `note`. Coverage is the union of these intervals. `stopped_at` carries
the last moment a launch actually arrived, not a wall clock, so a collector that was running but
receiving nothing produces a truthful gap rather than a claim of coverage.

## `trades` (1,865 rows) and `hist_trades` (1,072 rows)

Deliberately not the full trade history: this file carries only the trades needed to answer a
provenance question, chiefly curve buys of 40 SOL or more, which is the size that completes a curve
by itself. `trades` is observed, `hist_trades` is reconstructed from chain history; they are kept
separate so a reader can always tell which produced an answer. `venue` is `curve` or `amm`.

## `operator_wallets` (7,157), `operator_policy` (26), `wallet_flow` (1,708)

Wallet groupings traced from the funder that seeded each wallet, plus per-wallet aggregate flow
(`curve_sol`, `amm_buy`, `amm_sell`, `tokens`). These describe **observed conduct of addresses**.
They are not claims about who controls an address, and nothing here should be read as an assertion
about a person or an intent.

## `pool_map` (3,249) and `meta`

Pool address to mint, from PumpSwap's own pool-creation events. `meta` holds `built_at`, the ms
timestamp of the build that produced the file, and `watermark`.

---

## Reproducing it

The database is built by `npm run servicedb` from the collector's own database. The criteria that
turn these columns into a published verdict live in one file, `src/provenance.ts`, executed by the
site, the API and the validator alike. `npm run labels` checks those criteria against a labelled set
of known-manufactured tokens built from creator-wallet reuse, an axis none of the criteria read, and
exits non-zero if any of them is certified clean or if the criteria certify nobody at all.

## Corrections

If a row is wrong, `corrections@chainoftitle.org`. Show the transaction and it will be checked.
