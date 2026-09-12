import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { TokenState } from "./tracker.ts";

/**
 * Open the collector's database, migrating it to the current schema.
 *
 * `migrate: false` opens a database and changes NOTHING about it - no CREATE, no ALTER, and no journal_mode, which
 * is itself a write to the file header. That option exists because this function was being pointed at the PUBLISHED
 * RECORD by both `site.ts` and `serve.ts`, and it did exactly what it is written to do: it migrated the artifact.
 *
 * The columns it added were trivial. What it meant was not. The web service was schema-migrating the file it hands
 * to the public, so the bytes a reader downloads were not the bytes `servicedb` built, and the hash of the published
 * record changed after publication without anyone touching the data. For an archive whose own data page says its DOI
 * cannot be renamed, withdrawn or made private - and which is meant to be usable as evidence - a file that cannot be
 * hash-matched to what was published is a file an opposing party gets to argue about.
 *
 * Found 2026-09-08 by the schema page: a DROP COLUMN kept "silently not working", because every `npm run site` put
 * the columns straight back.
 */
export function openDb(path: string, opts: { migrate?: boolean } = {}): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (opts.migrate === false) {
    // busy_timeout is a connection setting and touches no bytes. Everything below this line writes to the file.
    db.exec("PRAGMA busy_timeout = 10000;");
    return db;
  }
  /**
   * Refuse to migrate a published record, whoever asked.
   *
   * Three callers were found doing it in one evening - serve.ts, site.ts twice - and the third was one line above a
   * `PRAGMA query_only = 1`, a generator that declares itself read-only while rewriting what it was handed. Roughly
   * forty tools in this repo open `config.dbPath`, every one of them honours a DB_PATH override, and two take a
   * `--db` flag: so any of them can be pointed at the record by someone who has no idea this function migrates.
   *
   * Fixing the callers fixes today. This fixes the class, including the tool somebody writes next month, and it does
   * it where the knowledge lives. A record is unmistakable: it carries a `meta` table with `built_at`, which the
   * collector's own database has never had.
   *
   * Throws rather than quietly opening read-only, because a caller that wanted the record needs to say so - the
   * whole failure was code doing something reasonable-looking to a file it did not own, silently.
   */
  const looksLikeRecord = (() => {
    try {
      const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='meta'").get() as any;
      if (!t?.c) return false;
      const m = db.prepare("SELECT COUNT(*) c FROM meta WHERE k='built_at'").get() as any;
      return !!m?.c;
    } catch { return false; }
  })();
  if (looksLikeRecord) {
    db.close();
    throw new Error(`${path} is a published record (it carries meta.built_at), and openDb() would migrate it - ` +
      `adding tables and columns, and changing its hash after publication. Open it with openDb(path, { migrate: false }).`);
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS tokens (
      mint TEXT PRIMARY KEY,
      name TEXT, symbol TEXT, uri TEXT, creator TEXT,
      created_at INTEGER, late_discovery INTEGER DEFAULT 0,
      launch_price REAL, last_price REAL, peak_price REAL, peak_at INTEGER, peak_source TEXT,
      dev_pct REAL, dev_sold INTEGER, dev_sold_at INTEGER,
      create_sig TEXT, create_slot INTEGER,
      buys INTEGER, sells INTEGER, buy_vol_sol REAL, sell_vol_sol REAL,
      unique_buyers INTEGER, unique_sellers INTEGER, bundled_buyers INTEGER,
      snap30_buyers INTEGER, snap30_buys INTEGER, snap30_sells INTEGER, snap30_vol REAL,
      graduated INTEGER, graduated_at INTEGER, last_seen_at INTEGER,
      p_1m REAL, p_5m REAL, p_15m REAL, p_60m REAL,
      twitter TEXT, telegram TEXT, website TEXT,
      kol_signals INTEGER DEFAULT 0,
      pool TEXT, amm_trusted INTEGER, vault_sol REAL, vault_at INTEGER,
      finalized INTEGER DEFAULT 0,
      updated_at INTEGER,
      -- Which launchpad this token was launched on. Appended last, and matched by the ALTER below, so a database
      -- created fresh and one migrated in place have identical column order: servicedb copies this table with a
      -- positional INSERT ... SELECT, where a column-order difference between two live databases would silently
      -- write each value into its neighbour's field.
      venue TEXT NOT NULL DEFAULT 'pumpfun',
      -- How we know the curve actually completed. See the ALTER below for why this is a nullable source rather than
      -- a boolean. Appended last for the same positional-copy reason as venue.
      graduated_confirmed_by TEXT,
      -- The account holding this launch's curve state, where the mint does not determine it.
      --
      -- pump.fun's bonding curve is a PDA derived from the mint, so it never needed storing: anyone can recompute
      -- it. LaunchLab's pool is seeded with the platform config and the quote mint as well, so it is NOT a function
      -- of the mint and is unrecoverable if we do not write it down - which would leave the venue's curve
      -- unreadable afterwards and make the deferred buyer-count work (the pool's own signature history) impossible
      -- to start. NOT tokens.pool: that column means the AMM pool a token graduated into, and assess() reads a
      -- non-null there as confirmation that the curve completed. See venues.ts CurveLocation.
      curve_account TEXT,
      -- What this launch's curve is priced in. NULL means SOL, which every row predating the column is, and every
      -- pump.fun launch is by construction. A LaunchLab pool names its quote asset per pool and most name something
      -- else, so a SOL figure for those would be a quantity of another token wearing SOL's name.
      quote_mint TEXT,
      -- Distinct non-creator wallets we watched buy on the bonding curve, counted live as the trades arrived.
      --
      -- The published outside-buyer count was recomputed afterwards from the trades table, which finalize samples
      -- down to 100-400 curve rows per token and retention then prunes outright. A count over what survived was a
      -- floor published as a measurement, and where the only survivor was the dev buy it read as ZERO OUTSIDE
      -- BUYERS - the strongest statement this archive makes against a launch. This column is what we actually
      -- observed, taken at the only moment it is free and exact. NULL means the launch predates it, never zero.
      curve_buyers_live INTEGER
    );
    CREATE INDEX IF NOT EXISTS tokens_created ON tokens(created_at);
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy TEXT NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      reason TEXT,
      decided_at INTEGER, opened_at INTEGER,
      token_age_s REAL,
      entry_price REAL, sol_in REAL, tokens REAL, fees_sol REAL,
      closed_at INTEGER, exit_price REAL, sol_out REAL, pnl_sol REAL, multiple REAL,
      exit_reason TEXT,
      peak_multiple REAL,
      hold_1m REAL, hold_5m REAL, hold_15m REAL, hold_60m REAL,
      partial_sol_out REAL, partial_at INTEGER, suspect INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS positions_strategy ON positions(strategy);
    CREATE INDEX IF NOT EXISTS positions_mint ON positions(mint);
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT, account TEXT, mint TEXT, symbol TEXT, kind TEXT,
      text TEXT, url TEXT, posted_at INTEGER, seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL, wallet TEXT NOT NULL, side TEXT NOT NULL,
      sol REAL, tokens REAL, price REAL, ts INTEGER, slot INTEGER, sig TEXT,
      age_ms INTEGER, buyer_rank INTEGER, is_dev INTEGER DEFAULT 0, market TEXT DEFAULT 'curve'
    );
    CREATE INDEX IF NOT EXISTS trades_mint ON trades(mint, ts);
    CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet);
    CREATE TABLE IF NOT EXISTS wallet_token_stats (
      mint TEXT NOT NULL, wallet TEXT NOT NULL,
      first_buy_at INTEGER, first_buy_age_s REAL, first_buy_rank INTEGER, first_buy_slot_delta INTEGER,
      buys INTEGER, sells INTEGER, sol_in REAL, sol_out REAL, tokens_net REAL,
      realized_pnl_sol REAL, unrealized_sol REAL, last_trade_at INTEGER, hold_s REAL,
      is_dev INTEGER, token_graduated INTEGER, token_peak_x REAL, token_created_at INTEGER,
      PRIMARY KEY (mint, wallet)
    );
    CREATE INDEX IF NOT EXISTS wts_wallet ON wallet_token_stats(wallet);
    CREATE TABLE IF NOT EXISTS smart_wallets (
      wallet TEXT PRIMARY KEY, score REAL, tokens INTEGER, grads INTEGER, runners INTEGER, early_share REAL, pnl_sol REAL, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS tweets (
      id TEXT PRIMARY KEY, author TEXT, followers INTEGER, created_at INTEGER, text TEXT, urls TEXT, query TEXT,
      mints TEXT, cashtags TEXT, hashtags TEXT, likes INTEGER, retweets INTEGER, views INTEGER, fetched_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tweets_created ON tweets(created_at);
    CREATE INDEX IF NOT EXISTS tweets_author ON tweets(author);
    CREATE TABLE IF NOT EXISTS buzz (
      id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT, kind TEXT, authors INTEGER, mentions INTEGER, followers INTEGER, prior_rate REAL,
      matched_mint TEXT, sample_url TEXT, sample_text TEXT, seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS wallet_teams (
      team_id INTEGER, wallet TEXT, tokens_together INTEGER, graduated INTEGER, real INTEGER, updated_at INTEGER,
      PRIMARY KEY (team_id, wallet)
    );
    -- Which venue each observation window covers. With one venue a single interval can answer "were you watching
    -- this launch"; with two it cannot, and a venue we were not subscribed to must read as unwatched rather than as
    -- clean. Stamped now, while the answer is known and uniform, so the history already distinguishes on the day a
    -- second venue arrives - backfilling it afterwards would mean asserting coverage over windows nobody recorded.
    -- venues.ts clause 3.
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, stopped_at INTEGER, note TEXT
    );
    -- pool -> mint, learned from PumpSwap CreatePoolEvent. Every graduation emits one; recording them all (not only
    -- for tokens tracked at that moment) is what lets a token restored hours later be priced from its first AMM print.
    -- Operator farms. Created here rather than only in clusters.ts so a collector that has never run the tracer still
    -- has the tables to read, and so a seed export carries the map - it is the least reproducible thing we hold.
    CREATE TABLE IF NOT EXISTS operator_funders (
      funder TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, txs INTEGER, wallets INTEGER, seeds INTEGER,
      sampled_at INTEGER, note TEXT, parent TEXT, hops INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS operator_wallets (
      wallet TEXT PRIMARY KEY, funder TEXT, cluster TEXT, role TEXT, seeded_at INTEGER, source_mint TEXT,
      traced INTEGER DEFAULT 0, added_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS operator_policy (
      cluster TEXT PRIMARY KEY, policy TEXT, hold_plays INTEGER, dist_plays INTEGER, plays INTEGER,
      manual INTEGER DEFAULT 0, note TEXT, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pool_map (
      pool TEXT PRIMARY KEY, mint TEXT NOT NULL, created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS pool_map_mint ON pool_map(mint);
    -- The launchpad's own record of a launch, versioned. pump.fun holds facts that exist nowhere on chain and
    -- nowhere in the metadata document - whether it BANNED the token, whether it was flagged nsfw, its all-time-high
    -- market cap, how many replies it drew - and can revise or delete any of them without notice or trace. A ban is
    -- the closest thing to an admission this market produces and it is never announced.
    --
    -- Keyed on (mint, sha256) so an unchanged document writes nothing and a changed one is kept BESIDE its
    -- predecessors rather than replacing them. That is the whole difference between a cache and an archive: a cache
    -- answers what the platform says now, this answers what it said then, which is the only question anyone can ask
    -- afterwards. Error rows are versioned the same way, because a delisting is a change worth recording.
    CREATE TABLE IF NOT EXISTS platform_snapshots (
      mint TEXT NOT NULL, sha256 TEXT NOT NULL, json TEXT, bytes INTEGER, fetched_at INTEGER,
      is_banned INTEGER, nsfw INTEGER, reply_count INTEGER, ath_market_cap REAL, ath_at INTEGER,
      is_live INTEGER, error TEXT,
      PRIMARY KEY (mint, sha256)
    );
    CREATE INDEX IF NOT EXISTS platform_fetched ON platform_snapshots(fetched_at);
    -- Telegram messages from the watched channels, kept whole.
    --
    -- The watcher already read every one of these and threw away any that did not name a token, because it was built
    -- to generate trading signals and that thesis is dead. What it was discarding is the promotion layer: what was
    -- said about a launch, by whom, and when - which is unrecoverable the moment it is deleted, and deletion is
    -- itself the event most worth having recorded.
    --
    -- THIS TABLE IS NEVER PUBLISHED. It is not in servicedb and must not be added to it. The published record is the
    -- creator's own claims about their own launch; this is other people's expression, and most people amplifying a
    -- manufactured token were fooled by it rather than party to it. Collect, retain, disclose only on lawful
    -- request. See TELEGRAM.md for the purpose, lawful basis and retention question, which is a legal decision and
    -- not a technical one.
    CREATE TABLE IF NOT EXISTS tg_messages (
      channel TEXT NOT NULL, msg_id INTEGER NOT NULL,
      posted_at INTEGER, fetched_at INTEGER,
      sender TEXT, text TEXT, url TEXT,
      mints TEXT, cashtags TEXT,
      views INTEGER, forwards INTEGER, reply_to INTEGER, edited_at INTEGER,
      PRIMARY KEY (channel, msg_id)
    );
    CREATE INDEX IF NOT EXISTS tg_posted ON tg_messages(posted_at);
    CREATE INDEX IF NOT EXISTS tg_mints ON tg_messages(mints);
    -- When we could NOT read a channel. The launch record has a runs table for exactly this reason: a gap that is not
    -- written down is indistinguishable afterwards from a channel that said nothing, and the second reads as a
    -- finding. Absence has to be able to prove it is absence.
    CREATE TABLE IF NOT EXISTS tg_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, from_at INTEGER, to_at INTEGER, polls INTEGER, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS tg_gaps_channel ON tg_gaps(channel, from_at);
    -- Every legal hold, and what it protected. A hold that leaves no trace of when it was set is hard to testify
    -- about afterwards, and protect_before is the answer to the harder question: what happens on RELEASE. Without
    -- it, unsetting the hold lets the next prune sweep the whole held period in one pass, so the moment of release
    -- is the moment the evidence disappears. Rows older than the earliest recorded protect_before are never deleted
    -- again by either pruner.
    CREATE TABLE IF NOT EXISTS legal_holds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT, set_at INTEGER, last_seen_at INTEGER,
      released_at INTEGER, protect_before INTEGER
    );
  `);
  // `updated_at` is written on every token row update, but vault_sol is only replaced when a pool read actually
  // succeeded (COALESCE below). Reporting updated_at as the measurement time therefore advanced the timestamp while
  // the number stayed put - the site claimed a two-minute-old reading for a figure hours out of date. vault_at is
  // written only at the moment a balance is read. Existing rows get NULL: an unknown measurement time must read as
  // unknown, never as fresh.
  try { db.exec("ALTER TABLE tokens ADD COLUMN vault_at INTEGER"); } catch {}
  // Chain-reconstructed provenance (`npm run backfill`). A token we never watched can still have its complete curve
  // life rebuilt from the bonding curve account's transaction history, which is how the archive answers for launches
  // predating coverage. `rebuilt_complete` is the honest part: if signature paging hit its cap, or transactions could
  // not all be fetched, the record is partial and must never certify anything.
  try { db.exec("ALTER TABLE tokens ADD COLUMN rebuilt_at INTEGER"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN rebuilt_complete INTEGER"); } catch {}
  // Distinct non-creator wallets that bought on the bonding curve, counted once and stored. `assess` derived this by
  // scanning `trades` per token, which is the only reason the serving path needed a 7 GB table at all; with it here,
  // the public service runs on a ~50 MB extract. Populated by `npm run servicedb`.
  try { db.exec("ALTER TABLE tokens ADD COLUMN curve_buyers INTEGER"); } catch {}
  /**
   * The launchpad a token was launched on. Every row written before this column existed is pump.fun, so the default
   * backfills them correctly - and that is a *recorded* fact, not an inference: the collector has only ever subscribed
   * to the pump.fun program, so "we watched pump.fun" is a statement about what we did, not a guess about the data.
   *
   * Added while the archive was still small enough for that to be true of all of it. The record is append-only and
   * grows ~24,000 launches a day; a venue stamp added later would have to be asserted over millions of rows nobody
   * recorded it for, which is precisely the move this project refuses to make about anyone else.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN venue TEXT NOT NULL DEFAULT 'pumpfun'"); } catch {}
  // Same reasoning for runs, and the same default: every window already recorded was a pump.fun window.
  try { db.exec("ALTER TABLE runs ADD COLUMN venue TEXT NOT NULL DEFAULT 'pumpfun'"); } catch {}
  /**
   * Appended in this order, matching the CREATE TABLE above, so a database created fresh and one migrated in place
   * have identical column order - the rule `venue` and `graduated_confirmed_by` already follow.
   *
   * Both are nullable with no default, and for both NULL is a fact rather than a gap: a launch with no
   * `curve_account` is one whose curve address is a function of its mint, and a launch with no `quote_mint` is
   * quoted in SOL. Every row that predates them is both.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN curve_account TEXT"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN quote_mint TEXT"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN curve_buyers_live INTEGER"); } catch {}

  /**
   * trades.venue becomes trades.market.
   *
   * A metadata-only rename in SQLite, which is the only reason it is safe to do on an 11 GB table inside the
   * ingesting process: no rows are rewritten and no index is rebuilt. It runs before any statement is prepared, so
   * a process that boots on an old database renames it and then queries the new name; a process that boots on a
   * renamed one throws here and is caught. Both end in the same place, which is what makes the deploy order not
   * matter.
   *
   * The old name meant the market a trade happened on while tokens.venue means the launchpad - one word, two
   * meanings, in a schema whose whole discipline is that a word means one thing. Renamed now because with a second
   * launchpad an unqualified `venue` in any query spanning both tables silently resolves to whichever the planner
   * picks, and that is not a failure anyone would see.
   */
  try { db.exec("ALTER TABLE trades RENAME COLUMN venue TO market"); } catch {}
  try { db.exec("ALTER TABLE hist_trades RENAME COLUMN venue TO market"); } catch {}
  /**
   * How we know a curve completed: 'pool', 'curve_complete', or NULL.
   *
   * `graduated` is set by inference - decoded curve trade events reaching the graduation threshold in vSOL - and was
   * never checked against anything. Measured on 2026-09-07 over the days when pool discovery was working, that
   * inference is confirmed by an actual pool 87% of the time for curves that took 10-60 minutes to fill and only 38%
   * of the time for curves flagged as completing within 60 seconds. Detection quality cannot explain a gradient that
   * tracks fill speed, so the threshold is firing spuriously on fast curves - and `instant-graduation` is the largest
   * DANGER category on the site. Of 628 recent fast-flagged launches with no pool, exactly one had a creator holding
   * 50% or more: we were accusing launches whose creators kept nothing.
   *
   * Nullable source rather than a boolean, because the relationship is asymmetric and the asymmetry is the point. A
   * PumpSwap pool cannot exist unless the curve completed, so a pool IS confirmation; the absence of one is NOT
   * disconfirmation, only the absence of evidence. A boolean would collapse "we never confirmed it" into a 0 that
   * reads as "we checked and it did not graduate", which is the exact substitution this project exists to refuse.
   *
   * Confirmation is monotonic, like the provenance counters below: NULL may become a source when evidence arrives
   * later - a pool discovered hours afterwards is still proof - and a source is never cleared.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN graduated_confirmed_by TEXT"); } catch {}
  /**
   * The creation transaction, added 2026-09-09. NULL means we did not record one, and that has three innocent
   * causes - the launch predates this column, we found the token late and never saw its creation, or the row was
   * rebuilt from chain history rather than watched. **NULL never means the token has no creation transaction.**
   * The paired backfill is `npm run backfillsig`, which recovers it for older rows from the dev's first-block trade
   * while those rows survive retention; what retention has already taken is recoverable only from an archival node.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN create_sig TEXT"); } catch {}
  /**
   * Where a peak came from. NULL on every row written before 2026-09-10, which means we did not record it - never
   * that the peak was unsourced. Deliberately not backfilled: the source is only knowable at the moment the price
   * arrived, and inferring it afterwards from what trade rows survived retention would be manufacturing provenance.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN peak_source TEXT"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN create_slot INTEGER"); } catch {}
  /**
   * What the token claimed to be at launch: its image, its description, and when we read them.
   *
   * `uri`, `twitter`, `telegram` and `website` were already stored. The image never was - `fetchMeta` did not read the
   * field, so the most recognisable thing about a launch was fetched and thrown away 154,000 times. The description was
   * read and then dropped on the floor for want of a column.
   *
   * This is the only class of fact here that is not recoverable later. On-chain history can be rebuilt from an archival
   * node whenever someone pays for it; off-chain metadata lives behind a URI the creator controls and disappears when
   * they repoint or unpin it. Every hour without this column is an hour of evidence that no amount of money brings back.
   *
   * No backfill, and that is a decision rather than an oversight: we never held these values, so there is nothing to
   * backfill from, and re-fetching the URIs now would record what they resolve to *today* while stamping it as the
   * launch claim. That would be inventing evidence. Historical rows stay NULL, which is true, and the loss they
   * represent is exactly what this column stops from continuing.
   *
   * `meta_at` records when the fetch succeeded, so a NULL image on a row with a `meta_at` means the launch declared
   * none, while a NULL image with no `meta_at` means we never looked. Absence of data must not read as a finding.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN image TEXT"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN description TEXT"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN meta_at INTEGER"); } catch {}
  /**
   * The picture itself, or rather the proof of it. These existed only on the laptop, added by `images.ts` outside
   * `openDb`, which meant no cloud collector had them and no record built in the cloud could ever carry image
   * evidence - the one thing this project collects that cannot be rebuilt from chain at any price. Declared here so
   * every database that `openDb` touches has the same shape.
   *
   * `image_sha256` present means we hold those bytes. `image_error` present means we tried and could not, which is a
   * different statement from "the launch declared no image" (that is `image IS NULL` with a `meta_at`), and both are
   * different from never having looked. Three states, three representations, on purpose.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN image_sha256 TEXT"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN image_bytes INTEGER"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN image_at INTEGER"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN image_error TEXT"); } catch {}
  /**
   * The same three states for the metadata document, and it belongs HERE rather than in the tool that first needed
   * it. `backfillmeta` created this column itself, so it existed on any database that tool had run against and
   * nowhere else. The moment the collector's own sweep started recording a cause, it referenced a column its schema
   * had never been given and every sweep failed with "no such column: meta_error" - recovery stopped dead while
   * ingestion carried on and the process looked entirely healthy.
   *
   * That is the third time this shape has bitten: a writer that provisions its own storage privately, and a second
   * writer that assumes it. Columns the collector reads or writes are the collector's schema, and `openDb` is where
   * a schema is declared.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN meta_error TEXT"); } catch {}
  /**
   * The metadata document itself, not our reading of it.
   *
   * `fetchMeta` extracted five fields and dropped the file. Everything else an operator wrote there - the off-chain
   * name, creator handles, whatever a launch platform stamps in - was fetched and discarded at the one moment it was
   * retrievable, because the URI is the creator's to repoint. This is the same unrecoverable class as the image and
   * costs about a kilobyte a launch.
   *
   * `meta_bytes` is the document's size as served and is set even when `meta_json` is NULL, which is how "too big to
   * store" is told apart from "never fetched". Never truncated: half a JSON document is not a JSON document.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN meta_json TEXT"); } catch {}
  /**
   * The commitment to the document, stored where the document is read rather than computed when the record is built.
   *
   * It existed only in `record.db`, produced by `servicedb` as `sha256(meta_json)` - and `TOKEN_COLUMNS` names it.
   * So every query built from TOKEN_COLUMNS threw `no such column: meta_sha256` against the collector, which is the
   * database the collector queries. That took out `/launch/<mint>` with an HTTP 500 and, with it, the live lookup
   * the web service depends on to answer about a token launched moments ago.
   *
   * The cost of that was the exact failure the endpoint was written to fix, and its own comment describes it as
   * "the worst failure this product has": a launch we watched from its creation transaction, answered with
   * `UNKNOWN - Launch not observed` for the first hours of its life, during the only window when anyone is asking.
   * It was reintroduced silently by adding a column to a shared column list that only one of the two databases had.
   *
   * A column list shared by two schemas is a claim that both schemas satisfy it. Nothing checked that claim.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN meta_sha256 TEXT"); } catch {}
  // Registered on every connection openDb hands out, so the write paths below and the backfill can both use it.
  try {
    db.function("sha256", (v: unknown) => (v == null ? null : createHash("sha256").update(String(v), "utf8").digest("hex")));
  } catch {}
  // Paired backfill: a column added without one leaves every existing row NULL while the value sits in the source,
  // which is this codebase's most repeated bug. Cheap and self-terminating - it touches only rows holding a document.
  try { db.exec("UPDATE tokens SET meta_sha256 = sha256(meta_json) WHERE meta_sha256 IS NULL AND meta_json IS NOT NULL"); } catch {}
  try { db.exec("ALTER TABLE tokens ADD COLUMN meta_bytes INTEGER"); } catch {}
  /**
   * Backfill from evidence already on the row. This is not a guess about history: every one of these rows has a pool
   * address we observed, and that observation is what confirmation means. Rows without one stay NULL - unconfirmed,
   * which is the honest state and the one the flag logic must now require against.
   */
  try { db.exec("UPDATE tokens SET graduated_confirmed_by = 'pool' WHERE graduated = 1 AND pool IS NOT NULL AND graduated_confirmed_by IS NULL"); } catch {}
  return db;
}

/**
 * Mints that are not launches and must never become rows.
 *
 * Wrapped SOL reached the tokens table as a launch - symbol "?", graduated, with a pool address attached - and the
 * service then served it as a record, under a DANGER flag about liquidity. A detector that mistakes the quote asset
 * for the asset being traded is an easy mistake to make repeatedly, so the exclusion lives here, at the only door
 * into the table, rather than in whichever detector made it this time.
 */
const NOT_LAUNCHES = new Set([
  "So11111111111111111111111111111111111111112",  // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export function upsertToken(db: DatabaseSync, t: TokenState): void {
  if (NOT_LAUNCHES.has(t.mint)) return;
  db.prepare(`
    INSERT INTO tokens (mint, name, symbol, uri, creator, created_at, late_discovery, launch_price, last_price, peak_price, peak_at, peak_source,
      create_sig, create_slot,
      dev_pct, dev_sold, dev_sold_at, buys, sells, buy_vol_sol, sell_vol_sol, unique_buyers, unique_sellers, bundled_buyers,
      snap30_buyers, snap30_buys, snap30_sells, snap30_vol, graduated, graduated_at, p_1m, p_5m, p_15m, p_60m,
      twitter, telegram, website, image, description, meta_at, kol_signals, pool, amm_trusted, vault_sol, vault_at, finalized, updated_at, venue, graduated_confirmed_by, meta_json, meta_bytes, curve_account, quote_mint, curve_buyers_live)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mint) DO UPDATE SET
      name=excluded.name, symbol=excluded.symbol, launch_price=excluded.launch_price, last_price=excluded.last_price,
      -- The three move together or not at all: a peak is a price, a moment, and where it came from. Splitting them
      -- is how vault_sol ended up published 1,198 times with no reading time.
      peak_price=excluded.peak_price, peak_at=excluded.peak_at, peak_source=excluded.peak_source,
      dev_sold=excluded.dev_sold, dev_sold_at=excluded.dev_sold_at,
      -- Provenance counters must never go backwards. A token restored by a detector (buyout, movement, late graduation)
      -- starts with an empty buyer set, and an unconditional assignment overwrote the recorded launch history with
      -- zeros: BILL lost 3,046 curve buyers this way on 2026-09-06 and dropped off the clean list. These are monotonic
      -- observations, so keep the larger; the 30 s snapshot is a launch-time fact, so keep the first one recorded.
      buys=MAX(COALESCE(excluded.buys,0), COALESCE(tokens.buys,0)),
      sells=MAX(COALESCE(excluded.sells,0), COALESCE(tokens.sells,0)),
      buy_vol_sol=MAX(COALESCE(excluded.buy_vol_sol,0), COALESCE(tokens.buy_vol_sol,0)),
      sell_vol_sol=MAX(COALESCE(excluded.sell_vol_sol,0), COALESCE(tokens.sell_vol_sol,0)),
      unique_buyers=MAX(COALESCE(excluded.unique_buyers,0), COALESCE(tokens.unique_buyers,0)),
      -- Monotonic like its neighbours, and for the same reason: a token restored by a detector starts with an empty
      -- set and would otherwise overwrite the launch history with a zero. NULL on both sides stays NULL, because a
      -- launch nobody counted live is unknown rather than zero - MAX(NULL, NULL) is NULL and that is deliberate.
      curve_buyers_live=CASE WHEN excluded.curve_buyers_live IS NULL THEN tokens.curve_buyers_live
                             WHEN tokens.curve_buyers_live IS NULL THEN excluded.curve_buyers_live
                             ELSE MAX(excluded.curve_buyers_live, tokens.curve_buyers_live) END,
      unique_sellers=MAX(COALESCE(excluded.unique_sellers,0), COALESCE(tokens.unique_sellers,0)),
      bundled_buyers=MAX(COALESCE(excluded.bundled_buyers,0), COALESCE(tokens.bundled_buyers,0)),
      snap30_buyers=COALESCE(tokens.snap30_buyers, excluded.snap30_buyers),
      snap30_buys=COALESCE(tokens.snap30_buys, excluded.snap30_buys),
      snap30_sells=COALESCE(tokens.snap30_sells, excluded.snap30_sells),
      snap30_vol=COALESCE(tokens.snap30_vol, excluded.snap30_vol),
      -- A launch fact: written once, never revised. A later writer (a detector restoring a token, a rebuild) has no
      -- creation transaction to offer and must not blank the one we recorded live.
      create_sig=COALESCE(tokens.create_sig, excluded.create_sig),
      create_slot=COALESCE(tokens.create_slot, excluded.create_slot),
      graduated=excluded.graduated, graduated_at=excluded.graduated_at,
      -- Monotonic: confirmation can arrive late (a pool found hours afterwards is still proof) but never un-arrives.
      -- A writer that has not confirmed anything must not erase a confirmation another path already earned.
      graduated_confirmed_by=COALESCE(excluded.graduated_confirmed_by, tokens.graduated_confirmed_by),
      p_1m=excluded.p_1m, p_5m=excluded.p_5m, p_15m=excluded.p_15m, p_60m=excluded.p_60m,
      twitter=COALESCE(excluded.twitter, tokens.twitter), telegram=COALESCE(excluded.telegram, tokens.telegram), website=COALESCE(excluded.website, tokens.website),
      -- The launch claim is written once and never revised: a later fetch reads today's URI, not the launch's.
      image=COALESCE(tokens.image, excluded.image), description=COALESCE(tokens.description, excluded.description),
      meta_at=COALESCE(tokens.meta_at, excluded.meta_at),
      meta_json=COALESCE(tokens.meta_json, excluded.meta_json), meta_bytes=COALESCE(tokens.meta_bytes, excluded.meta_bytes),
      -- Kept beside the document it commits to, so the two can never disagree about which document we read.
      meta_sha256=COALESCE(tokens.meta_sha256, CASE WHEN excluded.meta_json IS NOT NULL THEN sha256(excluded.meta_json) END),
      kol_signals=excluded.kol_signals, pool=COALESCE(excluded.pool, tokens.pool), amm_trusted=COALESCE(excluded.amm_trusted, tokens.amm_trusted),
      -- A reading is both numbers or it is not a reading, and this now enforces that instead of asserting it.
      --
      -- The old pair wrote vault_sol from a COALESCE and vault_at from a CASE keyed only on whether a balance
      -- arrived. A writer supplying a balance with no timestamp therefore got the balance stored AND the timestamp
      -- nulled: a reading nobody can date, in a record whose own rule is that a balance is never quoted without the
      -- moment it was read. 1,255 rows in the collector and 1,198 in the published archive are in that state.
      --
      -- The sentence above this was already here and was already right. It was a comment where it needed to be a
      -- constraint - the same failure this codebase keeps producing, in the line describing it.
      --
      -- Now a half-reading is ignored entirely rather than half-applied, so the stored pair can only ever be one the
      -- collector actually observed together.
      vault_sol=CASE WHEN excluded.vault_sol IS NOT NULL AND excluded.vault_at IS NOT NULL
                     THEN excluded.vault_sol ELSE tokens.vault_sol END,
      vault_at=CASE WHEN excluded.vault_sol IS NOT NULL AND excluded.vault_at IS NOT NULL
                    THEN excluded.vault_at ELSE tokens.vault_at END,
      finalized=excluded.finalized, updated_at=excluded.updated_at
  `).run(
    t.mint, t.name, t.symbol, t.uri, t.creator, t.createdAt, t.lateDiscovery ? 1 : 0, t.launchPrice, t.lastPrice, t.peakPrice, t.peakAt, t.peakSource,
    t.createSig || null, t.createdSlot || null,
    t.devPct, t.devSold ? 1 : 0, t.devSoldAt, t.buys, t.sells, t.buyVolSol, t.sellVolSol, t.buyers.size, t.sellers.size, t.bundledBuyers,
    t.snap30?.buyers ?? null, t.snap30?.buys ?? null, t.snap30?.sells ?? null, t.snap30?.volSol ?? null,
    t.graduated ? 1 : 0, t.graduatedAt,
    t.checkpoints[60] ?? null, t.checkpoints[300] ?? null, t.checkpoints[900] ?? null, t.checkpoints[3600] ?? null,
    t.meta?.twitter ?? null, t.meta?.telegram ?? null, t.meta?.website ?? null,
    t.meta?.image ?? null, t.meta?.description ?? null, t.meta ? Date.now() : null,
    t.kolSignals, t.pool, t.ammTrusted === null ? null : t.ammTrusted ? 1 : 0, t.vaultSol, t.vaultAt, t.finalized ? 1 : 0, Date.now(),
    // Not in the ON CONFLICT clause above: where a token launched is a launch fact and cannot change, the same reason
    // `created_at` is never updated. Defaulted here as well as in the schema so a second collector sets one field.
    /**
     * A backstop, and it must stay one.
     *
     * Live launches arrive stamped by the decoder that produced them (tracker.onCreate, from CreateEvent.venue), so
     * this fallback fires only for rows built by other paths: a chain rebuild, a detector restoration, a test. Those
     * are pump.fun today by construction. The day they are not, this line publishes another venue's launch as a
     * pump.fun one and nothing says otherwise, which is why venues.ts clause 4 says to set it at decode and never
     * rely on the default again. It is left here rather than made fatal because dropping a launch is worse than
     * mislabelling one, and this is the ingesting process.
     */
    t.venue ?? "pumpfun",
    t.graduatedConfirmedBy ?? null,
    // Appended last, matching the column list: this INSERT names its columns but binds positionally.
    t.meta?.raw ?? null, t.meta?.bytes ?? null,
    // Launch facts, written once. Neither is in the ON CONFLICT clause: where a launch's curve lives and what it is
    // priced in cannot change, the same reason `created_at` and `venue` are never updated.
    t.curveAccount ?? null, t.quoteMint ?? null,
    /**
     * Only where the number is a count of something, which is narrower than "the set has a size".
     *
     * Two ways it is not. A token a detector restored hours later has a set holding whatever arrived after the
     * restore, which is not the launch's buyer count. And on a venue whose trade events name no wallet the set can
     * never fill at all, so its size is 0 for every launch there - the invented zero this whole column exists to
     * stop, reproduced one layer down. Caught by running the collector and reading the column, not by review.
     *
     * NULL is the honest value in both cases: we did not count it. `venues.ts` clause 10.
     */
    t.lateDiscovery || t.tradesNameWallets === false ? null : t.curveBuyers.size,
  );
}

export interface TradeRow {
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  price: number;
  ts: number;
  slot: number;
  sig: string;
  ageMs: number;
  buyerRank: number | null;
  isDev: boolean;
  /**
   * Which market the trade happened on, and it is NOT the launch venue.
   *
   * This column was called `venue` while `tokens.venue` means the launchpad, so one word named two different things
   * in one schema - in a project whose stated rule is one word, one meaning. Harmless while pump.fun was the only
   * launchpad and a silent trap the day there are two: every query mentioning an unqualified `venue` across a join
   * would mean whichever the planner resolved it to. Renamed while the answer was still unambiguous.
   */
  market?: "curve" | "amm";
}

/** Buffers trade rows and writes them in one transaction per second. */
export class TradeWriter {
  private queue: TradeRow[] = [];
  private stmt;
  private timer: NodeJS.Timeout;
  written = 0;
  constructor(private db: DatabaseSync) {
    this.stmt = db.prepare(
      `INSERT INTO trades (mint, wallet, side, sol, tokens, price, ts, slot, sig, age_ms, buyer_rank, is_dev, market) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    this.timer = setInterval(() => this.flush(), 1000);
  }
  push(r: TradeRow): void {
    this.queue.push(r);
  }
  flush(): void {
    if (!this.queue.length) return;
    const rows = this.queue;
    this.queue = [];
    this.db.exec("BEGIN");
    try {
      for (const r of rows) this.stmt.run(r.mint, r.wallet, r.side, r.sol, r.tokens, r.price, r.ts, r.slot, r.sig, r.ageMs, r.buyerRank, r.isDev ? 1 : 0, r.market ?? "curve");
      this.db.exec("COMMIT");
      this.written += rows.length;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close(): void {
    clearInterval(this.timer);
    this.flush();
  }
}

/**
 * When a token's watch ends: aggregate every wallet's activity on it into wallet_token_stats,
 * then drop the bulk of the raw trades for tokens nobody will analyse further (dud, no signal),
 * keeping the first 100 so bundle/sniper patterns remain visible.
 * first_buy_* describe the wallet's first BONDING-CURVE buy only; a wallet that only traded on the
 * PumpSwap AMM gets NULLs there (it never bought "early" in any sense an outsider could copy).
 */
export function finalizeTokenTrades(db: DatabaseSync, t: TokenState, opts: { keepAll: boolean; keepCurve?: number; keepAmm?: number }): void {
  db.prepare("DELETE FROM wallet_token_stats WHERE mint = ?").run(t.mint);
  db.prepare(
    `INSERT INTO wallet_token_stats (mint, wallet, first_buy_at, first_buy_age_s, first_buy_rank, first_buy_slot_delta, buys, sells, sol_in, sol_out,
       tokens_net, realized_pnl_sol, unrealized_sol, last_trade_at, hold_s, is_dev, token_graduated, token_peak_x, token_created_at)
     SELECT mint, wallet,
       MIN(CASE WHEN side='buy' AND market='curve' THEN ts END),
       MIN(CASE WHEN side='buy' AND market='curve' THEN age_ms END) / 1000.0,
       MIN(CASE WHEN side='buy' AND market='curve' THEN buyer_rank END),
       CASE WHEN ? > 0 THEN MIN(CASE WHEN side='buy' AND market='curve' THEN slot END) - ? END,
       SUM(side='buy'), SUM(side='sell'),
       SUM(CASE WHEN side='buy' THEN sol ELSE 0 END), SUM(CASE WHEN side='sell' THEN sol ELSE 0 END),
       SUM(CASE WHEN side='buy' THEN tokens ELSE -tokens END),
       SUM(CASE WHEN side='sell' THEN sol ELSE -sol END),
       MAX(0, SUM(CASE WHEN side='buy' THEN tokens ELSE -tokens END)) * ?,
       MAX(ts),
       (MAX(CASE WHEN side='sell' THEN ts END) - MIN(CASE WHEN side='buy' THEN ts END)) / 1000.0,
       MAX(is_dev), ?, ?, ?
     FROM trades WHERE mint = ? GROUP BY wallet`,
  ).run(t.createdSlot, t.createdSlot, t.lastPrice, t.graduated ? 1 : 0, t.launchPrice > 0 ? t.peakPrice / t.launchPrice : null, t.createdAt, t.mint);
  if (!opts.keepAll) {
    const keepCurve = opts.keepCurve ?? 100, keepAmm = opts.keepAmm ?? 0;
    db.prepare(`DELETE FROM trades WHERE mint = ? AND market = 'curve' AND id NOT IN (SELECT id FROM trades WHERE mint = ? AND market = 'curve' ORDER BY ts, id LIMIT ?)`).run(t.mint, t.mint, keepCurve);
    db.prepare(`DELETE FROM trades WHERE mint = ? AND market = 'amm' AND id NOT IN (SELECT id FROM trades WHERE mint = ? AND market = 'amm' ORDER BY ts, id LIMIT ?)`).run(t.mint, t.mint, keepAmm);
  }
}

/**
 * Tokens that were being tracked when the process stopped never got finalized. Rebuild what can be
 * rebuilt from the stored trades (last/peak price, checkpoints, graduation by price), mark them
 * finalized and aggregate wallet stats, so restarts do not leave holes in the analysis.
 */
export function recoverOrphans(db: DatabaseSync, olderThanMs = 10 * 60_000): number {
  const GRAD_PRICE = 115 / 279_900_000; // curve price at graduation (vSol 115 / remaining virtual tokens)
  const rows = db
    .prepare(`SELECT mint, created_at, launch_price, peak_price, peak_at, peak_source, last_price, graduated, kol_signals, creator FROM tokens WHERE finalized = 0 AND updated_at < ?`)
    .all(Date.now() - olderThanMs) as any[];
  let n = 0;
  for (const r of rows) {
    const tr = db.prepare("SELECT price, ts, slot, is_dev, age_ms FROM trades WHERE mint = ? ORDER BY ts, id").all(r.mint) as any[];
    let last = r.last_price ?? r.launch_price, peak = r.peak_price ?? r.launch_price, lastAt = r.created_at;
    /**
     * The recorded peak time, not the creation time.
     *
     * This was `peakAt = r.created_at`, and `peak_at` was not even selected - so a recovery that found no higher
     * price still overwrote a real peak timestamp with the moment the token was created, silently, on every restart.
     * The peak survived and the answer to "when" was replaced by a different question's answer.
     */
    let peakAt = r.peak_at ?? r.created_at;
    /**
     * Whether the recomputation actually moved the peak. If it did not, the peak on the row is the one that was
     * observed live and its `peak_source` still describes it; overwriting that would downgrade a witnessed price to
     * a recomputed one for no reason.
     */
    let peakMoved = false;
    const cp: Record<number, number> = {};
    for (const x of tr) {
      if (x.price > peak) { peak = x.price; peakAt = x.ts; peakMoved = true; }
      last = x.price; lastAt = x.ts;
      for (const s of [60, 300, 900, 3600]) if (x.age_ms <= s * 1000) cp[s] = x.price; // last price seen before the checkpoint
    }
    for (const s of [60, 300, 900, 3600]) if (cp[s] === undefined) cp[s] = tr.length ? (tr.find((x) => x.age_ms > s * 1000) ? (cp[s] ?? r.launch_price) : last) : r.launch_price;
    const graduated = r.graduated === 1 || peak >= GRAD_PRICE * 0.999;
    /**
     * `peak_source` travels with the pair it describes.
     *
     * This statement wrote `peak_price` and `peak_at` and left `peak_source` alone, which split the triple the
     * ON CONFLICT clause in `upsertToken` is careful to keep together - a row whose source said `curve` kept a
     * source describing a peak that no longer existed. The ON CONFLICT pairing was right; this is a different
     * statement and inherited none of it.
     *
     * `recomputed` rather than the trade's own venue, and that is the honest answer rather than the convenient one.
     * `curve` and `amm` mean we decoded that trade as it happened. Reconstructing a peak afterwards from whichever
     * rows survived a four-day retention is a different act even when the underlying trade is the same, and the
     * entire purpose of the column is that a reader can tell a witnessed price from an asserted one.
     */
    db.prepare(
      `UPDATE tokens SET last_price=?, peak_price=?, peak_at=?, peak_source=?, last_seen_at=?, graduated=?, p_1m=COALESCE(p_1m,?), p_5m=COALESCE(p_5m,?), p_15m=COALESCE(p_15m,?), p_60m=COALESCE(p_60m,?), finalized=1, updated_at=? WHERE mint=?`,
    ).run(last, peak, peakAt, peakMoved ? "recomputed" : (r.peak_source ?? null), lastAt, graduated ? 1 : 0, cp[60], cp[300], cp[900], cp[3600], Date.now(), r.mint);
    if (tr.length) {
      const createdSlot = tr.find((x) => x.is_dev && x.age_ms === 0)?.slot ?? tr[0].slot ?? 0;
      const fake = { mint: r.mint, createdSlot, lastPrice: last, graduated, launchPrice: r.launch_price, peakPrice: peak, createdAt: r.created_at } as unknown as TokenState;
      finalizeTokenTrades(db, fake, { keepAll: graduated || (r.launch_price > 0 && peak >= 2 * r.launch_price) || (r.kol_signals ?? 0) > 0 });
    }
    n++;
  }
  return n;
}
