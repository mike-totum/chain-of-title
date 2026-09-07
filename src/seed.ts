/**
 * Export the archive tables into a small seed database, so a fresh collector can inherit the history rather than
 * starting blank. The provenance and the operator map are the asset; the trade rows are not.
 *   npm run seed -- [--out data/seed.db]
 * Ship the result with the deploy; the collector merges it once on boot (see mergeSeed in src/index.ts).
 */
import { statSync, rmSync, existsSync } from "node:fs";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const i = process.argv.indexOf("--out");
const OUT = i > 0 ? process.argv[i + 1] : "data/seed.db";
if (existsSync(OUT)) rmSync(OUT, { force: true });

// openDb creates the full, correct schema; then attach the live database and copy the archive tables straight across
const w = openDb(OUT);
w.exec(`ATTACH DATABASE 'file:${config.dbPath.replace(/'/g, "''")}?mode=ro' AS src`);
const tables = ["tokens", "operator_wallets", "operator_funders", "operator_policy", "pool_map", "runs", "signals"];
w.exec("BEGIN");
for (const t of tables) {
  try {
    // ALWAYS qualify with main. An unqualified name resolves to main first, then to ATTACHed databases — so when a
    // table was missing from the seed schema, `DELETE FROM operator_wallets` silently fell through to the live
    // database and destroyed the operator map (2026-09-06). Never write an unqualified DML statement under ATTACH.
    w.exec(`DELETE FROM main.${t}`);
    w.exec(`INSERT INTO main.${t} SELECT * FROM src.${t}`);
  } catch (e) { console.log(`  ${t}: ${(e as Error).message}`); }
}
w.exec("COMMIT");
w.exec("DETACH DATABASE src");
w.exec("VACUUM");
const counts = tables.map((t) => {
  try { return `${t} ${(w.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c.toLocaleString()}`; } catch { return `${t} -`; }
});
console.log(`\nwrote ${OUT} — ${(statSync(OUT).size / 1048576).toFixed(1)} MB`);
for (const c of counts) console.log(`  ${c}`);
console.log(`\nship this with the deploy; the collector merges it once on boot and then leaves it alone.`);
