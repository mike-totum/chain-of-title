/**
 * Move trade rows off the collector's disk and into the object store, so the archive can keep growing sideways.
 *   TRADES_OFFLOAD=1 on the collector, or: npm run offload -- --dry-run
 *
 * The collector writes ~3.5 M trade rows a day, about 2 GB, into a 19 GB volume. Left alone it fills the disk in
 * days and ingestion stops - and ingestion stopping is the only failure this project cannot recover from, because
 * a launch not observed is not observable later. Trades are also the one thing here that anybody can re-derive
 * from an archival node, which makes them the wrong thing to spend the disk on: what we hold that nobody else does
 * is the launch record, at ~300 bytes each.
 *
 * So trades become a working set. Measured over the whole archive on 2026-09-10: every curve buyout happens within
 * 1.41 days of its launch, every follow-on market trade by that buyer within 2.46 days, and every graduation
 * within 5.8 - though graduation timing is read from `tokens`, not from a trade row. A three-day window loses no
 * attribution at all; the default here is four, for a day and a half of margin. Seven would be more comfortable and
 * does not fit the volume, which is the whole problem.
 *
 * Nothing is deleted that has not been uploaded, verified by size against what we sent, and written into a local
 * ledger. The order is always export, verify, record, then delete.
 */
import { createGzip, gunzipSync } from "node:zlib";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { createHash } from "node:crypto";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { r2Config, putKey, headKey, getKey, type R2Config } from "./r2.ts";
import { BUYOUT_SOL } from "./provenance.ts";

/**
 * Every column, because the point of the archive is that it is complete.
 *
 * `market` was called `venue` until 2026-09-11 and this list was not renamed with it, so every pass since has
 * thrown on the very first SELECT and logged `[offload] FAILED, nothing deleted`. The archive was saved by the
 * query being broken, which is not a guard. `offload.test.ts` now asserts this list against the table itself.
 */
export const TRADE_COLUMNS = ["id", "mint", "wallet", "side", "sol", "tokens", "price", "ts", "slot", "sig", "age_ms", "buyer_rank", "is_dev", "market"];

export interface OffloadOptions {
  retainDays?: number;
  /** Rows per uploaded object. Bounds memory: the whole part is held compressed before it is signed and sent. */
  partRows?: number;
  /** Objects to upload in one pass, so a scheduled run always terminates. */
  maxParts?: number;
  dryRun?: boolean;
  /** Key namespace. Only the self-test changes it, so a rehearsal cannot write into the real archive. */
  keyPrefix?: string;
  log?: (s: string) => void;
}

export interface OffloadResult {
  parts: number; rows: number; bytes: number; deleted: number; skipped: string; cutoff: number;
}

/**
 * Rows the published record is built from, which must never leave this disk. TRUE means keep.
 *
 * `servicedb` builds `rec.trades` from buyout-sized curve buys plus the AMM trades on those same (wallet, mint)
 * pairs. They are the evidence behind every operator page. The first version of this offloader did not know that
 * and took some of them with the bulk, so the next record carried 4,260 trade rows against the 4,955 already
 * published - and the web service's shrink guard correctly refused the pull, which left the public archive
 * 29,419 launches behind until it was found. The bulk is commodity data anyone can re-derive; these few thousand
 * rows are the part that is ours, and they are small enough that keeping them forever costs nothing.
 *
 * Exported and named rather than inlined because it is the guard that decides a DELETE, and a guard nothing can
 * call is a guard nothing can test. It read `r.venue` until 2026-09-12 - a column renamed the day before - which
 * is `undefined` on every row, so it recognised NOTHING as evidence. Only the equally stale `TRADE_COLUMNS` above
 * kept that from mattering: the SELECT threw first, and the pass died before the delete. Repairing the column
 * list alone would have made the query succeed with this predicate still blind, and the very next pass would have
 * exported and then deleted every buyout row in the archive - the single most probative record a launch has, the
 * row `BUYOUT_SOL` exists for and the buyout detectors and `assess` are built on. That is why the test drives this
 * function with rows read back through `TRADE_COLUMNS`: half a rename fails it.
 *
 * THE THIRD CLAUSE IS NOT PART OF THAT REPAIR, and it is the larger half of this fix. The default was inverted on
 * 2026-09-12 - it was "delete on a timer, exempting what has bitten us", it is now "if a row can be used, deleting
 * it needs a reason" - and `KEEP_TRADE_EVIDENCE` grew a clause holding the whole curve ledger of every launch that
 * GRADUATED. This is the fourth trade-deletion path and the only one that does not read that fragment, so without
 * the clause it would keep exporting-and-deleting locally exactly the population the other three now protect: the
 * 12,525 launches every report, finding and outside-buyer count is about. The rows would still exist in the bucket,
 * which is not the same as being here - `servicedb` rebuilds `rec.trades` and recounts `curve_buyers` from what the
 * collector currently holds, so a launch whose ledger has been moved to R2 publishes as a launch with an incomplete
 * one. Deletion by another route, arriving through the path nobody suspects.
 *
 * `graduated = 1` or a confirmation, matching the fragment exactly: the inferred flag overstates graduation and we
 * know it, but confirmation can arrive after this pass would have run, and a ledger that is gone can never be
 * confirmed, measured or reported on again.
 */
export function evidenceFilter(db: any): (r: any) => boolean {
  const keep = new Set<string>();
  for (const b of db.prepare(
    `SELECT DISTINCT wallet, mint FROM trades WHERE market='curve' AND side='buy' AND sol >= ?`).all(BUYOUT_SOL) as any[])
    keep.add(`${b.wallet} ${b.mint}`);
  /**
   * Asked per mint against the primary key and memoised, rather than read as one set of graduated mints up front.
   * A pass sees at most maxParts * partRows rows, so the cache is bounded by the pass; a `SELECT mint FROM tokens
   * WHERE graduated = 1` is a full scan of a table with millions of rows on a process that drops two websockets
   * when it stops answering, and this function cannot yield.
   */
  const gradQ = db.prepare(
    "SELECT 1 g FROM tokens WHERE mint = ? AND (COALESCE(graduated, 0) = 1 OR graduated_confirmed_by IS NOT NULL)");
  const grad = new Map<string, boolean>();
  const graduated = (mint: string): boolean => {
    let v = grad.get(mint);
    if (v === undefined) { v = !!gradQ.get(mint); grad.set(mint, v); }
    return v;
  };
  return (r: any) =>
    (r.market === "curve" && r.side === "buy" && Number(r.sol) >= BUYOUT_SOL) ||
    (r.market === "amm" && keep.has(`${r.wallet} ${r.mint}`)) ||
    (r.market === "curve" && graduated(String(r.mint)));
}

/**
 * The column names an archived object carries, mapped onto the columns this database actually has.
 *
 * Every object uploaded before 2026-09-11 has `venue` as its last header field, because that was the column's name
 * when it was written. `restoreOffloaded` builds its INSERT from that header, so after the rename the restore path
 * - the only way back for rows that exist nowhere else - threw `no such column: venue` on the first object and
 * took the whole restore down with it. The objects are correct; the name in them is historical, and a rename in
 * this schema must not invalidate the archive's own files.
 */
export function restoreColumns(header: string[]): string[] {
  return header.map((c) => (c.trim() === "venue" ? "market" : c.trim()));
}

/**
 * The ledger. One row per uploaded object, holding exactly which rows it contains, so a deletion can be justified
 * afterwards and a re-run can tell what it already did. `id_from`/`id_to` are the authority - the day in the key is
 * for humans reading the bucket.
 */
function ensureLedger(db: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS trade_offloads (
    key TEXT PRIMARY KEY, day TEXT, id_from INTEGER, id_to INTEGER, rows INTEGER, bytes INTEGER,
    sha256 TEXT, ts_min INTEGER, ts_max INTEGER, uploaded_at INTEGER, deleted_at INTEGER, deleted_rows INTEGER)`);
  db.exec("CREATE INDEX IF NOT EXISTS trade_offloads_day ON trade_offloads(day)");
}

/** CSV, because the archive should open in anything. Values are base58, numbers and short words; a stray separator
 *  would still corrupt a row, so they are escaped rather than trusted. */
const cell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function gzip(text: string): Promise<Buffer> {
  const gz = createGzip({ level: 6 });
  const chunks: Buffer[] = [];
  gz.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res, rej) => { gz.on("end", () => res()); gz.on("error", rej); });
  gz.end(text);
  await done;
  return Buffer.concat(chunks);
}

export async function offloadTrades(db: any, o: OffloadOptions = {}): Promise<OffloadResult> {
  const log = o.log ?? ((s: string) => console.log(s));
  /**
   * Four days, which is a disk decision as much as an evidence one. The measurement says three loses nothing:
   * buyouts land within 1.41 days of a launch and the buyer's follow-on market trades within 2.46. Graduation
   * timing reaches 5.8 days but is read from `tokens`, not from here. Seven days would be the comfortable margin
   * and does not fit - at 3.5 M rows a day that is ~24 M rows and roughly 13 GB in a 19 GB volume, which is the
   * problem this exists to solve. Four keeps a day and a half of margin past the last thing that needs a trade row.
   */
  const retainDays = o.retainDays ?? Number(process.env.TRADES_RETAIN_DAYS ?? 4);
  // Measured against the event loop rather than against memory. 150,000 rows put the worst loop delay at 653 ms
  // because a single `.all()` cannot yield partway; 40,000 brings it to 149 ms, and the process has two websockets
  // that drop when it stops answering. ~11 MB of CSV per part.
  const partRows = o.partRows ?? Number(process.env.TRADES_PART_ROWS ?? 40_000);
  const maxParts = o.maxParts ?? Number(process.env.TRADES_MAX_PARTS ?? 4);
  const cutoff = Date.now() - retainDays * 86400_000;
  const empty: OffloadResult = { parts: 0, rows: 0, bytes: 0, deleted: 0, skipped: "", cutoff };

  const cfg = o.dryRun ? null : r2Config();
  if (!cfg && !o.dryRun) return { ...empty, skipped: "R2 is not configured; set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET" };
  // A dry run opens the database query-only, so it must not try to create the ledger it will never write to.
  if (!o.dryRun) ensureLedger(db);

  /**
   * The oldest rows still on disk, as an id range rather than a time range.
   *
   * `trades` has no index on `ts`, so every WHERE on time is a full scan of ten million rows; `id` is the primary
   * key and rises with ingestion, so ranging on it seeks. The time filter stays in the WHERE for correctness - a
   * row written out of order by a backfill must be judged on its timestamp, not on where it landed in the table.
   */
  /**
   * Two queries, not one. `SELECT MIN(id), MAX(id) FROM trades` scans the whole table - SQLite optimises a single
   * MIN or MAX into an index lookup and gives up when both appear together, so one convenient line cost 993 ms on
   * a 21 M row table and about two seconds on the collector. That was the whole reason the first passes dropped
   * both websockets: it happens before any row is read, which is why a pass that moved a single row did it too.
   * Asked separately, each is an index seek and returns in under a millisecond.
   */
  const lowest = (db.prepare("SELECT MIN(id) a FROM trades").get() as any)?.a;
  const highest = (db.prepare("SELECT MAX(id) b FROM trades").get() as any)?.b;
  if (lowest == null) return { ...empty, skipped: "no trades on disk" };
  const oldest = { a: lowest, b: highest };

  // Which rows may never leave this disk. Built once per pass; see `evidenceFilter`.
  const isEvidence = evidenceFilter(db);

  const rowsIn = db.prepare(
    `SELECT ${TRADE_COLUMNS.join(", ")} FROM trades WHERE id >= ? AND id < ? AND ts IS NOT NULL AND ts < ? ORDER BY id LIMIT ?`);
  const nextIdAfter = db.prepare("SELECT MIN(id) a FROM trades WHERE id >= ?");
  const ins = o.dryRun ? null : db.prepare(`INSERT OR REPLACE INTO trade_offloads
    (key, day, id_from, id_to, rows, bytes, sha256, ts_min, ts_max, uploaded_at, deleted_at, deleted_rows)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const doneKey = o.dryRun ? null : db.prepare("SELECT deleted_at FROM trade_offloads WHERE key = ?");

  const res: OffloadResult = { ...empty };
  let cursor = Number(oldest.a);

  for (let part = 0; part < maxParts; part++) {
    // A window of ids wide enough to contain a full part even when most of its rows are already gone or too new.
    const windowEnd = cursor + partRows * 8;
    let rows = rowsIn.all(cursor, windowEnd, cutoff, partRows) as any[];
    if (!rows.length) {
      // Give the loop back before stepping to the next window. This process is also decoding two websockets, and
      // the first pass in production blocked long enough to disconnect both of them - which costs launches, the
      // one loss that cannot be repaired. Every synchronous step here is now followed by a yield.
      await yieldToLoop();
      const next = (nextIdAfter.get(windowEnd) as any)?.a;
      if (next == null) { res.skipped = res.parts ? "" : "nothing older than the retention window"; break; }
      // The window held nothing eligible; step over it rather than giving up, because a gap of deleted ids is
      // normal once this has run before.
      cursor = Number(next);
      part--;
      if (cursor > Number(oldest.b)) break;
      continue;
    }

    const idFrom = Number(rows[0].id), idTo = Number(rows[rows.length - 1].id);
    // Evidence rows stay. They are still counted in the window we advance past, so the pass makes progress.
    const held = rows.filter(isEvidence);
    rows = rows.filter((r) => !isEvidence(r));
    if (!rows.length) { cursor = idTo + 1; part--; await yieldToLoop(); continue; }
    // Folded rather than spread: `Math.min(...rows)` on a 250,000-row part exceeds the argument limit and throws
    // RangeError: Maximum call stack size exceeded, which is a confusing way to learn that a part got large.
    let tsMin = Infinity, tsMax = -Infinity;
    for (const r of rows) { const t = Number(r.ts); if (t < tsMin) tsMin = t; if (t > tsMax) tsMax = t; }
    const day = new Date(tsMin).toISOString().slice(0, 10);
    const key = `${o.keyPrefix ?? "trades"}/${day}/${String(idFrom).padStart(12, "0")}-${String(idTo).padStart(12, "0")}.csv.gz`;

    if ((doneKey?.get(key) as any)?.deleted_at) { cursor = idTo + 1; part--; continue; }

    /**
     * Built in slices with a yield between them. A single map+join over 150,000 rows produces ~40 MB of string in
     * one uninterruptible go; the feeds notice.
     */
    const pieces: string[] = [TRADE_COLUMNS.join(",") + "\n"];
    for (let i = 0; i < rows.length; i += 10_000) {
      pieces.push(rows.slice(i, i + 10_000).map((r) => TRADE_COLUMNS.map((c) => cell(r[c])).join(",")).join("\n") + "\n");
      await yieldToLoop();
    }
    const csv = pieces.join("");
    const body = await gzip(csv);
    const sha = createHash("sha256").update(body).digest("hex");

    if (o.dryRun) {
      log(`[offload] would upload ${key}: ${rows.length.toLocaleString()} rows, ${(body.length / 1048576).toFixed(1)} MB gz ` +
        `(${(csv.length / 1048576).toFixed(1)} MB raw), ${new Date(tsMin).toISOString()} .. ${new Date(tsMax).toISOString()}`);
      res.parts++; res.rows += rows.length; res.bytes += body.length;
      cursor = idTo + 1;
      continue;
    }

    await putKey(cfg!, key, body, "application/gzip");
    /**
     * Verify by asking the store, not by trusting the 200. A PUT that returned success and stored nothing is the
     * exact failure this project keeps meeting, and here it would be followed immediately by a DELETE.
     */
    const stored = await headKey(cfg!, key);
    if (stored === null) throw new Error(`${key} is not in the store after a successful PUT; refusing to delete anything`);
    if (stored >= 0 && stored !== body.length)
      throw new Error(`${key} stored ${stored} bytes, sent ${body.length}; refusing to delete anything`);

    ins!.run(key, day, idFrom, idTo, rows.length, body.length, sha, tsMin, tsMax, Date.now(), null, null);
    /**
     * Deleted in sub-ranges for the same reason: one DELETE covering 150,000 rows is a single long write, and the
     * ledger row above is already committed, so a pass interrupted midway resumes correctly rather than orphaning
     * an upload. The range is bounded by ids we have just exported, so a partial delete loses nothing.
     */
    /**
     * Deleted by explicit id, not by range. The range now contains rows we deliberately kept, and a range delete
     * would take them - which is the very fault this part of the pass exists to avoid.
     */
    let removed = 0;
    const ids = rows.map((r) => Number(r.id));
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      removed += db.prepare(`DELETE FROM trades WHERE id IN (${slice.map(() => "?").join(",")})`).run(...slice).changes as number;
      await yieldToLoop();
    }
    db.prepare("UPDATE trade_offloads SET deleted_at = ?, deleted_rows = ? WHERE key = ?").run(Date.now(), removed, key);

    log(`[offload] ${key}: ${rows.length.toLocaleString()} rows, ${(body.length / 1048576).toFixed(1)} MB gz, ` +
      `deleted ${removed.toLocaleString()} locally${held.length ? `, kept ${held.length.toLocaleString()} evidence rows` : ""}`);
    res.parts++; res.rows += rows.length; res.bytes += body.length; res.deleted += removed;
    cursor = idTo + 1;
    await yieldToLoop();
  }
  return res;
}

/**
 * Put back what an earlier pass should never have taken.
 *
 * The first version of this offloader did not know which rows the published record is built from and exported some
 * of them. Nothing was lost - that is the point of uploading before deleting - but the collector no longer held
 * them, so the next record build came out with less evidence than the one it would replace and the web service
 * refused it. This reads every object the ledger names back out of R2 and re-inserts its rows under their original
 * ids, which are still free because nothing else has used them.
 *
 * Idempotent by INSERT OR IGNORE on the primary key: running it twice restores nothing the second time. Bounded
 * per object, and it yields, for the same reason everything else here does.
 */
export async function restoreOffloaded(db: any, o: { log?: (s: string) => void } = {}): Promise<{ objects: number; restored: number }> {
  const log = o.log ?? ((s: string) => console.log(s));
  const cfg = r2Config();
  if (!cfg) { log("[restore] R2 is not configured"); return { objects: 0, restored: 0 }; }
  ensureLedger(db);
  try { db.exec("ALTER TABLE trade_offloads ADD COLUMN restored_at INTEGER"); } catch { /* already there */ }

  const todo = db.prepare("SELECT key, rows FROM trade_offloads WHERE deleted_at IS NOT NULL AND restored_at IS NULL ORDER BY key").all() as any[];
  let restored = 0;
  for (const t of todo) {
    const body = await getKey(cfg, t.key);
    if (!body) { log(`[restore] ${t.key} is not in the store; skipping`); continue; }
    const lines = gunzipSync(body).toString("utf8").trim().split("\n");
    // Through `restoreColumns`, because an object written before 2026-09-11 names the column `venue`.
    const header = restoreColumns(lines[0].split(","));
    const ins = db.prepare(`INSERT OR IGNORE INTO trades (${header.join(", ")}) VALUES (${header.map(() => "?").join(",")})`);
    let n = 0;
    for (let i = 1; i < lines.length; i++) {
      // The exporter escapes only when it has to, and these columns are base58, numbers and short words.
      const v = lines[i].split(",").map((x) => (x === "" ? null : x));
      n += ins.run(...v).changes as number;
      if (i % 2000 === 0) await yieldToLoop();
    }
    db.prepare("UPDATE trade_offloads SET restored_at = ? WHERE key = ?").run(Date.now(), t.key);
    restored += n;
    log(`[restore] ${t.key}: ${n.toLocaleString()} rows put back`);
    await yieldToLoop();
  }
  return { objects: todo.length, restored };
}

// CLI. Importing must not run a pass.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  if (process.argv.includes("--restore")) {
    const db = openDb(config.dbPath);
    const r = await restoreOffloaded(db);
    console.log(`restored ${r.restored.toLocaleString()} rows from ${r.objects} objects`);
    process.exit(0);
  }
  const db = openDb(config.dbPath);
  if (dryRun) db.exec("PRAGMA query_only = 1");
  const r = await offloadTrades(db, { dryRun, log: (s) => console.log(s) });
  console.log(`\n${dryRun ? "DRY RUN - nothing uploaded, nothing deleted" : "offload complete"}`);
  console.log(`  parts   ${r.parts}`);
  console.log(`  rows    ${r.rows.toLocaleString()}`);
  console.log(`  bytes   ${(r.bytes / 1048576).toFixed(1)} MB compressed`);
  if (!dryRun) console.log(`  deleted ${r.deleted.toLocaleString()} rows from the local database`);
  console.log(`  cutoff  ${new Date(r.cutoff).toISOString()} (rows older than this are eligible)`);
  if (r.skipped) console.log(`  note    ${r.skipped}`);
}
