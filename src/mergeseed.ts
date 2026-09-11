/**
 * Merge a seed database into the live one, once, on boot.
 *
 * `npm run seed` has always written a file that nothing read: there was no importer, and `.railwayignore` excluded
 * the file from the deploy, so the documented way to give a fresh collector the history it lacks succeeded and
 * achieved nothing. This is the missing half. The cloud collector holds 36,132 launches and zero operator wallets
 * against 166,386 and 7,512 here, so without it the collector can never produce a record worth publishing.
 *
 * Direction is one-way and non-negotiable: seed into live, never the reverse. The word DELETE does not appear in
 * this file, because an unqualified one in `seed.ts` fell through `main` into the ATTACHed live database and
 * destroyed the 6,289-row operator map on 2026-09-06. The seed is attached read-only, every statement is
 * `main.`-qualified, and the whole merge is one transaction so a failure rolls back rather than half-merging.
 *
 * Every conflict rule below is `upsertToken`'s, not a second set invented here. Where the two databases overlap
 * (this laptop from 09-02, the collector from 09-06 21:44) each row is a merge decision, and inventing new semantics
 * for the merge is how the two writers start disagreeing about the same token.
 */
import { createHash } from "node:crypto";
import { statSync, readFileSync, chmodSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type MergeResult = {
  skipped: boolean;
  reason?: string;
  before: Record<string, number>;
  after: Record<string, number>;
  columns?: number;
  backup?: string;
};

/** Tables the seed carries, in dependency-free order. `tokens` first so the assertions below have something to check. */
const TABLES = ["tokens", "operator_wallets", "operator_funders", "operator_policy", "pool_map", "runs", "signals",
  "trades", "hist_trades"] as const;

/**
 * Columns of `table` in `schema`. The schema goes in the SECOND ARGUMENT, not as a prefix.
 *
 * `seed.pragma_table_info('tokens')` parses, runs, and silently returns MAIN's columns - the prefix on a
 * table-valued pragma function is ignored rather than rejected. Measured 2026-09-08: 54 for both schemas where the
 * seed actually had 50. So the subset check below was comparing main against main and could never fail, which made
 * it exactly the check that cannot fail during the failure it exists to catch - the shape this codebase keeps
 * producing, this time inside the guard written to stop it.
 *
 * It surfaced only because a test target had columns the seed lacked. On the real collector both sides are built by
 * `openDb` and match, so the bug would have sat here undetected until the day the schemas diverged, which is the one
 * day the check was for.
 */
const cols = (db: DatabaseSync, schema: string, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as any[]).map((r) => r.name);

const count = (db: DatabaseSync, schema: string, table: string): number => {
  try { return (db.prepare(`SELECT COUNT(*) c FROM ${schema}.${table}`).get() as any).c as number; } catch { return 0; }
};

/**
 * Target columns are referred to unqualified (`tokens.x`, not `main.tokens.x`) because SQLite does not accept a
 * schema-qualified name inside ON CONFLICT DO UPDATE - it fails with "no such column". The INSERT target above is
 * `main.`-qualified, which is where the ambiguity that matters actually lives. `db.ts`'s own upsert reads the same way.
 *
 * The conflict policy, written out per column rather than generated, because this is where every merge decision
 * lives and each one has to be readable on its own line. The insert column list is derived from the intersection of
 * the two schemas and named explicitly in the SQL - never positional. `seed.ts` copies with `SELECT *`, and a
 * positional copy is precisely what punishes `db.ts`'s hand-maintained column order the day it slips: on 2026-09-07
 * an ALTER appending `slot` would have had a positional INSERT writing slot numbers into `venue`, and a bare
 * `ADD COLUMN venue` left 143,102 rows NULL behind an incremental watermark. Two of the same class in one day.
 */
/**
 * Conflict policy as a map from column to expression, emitted only for columns both databases actually have.
 *
 * It was a single hardcoded SQL string, written from this laptop's `pragma_table_info` - which has 53 columns where
 * `openDb` creates 50. `image_sha256`, `image_bytes` and `image_at` exist on the laptop because something outside
 * `openDb` added them, so the clause referenced columns that are absent from both the seed and any fresh collector,
 * and the merge failed on its first statement. Deriving the clause from the shared set makes that impossible.
 *
 * NEVER_UPDATE is the other half and the reason this is a map rather than a filter: a column added to `db.ts`
 * tomorrow must not silently acquire no policy and quietly stop merging. Every shared column has to appear in one
 * list or the other, and the merge refuses to run if one appears in neither.
 */
const NEVER_UPDATE = new Set([
  // Launch facts. Once recorded they are never revised, which is the whole claim the site makes.
  "mint", "created_at", "launch_price", "dev_pct", "snap30_buyers", "snap30_buys", "snap30_sells", "snap30_vol",
]);

const TOKEN_POLICY: Record<string, string> = {
  name: `COALESCE(tokens.name, excluded.name)`,
  symbol: `COALESCE(tokens.symbol, excluded.symbol)`,
  uri: `COALESCE(tokens.uri, excluded.uri)`,
  // The laptop watched these live; the collector would have found them late. Least-late wins.
  creator: `COALESCE(tokens.creator, excluded.creator)`,
  // Monotonic observations. BILL lost 3,046 curve buyers to an unconditional assignment on 2026-09-06.
  late_discovery: `MIN(COALESCE(tokens.late_discovery,1), COALESCE(excluded.late_discovery,1))`,
  buys: `MAX(COALESCE(excluded.buys,0), COALESCE(tokens.buys,0))`,
  sells: `MAX(COALESCE(excluded.sells,0), COALESCE(tokens.sells,0))`,
  buy_vol_sol: `MAX(COALESCE(excluded.buy_vol_sol,0), COALESCE(tokens.buy_vol_sol,0))`,
  sell_vol_sol: `MAX(COALESCE(excluded.sell_vol_sol,0), COALESCE(tokens.sell_vol_sol,0))`,
  unique_buyers: `MAX(COALESCE(excluded.unique_buyers,0), COALESCE(tokens.unique_buyers,0))`,
  unique_sellers: `MAX(COALESCE(excluded.unique_sellers,0), COALESCE(tokens.unique_sellers,0))`,
  bundled_buyers: `MAX(COALESCE(excluded.bundled_buyers,0), COALESCE(tokens.bundled_buyers,0))`,
  // Graduation only ever becomes more certain. Confirmation can arrive late but must never un-arrive.
  curve_buyers: `MAX(COALESCE(excluded.curve_buyers,0), COALESCE(tokens.curve_buyers,0))`,
  graduated: `MAX(COALESCE(excluded.graduated,0), COALESCE(tokens.graduated,0))`,
  graduated_at: `COALESCE(tokens.graduated_at, excluded.graduated_at)`,
  graduated_confirmed_by: `COALESCE(tokens.graduated_confirmed_by, excluded.graduated_confirmed_by)`,
  dev_sold: `MAX(COALESCE(excluded.dev_sold,0), COALESCE(tokens.dev_sold,0))`,
  // The launch claim is written once: a later fetch reads today's URI, not the launch's.
  dev_sold_at: `COALESCE(tokens.dev_sold_at, excluded.dev_sold_at)`,
  image: `COALESCE(tokens.image, excluded.image)`,
  description: `COALESCE(tokens.description, excluded.description)`,
  meta_at: `COALESCE(tokens.meta_at, excluded.meta_at)`,
  // The document itself, same keep-first rule as every other launch claim: whoever read it first read it closest to
  // the launch, and a later fetch reads today's URI rather than that day's.
  meta_json: `COALESCE(tokens.meta_json, excluded.meta_json)`,
  meta_bytes: `COALESCE(tokens.meta_bytes, excluded.meta_bytes)`,
  // Our fetch attempt, not the launch - same rule and same reason as image_error below. The target's own attempt
  // describes the target, so it wins; the seed only fills a slot the target never wrote. Named here because the
  // guard would otherwise refuse the merge over it, which is the guard doing its job: this column appeared after
  // the policy was written, and the alternative to stopping is dropping it silently.
  meta_error: `COALESCE(tokens.meta_error, excluded.meta_error)`,
  /**
   * The document's hash moves with the document or not at all - the vault_sol/vault_at rule, for the same reason.
   *
   * Plain keep-first would break the one thing the hash is for. A target holding its own document but no hash (rows
   * written before meta_sha256 existed) would take the SEED's hash while keeping its OWN bytes, and publish a
   * sha256 that verifies nothing. `meta_at` is the marker for "we hold a document", and it is exactly the rows
   * where meta_at is null that adopt the seed's - so gate on that and the hash always describes the bytes beside it.
   */
  meta_sha256: `CASE WHEN tokens.meta_at IS NULL THEN excluded.meta_sha256 ELSE tokens.meta_sha256 END`,
  /**
   * The creation transaction and its slot: a launch fact, immutable once recorded, and the two are one observation.
   * Neither is ever revised, so keep-first - but paired, so a row can never carry one without the other.
   */
  create_sig: `CASE WHEN tokens.create_sig IS NULL THEN excluded.create_sig ELSE tokens.create_sig END`,
  create_slot: `CASE WHEN tokens.create_sig IS NULL THEN excluded.create_slot ELSE tokens.create_slot END`,
  // A diagnostic about OUR fetch attempt, not a fact about the launch. The target's own attempt is the one that
  // describes the target, so it wins; the seed only fills a slot the target never wrote. Added 2026-09-08 when the
  // shared-column guard refused the merge over it - which is the guard working exactly as intended: a column that
  // appeared after the policy was written stopped the merge instead of being silently dropped.
  image_error: `COALESCE(tokens.image_error, excluded.image_error)`,
  image_sha256: `COALESCE(tokens.image_sha256, excluded.image_sha256)`,
  image_bytes: `COALESCE(tokens.image_bytes, excluded.image_bytes)`,
  image_at: `COALESCE(tokens.image_at, excluded.image_at)`,
  twitter: `COALESCE(tokens.twitter, excluded.twitter)`,
  telegram: `COALESCE(tokens.telegram, excluded.telegram)`,
  website: `COALESCE(tokens.website, excluded.website)`,
  pool: `COALESCE(tokens.pool, excluded.pool)`,
  amm_trusted: `COALESCE(tokens.amm_trusted, excluded.amm_trusted)`,
  venue: `COALESCE(tokens.venue, excluded.venue)`,
  rebuilt_at: `COALESCE(tokens.rebuilt_at, excluded.rebuilt_at)`,
  // A pool balance and the moment it was read move together or not at all, and only when the seed's is newer.
  // vault_at advancing while vault_sol stood still is the bug that made vault_at exist in the first place.
  rebuilt_complete: `MAX(COALESCE(excluded.rebuilt_complete,0), COALESCE(tokens.rebuilt_complete,0))`,
  vault_sol: `CASE WHEN excluded.vault_at IS NOT NULL AND excluded.vault_at > COALESCE(tokens.vault_at,-1)
                   THEN excluded.vault_sol ELSE tokens.vault_sol END`,
  // Point-in-time prices belong to whichever writer saw the token most recently.
  vault_at: `CASE WHEN excluded.vault_at IS NOT NULL AND excluded.vault_at > COALESCE(tokens.vault_at,-1)
                  THEN excluded.vault_at ELSE tokens.vault_at END`,
  last_price: `CASE WHEN COALESCE(excluded.last_seen_at,0) > COALESCE(tokens.last_seen_at,0) THEN excluded.last_price ELSE tokens.last_price END`,
  p_1m: `CASE WHEN COALESCE(excluded.last_seen_at,0) > COALESCE(tokens.last_seen_at,0) THEN excluded.p_1m ELSE tokens.p_1m END`,
  p_5m: `CASE WHEN COALESCE(excluded.last_seen_at,0) > COALESCE(tokens.last_seen_at,0) THEN excluded.p_5m ELSE tokens.p_5m END`,
  p_15m: `CASE WHEN COALESCE(excluded.last_seen_at,0) > COALESCE(tokens.last_seen_at,0) THEN excluded.p_15m ELSE tokens.p_15m END`,
  p_60m: `CASE WHEN COALESCE(excluded.last_seen_at,0) > COALESCE(tokens.last_seen_at,0) THEN excluded.p_60m ELSE tokens.p_60m END`,
  peak_price: `MAX(COALESCE(excluded.peak_price,0), COALESCE(tokens.peak_price,0))`,
  peak_at: `CASE WHEN COALESCE(excluded.peak_price,0) > COALESCE(tokens.peak_price,0) THEN excluded.peak_at ELSE tokens.peak_at END`,
  kol_signals: `MAX(COALESCE(excluded.kol_signals,0), COALESCE(tokens.kol_signals,0))`,
  finalized: `MAX(COALESCE(excluded.finalized,0), COALESCE(tokens.finalized,0))`,
  last_seen_at: `MAX(COALESCE(excluded.last_seen_at,0), COALESCE(tokens.last_seen_at,0))`,
  /**
   * Stamped to the MERGE time, not carried from either side - because `updated_at` is not a fact about the launch
   * here, it is the watermark `servicedb` copies by, and a merged row that does not move it is a row the published
   * record can never see.
   *
   * Taking MAX of the two sides looks conservative and is the bug. The seed's timestamps are whenever the LAPTOP
   * last touched each row, which for a document captured at 16:30 is 16:30 - behind a collector whose last record
   * build stamped its watermark at 17:59. Measured after the 2026-09-10 merge: 113,866 rows carried a document and
   * an `updated_at` behind the watermark, so 70,000 recovered documents sat in the collector invisible to every
   * future incremental build. They needed a full rebuild to surface, and nothing would have reported them missing.
   *
   * This is the fourth time in this codebase that a write which did not move `updated_at` failed to reach the
   * record. `backfillmeta` carries the same note and the same fix. A merge changed the row; the row says so.
   */
  updated_at: `CAST(strftime('%s','now') AS INTEGER) * 1000`,
};

/**
 * Mints whose buyer counts must not fall: the 25 with the most to lose, read from the target before the merge.
 * Dynamic rather than a fixed list, so it adapts to whatever the collector actually holds - the failure being
 * guarded is the one that cost BILL 3,046 curve buyers on 2026-09-06 to a careless write.
 */
const WITNESS_SQL = `SELECT mint, COALESCE(curve_buyers,0) b, COALESCE(unique_buyers,0) u FROM main.tokens
  WHERE curve_buyers IS NOT NULL ORDER BY curve_buyers DESC LIMIT 25`;
/**
 * The fallback matters more than it looks. `curve_buyers` is populated by `servicedb`, which on a collector whose
 * record build has been failing may never have run - and then the set above comes back empty, the loop iterates zero
 * times, and the merge reports that no token lost buyers having checked none. A check that can only fail one way is
 * vacuous in the other, so an empty witness set refuses the merge rather than passing it.
 */
const WITNESS_FALLBACK_SQL = `SELECT mint, COALESCE(curve_buyers,0) b, COALESCE(unique_buyers,0) u FROM main.tokens
  WHERE COALESCE(unique_buyers,0) > 0 ORDER BY unique_buyers DESC LIMIT 25`;

export async function mergeSeed(
  db: DatabaseSync, seedPath: string, opts: { dryRun?: boolean; log?: (s: string) => void } = {},
): Promise<MergeResult> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const st = statSync(seedPath);
  const hash = createHash("sha256").update(readFileSync(seedPath)).digest("hex").slice(0, 16);
  const key = `${st.size}:${hash}`;

  // Created inside the transaction below, not here: a dry run must write nothing at all, and `CREATE TABLE IF NOT
  // EXISTS` before BEGIN left an empty table behind in a database the caller was only asking a question about.
  const MARKER_DDL = `CREATE TABLE IF NOT EXISTS main.seed_merges (
    key TEXT PRIMARY KEY, path TEXT, bytes INTEGER, merged_at INTEGER, rows_added INTEGER, note TEXT)`;

  const before: Record<string, number> = {};
  for (const t of TABLES) before[t] = count(db, "main", t);

  /**
   * The gate that makes a redeploy a no-op. A collector in a crash-loop runs boot code repeatedly, and "merges once
   * on boot" is a promise about a file that is still sitting on the volume the next time the process starts - so the
   * marker is keyed on the file's size and content hash, not its name. A different seed is a different merge.
   */
  // No marker table yet means nothing has ever been merged, which is not an error.
  let done: any = null;
  try { done = db.prepare("SELECT merged_at FROM main.seed_merges WHERE key = ?").get(key); } catch { done = null; }
  if (done && !opts.dryRun) {
    return { skipped: true, reason: `already merged at ${new Date(done.merged_at).toISOString()}`, before, after: before };
  }

  /**
   * A copy before the first write. `VACUUM INTO` cannot run inside a transaction, so it happens here, and a dry run
   * skips it because a dry run never writes.
   */
  let backup: string | undefined;
  if (!opts.dryRun) {
    /**
     * Beside the live database, not beside the seed. Those are different filesystems on the collector: the seed
     * ships inside the image at /app/data/seed.db while pump.db sits on the mounted volume, so deriving the path
     * from the seed put a 1.2 GB backup on ephemeral container storage - gone at the next restart, and quite
     * possibly filling the layer and failing the merge on the way. The one artefact whose whole purpose is
     * surviving a bad merge has to live where the thing it is backing up lives.
     */
    const livePath = ((db.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get() as any)?.file ?? "") as string;
    if (!livePath) throw new Error("cannot determine the live database's path, so cannot place a backup beside it");
    backup = `${livePath.replace(/[^/]*$/, "")}pre-merge-${Date.now()}.db`;
    // A VACUUM INTO that runs out of room leaves a partial file consuming what is left. Check before, not after.
    try {
      const { statfsSync } = await import("node:fs");
      const fs2 = statfsSync(livePath.replace(/[^/]*$/, "") || ".");
      const free = fs2.bavail * fs2.bsize, need = statSync(livePath).size;
      if (free < need * 1.1)
        throw new Error(`backup needs ~${(need / 1e9).toFixed(1)} GB beside ${livePath} and only ${(free / 1e9).toFixed(1)} GB is free`);
    } catch (e) { if ((e as Error).message.startsWith("backup needs")) throw e; }
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    log(`[seed] backed up to ${backup}`);
  }

  /**
   * Read-only enforced by the filesystem, because SQLite's own mechanism is unavailable here: `node:sqlite` does not
   * enable URI filenames, so `ATTACH 'file:...?mode=ro'` fails outright - it is what made `seed.ts` throw on its
   * first statement every time anyone ran it. chmod 444 achieves the same guarantee by a different route, and it is
   * a real one: a write through the attachment fails with "attempt to write a readonly database" rather than
   * relying on this file never naming `seed.` as a target.
   */
  try { chmodSync(seedPath, 0o444); } catch { /* a seed we cannot chmod is still never written to below */ }
  db.exec(`ATTACH DATABASE '${seedPath.replace(/'/g, "''")}' AS seed`);
  try {
    /**
     * Refuse a seed whose schema is not a subset of live's. Writing each value into its neighbour's field is the
     * failure this guards, and it is silent - the rows land, the counts look right, and the data is wrong.
     */
    const liveCols = new Set(cols(db, "main", "tokens"));
    const seedCols = cols(db, "seed", "tokens");
    const stray = seedCols.filter((c) => !liveCols.has(c));
    if (stray.length) throw new Error(`seed tokens has columns live does not: ${stray.join(", ")}. Refusing to merge.`);
    const shared = seedCols.filter((c) => liveCols.has(c));
    const list = shared.map((c) => `"${c}"`).join(", ");
    // Every shared column must have a stated policy or be explicitly never-updated. A new column with neither is a
    // column the merge would silently drop, which is the failure this project keeps meeting in other forms.
    const unpoliced = shared.filter((c) => !NEVER_UPDATE.has(c) && !(c in TOKEN_POLICY));
    if (unpoliced.length)
      throw new Error(`no merge policy for tokens columns: ${unpoliced.join(", ")}. Add them to TOKEN_POLICY or NEVER_UPDATE.`);
    const setClause = shared.filter((c) => c in TOKEN_POLICY).map((c) => `${c}=${TOKEN_POLICY[c]}`).join(",\n  ");
    log(`[seed] ${shared.length} shared columns on tokens, named explicitly`);

    const floorBefore = (db.prepare("SELECT MIN(created_at) m FROM main.tokens").get() as any)?.m ?? Infinity;
    const seedFloor = (db.prepare("SELECT MIN(created_at) m FROM seed.tokens").get() as any)?.m ?? Infinity;
    let witnessRows = db.prepare(WITNESS_SQL).all() as any[];
    if (!witnessRows.length) witnessRows = db.prepare(WITNESS_FALLBACK_SQL).all() as any[];
    if (!witnessRows.length)
      throw new Error("no witness tokens: the target holds no row with a buyer count, so the buyer-loss check would verify nothing");
    log(`[seed] ${witnessRows.length} witness tokens will be checked for lost buyers`);
    const witnessBefore = new Map<string, any>(witnessRows.map((r) => [r.mint, r]));

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MARKER_DDL);
      /**
       * Mints the target does not have yet. The INSERT below carries their columns VERBATIM - TOKEN_POLICY governs
       * only the conflict branch - so every rule the policy encodes is bypassed for a row that is new here, and any
       * contradiction the seed carries is imported intact.
       *
       * That is not hypothetical: the laptop holds 1,255 rows with a pool balance and no reading time, and the
       * collector held exactly 1,255. The pair was never written that way by any collector path - it arrived by
       * this INSERT, from a seed, past a policy that says vault_sol and vault_at move together or not at all.
       */
      db.exec(`CREATE TEMP TABLE inserted_mints AS
               SELECT s.mint FROM seed.tokens s LEFT JOIN main.tokens t ON t.mint = s.mint WHERE t.mint IS NULL`);
      db.exec(`INSERT INTO main.tokens (${list}) SELECT ${list} FROM seed.tokens WHERE true
               ON CONFLICT(mint) DO UPDATE SET ${setClause}`);
      /**
       * A balance we cannot date is not a reading, and importing one manufactures a contradiction the record then
       * has to refuse to publish. Dropped only for rows this merge CREATED - a row the collector already owned is
       * the collector's to keep or fix, and a merge is not the place to revise it.
       */
      const orphaned = db.prepare(`UPDATE main.tokens SET vault_sol = NULL
        WHERE vault_sol IS NOT NULL AND vault_at IS NULL
          AND mint IN (SELECT mint FROM inserted_mints)`).run();
      if (Number(orphaned.changes ?? 0) > 0)
        log(`[seed] dropped ${Number(orphaned.changes).toLocaleString()} imported pool balances that carried no reading time`);
      db.exec("DROP TABLE inserted_mints");

      // Live wins on everything below: the collector's own observations are never overwritten by an older export.
      db.exec(`INSERT OR IGNORE INTO main.operator_wallets (wallet, funder, cluster, role, seeded_at, source_mint, traced, added_at)
               SELECT wallet, funder, cluster, role, seeded_at, source_mint, traced, added_at FROM seed.operator_wallets`);
      db.exec(`INSERT OR IGNORE INTO main.operator_funders (funder, first_seen, last_seen, txs, wallets, seeds, sampled_at, note, parent, hops)
               SELECT funder, first_seen, last_seen, txs, wallets, seeds, sampled_at, note, parent, hops FROM seed.operator_funders`);
      // A hand-set policy is a human judgement and is never overwritten in either direction.
      db.exec(`INSERT OR IGNORE INTO main.operator_policy (cluster, policy, hold_plays, dist_plays, plays, manual, note, updated_at)
               SELECT cluster, policy, hold_plays, dist_plays, plays, manual, note, updated_at FROM seed.operator_policy
               WHERE COALESCE(manual,0) = 0 OR cluster NOT IN (SELECT cluster FROM main.operator_policy WHERE COALESCE(manual,0) = 1)`);
      db.exec(`INSERT OR IGNORE INTO main.pool_map (pool, mint, created_at)
               SELECT pool, mint, created_at FROM seed.pool_map`);

      /**
       * Buyout evidence: the rows `findBuyout` reads and `servicedb` copies into the published record. This is the
       * answer to who took each curve - the half of the product a contract scanner cannot produce.
       *
       * Without them a seeded collector builds a record that GROWS the launch count while carrying a quarter of the
       * buyouts, and the pull guard waves it through because it counts `tokens` and nothing else. Measured
       * 2026-09-08: 580 buyout trades on the collector against 2,099 here. The right number is not the right archive.
       *
       * `hist_trades` is created by `history.ts`, which has only ever run on the laptop, so on a collector the table
       * does not exist and the rows would have nowhere to land. Created here rather than assumed - a missing table
       * is exactly what made the record build produce a 94,208-byte file for the life of this deployment.
       *
       * `trades.id` is AUTOINCREMENT and collides, so rows go in without it and dedupe on the transaction signature
       * with mint and wallet: one wallet's leg of one transaction on one mint, which is what a row here means.
       * `hist_trades` has a real primary key of (mint, sig, idx) and needs no help.
       */
      db.exec(`CREATE TABLE IF NOT EXISTS main.hist_trades (mint TEXT NOT NULL, sig TEXT NOT NULL, idx INTEGER NOT NULL,
        ts INTEGER, slot INTEGER, wallet TEXT, side TEXT, sol REAL, tokens REAL, vsol REAL, vtok REAL, is_dev INTEGER,
        PRIMARY KEY (mint, sig, idx))`);
      db.exec("CREATE INDEX IF NOT EXISTS main.hist_trades_mint ON hist_trades(mint, ts)");
      /**
       * Only if the seed actually carries them. A seed written before these tables were exported has neither, and an
       * unconditional copy throws `no such table: seed.hist_trades` and takes the whole merge down - including the
       * tokens and operator rows that would otherwise have landed.
       *
       * This is the same assumption that broke `servicedb` for the entire life of the deployment: it copied
       * `main.hist_trades` unconditionally, that table only exists where `history.ts` has run, and the build threw
       * before writing a row and left a 94,208-byte file behind. Writing the identical bug into the importer while
       * fixing it in the exporter would be difficult to explain, and it was caught only because a test used an older
       * seed. An absent table is a seed that carries nothing here, not a reason to abandon the merge.
       */
      const seedHas = (t: string) =>
        ((db.prepare("SELECT COUNT(*) c FROM seed.sqlite_master WHERE type='table' AND name = ?").get(t) as any).c as number) > 0;
      if (seedHas("trades"))
        db.exec(`INSERT INTO main.trades (mint, wallet, side, sol, tokens, price, ts, slot, sig, age_ms, buyer_rank, is_dev, venue)
                 SELECT s.mint, s.wallet, s.side, s.sol, s.tokens, s.price, s.ts, s.slot, s.sig, s.age_ms, s.buyer_rank, s.is_dev, s.venue
                 FROM seed.trades s
                 WHERE NOT EXISTS (SELECT 1 FROM main.trades m
                   WHERE m.sig = s.sig AND m.mint = s.mint AND m.wallet = s.wallet)`);
      else log(`[seed] this seed carries no trades table - no buyout evidence to inherit`);
      if (seedHas("hist_trades"))
        db.exec(`INSERT OR IGNORE INTO main.hist_trades (mint, sig, idx, ts, slot, wallet, side, sol, tokens, vsol, vtok, is_dev)
                 SELECT mint, sig, idx, ts, slot, wallet, side, sol, tokens, vsol, vtok, is_dev FROM seed.hist_trades`);
      else log(`[seed] this seed carries no hist_trades table - reconstructed buyout history will be missing`);

      /**
       * `runs` is evidence: provenance.ts derives published coverage from it, so merging tokens without runs would
       * have the collector disclaim days it actually watched - absence of data reading as a finding, inverted.
       * `id` is AUTOINCREMENT in both databases so the ids collide; insert without it and dedupe on the pair that
       * identifies a run. health.ts already orders by started_at rather than id, so appended history cannot make a
       * live collector look dead.
       */
      db.exec(`INSERT INTO main.runs (started_at, stopped_at, note)
               SELECT s.started_at, s.stopped_at, s.note FROM seed.runs s
               WHERE NOT EXISTS (SELECT 1 FROM main.runs m
                 WHERE COALESCE(m.started_at,-1) = COALESCE(s.started_at,-1)
                   AND COALESCE(m.stopped_at,-1) = COALESCE(s.stopped_at,-1))`);
      db.exec(`INSERT INTO main.signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at)
               SELECT s.source, s.account, s.mint, s.symbol, s.kind, s.text, s.url, s.posted_at, s.seen_at FROM seed.signals s
               WHERE NOT EXISTS (SELECT 1 FROM main.signals m
                 WHERE COALESCE(m.source,'') = COALESCE(s.source,'') AND COALESCE(m.mint,'') = COALESCE(s.mint,'')
                   AND COALESCE(m.kind,'') = COALESCE(s.kind,'') AND COALESCE(m.posted_at,-1) = COALESCE(s.posted_at,-1))`);

      /**
       * Checks that can fail during the failure they exist to address. Every one of these is a way the merge could
       * appear to succeed while destroying something: a table shrinking, history not actually arriving, or a
       * provenance counter going backwards on a token we already hold.
       */
      const after: Record<string, number> = {};
      for (const t of TABLES) {
        after[t] = count(db, "main", t);
        const seedN = count(db, "seed", t);
        const floor = Math.max(before[t], seedN);
        if (after[t] < floor) throw new Error(`${t} holds ${after[t]} after merge, below max(before ${before[t]}, seed ${seedN})`);
      }
      const floorAfter = (db.prepare("SELECT MIN(created_at) m FROM main.tokens").get() as any)?.m ?? Infinity;
      if (seedFloor < floorBefore && floorAfter > seedFloor)
        throw new Error(`history did not arrive: earliest launch is ${floorAfter}, seed reaches back to ${seedFloor}`);
      for (const [mint, b] of witnessBefore) {
        const a = db.prepare("SELECT COALESCE(curve_buyers,0) b, COALESCE(unique_buyers,0) u FROM main.tokens WHERE mint = ?").get(mint) as any;
        if (!a) throw new Error(`witness ${mint} disappeared from tokens`);
        if (a.b < b.b || a.u < b.u) throw new Error(`witness ${mint} lost buyers: ${b.b}/${b.u} -> ${a.b}/${a.u}`);
      }

      const added = TABLES.reduce((n, t) => n + (after[t] - before[t]), 0);
      if (opts.dryRun) {
        db.exec("ROLLBACK");
        log(`[seed] DRY RUN, rolled back. Would add ${added.toLocaleString()} rows.`);
      } else {
        db.prepare("INSERT OR REPLACE INTO main.seed_merges (key, path, bytes, merged_at, rows_added, note) VALUES (?,?,?,?,?,?)")
          .run(key, seedPath, st.size, Date.now(), added, `${shared.length} token columns`);
        db.exec("COMMIT");
        log(`[seed] merged ${added.toLocaleString()} rows from ${seedPath}`);
      }
      return { skipped: false, before, after, columns: shared.length, backup };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.exec("DETACH DATABASE seed");
  }
}

/**
 * Direct invocation, for exercising the merge against a copy before it ever runs on the collector.
 *   npm run mergeseed -- --db <live.db> --seed <seed.db> [--dry-run]
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string, d = "") => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const { openDb } = await import("./db.ts");
  const live = arg("--db"), seed = arg("--seed");
  if (!live || !seed) { console.error("usage: mergeseed --db <live.db> --seed <seed.db> [--dry-run]"); process.exit(2); }
  const db = openDb(live);
  const r = await mergeSeed(db, seed, { dryRun: process.argv.includes("--dry-run") });
  if (r.skipped) { console.log(`[seed] skipped: ${r.reason}`); process.exit(0); }
  for (const t of Object.keys(r.after)) {
    const d = r.after[t] - r.before[t];
    console.log(`  ${t.padEnd(18)} ${r.before[t].toLocaleString().padStart(9)} -> ${r.after[t].toLocaleString().padStart(9)}  ${d >= 0 ? "+" : ""}${d.toLocaleString()}`);
  }
}
