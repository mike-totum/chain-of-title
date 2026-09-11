/**
 * Export the archive tables into a small seed database, so a fresh collector can inherit the history rather than
 * starting blank. The provenance and the operator map are the asset; the trade rows are not.
 *   npm run seed -- [--out data/seed.db]
 *
 * Ship the result with the deploy. `mergeSeed` (src/mergeseed.ts) merges it into the collector's database once on
 * boot, gated on a marker so a redeploy is a no-op.
 *
 * THE LIVE DATABASE IS NEVER ATTACHED. It is opened as its own connection with `readOnly: true` and rows are carried
 * across in JavaScript. That is slower than `INSERT ... SELECT` across an ATTACH and it is the point: on 2026-09-06
 * an unqualified `DELETE` in this file fell through `main` into the ATTACHed live database and destroyed the
 * 6,289-row operator map. A source that is not attached cannot be written by a statement that forgets to qualify
 * itself, and a connection opened read-only cannot be written at all.
 *
 * The previous attempt at that protection did not work and had never worked: it attached
 * `file:data/pump.db?mode=ro`, and `node:sqlite` does not enable URI filenames, so SQLite looked for a file
 * literally named `file:data/pump.db?mode=ro` and the command failed on its first statement every time it was run.
 * Nothing noticed, because nothing consumed the output either.
 */
import { DatabaseSync } from "node:sqlite";
import { statSync, rmSync, existsSync } from "node:fs";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { BUYOUT_SOL } from "./provenance.ts";

const i = process.argv.indexOf("--out");
const OUT = i > 0 ? process.argv[i + 1] : "data/seed.db";
/**
 * Clear the previous seed AND its write-ahead sidecars.
 *
 * Removing only the database left `seed.db-shm` and `seed.db-wal` behind, and `mergeSeed` chmods a merged seed to
 * read-only so a merged file cannot be edited and re-merged under the same size marker. The next run then deleted
 * the database, created a new one, and SQLite opened the surviving 444 shared-memory file to enable WAL - failing
 * with "attempt to write a readonly database" pointing at the schema statement, which is nowhere near the cause.
 * A database is its three files; deleting one of them is not deleting it.
 */
for (const f of [OUT, `${OUT}-wal`, `${OUT}-shm`]) if (existsSync(f)) rmSync(f, { force: true });

/**
 * Every table the collector needs to inherit, and the filter that makes two of them affordable.
 *
 * `trades` was deliberately absent on the grounds that it is bulk rather than asset. That was half right and the
 * wrong half mattered: 17.5M trade rows are indeed bulk, but the curve buys at or above BUYOUT_SOL inside them are
 * the buyout evidence - what `findBuyout` reads and what `servicedb` copies into the published record. Leaving them
 * out produced a collector whose record carried 580 buyouts against the laptop's 2,099, so adopting it would have
 * grown the launch count while destroying three quarters of the proof of who took the curves. The count guard on the
 * pull sees only `tokens` and would have called that growth.
 *
 * `hist_trades` is the same evidence recovered from chain by `history.ts`, which has only ever run on the laptop. A
 * collector cannot reconstruct it - the transactions are still on chain, but reaching back for them needs an
 * archival node and time. Seeding it is the only way a cloud collector ever holds the buyout history that predates
 * it, and without it the collector can never be the source of the record.
 *
 * Filtered rather than whole: 3,171 rows across both, against 18.4M unfiltered. The filter is exactly `servicedb`'s,
 * so the seed carries precisely what the published record is built from and nothing else.
 */
const EVIDENCE_WHERE: Record<string, string> = {
  trades: `WHERE market = 'curve' AND side = 'buy' AND sol >= ${BUYOUT_SOL}`,
  hist_trades: `WHERE side = 'buy' AND sol >= ${BUYOUT_SOL}`,
};
const tables = ["tokens", "operator_wallets", "operator_funders", "operator_policy", "pool_map", "runs", "signals",
  // hist_tokens travels with hist_trades or the reconstructions arrive unqualified. It is the only place that
  // records how much of a curve a rebuild actually read, and without it the record cannot tell a rebuild that read
  // a whole curve from one that read 2.5% of it — which is exactly what happened: 1,072 buyout rows published with
  // no completeness marker because the evidence was in the seed and the qualifier was not.
  "trades", "hist_trades", "hist_tokens"];

const src = new DatabaseSync(config.dbPath, { readOnly: true });
const w = openDb(OUT);   // creates the full, correct schema
/**
 * `openDb` does not create `hist_trades` - it is made by `history.ts`, which has only ever run on the laptop. The
 * seed needs somewhere to put the rows, and the collector needs the table to exist before it can receive them, so
 * the definition is stated here verbatim from the source database rather than assumed. `mergeSeed` creates it on the
 * target the same way.
 */
w.exec(`CREATE TABLE IF NOT EXISTS hist_trades (mint TEXT NOT NULL, sig TEXT NOT NULL, idx INTEGER NOT NULL,
  ts INTEGER, slot INTEGER, wallet TEXT, side TEXT, sol REAL, tokens REAL, vsol REAL, vtok REAL, is_dev INTEGER,
  PRIMARY KEY (mint, sig, idx))`);
w.exec("CREATE INDEX IF NOT EXISTS hist_trades_mint ON hist_trades(mint, ts)");
/**
 * And `hist_tokens`, for the same reason and one more: it is the qualifier on the rows above. Listing the table for
 * export without creating it here exports nothing — the copy carries only columns present in BOTH databases, so an
 * absent destination table means an empty intersection and a silent skip. Which is exactly what happened on the
 * first attempt: "hist_tokens -" in the summary, zero rows, no error.
 */
w.exec(`CREATE TABLE IF NOT EXISTS hist_tokens (
  mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, creator TEXT, curve TEXT, created_at INTEGER, complete INTEGER,
  mcap_sol REAL, mcap_usd REAL, ath_usd REAL, ath_at INTEGER, sol_usd REAL, source TEXT, status TEXT DEFAULT 'new',
  sigs INTEGER, sigs_failed INTEGER, sigs_capped INTEGER DEFAULT 0, txs_fetched INTEGER, trades INTEGER,
  buyers INTEGER, dev_pct REAL, first_ts INTEGER, last_ts INTEGER, grad_ts INTEGER, graduated_min REAL,
  peak_x REAL, error TEXT, updated_at INTEGER, dev_buy_pct REAL)`);

const CHUNK = 5_000;
for (const t of tables) {
  try {
    // Names, never positions. db.ts keeps the two schemas' column order identical by hand, and a positional copy is
    // what punishes that invariant the day it slips. Only columns present in both are carried; `runs` and `signals`
    // drop `id`, which is AUTOINCREMENT in both databases and would collide on merge.
    const srcCols = (src.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as any[]).map((r) => r.name);
    const dstCols = new Set((w.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as any[]).map((r) => r.name));
    const shared = srcCols.filter((c) => dstCols.has(c) && !(c === "id" && (t === "runs" || t === "signals" || t === "trades")));
    if (!shared.length) { console.log(`  ${t}: no shared columns, skipped`); continue; }

    const list = shared.map((c) => `"${c}"`).join(", ");
    const insert = w.prepare(`INSERT OR REPLACE INTO ${t} (${list}) VALUES (${shared.map(() => "?").join(", ")})`);
    const read = src.prepare(`SELECT ${list} FROM ${t} ${EVIDENCE_WHERE[t] ?? ""} LIMIT ? OFFSET ?`);

    let off = 0, n = 0;
    for (;;) {
      const rows = read.all(CHUNK, off) as any[];
      if (!rows.length) break;
      w.exec("BEGIN");
      for (const r of rows) insert.run(...shared.map((c) => r[c] ?? null));
      w.exec("COMMIT");
      n += rows.length; off += rows.length;
      if (n % 50_000 === 0) console.log(`  ${t}: ${n.toLocaleString()}…`);
    }
    console.log(`  ${t}: ${n.toLocaleString()} rows, ${shared.length} columns`);
  } catch (e) {
    console.log(`  ${t}: ${(e as Error).message}`);
  }
}
src.close();
w.exec("VACUUM");

const counts = tables.map((t) => {
  try { return `${t} ${(w.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c.toLocaleString()}`; } catch { return `${t} -`; }
});
w.close();
console.log(`\nwrote ${OUT} - ${(statSync(OUT).size / 1048576).toFixed(1)} MB`);
for (const c of counts) console.log(`  ${c}`);
console.log(`\nShip it with the deploy. Prove it first against a copy:`);
console.log(`  npm run mergeseed -- --db <copy-of-collector.db> --seed ${OUT} --dry-run`);
