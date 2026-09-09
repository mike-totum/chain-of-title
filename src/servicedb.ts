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
import { createHash } from "node:crypto";
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

/**
 * A legal hold freezes the published record, not only the pruners.
 *
 * Holding deletion while still rebuilding would defeat itself: `servicedb` rebuilds `rec.trades` and
 * `rec.wallet_flow` in full from whatever the collector currently holds, so evidence already published disappears
 * from the artifact the moment the collector no longer has its source rows — a deletion by another route, arriving
 * through the one path nobody would think to suspend. Raised by the other session while reviewing the hold, and it
 * was right.
 *
 * So under a hold the record does not change at all. New launches stop being published for the duration, which is a
 * real cost and the correct trade: a hold is exceptional and time-bounded, and "the file under dispute did not move
 * while the dispute was live" is a sentence worth being able to say without qualification.
 */
const HOLD = (process.env.LEGAL_HOLD ?? "").trim();
if (HOLD) {
  console.log(`LEGAL HOLD IS SET (${HOLD}) — the published record is frozen and will not be rebuilt.`);
  console.log(`Collection continues; only publication is suspended. Unset LEGAL_HOLD to resume.`);
  process.exit(0);
}

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
  for (const t of ["tokens", "trades", "hist_trades", "operator_wallets", "operator_policy", "pool_map", "runs", "meta", "corrections"])
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
    graduated_confirmed_by TEXT,
    -- What the token claimed to be at launch. The only fields in this file that cannot be rebuilt from chain by
    -- anyone willing to pay for archival RPC: they live behind a URI the creator controls and vanish when it is
    -- repointed or unpinned. meta_at distinguishes "declared none" from "we never looked". See db.ts.
    uri TEXT, image TEXT, description TEXT, meta_at INTEGER,
    -- The proof of the picture, never the picture. A sha256 is 64 bytes and lets anyone verify that a copy of an
    -- image is the one we saw; the bytes average a few hundred KB and would inflate a 334-bytes-per-launch archive
    -- by four orders of magnitude, destroying the property that makes it mirrorable. The files travel separately.
    -- image_error is deliberately NOT carried: it describes our fetch, not the launch.
    image_sha256 TEXT, image_bytes INTEGER, image_at INTEGER,
    -- The curve account's own complete bit, and when we read it. graduated is an inference from decoded trade
    -- volume and it is wrong on about two rows in five; this is the reading that says so, published as evidence
    -- rather than used to quietly rewrite the inference.
    --
    -- Four states, and the pair is what tells them apart — the same shape as image/meta_at:
    --   curve_checked_at NULL                         we hold no reading. Covers a read never attempted and one
    --                                                 that failed: a failed RPC call writes nothing, deliberately,
    --                                                 so it is retried rather than recorded as an observation
    --   curve_checked_at set, curve_complete NULL     we read it and the account was gone: we looked, learned nothing
    --   curve_checked_at set, curve_complete 0        we read it and the curve had not completed. A disconfirmation
    --   curve_checked_at set, curve_complete 1        we read it and the curve had completed
    --
    -- A mint we hold no reading for must serialise NULL and must never default to 0. Defaulting would publish our
    -- own RPC failures as findings about someone else's token — this project's recurring failure with the sign
    -- flipped. The sync below is guarded on EXISTS for exactly that reason: rows we hold nothing for are untouched.
    curve_checked_at INTEGER, curve_complete INTEGER
  );
  CREATE INDEX IF NOT EXISTS rec.tokens_created ON tokens(created_at);
  CREATE INDEX IF NOT EXISTS rec.tokens_creator ON tokens(creator);
  -- only the curve buys large enough to be a buyout: findBuyout's whole input, 1,485 rows of 13.2 million
  CREATE TABLE IF NOT EXISTS rec.trades (
    mint TEXT NOT NULL, wallet TEXT NOT NULL, side TEXT, sol REAL, ts INTEGER, slot INTEGER, venue TEXT, is_dev INTEGER
  );
  CREATE INDEX IF NOT EXISTS rec.trades_mint ON trades(mint, ts);
  -- The image route refuses any hash the record does not attest, on every request; without this that is a scan of
  -- every launch on file. Partial, so it costs nothing for the rows that hold no picture.
  CREATE INDEX IF NOT EXISTS rec.tokens_image ON tokens(image_sha256) WHERE image_sha256 IS NOT NULL;
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
  -- Every correction this project has issued, carried by the record itself.
  --
  -- Until now they existed only as prose on chainoftitle.org/corrections. DATA.md states that the reason this file
  -- is deposited under a DOI is that "the record outlives the site" — and the corrections did not. Someone who
  -- mirrors the CC0 file and never visits the site could not learn that a column they were counting is wrong.
  --
  -- Append-only, and the shape enforces it: a correction that is itself wrong is not edited, it is superseded by a
  -- new row naming the old one in supersedes. Nothing in this file ever UPDATEs a row here.
  CREATE TABLE IF NOT EXISTS rec.corrections (
    id TEXT PRIMARY KEY,           -- stable slug, so a correction can be cited
    issued_at INTEGER NOT NULL,    -- when it was published, ms since epoch
    scope TEXT NOT NULL,           -- 'column', 'row' or 'record'
    subject TEXT,                  -- the column name or mint it concerns; NULL when record-wide
    finding TEXT NOT NULL,         -- what was wrong
    effect TEXT NOT NULL,          -- what a reader who trusted it would have wrongly concluded
    remedy TEXT NOT NULL,          -- what was done, and what to read instead
    supersedes TEXT                -- the id of a correction this one replaces, when it replaces one
  );
  -- The confirmed set, as a view, so the obvious query returns the defensible answer.
  --
  -- tokens.graduated is an inference and it stays exactly as it was recorded; nothing in this file rewrites it.
  -- But a reader who runs SELECT COUNT(*) FROM tokens WHERE graduated = 1 gets a number about three quarters too
  -- large, and telling them so in a data dictionary they may never open is not enough. This adds a correct
  -- affordance beside the raw column rather than editing the column: SELECT * FROM graduations is the confirmed set.
  CREATE VIEW IF NOT EXISTS rec.graduations AS
    SELECT * FROM tokens WHERE graduated_confirmed_by IS NOT NULL;
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
/**
 * The launch claim: what the token said it was. Four columns, two different backfill answers, and the difference is
 * the whole point of stating them separately.
 */
for (const c of ["uri TEXT", "image TEXT", "description TEXT", "meta_at INTEGER",
                 "image_sha256 TEXT", "image_bytes INTEGER", "image_at INTEGER", "meta_bytes INTEGER",
                 "meta_sha256 TEXT", "curve_checked_at INTEGER", "curve_complete INTEGER"])
  try { db.exec(`ALTER TABLE rec.tokens ADD COLUMN ${c}`); } catch {}

/**
 * The commitment, not the document.
 *
 * `meta_json` stays in the collector: a kilobyte a launch against 24,000 launches a day would add tens of megabytes
 * a day to a file whose entire value is that one person can mirror it. But holding a document nobody can verify we
 * hold is a claim, and this project does not publish claims it cannot evidence.
 *
 * A sha256 costs 64 bytes and settles it. Anyone who later obtains the document — from us, lawfully, or by having
 * archived the URI themselves before the creator repointed it — can prove it is the one we read at launch. It is
 * the same trade already made for images: the proof rather than the picture.
 *
 * Computed over the UTF-8 bytes of the stored document, which is what we received; a NULL here means we hold no
 * document to commit to, and `meta_bytes` still distinguishes "too large to store" from "never fetched".
 */
db.function("sha256", (v: unknown) =>
  v == null ? null : createHash("sha256").update(String(v), "utf8").digest("hex"));

/**
 * And backfilled, because the copy below is incremental.
 *
 * A new column plus a watermark leaves every row that has not changed since the last run permanently NULL. The first
 * run of meta_sha256 stamped 325 of 12,255 documents the collector was already holding, and `uri` carries its own
 * backfill a few lines down for the same reason.
 *
 * Generalised after fixing it once and not learning from it: with meta_sha256 backfilled the record still published
 * ZERO image commitments while the collector held them, because the image columns were added the same way and never
 * got the same treatment. Anything the collector fills in long after a launch — a picture fetched hours later, a
 * document read on a retry — arrives after the row has stopped changing, so it can only ever reach the record this
 * way. One list, so the next such column is a line here rather than a silent hole in the published file.
 */
for (const [col, expr] of [
  ["meta_sha256", "sha256(m.meta_json)"],
  ["image_sha256", "m.image_sha256"],
  ["image_bytes", "m.image_bytes"],
  ["image_at", "m.image_at"],
] as const) {
  try {
    const r = db.prepare(`UPDATE rec.tokens SET ${col} = (
        SELECT ${expr} FROM main.tokens m WHERE m.mint = rec.tokens.mint)
      WHERE ${col} IS NULL AND EXISTS (
        SELECT 1 FROM main.tokens m WHERE m.mint = rec.tokens.mint AND ${expr} IS NOT NULL)`).run();
    if (Number(r.changes ?? 0) > 0) log(`  backfilled ${Number(r.changes).toLocaleString()} ${col}`);
  } catch (e) { log(`  WARNING: ${col} backfill failed: ${String((e as any)?.message ?? e).slice(0, 120)}`); }
}
/**
 * DO NOT add a DROP COLUMN here. It was tried and it does not hold.
 *
 * `openDb()` runs the collector's schema migrations against whatever file it is handed, and both `site.ts` and
 * `serve.ts` open the published record with it. So a column dropped at build time is back the moment anything of
 * ours reads the file: dropped here, 31 columns; one `npm run site` later, 33 again. The drop was silently undone
 * on every cycle and looked like it had never run.
 *
 * That is worth more attention than the two columns are. The web service migrating the artifact it serves means the
 * file a reader downloads is not byte-identical to the file we built, and its hash moves after publication — which
 * is the property an archive under a DOI most needs to keep. The fix belongs in `openDb` (a read-only open that
 * does not migrate), not here, and it is not this file's to make.
 *
 * Until then both columns stay, empty, and the schema page says so rather than pretending they carry something.
 *
 * `image_error` describes our fetch, not the launch — the CREATE above says so and then the file carried it anyway.
 *
 * `meta_json` is the harder one and is a publication decision rather than a collection one. Keeping the metadata
 * document in the collector is exactly the archaeology this project exists to do: the URI is the creator's to
 * repoint and the document is retrievable once. Publishing it in record.db is a different act. It runs about a
 * kilobyte a launch against roughly 24,000 launches a day, so it would add ~24 MB a day to a 75 MB file and destroy
 * the property the archive is built on — that one person can mirror the whole thing. That is the same argument this
 * file already makes for storing an image's sha256 rather than its bytes, pointed at a much larger column.
 *
 * So: collect it, do not publish it yet, and let it be decided deliberately rather than by an ALTER. Both columns
 * hold no data today, so dropping them loses nothing; a schema that advertises holdings the file does not have is
 * worse than one that says less.
 */

/**
 * `uri` gets a real backfill, because the collector has held it all along: 154,000 of 157,000 launches. Without this
 * the watermark leaves every historical row NULL while the value sits in the source database, which is the third time
 * that trap has been hit here. Copying it invents nothing; it is a value we recorded at launch.
 */
try {
  db.exec(`UPDATE rec.tokens SET uri = (SELECT t.uri FROM main.tokens t WHERE t.mint = rec.tokens.mint)
           WHERE uri IS NULL AND EXISTS (SELECT 1 FROM main.tokens t WHERE t.mint = rec.tokens.mint AND t.uri IS NOT NULL AND t.uri != '')`);
} catch {}
/**
 * `image`, `description` and `meta_at` get none, and that is a decision rather than an omission. They were never
 * captured before 2026-09-08: `fetchMeta` did not read the image field and there was no column for the description it
 * did read. There is nothing to backfill from. Re-fetching the URIs now would record what they resolve to *today* and
 * stamp it as the launch claim, which is manufacturing evidence about the past, and this project does not get to do
 * that to anyone. Historical rows stay NULL because NULL is the true answer.
 */

const since = FULL ? 0 : Number((db.prepare("SELECT v FROM rec.meta WHERE k='watermark'").get() as any)?.v ?? 0);
log(`carrying launches ${since ? `changed since ${new Date(since).toISOString()}` : "(full rebuild)"}…`);

db.exec("BEGIN");
try {
  // Launch facts. `updated_at` is the watermark: a row is carried when the collector last touched it.
  /**
   * Named columns, not positional — the same fix `rec.trades` already carries, arrived at the same way.
   *
   * A record database built by an earlier version of this file holds columns this one no longer writes:
   * CREATE TABLE IF NOT EXISTS will not widen an existing table, and deleting an ALTER does not narrow one either.
   * data/record.db had 33 columns against the 30 this SELECT supplies and every rebuild died on
   * "table rec.tokens has 33 columns but 30 values were supplied" — on the collector, which is the only machine
   * that matters. Naming the columns makes the copy indifferent to what else the file has accumulated.
   */
  db.exec(`INSERT INTO rec.tokens
      (mint, name, symbol, creator, created_at, late_discovery, dev_pct, dev_sold,
       unique_buyers, curve_buyers, snap30_buyers, bundled_buyers, graduated, graduated_at,
       pool, vault_sol, vault_at, last_price, rebuilt_at, rebuilt_complete, updated_at,
       venue, graduated_confirmed_by, uri, image, description, meta_at,
       image_sha256, image_bytes, image_at, meta_sha256, meta_bytes)
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
           COALESCE(graduated_confirmed_by, CASE WHEN graduated = 1 AND pool IS NOT NULL THEN 'pool' END),
           -- The launch claim, carried verbatim. Never re-derived: a later read of the URI is not what it said then.
           uri, image, description, meta_at,
           image_sha256, image_bytes, image_at,
           sha256(meta_json),
           -- The document's size as served, which is what tells "too big to store" apart from "never fetched".
           -- meta_json itself is deliberately not published: see the DROP below.
           meta_bytes
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
  /**
   * The AMM trades that `wallet_flow` is computed from, on the mints those wallets actually took.
   *
   * Without them `amm_sell` was the one column in the published file that could not be reproduced FROM the published
   * file: the record carried no `venue='amm'` rows at all, so a reader could see "this wallet sold 4,515 SOL into
   * buyers" and had no way to check it, or to disagree. For a project whose entire claim is that you should not have
   * to take its word, that is the wrong column to have.
   *
   * Scoped to the same (wallet, mint) pairs as the aggregate, so it is exactly the evidence behind the number and not
   * a second, larger claim. 1,916 rows measured 2026-09-08 against 10,773 for the wallet-wide version — small enough
   * that there was never a size reason not to publish it.
   */
  db.exec(`INSERT INTO rec.trades (mint, wallet, side, sol, ts, slot, venue, is_dev)
    SELECT t.mint, t.wallet, t.side, t.sol, t.ts, t.slot, t.venue, COALESCE(t.is_dev,0)
    FROM main.trades t
    JOIN (SELECT DISTINCT wallet, mint FROM main.trades
           WHERE venue='curve' AND side='buy' AND sol >= ${BUYOUT_SOL}) b
      ON b.wallet = t.wallet AND b.mint = t.mint
    WHERE t.venue='amm'`);
  /**
   * `hist_trades` is optional, and assuming otherwise is what has produced every 94 KB record the cloud collector has
   * ever built. The table is created by `history.ts`, which only ever runs on the laptop - so on a collector it does
   * not exist, this statement throws, the whole build dies before writing a single row, and the child process reports
   * a failure nobody reads while the schema-only file it left behind sits there looking like a database.
   *
   * The web service's pull guard rejected those files for their size, which is the only reason the published archive
   * survived. That was an accident, not a design: the build was broken for the entire life of the cloud collector and
   * seeding it with 168,300 launches did not change that, because the fault was never missing data.
   */
  const hasHist = (db.prepare(
    "SELECT COUNT(*) c FROM main.sqlite_master WHERE type='table' AND name='hist_trades'").get() as any).c > 0;
  db.exec("DELETE FROM rec.hist_trades");
  if (hasHist)
    db.exec(`INSERT INTO rec.hist_trades SELECT mint, sig, idx, ts, slot, wallet, side, sol, tokens, vsol, vtok, COALESCE(is_dev,0)
      FROM main.hist_trades WHERE side='buy' AND sol >= ${BUYOUT_SOL}`);
  else
    log("  hist_trades absent in the source (history.ts has never run here); the record carries none");

  for (const [t, cols] of [
    ["operator_wallets", "wallet, funder, cluster, role, seeded_at, source_mint, added_at"],
    ["operator_policy", "cluster, policy, hold_plays, dist_plays, plays, note, updated_at"],
    ["pool_map", "pool, mint, created_at"],
    ["runs", "id, started_at, stopped_at, note"],
  ] as const) {
    db.exec(`DELETE FROM rec.${t}`);
    db.exec(`INSERT INTO rec.${t} SELECT ${cols} FROM main.${t}`);
  }

  // one row per wallet that has ever taken a curve, over the trades on the curves it actually took
  db.exec("DELETE FROM rec.wallet_flow");
  /**
   * Scoped to the mints the wallet actually took, which is what every label on it says.
   *
   * It used to select on `wallet IN (...)` — the wallet had taken SOME curve, and then every trade that wallet ever
   * made anywhere was summed into the total. So `amm_sell`, rendered as "sold after taking the curve" on the wallet
   * page and used as a worked example on the data page captioned "who sold the most into buyers after taking a
   * curve", included sells on tokens the wallet had never touched the curve of. The number was real and the sentence
   * around it was not, which is worse than either being wrong on its own.
   *
   * Joining on the (wallet, mint) pairs makes the figure mean what it is captioned. `tokens` becomes the count of
   * curves that wallet took, which is also what the page has always claimed it was.
   */
  db.exec(`INSERT INTO rec.wallet_flow
    SELECT t.wallet,
      COALESCE(SUM(CASE WHEN t.venue='curve' AND t.side='buy' THEN t.sol END),0),
      COALESCE(SUM(CASE WHEN t.venue='amm'   AND t.side='buy' THEN t.sol END),0),
      COALESCE(SUM(CASE WHEN t.venue='amm'   AND t.side='sell' THEN t.sol END),0),
      COUNT(DISTINCT t.mint)
    FROM main.trades t
    JOIN (SELECT DISTINCT wallet, mint FROM main.trades
           WHERE venue='curve' AND side='buy' AND sol >= ${BUYOUT_SOL}) b
      ON b.wallet = t.wallet AND b.mint = t.mint
    GROUP BY t.wallet`);

  /**
   * Who built this file, not only when.
   *
   * On 2026-09-08 production began serving a record built at 14:37 that appears in no log: the publish loop's own
   * log ends at 12:56, the collector's record build was not enabled locally, and nothing else admitted to it. The
   * file was correct and there was still no way to say what produced it — which means there was no way to say
   * whether the thing that produced it was supposed to.
   *
   * A record that cannot account for its own origin is a strange artefact for a provenance project to publish.
   *
   * Deliberately NOT the hostname. This file is published CC0 and mirrored under a DOI, so anything written here is
   * public forever, and a personal machine name is not ours to publish. Railway names its own services; everything
   * else is "local", which is the distinction that actually matters — cloud or laptop — without carrying a person
   * into a permanent public record. The same care the rest of this project takes about other people's data.
   */
  const builder = process.env.RAILWAY_SERVICE_NAME ? `railway:${process.env.RAILWAY_SERVICE_NAME}` : "local";
  const builtBy = `${builder} ${process.argv.slice(1).map((a) => a.replace(/^.*\//, "")).join(" ")}`.slice(0, 200).replace(/'/g, "''");
  /**
   * The curve reading, re-synced in full on every build rather than backfilled once.
   *
   * Placed here, after every INSERT, and not beside the backfills above: those run before the incremental copy
   * because their columns are also supplied by it, so a fresh file gets them on insert and an existing file
   * gets them from the backfill. These two columns are supplied by neither — nothing in the copy below reads
   * curve_checks — so running them up there updated a table that was still empty and published 205,217 NULLs.
   *
   * This deliberately does NOT join the list above, and the reason is the difference between a fact and a reading.
   * Every column in that list is written once and never revised — a document's hash, a picture's size — so filling it
   * only `WHERE col IS NULL` is right. A curve reading is not like that. `curve_checks` is rechecked on a cooldown
   * while a launch is still settling, and a curve that read `complete = 0` last week can read 1 today: slow fills
   * happen, which is the entire reason the recheck exists.
   *
   * Under `WHERE col IS NULL` that flip could never reach the published file. The row would carry 0 for the life of
   * the archive while the collector held 1, and a published disconfirmation that cannot be withdrawn is a worse
   * artefact than no column at all. So both columns are rewritten from the collector every build. It costs a join
   * over a few thousand rows and it cannot go stale.
   *
   * `graduated` itself is untouched here and everywhere else. The inference stays exactly as it was recorded and the
   * reading is published beside it; a reader gets both and can see them disagree. Repairing the column would destroy
   * the evidence that the error happened, which is the one thing a correction must not do.
   */
  try {
    const r = db.prepare(`UPDATE rec.tokens SET
        curve_checked_at = (SELECT c.checked_at FROM main.curve_checks c WHERE c.mint = rec.tokens.mint),
        curve_complete   = (SELECT c.complete   FROM main.curve_checks c WHERE c.mint = rec.tokens.mint)
      WHERE EXISTS (SELECT 1 FROM main.curve_checks c WHERE c.mint = rec.tokens.mint)`).run();
    if (Number(r.changes ?? 0) > 0) log(`  synced ${Number(r.changes).toLocaleString()} curve readings`);
  } catch (e) { log(`  WARNING: curve reading sync failed: ${String((e as any)?.message ?? e).slice(0, 120)}`); }

  db.exec(`INSERT INTO rec.meta (k, v) VALUES ('watermark', '${Date.now()}'), ('built_at', '${Date.now()}'),
      ('built_by', '${builtBy}'), ('built_pid', '${process.pid}')
    ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

/**
 * Publish nothing but the record.
 *
 * `openDb` migrates whatever database it is handed, and until 2026-09-08 both the site generator and the web service
 * pointed it at the published record — so the file the public downloads had accumulated ten empty tables from the
 * collector's schema: tweets, signals, positions, buzz, smart_wallets, wallet_teams, wallet_token_stats,
 * operator_funders and platform_snapshots. Every one of them held zero rows.
 *
 * Empty is not harmless. A file that ships a `tweets` table tells a reader we publish tweets, and the schema page
 * generated from this file would have published that claim in a table of its own. An archive is allowed to hold
 * nothing about a subject; it is not allowed to imply it holds something and then be empty, which is the same
 * absence-reads-as-a-finding failure this project keeps catching in its own data.
 *
 * openDb({ migrate: false }) stops new ones appearing. This removes the ones already there, on every build, so a
 * record inherited from any older version converges on the declared shape rather than carrying its history forever.
 * sqlite_sequence is SQLite's own and cannot be dropped.
 */
/**
 * The corrections themselves, written into the record.
 *
 * INSERT OR IGNORE on a stable id: seeding is idempotent, and because nothing here ever UPDATEs, a correction that
 * is already in a mirrored copy of the file can never be silently reworded afterwards. Amending one means adding a
 * row that names it in `supersedes`.
 *
 * Both of these were already published as prose on chainoftitle.org/corrections. Neither is new; what is new is that
 * the file carries them, so a mirror is self-describing.
 */
{
  const ins = db.prepare(`INSERT OR IGNORE INTO rec.corrections
    (id, issued_at, scope, subject, finding, effect, remedy, supersedes) VALUES (?,?,?,?,?,?,?,NULL)`);
  const at = (d: string) => Date.parse(`${d}T00:00:00Z`);
  ins.run("zero-buyers-ungated", at("2026-09-07"), "record", null,
    "The rule that flags a launch for having no outside buyers was never made conditional on the curve having "
    + "completed. It was written for graduations and applied to every launch, including the great majority that "
    + "simply die without a buyer, which is the ordinary end of a token and not evidence of manufacture.",
    "Up to 34,242 launch records were in a state where a page could say the token completed its bonding curve with "
    + "zero outside buyers, and that its graduation was funded by the creator rather than by demand. For a launch "
    + "that never completed a curve the first statement is false and the second asserts conduct the record does not "
    + "establish.",
    "The rule is now gated on confirmed completion. Launches carrying a danger flag fell from 866 to 457, which is "
    + "a correction and not a change in the market.");
  ins.run("graduated-inferred", at("2026-09-09"), "column", "graduated",
    "tokens.graduated is written when the collector's own feed sees a decoded trade reach the graduation threshold. "
    + "Curves cross that mark and fall back, and until 2026-09-09 nothing ever re-read the curve account to check.",
    "A reader counting WHERE graduated = 1 gets roughly 1.8x the number of curves that actually completed. Measured "
    + "on 2026-09-09: of 12,351 rows carrying the flag, 6,945 are confirmed, and 5,187 unconfirmed graduations were "
    + "read directly and returned complete = 0 — disconfirmed, not merely unwitnessed.",
    "graduated is left exactly as recorded, because repairing it would overwrite an observation with a later reading "
    + "and destroy the evidence that the error happened. The reading is published beside it as curve_checked_at and "
    + "curve_complete, and the graduations view carries the confirmed set. Count with graduated_confirmed_by IS NOT "
    + "NULL, or select from graduations.");
}

const RECORD_TABLES = new Set(["tokens", "trades", "hist_trades", "operator_wallets", "operator_policy",
  "pool_map", "runs", "wallet_flow", "meta", "corrections", "sqlite_sequence"]);
for (const r of db.prepare("SELECT name FROM rec.sqlite_master WHERE type='table'").all() as { name: string }[]) {
  if (RECORD_TABLES.has(r.name)) continue;
  const rows = (db.prepare(`SELECT COUNT(*) c FROM rec.${r.name}`).get() as any).c as number;
  // Refuse to drop anything holding data. A table with rows in it is either a table this list has gone stale about
  // or a mistake much larger than a stray schema, and silently deleting published rows to tidy a shape is not a
  // trade this file gets to make on its own.
  if (rows > 0) { log(`  WARNING: rec.${r.name} is not a record table but holds ${rows} rows — left alone, fix the list`); continue; }
  try { db.exec(`DROP TABLE rec.${r.name}`); log(`  dropped stray empty table rec.${r.name}`); } catch { /* view, or in use */ }
}

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
