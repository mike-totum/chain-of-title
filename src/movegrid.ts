/** Does a simple exit rule pay on [movement] signals? Replays each signal's real AMM path with a take-profit /
 *  stop-loss grid, splitting by top-buyer share and by whether the ticker belongs to a known factory family.
 *  npm run movegrid -- [--hours 48] [--fee 0.005] */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const HOURS = arg("--hours", 48), FEE = arg("--fee", 0.005), MAXH = arg("--maxhold", 6);
const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");

const sigs = db.prepare(`SELECT mint, symbol, text, seen_at FROM signals WHERE source='movement' AND seen_at >= ? ORDER BY seen_at`)
  .all(Date.now() - HOURS * 3600_000) as { mint: string; symbol: string; text: string; seen_at: number }[];
const pathQ = db.prepare(`SELECT ts, price, sol FROM trades WHERE mint=? AND market='amm' AND ts>=? ORDER BY ts LIMIT 8000`);

/** the wash factory relaunches the same ticker families all day; they should not be counted as organic demand */
const FAMILY = /^(pons|z|stonk|wofi|usms|rst|lqx|goaf|wotf|ftfs|uotf)/i;
type Row = { sym: string; top: number; family: boolean; path: { ts: number; price: number }[]; entry: number };
const rows: Row[] = [];
for (const s of sigs) {
  const p = (pathQ.all(s.mint, s.seen_at + 2000) as { ts: number; price: number; sol: number }[]).filter((x) => x.price > 0 && x.sol >= 0.01);
  if (p.length < 5) continue;
  const m = /top buyer (\d+)%/.exec(s.text ?? "");
  rows.push({ sym: s.symbol ?? "?", top: m ? Number(m[1]) : -1, family: FAMILY.test(s.symbol ?? ""), path: p, entry: p[0].price });
}
console.log(`${rows.length} movement signals with a replayable AMM path (last ${HOURS} h), fee ${(FEE * 100).toFixed(2)}% round trip, max hold ${MAXH} h\n`);

/** walk the real path: take profit at tp, stop at sl, else exit at the last print inside the hold window */
function sim(r: Row, tp: number, sl: number): number {
  const deadline = r.path[0].ts + MAXH * 3600_000;
  for (const x of r.path) {
    if (x.ts > deadline) break;
    const m = x.price / r.entry;
    if (m >= tp) return tp - FEE;
    if (m <= sl) return sl - FEE;
  }
  const last = r.path.filter((x) => x.ts <= deadline).pop() ?? r.path[0];
  return last.price / r.entry - FEE;
}

function grid(label: string, set: Row[]) {
  if (set.length < 5) { console.log(`\n${label}: n=${set.length}, too few`); return; }
  console.log(`\n${label}  (n=${set.length})`);
  console.log("  TP \\ SL      0.60    0.70    0.80");
  for (const tp of [1.3, 1.5, 2.0, 3.0]) {
    const cells = [0.6, 0.7, 0.8].map((sl) => {
      const rs = set.map((r) => sim(r, tp, sl));
      return (rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3);
    });
    console.log(`  ${tp.toFixed(1)}x       ${cells.map((c) => c.padStart(6)).join("  ")}`);
  }
  const hold = set.map((r) => sim(r, 1e9, 0)); // no rules: hold to the window end
  console.log(`  hold, no rules: ${(hold.reduce((a, b) => a + b, 0) / hold.length).toFixed(3)}`);
}

grid("ALL MOVEMENT SIGNALS", rows);
grid("TOP BUYER <= 20% (broad crowd)", rows.filter((r) => r.top >= 0 && r.top <= 20));
grid("TOP BUYER 21-40% (concentrated)", rows.filter((r) => r.top > 20));
grid("NOT a factory ticker family", rows.filter((r) => !r.family));
grid("factory ticker family (PONS*/Z*/STONK*...)", rows.filter((r) => r.family));
grid("crowd AND not factory", rows.filter((r) => r.top >= 0 && r.top <= 20 && !r.family));
