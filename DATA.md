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
sqlite3 record.db "SELECT mint, symbol, dev_pct, curve_buyers FROM tokens WHERE graduated_confirmed_by IS NOT NULL LIMIT 5;"
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

**`graduated` is an inference, and it is wrong on about two rows in five.** The collector records a
curve as completing when its own feed reaches the graduation threshold. Curves cross that mark and fall
back, and until 2026-09-09 nothing ever re-read the curve to check. On that date the curve account was
read directly for every unconfirmed graduation the collector held: 943 had in fact completed and are now
confirmed, and **5,187 returned `complete = 0`** — read and disconfirmed, not merely unwitnessed. Against
12,349 rows carrying `graduated = 1`, 6,945 are confirmed. **Count graduations with
`graduated_confirmed_by IS NOT NULL`**, or simply `SELECT * FROM graduations`, which is a view over exactly that
set. `WHERE graduated = 1` returns roughly 1.8x the true number.

`graduated` itself is left exactly as it was recorded. Repairing it would overwrite an observation with a later
reading and destroy the evidence that the error happened, which is the one thing a correction must not do. The
reading is published beside it instead, as `curve_checked_at` and `curve_complete`, and the whole episode is in
the `corrections` table in this file.

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
| `graduated` | 1 if the curve was **recorded** as completing — an inference from decoded trade events, never a reading of the curve. Wrong on most rows where `graduated_confirmed_by IS NULL`; see the warning above. Do not count it alone |
| `graduated_at` | when, ms since epoch |
| `graduated_confirmed_by` | how completion was confirmed: `pool` (a PumpSwap pool exists, which cannot happen unless the curve completed), `curve_complete` (the curve account's own flag was read), or NULL for an inference from decoded trade events that was never confirmed. NULL is not disconfirmation — but it is no longer neutral either: where the curve account has since been read, the great majority of NULL rows returned `complete = 0`. **This column, not `graduated`, is the graduation flag** |
| `curve_checked_at` | when we read the bonding curve account itself, ms since epoch. NULL means we hold no reading — which covers both a read we never attempted and one that failed, because a failed call writes nothing rather than recording our own RPC trouble as an observation about a token |
| `curve_complete` | what that reading said: `1` the curve had completed, `0` it had not, NULL the account no longer existed. Read it **with** `curve_checked_at`: the pair distinguishes "we looked and it had not completed" (a disconfirmation) from "we looked and learned nothing" from "we never looked". A NULL here is never a zero |
| `pool` | PumpSwap pool address, when known |
| `vault_sol` | SOL in the pool at the moment it was read |
| `vault_at` | when that balance was read. Written only on an actual read, never inferred |
| `last_price` | last observed price |
| `rebuilt_at` | set if this row was reconstructed from chain history rather than observed live |
| `rebuilt_complete` | 1 if the reconstruction read every transaction. A partial rebuild understates buyers and dev share, always in the direction that makes a manufactured launch look ordinary, and certifies nothing |
| `venue` | launch venue. `pumpfun` throughout this release; the column exists because the record format is venue-neutral |
| `updated_at` | last write to this row |
| `uri` | the metadata URI declared in the creation transaction |
| `image`, `description` | what the token claimed to be at launch, read from that URI. Captured from 2026-09-08 onward; NULL on earlier rows because nothing read them then, and they are deliberately **not** backfilled — re-fetching a URI today records what it resolves to now and stamping that as the launch claim would be manufacturing evidence about the past |
| `meta_at` | when that read succeeded. This is what separates "the launch declared no image" (`image` NULL, `meta_at` set) from "we never looked" (both NULL) |
| `image_sha256` | sha256 of the image bytes as we fetched them, when we hold them. The record carries the proof, never the picture: 64 hex characters against a few hundred KB, which is what keeps this file mirrorable |
| `image_bytes`, `image_at` | size of those bytes, and when they were fetched — the fetch time, not the launch time |

### Why the picture is only kept for some launches

`image_sha256` is NULL on most rows, and that means **we did not fetch the bytes**, not that the launch had no
image. The URL is on the row either way.

The bytes are fetched for launches that **completed their bonding curve**, and the reason is arithmetic rather
than principle. Roughly 24,000 launches a day declare an image, and they average 409 KB — about **13.6 GB a day**,
or the entire storage volume every 33 hours. Graduations run near 1,400 a day, which is about 570 MB a day, and
that is what can actually be kept. Images are stored content-addressed, so the many launches that reuse the same
picture cost one copy: roughly a quarter of what we fetch is already held.

This is a real limit and it is stated rather than hidden, because the gap it leaves is exactly the kind we
criticise elsewhere. A launch that never graduated has its declared image URL recorded and its bytes unheld, and
if the operator unpins it, that picture is gone and this archive will not have it. If that matters to you, the
URLs are in the file and nothing stops you fetching them; the reason we did not is that we could not afford to.

`image_error` exists in the collector's own database but is **not** published here: it records why *our* fetch
failed, which is a fact about our infrastructure and not about the launch.

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

## `graduations` — a view, not a table

`SELECT * FROM graduations` is `tokens` restricted to `graduated_confirmed_by IS NOT NULL`: the launches whose
completion we can actually evidence. It exists because the obvious query against the raw column returns a number
about three quarters too large, and a warning in a data dictionary only helps the people who read it. The raw
column is untouched and still there; this is an affordance beside it, not a replacement for it.

## `corrections` — every correction, carried by the record

Corrections used to live only as prose at `chainoftitle.org/corrections`. The stated reason this file is deposited
under a DOI is that the record outlives the site — and the corrections did not. Someone who mirrors the file and
never visits the site could not learn that a column they were counting is wrong. Now they can.

| column | meaning |
|---|---|
| `id` | stable slug, so a correction can be cited |
| `issued_at` | when it was published, ms since epoch |
| `scope` | `column`, `row` or `record` |
| `subject` | the column name or mint it concerns; NULL when record-wide |
| `finding` | what was wrong |
| `effect` | what a reader who trusted it would have wrongly concluded |
| `remedy` | what was done, and what to read instead |
| `supersedes` | the id of a correction this one replaces, when it replaces one |

**Append-only, and that is structural rather than a promise.** A correction that turns out to be wrong is not
edited; a new row is added naming the old one in `supersedes`. Nothing in the build ever updates a row here, so a
correction already present in a mirrored copy cannot be silently reworded afterwards.

## Reproducing it

The database is built by `npm run servicedb` from the collector's own database. The criteria that
turn these columns into a published verdict live in one file, `src/provenance.ts`, executed by the
site, the API and the validator alike. `npm run labels` checks those criteria against a labelled set
of known-manufactured tokens built from creator-wallet reuse, an axis none of the criteria read, and
exits non-zero if any of them is certified clean or if the criteria certify nobody at all.

## Corrections

If a row is wrong, `corrections@chainoftitle.org`. Show the transaction and it will be checked.
