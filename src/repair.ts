/**
 * Repair launch provenance zeroed by the restore-overwrite bug (fixed in db.ts 2026-09-06).
 * A token restored by a detector was re-written with an empty buyer set, erasing what we had recorded at launch.
 * The per-trade rows still hold the truth for anything inside retention, so recount from them. Only ever increases.
 *   npm run repair -- [--apply]
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const APPLY = process.argv.includes("--apply");
const db = openDb(config.dbPath);

const rows = db.prepare(`
  SELECT t.mint, t.symbol, t.unique_buyers stored,
         (SELECT COUNT(DISTINCT wallet) FROM trades x WHERE x.mint=t.mint AND x.venue='curve' AND x.side='buy' AND x.is_dev=0) real_buyers,
         (SELECT COUNT(*) FROM trades x WHERE x.mint=t.mint AND x.venue='curve' AND x.side='buy') buys,
         (SELECT COALESCE(SUM(sol),0) FROM trades x WHERE x.mint=t.mint AND x.venue='curve' AND x.side='buy') buyvol
  FROM tokens t
  WHERE t.late_discovery = 0 AND COALESCE(t.unique_buyers,0) = 0
`).all() as any[];
const fixable = rows.filter((r) => r.real_buyers > 0);
console.log(`${rows.length.toLocaleString()} tokens record zero buyers; ${fixable.length.toLocaleString()} have trade rows proving otherwise\n`);
for (const r of fixable.slice(0, 12)) console.log(`  ${(r.symbol ?? "?").padEnd(14)} ${r.mint.slice(0, 6)}  stored ${r.stored ?? 0} → ${r.real_buyers} buyers, ${r.buys} buys, ${r.buyvol.toFixed(1)} SOL`);
if (!APPLY) { console.log(`\ndry run - re-run with --apply to restore these counters.`); process.exit(0); }

const up = db.prepare(`UPDATE tokens SET unique_buyers=?, buys=MAX(COALESCE(buys,0),?), buy_vol_sol=MAX(COALESCE(buy_vol_sol,0),?) WHERE mint=?`);
db.exec("BEGIN");
for (const r of fixable) up.run(r.real_buyers, r.buys, r.buyvol, r.mint);
db.exec("COMMIT");
console.log(`\nrestored buyer counts on ${fixable.length.toLocaleString()} tokens from stored trade rows.`);
console.log(`Tokens whose trades were pruned cannot be recovered; their counters stay at zero and they will read as`);
console.log(`"few outside buyers", which is a conservative error rather than a false clean.`);
