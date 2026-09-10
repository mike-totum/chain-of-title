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
import { createGzip } from "node:zlib";
import { createHash } from "node:crypto";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { r2Config, putKey, headKey, type R2Config } from "./r2.ts";

/** Every column, because the point of the archive is that it is complete. */
const COLUMNS = ["id", "mint", "wallet", "side", "sol", "tokens", "price", "ts", "slot", "sig", "age_ms", "buyer_rank", "is_dev", "venue"];

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
  // 250,000 rows held ~66 MB of CSV and ~32 MB of gzip in memory at once, measured. 150,000 keeps the peak
  // under 60 MB, which matters on a container that is also decoding the chain.
  const partRows = o.partRows ?? Number(process.env.TRADES_PART_ROWS ?? 150_000);
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
  const oldest = db.prepare("SELECT MIN(id) a, MAX(id) b FROM trades").get() as any;
  if (oldest?.a == null) return { ...empty, skipped: "no trades on disk" };

  const rowsIn = db.prepare(
    `SELECT ${COLUMNS.join(", ")} FROM trades WHERE id >= ? AND id < ? AND ts IS NOT NULL AND ts < ? ORDER BY id LIMIT ?`);
  const nextIdAfter = db.prepare("SELECT MIN(id) a FROM trades WHERE id >= ?");
  const del = db.prepare("DELETE FROM trades WHERE id >= ? AND id <= ? AND ts IS NOT NULL AND ts < ?");
  const ins = o.dryRun ? null : db.prepare(`INSERT OR REPLACE INTO trade_offloads
    (key, day, id_from, id_to, rows, bytes, sha256, ts_min, ts_max, uploaded_at, deleted_at, deleted_rows)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const doneKey = o.dryRun ? null : db.prepare("SELECT deleted_at FROM trade_offloads WHERE key = ?");

  const res: OffloadResult = { ...empty };
  let cursor = Number(oldest.a);

  for (let part = 0; part < maxParts; part++) {
    // A window of ids wide enough to contain a full part even when most of its rows are already gone or too new.
    const windowEnd = cursor + partRows * 8;
    const rows = rowsIn.all(cursor, windowEnd, cutoff, partRows) as any[];
    if (!rows.length) {
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
    // Folded rather than spread: `Math.min(...rows)` on a 250,000-row part exceeds the argument limit and throws
    // RangeError: Maximum call stack size exceeded, which is a confusing way to learn that a part got large.
    let tsMin = Infinity, tsMax = -Infinity;
    for (const r of rows) { const t = Number(r.ts); if (t < tsMin) tsMin = t; if (t > tsMax) tsMax = t; }
    const day = new Date(tsMin).toISOString().slice(0, 10);
    const key = `${o.keyPrefix ?? "trades"}/${day}/${String(idFrom).padStart(12, "0")}-${String(idTo).padStart(12, "0")}.csv.gz`;

    if ((doneKey?.get(key) as any)?.deleted_at) { cursor = idTo + 1; part--; continue; }

    const csv = COLUMNS.join(",") + "\n" + rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(",")).join("\n") + "\n";
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
    const removed = del.run(idFrom, idTo, cutoff).changes as number;
    db.prepare("UPDATE trade_offloads SET deleted_at = ?, deleted_rows = ? WHERE key = ?").run(Date.now(), removed, key);

    log(`[offload] ${key}: ${rows.length.toLocaleString()} rows, ${(body.length / 1048576).toFixed(1)} MB gz, deleted ${removed.toLocaleString()} locally`);
    res.parts++; res.rows += rows.length; res.bytes += body.length; res.deleted += removed;
    cursor = idTo + 1;
  }
  return res;
}

// CLI. Importing must not run a pass.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ");
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  const db = openDb(config.dbPath);
  if (dryRun) db.exec("PRAGMA query_only = 1");
  const r = await offloadTrades(db, { dryRun, log: (s) => console.log(s) });
  console.log(`\n${dryRun ? "DRY RUN — nothing uploaded, nothing deleted" : "offload complete"}`);
  console.log(`  parts   ${r.parts}`);
  console.log(`  rows    ${r.rows.toLocaleString()}`);
  console.log(`  bytes   ${(r.bytes / 1048576).toFixed(1)} MB compressed`);
  if (!dryRun) console.log(`  deleted ${r.deleted.toLocaleString()} rows from the local database`);
  console.log(`  cutoff  ${new Date(r.cutoff).toISOString()} (rows older than this are eligible)`);
  if (r.skipped) console.log(`  note    ${r.skipped}`);
}
