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

const i = process.argv.indexOf("--out");
const OUT = i > 0 ? process.argv[i + 1] : "data/seed.db";
if (existsSync(OUT)) rmSync(OUT, { force: true });

/** Every table the collector needs to inherit. `trades` is deliberately absent: it is the bulk and not the asset. */
const tables = ["tokens", "operator_wallets", "operator_funders", "operator_policy", "pool_map", "runs", "signals"];

const src = new DatabaseSync(config.dbPath, { readOnly: true });
const w = openDb(OUT);   // creates the full, correct schema

const CHUNK = 5_000;
for (const t of tables) {
  try {
    // Names, never positions. db.ts keeps the two schemas' column order identical by hand, and a positional copy is
    // what punishes that invariant the day it slips. Only columns present in both are carried; `runs` and `signals`
    // drop `id`, which is AUTOINCREMENT in both databases and would collide on merge.
    const srcCols = (src.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as any[]).map((r) => r.name);
    const dstCols = new Set((w.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as any[]).map((r) => r.name));
    const shared = srcCols.filter((c) => dstCols.has(c) && !(c === "id" && (t === "runs" || t === "signals")));
    if (!shared.length) { console.log(`  ${t}: no shared columns, skipped`); continue; }

    const list = shared.map((c) => `"${c}"`).join(", ");
    const insert = w.prepare(`INSERT OR REPLACE INTO ${t} (${list}) VALUES (${shared.map(() => "?").join(", ")})`);
    const read = src.prepare(`SELECT ${list} FROM ${t} LIMIT ? OFFSET ?`);

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
console.log(`\nwrote ${OUT} — ${(statSync(OUT).size / 1048576).toFixed(1)} MB`);
for (const c of counts) console.log(`  ${c}`);
console.log(`\nShip it with the deploy. Prove it first against a copy:`);
console.log(`  npm run mergeseed -- --db <copy-of-collector.db> --seed ${OUT} --dry-run`);
