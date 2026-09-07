/** Grade the new live detectors: what happened after each [movement] and [buyout] signal.
 *  npm run movements -- [--hours 48]
 *  Entry is the first AMM print at least FILL s after the signal (a follower cannot fill on the trigger print itself). */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const HOURS = arg("--hours", 48), FILL_S = arg("--fill", 2);
const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");
const since = Date.now() - HOURS * 3600_000;

const sigs = db.prepare(`SELECT source, mint, symbol, text, seen_at FROM signals
  WHERE source IN ('movement','buyout','lategrad') AND seen_at >= ? ORDER BY seen_at`).all(since) as
  { source: string; mint: string; symbol: string; text: string; seen_at: number }[];

const path = db.prepare(`SELECT ts, price, sol FROM trades WHERE mint = ? AND venue = 'amm' AND ts >= ? ORDER BY ts LIMIT 6000`);
type R = { source: string; symbol: string; mint: string; text: string; at: number; entry: number; mx: (h: number) => number; last: number; n: number };
const rows: R[] = [];
for (const s of sigs) {
  const p = (path.all(s.mint, s.seen_at + FILL_S * 1000) as { ts: number; price: number; sol: number }[]).filter((x) => x.price > 0 && x.sol >= 0.01);
  if (p.length < 3) continue;
  const entry = p[0].price;
  const mx = (h: number) => { let m = 0; for (const x of p) { if (x.ts - s.seen_at > h * 3600_000) break; if (x.price > m) m = x.price; } return m / entry; };
  rows.push({ source: s.source, symbol: s.symbol ?? "?", mint: s.mint, text: s.text, at: s.seen_at, entry, mx, last: p[p.length - 1].price / entry, n: p.length });
}

const fired = (src: string) => sigs.filter((s) => s.source === src).length;
console.log(`last ${HOURS} h: ${fired("movement")} movement, ${fired("buyout")} buyout, ${fired("lategrad")} late-graduation signals; ${rows.length} with a followable AMM path\n`);

const pct = (a: R[], f: (r: R) => boolean) => a.length ? (100 * a.filter(f).length / a.length).toFixed(0) + "%" : "-";
const avg = (a: R[], f: (r: R) => number) => a.length ? (a.reduce((s, r) => s + f(r), 0) / a.length).toFixed(2) : "-";
const med = (a: R[], f: (r: R) => number) => { if (!a.length) return "-"; const s = a.map(f).sort((x, y) => x - y); return s[Math.floor(s.length / 2)].toFixed(2); };

console.log("source     n    avg1h  med1h  avg6h  med6h  >=1.5x  >=3x  >=10x  last  (multiples vs the first fillable print)");
for (const src of ["movement", "buyout", "lategrad"]) {
  const g = rows.filter((r) => r.source === src);
  if (!g.length) { console.log(`${src.padEnd(9)}  ${String(g.length).padStart(3)}   no followable path yet`); continue; }
  console.log(`${src.padEnd(9)}  ${String(g.length).padStart(3)}  ${avg(g, r => r.mx(1)).padStart(5)}  ${med(g, r => r.mx(1)).padStart(5)}  ${avg(g, r => r.mx(6)).padStart(5)}  ${med(g, r => r.mx(6)).padStart(5)}  ${pct(g, r => r.mx(6) >= 1.5).padStart(6)}  ${pct(g, r => r.mx(6) >= 3).padStart(4)}  ${pct(g, r => r.mx(6) >= 10).padStart(5)}  ${avg(g, r => r.last).padStart(4)}`);
}

console.log("\nEVERY SIGNAL (newest first)");
console.log("when              source     symbol        mint      max1h  max6h   last  prints  detail");
for (const r of [...rows].reverse().slice(0, 60))
  console.log(`${new Date(r.at).toISOString().slice(5, 16)}  ${r.source.padEnd(9)}  ${r.symbol.slice(0, 12).padEnd(12)}  ${r.mint.slice(0, 6)}  ${r.mx(1).toFixed(2).padStart(5)}  ${r.mx(6).toFixed(2).padStart(5)}  ${r.last.toFixed(2).padStart(5)}  ${String(r.n).padStart(6)}  ${r.text}`);
