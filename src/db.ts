import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TokenState } from "./tracker.ts";

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS tokens (
      mint TEXT PRIMARY KEY,
      name TEXT, symbol TEXT, uri TEXT, creator TEXT,
      created_at INTEGER, late_discovery INTEGER DEFAULT 0,
      launch_price REAL, last_price REAL, peak_price REAL, peak_at INTEGER,
      dev_pct REAL, dev_sold INTEGER, dev_sold_at INTEGER,
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
      graduated_confirmed_by TEXT
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
      age_ms INTEGER, buyer_rank INTEGER, is_dev INTEGER DEFAULT 0, venue TEXT DEFAULT 'curve'
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
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER, stopped_at INTEGER, note TEXT
    );
    -- pool -> mint, learned from PumpSwap CreatePoolEvent. Every graduation emits one; recording them all (not only
    -- for tokens tracked at that moment) is what lets a token restored hours later be priced from its first AMM print.
    -- Operator farms. Created here rather than only in clusters.ts so a collector that has never run the tracer still
    -- has the tables to read, and so a seed export carries the map — it is the least reproducible thing we hold.
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
  `);
  // `updated_at` is written on every token row update, but vault_sol is only replaced when a pool read actually
  // succeeded (COALESCE below). Reporting updated_at as the measurement time therefore advanced the timestamp while
  // the number stayed put — the site claimed a two-minute-old reading for a figure hours out of date. vault_at is
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
   * backfills them correctly — and that is a *recorded* fact, not an inference: the collector has only ever subscribed
   * to the pump.fun program, so "we watched pump.fun" is a statement about what we did, not a guess about the data.
   *
   * Added while the archive was still small enough for that to be true of all of it. The record is append-only and
   * grows ~24,000 launches a day; a venue stamp added later would have to be asserted over millions of rows nobody
   * recorded it for, which is precisely the move this project refuses to make about anyone else.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN venue TEXT NOT NULL DEFAULT 'pumpfun'"); } catch {}
  /**
   * How we know a curve completed: 'pool', 'curve_complete', or NULL.
   *
   * `graduated` is set by inference — decoded curve trade events reaching the graduation threshold in vSOL — and was
   * never checked against anything. Measured on 2026-09-07 over the days when pool discovery was working, that
   * inference is confirmed by an actual pool 87% of the time for curves that took 10-60 minutes to fill and only 38%
   * of the time for curves flagged as completing within 60 seconds. Detection quality cannot explain a gradient that
   * tracks fill speed, so the threshold is firing spuriously on fast curves — and `instant-graduation` is the largest
   * DANGER category on the site. Of 628 recent fast-flagged launches with no pool, exactly one had a creator holding
   * 50% or more: we were accusing launches whose creators kept nothing.
   *
   * Nullable source rather than a boolean, because the relationship is asymmetric and the asymmetry is the point. A
   * PumpSwap pool cannot exist unless the curve completed, so a pool IS confirmation; the absence of one is NOT
   * disconfirmation, only the absence of evidence. A boolean would collapse "we never confirmed it" into a 0 that
   * reads as "we checked and it did not graduate", which is the exact substitution this project exists to refuse.
   *
   * Confirmation is monotonic, like the provenance counters below: NULL may become a source when evidence arrives
   * later — a pool discovered hours afterwards is still proof — and a source is never cleared.
   */
  try { db.exec("ALTER TABLE tokens ADD COLUMN graduated_confirmed_by TEXT"); } catch {}
  /**
   * What the token claimed to be at launch: its image, its description, and when we read them.
   *
   * `uri`, `twitter`, `telegram` and `website` were already stored. The image never was — `fetchMeta` did not read the
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
   * Backfill from evidence already on the row. This is not a guess about history: every one of these rows has a pool
   * address we observed, and that observation is what confirmation means. Rows without one stay NULL — unconfirmed,
   * which is the honest state and the one the flag logic must now require against.
   */
  try { db.exec("UPDATE tokens SET graduated_confirmed_by = 'pool' WHERE graduated = 1 AND pool IS NOT NULL AND graduated_confirmed_by IS NULL"); } catch {}
  return db;
}

/**
 * Mints that are not launches and must never become rows.
 *
 * Wrapped SOL reached the tokens table as a launch — symbol "?", graduated, with a pool address attached — and the
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
    INSERT INTO tokens (mint, name, symbol, uri, creator, created_at, late_discovery, launch_price, last_price, peak_price, peak_at,
      dev_pct, dev_sold, dev_sold_at, buys, sells, buy_vol_sol, sell_vol_sol, unique_buyers, unique_sellers, bundled_buyers,
      snap30_buyers, snap30_buys, snap30_sells, snap30_vol, graduated, graduated_at, p_1m, p_5m, p_15m, p_60m,
      twitter, telegram, website, image, description, meta_at, kol_signals, pool, amm_trusted, vault_sol, vault_at, finalized, updated_at, venue, graduated_confirmed_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(mint) DO UPDATE SET
      name=excluded.name, symbol=excluded.symbol, launch_price=excluded.launch_price, last_price=excluded.last_price,
      peak_price=excluded.peak_price, peak_at=excluded.peak_at, dev_sold=excluded.dev_sold, dev_sold_at=excluded.dev_sold_at,
      -- Provenance counters must never go backwards. A token restored by a detector (buyout, movement, late graduation)
      -- starts with an empty buyer set, and an unconditional assignment overwrote the recorded launch history with
      -- zeros: BILL lost 3,046 curve buyers this way on 2026-09-06 and dropped off the clean list. These are monotonic
      -- observations, so keep the larger; the 30 s snapshot is a launch-time fact, so keep the first one recorded.
      buys=MAX(COALESCE(excluded.buys,0), COALESCE(tokens.buys,0)),
      sells=MAX(COALESCE(excluded.sells,0), COALESCE(tokens.sells,0)),
      buy_vol_sol=MAX(COALESCE(excluded.buy_vol_sol,0), COALESCE(tokens.buy_vol_sol,0)),
      sell_vol_sol=MAX(COALESCE(excluded.sell_vol_sol,0), COALESCE(tokens.sell_vol_sol,0)),
      unique_buyers=MAX(COALESCE(excluded.unique_buyers,0), COALESCE(tokens.unique_buyers,0)),
      unique_sellers=MAX(COALESCE(excluded.unique_sellers,0), COALESCE(tokens.unique_sellers,0)),
      bundled_buyers=MAX(COALESCE(excluded.bundled_buyers,0), COALESCE(tokens.bundled_buyers,0)),
      snap30_buyers=COALESCE(tokens.snap30_buyers, excluded.snap30_buyers),
      snap30_buys=COALESCE(tokens.snap30_buys, excluded.snap30_buys),
      snap30_sells=COALESCE(tokens.snap30_sells, excluded.snap30_sells),
      snap30_vol=COALESCE(tokens.snap30_vol, excluded.snap30_vol),
      graduated=excluded.graduated, graduated_at=excluded.graduated_at,
      -- Monotonic: confirmation can arrive late (a pool found hours afterwards is still proof) but never un-arrives.
      -- A writer that has not confirmed anything must not erase a confirmation another path already earned.
      graduated_confirmed_by=COALESCE(excluded.graduated_confirmed_by, tokens.graduated_confirmed_by),
      p_1m=excluded.p_1m, p_5m=excluded.p_5m, p_15m=excluded.p_15m, p_60m=excluded.p_60m,
      twitter=COALESCE(excluded.twitter, tokens.twitter), telegram=COALESCE(excluded.telegram, tokens.telegram), website=COALESCE(excluded.website, tokens.website),
      -- The launch claim is written once and never revised: a later fetch reads today's URI, not the launch's.
      image=COALESCE(tokens.image, excluded.image), description=COALESCE(tokens.description, excluded.description),
      meta_at=COALESCE(tokens.meta_at, excluded.meta_at),
      kol_signals=excluded.kol_signals, pool=COALESCE(excluded.pool, tokens.pool), amm_trusted=COALESCE(excluded.amm_trusted, tokens.amm_trusted),
      -- vault_sol and vault_at move together or not at all: a kept balance keeps the time it was read.
      vault_sol=COALESCE(excluded.vault_sol, tokens.vault_sol),
      vault_at=CASE WHEN excluded.vault_sol IS NOT NULL THEN excluded.vault_at ELSE tokens.vault_at END,
      finalized=excluded.finalized, updated_at=excluded.updated_at
  `).run(
    t.mint, t.name, t.symbol, t.uri, t.creator, t.createdAt, t.lateDiscovery ? 1 : 0, t.launchPrice, t.lastPrice, t.peakPrice, t.peakAt,
    t.devPct, t.devSold ? 1 : 0, t.devSoldAt, t.buys, t.sells, t.buyVolSol, t.sellVolSol, t.buyers.size, t.sellers.size, t.bundledBuyers,
    t.snap30?.buyers ?? null, t.snap30?.buys ?? null, t.snap30?.sells ?? null, t.snap30?.volSol ?? null,
    t.graduated ? 1 : 0, t.graduatedAt,
    t.checkpoints[60] ?? null, t.checkpoints[300] ?? null, t.checkpoints[900] ?? null, t.checkpoints[3600] ?? null,
    t.meta?.twitter ?? null, t.meta?.telegram ?? null, t.meta?.website ?? null,
    t.meta?.image ?? null, t.meta?.description ?? null, t.meta ? Date.now() : null,
    t.kolSignals, t.pool, t.ammTrusted === null ? null : t.ammTrusted ? 1 : 0, t.vaultSol, t.vaultAt, t.finalized ? 1 : 0, Date.now(),
    // Not in the ON CONFLICT clause above: where a token launched is a launch fact and cannot change, the same reason
    // `created_at` is never updated. Defaulted here as well as in the schema so a second collector sets one field.
    t.venue ?? "pumpfun",
    t.graduatedConfirmedBy ?? null,
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
  venue?: "curve" | "amm";
}

/** Buffers trade rows and writes them in one transaction per second. */
export class TradeWriter {
  private queue: TradeRow[] = [];
  private stmt;
  private timer: NodeJS.Timeout;
  written = 0;
  constructor(private db: DatabaseSync) {
    this.stmt = db.prepare(
      `INSERT INTO trades (mint, wallet, side, sol, tokens, price, ts, slot, sig, age_ms, buyer_rank, is_dev, venue) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      for (const r of rows) this.stmt.run(r.mint, r.wallet, r.side, r.sol, r.tokens, r.price, r.ts, r.slot, r.sig, r.ageMs, r.buyerRank, r.isDev ? 1 : 0, r.venue ?? "curve");
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
       MIN(CASE WHEN side='buy' AND venue='curve' THEN ts END),
       MIN(CASE WHEN side='buy' AND venue='curve' THEN age_ms END) / 1000.0,
       MIN(CASE WHEN side='buy' AND venue='curve' THEN buyer_rank END),
       CASE WHEN ? > 0 THEN MIN(CASE WHEN side='buy' AND venue='curve' THEN slot END) - ? END,
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
    db.prepare(`DELETE FROM trades WHERE mint = ? AND venue = 'curve' AND id NOT IN (SELECT id FROM trades WHERE mint = ? AND venue = 'curve' ORDER BY ts, id LIMIT ?)`).run(t.mint, t.mint, keepCurve);
    db.prepare(`DELETE FROM trades WHERE mint = ? AND venue = 'amm' AND id NOT IN (SELECT id FROM trades WHERE mint = ? AND venue = 'amm' ORDER BY ts, id LIMIT ?)`).run(t.mint, t.mint, keepAmm);
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
    .prepare(`SELECT mint, created_at, launch_price, peak_price, last_price, graduated, kol_signals, creator FROM tokens WHERE finalized = 0 AND updated_at < ?`)
    .all(Date.now() - olderThanMs) as any[];
  let n = 0;
  for (const r of rows) {
    const tr = db.prepare("SELECT price, ts, slot, is_dev, age_ms FROM trades WHERE mint = ? ORDER BY ts, id").all(r.mint) as any[];
    let last = r.last_price ?? r.launch_price, peak = r.peak_price ?? r.launch_price, peakAt = r.created_at, lastAt = r.created_at;
    const cp: Record<number, number> = {};
    for (const x of tr) {
      if (x.price > peak) { peak = x.price; peakAt = x.ts; }
      last = x.price; lastAt = x.ts;
      for (const s of [60, 300, 900, 3600]) if (x.age_ms <= s * 1000) cp[s] = x.price; // last price seen before the checkpoint
    }
    for (const s of [60, 300, 900, 3600]) if (cp[s] === undefined) cp[s] = tr.length ? (tr.find((x) => x.age_ms > s * 1000) ? (cp[s] ?? r.launch_price) : last) : r.launch_price;
    const graduated = r.graduated === 1 || peak >= GRAD_PRICE * 0.999;
    db.prepare(
      `UPDATE tokens SET last_price=?, peak_price=?, peak_at=?, last_seen_at=?, graduated=?, p_1m=COALESCE(p_1m,?), p_5m=COALESCE(p_5m,?), p_15m=COALESCE(p_15m,?), p_60m=COALESCE(p_60m,?), finalized=1, updated_at=? WHERE mint=?`,
    ).run(last, peak, peakAt, lastAt, graduated ? 1 : 0, cp[60], cp[300], cp[900], cp[3600], Date.now(), r.mint);
    if (tr.length) {
      const createdSlot = tr.find((x) => x.is_dev && x.age_ms === 0)?.slot ?? tr[0].slot ?? 0;
      const fake = { mint: r.mint, createdSlot, lastPrice: last, graduated, launchPrice: r.launch_price, peakPrice: peak, createdAt: r.created_at } as unknown as TokenState;
      finalizeTokenTrades(db, fake, { keepAll: graduated || (r.launch_price > 0 && peak >= 2 * r.launch_price) || (r.kol_signals ?? 0) > 0 });
    }
    n++;
  }
  return n;
}
