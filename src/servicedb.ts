/**
 * Build the record database — the file the public service reads, and the thing this project actually is.
 *
 *   npm run servicedb            incremental: carry across launches changed since the last run
 *   npm run servicedb -- --full  rebuild from scratch
 *
 * **Why this exists.** The collector's database is a research instrument: 13.2 M trade rows, 3.3 GB of them plus
 * 1.7 GB of indexes, growing by roughly a gigabyte a day and pruned on a retention window. None of that is the
 * product. The product is one immutable row per launch — what a token was at birth — and at ~24,000 launches a day
 * the arithmetic that matters is per-row, not per-day: about 200 bytes each, so ten million launches is ~2 GB and a
 * hundred million is ~20 GB. That is a file you can serve, replicate, hand to a researcher and publish as a dump.
 *
 * The whole reason it fits is that nothing on the serving path needs the trade rows any more:
 *   - `tokens.curve_buyers` stores the distinct-outside-buyer count, so `assess` never scans `trades`.
 *   - `findBuyout` needs only curve buys of 40 SOL or more, which is **1,485 rows out of 13.2 million**.
 * Table names match the source deliberately, so `serve.ts` runs against either file unmodified.
 *
 * What is deliberately *not* carried: per-trade history, wallet aggregates, tweets, paper positions, price
 * checkpoints. Those are how the record was derived, not the record. A launch fact, once established, never changes,
 * which is what makes this file cheap to cache, cheap to ship, and safe to treat as append-mostly.
 */
import { openDb } from "./db.ts";
import { config } from "./config.ts";
import { statSync } from "node:fs";
import { BUYOUT_SOL } from "./provenance.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "data/record.db");
const FULL = process.argv.includes("--full");
/**
 * Never write to the source database. The collector runs this against its own live file, and the `UPDATE tokens SET
 * curve_buyers` below takes a write lock: the collector's inserts then failed with SQLITE_BUSY and the process died,
 * crash-looping every three minutes. Readers do not block writers in WAL mode, so with this flag the build is purely
 * a reader and the collector never notices it. `curve_buyers` is computed straight into the record instead.
 */
const READ_ONLY = process.argv.includes("--read-only");

const db = openDb(config.dbPath);
const log = (...a: unknown[]) => console.log(...a);

// ---------- 1. make sure the source has the counts the record depends on ----------
// Counting distinct curve buyers per token is one sequential pass over `trades`, and the result never changes for a
// token whose curve has finished. Tokens are refreshed when the count is missing, or when the token is recent enough
// that its curve may still be active.
const RECENT_MS = 48 * 3600_000;
log(READ_ONLY ? "counting curve buyers into the record (source is read-only)…" : "counting curve buyers…");
const t0 = Date.now();
if (!READ_ONLY) db.exec(`
  UPDATE tokens SET curve_buyers = (
    SELECT COUNT(DISTINCT tr.wallet) FROM trades tr
    WHERE tr.mint = tokens.mint AND tr.venue = 'curve' AND tr.side = 'buy' AND COALESCE(tr.is_dev, 0) = 0
  )
  WHERE ${FULL ? "1=1" : `curve_buyers IS NULL OR updated_at >= ${Date.now() - RECENT_MS}`}
    AND EXISTS (SELECT 1 FROM trades tr2 WHERE tr2.mint = tokens.mint)
`);
if (!READ_ONLY) {
  const counted = (db.prepare("SELECT COUNT(*) c FROM tokens WHERE curve_buyers IS NOT NULL").get() as any).c;
  log(`  ${counted.toLocaleString()} launches have a stored buyer count (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

// ---------- 2. build the record ----------
db.exec(`ATTACH DATABASE '${OUT.replace(/'/g, "''")}' AS rec`);
if (FULL) {
  for (const t of ["tokens", "trades", "hist_trades", "operator_wallets", "operator_policy", "pool_map", "runs", "meta"])
    db.exec(`DROP TABLE IF EXISTS rec.${t}`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS rec.tokens (
    mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, creator TEXT,
    created_at INTEGER, late_discovery INTEGER,
    dev_pct REAL, dev_sold INTEGER,
    unique_buyers INTEGER, curve_buyers INTEGER, snap30_buyers INTEGER, bundled_buyers INTEGER,
    graduated INTEGER, graduated_at INTEGER,
    pool TEXT, vault_sol REAL, vault_at INTEGER, last_price REAL,
    rebuilt_at INTEGER, rebuilt_complete INTEGER, updated_at INTEGER,
    -- Last, matching main.tokens and the ALTER below, because the copy below is a positional INSERT ... SELECT.
    -- NOT NULL so the published archive can never carry a row whose venue reads as unknown when it is not.
    venue TEXT NOT NULL DEFAULT 'pumpfun',
    -- Nullable on purpose: NULL means the graduation was inferred and never confirmed, which is a real third state
    -- and must not be collapsed into a boolean. See db.ts.
    graduated_confirmed_by TEXT
  );
  CREATE INDEX IF NOT EXISTS rec.tokens_created ON tokens(created_at);
  CREATE INDEX IF NOT EXISTS rec.tokens_creator ON tokens(creator);
  -- only the curve buys large enough to be a buyout: findBuyout's whole input, 1,485 rows of 13.2 million
  CREATE TABLE IF NOT EXISTS rec.trades (
    mint TEXT NOT NULL, wallet TEXT NOT NULL, side TEXT, sol REAL, ts INTEGER, slot INTEGER, venue TEXT, is_dev INTEGER
  );
  CREATE INDEX IF NOT EXISTS rec.trades_mint ON trades(mint, ts);
  CREATE INDEX IF NOT EXISTS rec.trades_wallet ON trades(wallet);
  CREATE TABLE IF NOT EXISTS rec.hist_trades (
    mint TEXT NOT NULL, sig TEXT NOT NULL, idx INTEGER, ts INTEGER, slot INTEGER, wallet TEXT,
    side TEXT, sol REAL, tokens REAL, vsol REAL, vtok REAL, is_dev INTEGER, PRIMARY KEY (mint, sig, idx)
  );
  CREATE INDEX IF NOT EXISTS rec.hist_trades_mint ON hist_trades(mint, ts);
  CREATE TABLE IF NOT EXISTS rec.operator_wallets (
    wallet TEXT PRIMARY KEY, funder TEXT, cluster TEXT, role TEXT, seeded_at INTEGER, source_mint TEXT, added_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS rec.operator_policy (
    cluster TEXT PRIMARY KEY, policy TEXT, hold_plays INTEGER, dist_plays INTEGER, plays INTEGER, note TEXT, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS rec.pool_map (pool TEXT PRIMARY KEY, mint TEXT NOT NULL, created_at INTEGER);
  CREATE INDEX IF NOT EXISTS rec.pool_map_mint ON pool_map(mint);
  CREATE TABLE IF NOT EXISTS rec.runs (id INTEGER PRIMARY KEY, started_at INTEGER, stopped_at INTEGER, note TEXT);
  -- What each curve-taking wallet did afterwards, precomputed. Derived from every trade the wallet made, so it cannot
  -- be recomputed from this file — and a wallet page that cannot compute it must not fall back to zero, because zero
  -- reads as "did not sell" about a wallet that may have sold thousands of SOL into buyers.
  CREATE TABLE IF NOT EXISTS rec.wallet_flow (
    wallet TEXT PRIMARY KEY, curve_sol REAL, amm_buy REAL, amm_sell REAL, tokens INTEGER
  );
  CREATE TABLE IF NOT EXISTS rec.meta (k TEXT PRIMARY KEY, v TEXT);
`);

/**
 * `slot` was added to the published record after the first databases were built. An incremental run reuses the
 * existing file and `CREATE TABLE IF NOT EXISTS` will not widen a table that is already there, so without this the
 * insert below fails on a column-count mismatch — on the collector, which only ever runs incrementally. Defensive
 * ALTER is the same pattern `openDb` uses for the collector's own schema.
 */
try { db.exec("ALTER TABLE rec.trades ADD COLUMN slot INTEGER"); } catch {}
/**
 * Same reasoning for the launch record's venue column, with one addition that matters more than the ALTER itself:
 * the default backfills the rows already in the file.
 *
 * A bare `ADD COLUMN venue TEXT` leaves every existing row NULL, and an incremental run only re-copies rows changed
 * since the watermark — so the first version of this left 143,102 of 145,984 published launches unstamped. That is
 * worse than having no column at all: a consumer reading NULL concludes the venue is unknown, when we know exactly
 * what it is. Every row in this file came from the pump.fun collector, so the default states a recorded fact.
 */
try { db.exec("ALTER TABLE rec.tokens ADD COLUMN venue TEXT NOT NULL DEFAULT 'pumpfun'"); } catch {}
/**
 * Graduation confirmation. No backfilling default here, unlike venue: an unconfirmed graduation is genuinely unknown,
 * and stamping existing rows would invent evidence. The copy below carries whatever the collector actually recorded,
 * and `openDb` has already upgraded rows there that have an observed pool.
 */
try { db.exec("ALTER TABLE rec.tokens ADD COLUMN graduated_confirmed_by TEXT"); } catch {}
/**
 * Upgrade the rows already in the file from evidence they already carry.
 *
 * The ALTER above only widens the table; an incremental run re-copies nothing behind the watermark, so without this
 * the column arrives NULL on every historical row and stays that way — 4,021 launches with a pool address we
 * observed, reported as unconfirmed. That is the same trap the venue column hit, and it is worth stating once more:
 * a migration that adds a column does not reach the rows a watermark excludes.
 *
 * This invents nothing. A pool on the row is an observation we made, and a pool cannot exist unless the curve
 * completed, so it is exactly the evidence the column is for. Rows without one stay NULL.
 */
try { db.exec("UPDATE rec.tokens SET graduated_confirmed_by = 'pool' WHERE graduated = 1 AND pool IS NOT NULL AND graduated_confirmed_by IS NULL"); } catch {}

const since = FULL ? 0 : Number((db.prepare("SELECT v FROM rec.meta WHERE k='watermark'").get() as any)?.v ?? 0);
log(`carrying launches ${since ? `changed since ${new Date(since).toISOString()}` : "(full rebuild)"}…`);

db.exec("BEGIN");
try {
  // Launch facts. `updated_at` is the watermark: a row is carried when the collector last touched it.
  db.exec(`INSERT INTO rec.tokens
    SELECT mint, name, symbol, creator, created_at, COALESCE(late_discovery,0), dev_pct, dev_sold,
           unique_buyers,
           ${READ_ONLY ? `COALESCE(curve_buyers, (SELECT COUNT(DISTINCT tr.wallet) FROM trades tr
             WHERE tr.mint = main.tokens.mint AND tr.venue='curve' AND tr.side='buy' AND COALESCE(tr.is_dev,0)=0))` : "curve_buyers"},
           snap30_buyers, bundled_buyers, graduated, graduated_at,
           pool, vault_sol, vault_at, last_price, rebuilt_at, rebuilt_complete, updated_at,
           -- Last, matching both schemas. COALESCE because a collector database migrated mid-run can hold rows
           -- written before the default applied; an unstamped launch is pump.fun for the same recorded reason.
           COALESCE(venue, 'pumpfun'),
           -- No COALESCE: NULL here means "inferred, never confirmed" and must survive the copy as NULL. A pool we
           -- observed is confirmation, so upgrade on the way through rather than losing it.
           COALESCE(graduated_confirmed_by, CASE WHEN graduated = 1 AND pool IS NOT NULL THEN 'pool' END)
    FROM main.tokens WHERE COALESCE(updated_at, 0) >= ${since}
      -- The quote asset is not a launch. Wrapped SOL was copied into the record as one and served as a token page.
      AND main.tokens.mint NOT IN ('So11111111111111111111111111111111111111112',
                                   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                                   'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB')
    ON CONFLICT(mint) DO UPDATE SET
      graduated_confirmed_by=COALESCE(excluded.graduated_confirmed_by, rec.tokens.graduated_confirmed_by),
      name=excluded.name, symbol=excluded.symbol, creator=excluded.creator, created_at=excluded.created_at,
      late_discovery=excluded.late_discovery, dev_pct=excluded.dev_pct, dev_sold=excluded.dev_sold,
      unique_buyers=excluded.unique_buyers, curve_buyers=excluded.curve_buyers, snap30_buyers=excluded.snap30_buyers,
      bundled_buyers=excluded.bundled_buyers, graduated=excluded.graduated, graduated_at=excluded.graduated_at,
      pool=excluded.pool, vault_sol=excluded.vault_sol, vault_at=excluded.vault_at, last_price=excluded.last_price,
      rebuilt_at=excluded.rebuilt_at, rebuilt_complete=excluded.rebuilt_complete, updated_at=excluded.updated_at`);

  // Buyouts only. Rebuilt in full each time: it is small and cheap, and a partial buyout table would understate a
  // wallet's record, which is the one number the operator pages exist to state.
  db.exec("DELETE FROM rec.trades");
  // `slot` is carried even though nothing reads it yet. A trade's `ts` is the moment the collector decoded it, not
  // block time, so the gap between a launch and the buy that took its curve is only as fine as the batch they arrived
  // in — 97% of buyouts record a gap of exactly zero. The slot is the one field that could settle it, and leaving it
  // out of the published record meant nobody could check the claim, including us.
  // Named columns, not positional. `slot` is new, and on a record database built before it existed the ALTER above
  // appends it last — so a positional SELECT would quietly write the slot into `venue` on exactly the incremental
  // runs the collector actually does. Naming them makes physical column order irrelevant.
  db.exec(`INSERT INTO rec.trades (mint, wallet, side, sol, ts, slot, venue, is_dev)
    SELECT mint, wallet, side, sol, ts, slot, venue, COALESCE(is_dev,0)
    FROM main.trades WHERE venue='curve' AND side='buy' AND sol >= ${BUYOUT_SOL}`);
  db.exec("DELETE FROM rec.hist_trades");
  db.exec(`INSERT INTO rec.hist_trades SELECT mint, sig, idx, ts, slot, wallet, side, sol, tokens, vsol, vtok, COALESCE(is_dev,0)
    FROM main.hist_trades WHERE side='buy' AND sol >= ${BUYOUT_SOL}`);

  for (const [t, cols] of [
    ["operator_wallets", "wallet, funder, cluster, role, seeded_at, source_mint, added_at"],
    ["operator_policy", "cluster, policy, hold_plays, dist_plays, plays, note, updated_at"],
    ["pool_map", "pool, mint, created_at"],
    ["runs", "id, started_at, stopped_at, note"],
  ] as const) {
    db.exec(`DELETE FROM rec.${t}`);
    db.exec(`INSERT INTO rec.${t} SELECT ${cols} FROM main.${t}`);
  }

  // one row per wallet that has ever taken a curve; the aggregate is over all of its trades, on both venues
  db.exec("DELETE FROM rec.wallet_flow");
  db.exec(`INSERT INTO rec.wallet_flow
    SELECT t.wallet,
      COALESCE(SUM(CASE WHEN t.venue='curve' AND t.side='buy' THEN t.sol END),0),
      COALESCE(SUM(CASE WHEN t.venue='amm'   AND t.side='buy' THEN t.sol END),0),
      COALESCE(SUM(CASE WHEN t.venue='amm'   AND t.side='sell' THEN t.sol END),0),
      COUNT(DISTINCT t.mint)
    FROM main.trades t
    WHERE t.wallet IN (SELECT DISTINCT wallet FROM main.trades WHERE venue='curve' AND side='buy' AND sol >= ${BUYOUT_SOL})
    GROUP BY t.wallet`);

  db.exec(`INSERT INTO rec.meta (k, v) VALUES ('watermark', '${Date.now()}'), ('built_at', '${Date.now()}')
    ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

const n = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM rec.${t}`).get() as any).c as number;
const rows = { launches: n("tokens"), buyouts: n("trades") + n("hist_trades"), wallet_flow: n("wallet_flow"), operators: n("operator_wallets"), pools: n("pool_map") };
db.exec("DETACH DATABASE rec");

// Fold the write-ahead log back into the file and leave it in rollback-journal mode. The record is shipped as a
// single file — baked into an image, copied to a volume, handed to a researcher — and a 42 MB WAL sidecar left
// beside a 41 MB database means whoever copies just the `.db` gets a partial archive without being told.
db.exec(`ATTACH DATABASE '${OUT.replace(/'/g, "''")}' AS out2`);
try { db.exec("PRAGMA out2.wal_checkpoint(TRUNCATE)"); } catch {}
db.exec("DETACH DATABASE out2");
{
  const solo = new (await import("node:sqlite")).DatabaseSync(OUT);
  solo.exec("PRAGMA journal_mode=DELETE");
  const check = (solo.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
  solo.close();
  if (check !== rows.launches) throw new Error(`record database reads ${check} launches standalone but was written with ${rows.launches}`);
  log(`  verified   ${check.toLocaleString()} launches readable from the file alone`);
}

const mb = statSync(OUT).size / 1048576;
log(`\nwrote ${OUT}`);
for (const [k, v] of Object.entries(rows)) log(`  ${k.padEnd(10)} ${v.toLocaleString()}`);
log(`  size       ${mb.toFixed(1)} MB  (${(mb * 1048576 / Math.max(rows.launches, 1)).toFixed(0)} bytes per launch)`);
log(`  source     ${(statSync(config.dbPath).size / 1073741824).toFixed(1)} GB`);
log(`\nserve it with:  npm run serve -- --db ${OUT}`);
