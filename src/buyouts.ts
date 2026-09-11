/** Does a big single curve buy ("buyout") predict a run?  Behaviour-based, no wallet list.
 *  npm run buyouts -- [--hours 96] [--min-sol 40]
 *  For every token whose curve received a single buy >= MIN_SOL, measures what a follower would have made
 *  entering at the first AMM print after the buyout, and how that varies with the token's state at buyout time. */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const HOURS = arg("--hours", 96), MIN_SOL = arg("--min-sol", 40);
const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");
const since = Date.now() - HOURS * 3600_000;

type Buyout = { mint: string; symbol: string; wallet: string; sol: number; ts: number; created: number; devPct: number; graduated: number; buyers: number };
const buyouts = db.prepare(`
  SELECT t.mint, tk.symbol, t.wallet, MAX(t.sol) sol, MIN(t.ts) ts,
         tk.created_at created, tk.dev_pct devPct, tk.graduated, tk.unique_buyers buyers
  FROM trades t JOIN tokens tk ON tk.mint = t.mint
  WHERE t.market = 'curve' AND t.side = 'buy' AND t.sol >= ? AND t.ts >= ?
  GROUP BY t.mint`).all(MIN_SOL, since) as Buyout[];

console.log(`${buyouts.length} tokens with a >= ${MIN_SOL} SOL single curve buy in the last ${HOURS} h (${(buyouts.length / (HOURS / 24)).toFixed(0)}/day)\n`);

const ammAfter = db.prepare(`SELECT ts, price, sol, side FROM trades WHERE mint = ? AND market = 'amm' AND ts >= ? ORDER BY ts LIMIT 4000`);
const curveBefore = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(sol),0) vol FROM trades WHERE mint = ? AND market = 'curve' AND ts < ? AND ts >= ?`);

type Row = Buyout & { ageH: number; quietH: number; entry: number; mx1: number; mx6: number; mx24: number; last: number; n: number };
const rows: Row[] = [];
for (const b of buyouts) {
  const path = ammAfter.all(b.mint, b.ts) as { ts: number; price: number; sol: number; side: string }[];
  const real = path.filter((p) => p.price > 0 && p.sol >= 0.01);
  if (real.length < 5) continue;                       // no followable market
  const entry = real[0].price;
  if (!(entry > 0)) continue;
  const upTo = (h: number) => { let m = 0; for (const p of real) { if (p.ts - b.ts > h * 3600_000) break; if (p.price > m) m = p.price; } return m / entry; };
  const q = curveBefore.get(b.mint, b.ts, b.ts - 3600_000) as { n: number; vol: number };
  rows.push({ ...b, ageH: (b.ts - b.created) / 3600_000, quietH: q.n, entry,
    mx1: upTo(1), mx6: upTo(6), mx24: upTo(24), last: real[real.length - 1].price / entry, n: real.length });
}
console.log(`${rows.length} of them had >= 5 AMM prints after the buyout (a follower could act)\n`);

const pct = (a: Row[], f: (r: Row) => boolean) => a.length ? (100 * a.filter(f).length / a.length).toFixed(0) + "%" : "-";
const avg = (a: Row[], f: (r: Row) => number) => a.length ? (a.reduce((s, r) => s + f(r), 0) / a.length).toFixed(2) : "-";
const med = (a: Row[], f: (r: Row) => number) => { if (!a.length) return "-"; const s = a.map(f).sort((x, y) => x - y); return s[Math.floor(s.length / 2)].toFixed(2); };

function table(title: string, groups: [string, Row[]][]) {
  console.log(`\n${title}`);
  console.log("bucket                     n     avg6h  med6h  >=2x   >=5x   >=10x  avg24h  last");
  for (const [name, g] of groups) {
    if (!g.length) { console.log(`${name.padEnd(24)}  ${String(g.length).padStart(4)}   -`); continue; }
    console.log(`${name.padEnd(24)}  ${String(g.length).padStart(4)}  ${avg(g, r => r.mx6).padStart(6)} ${med(g, r => r.mx6).padStart(6)} ${pct(g, r => r.mx6 >= 2).padStart(5)}  ${pct(g, r => r.mx6 >= 5).padStart(5)}  ${pct(g, r => r.mx6 >= 10).padStart(5)}  ${avg(g, r => r.mx24).padStart(6)}  ${avg(g, r => r.last).padStart(5)}`);
  }
}

const bucket = (f: (r: Row) => string, order: string[]) => order.map((k) => [k, rows.filter((r) => f(r) === k)] as [string, Row[]]);

table("ALL BUYOUTS (entry = first AMM print after the buyout; multiples vs that entry)", [["all", rows]]);

table("BY TOKEN AGE AT BUYOUT (the 'dormant curve' thesis)",
  bucket((r) => r.ageH < 0.25 ? "< 15 min (fresh)" : r.ageH < 1 ? "15-60 min" : r.ageH < 6 ? "1-6 h" : r.ageH < 24 ? "6-24 h" : "> 24 h (dormant)",
    ["< 15 min (fresh)", "15-60 min", "1-6 h", "6-24 h", "> 24 h (dormant)"]));

table("BY CURVE ACTIVITY IN THE HOUR BEFORE THE BUYOUT",
  bucket((r) => r.quietH === 0 ? "0 trades (dead)" : r.quietH < 10 ? "1-9" : r.quietH < 50 ? "10-49" : "50+ (busy)",
    ["0 trades (dead)", "1-9", "10-49", "50+ (busy)"]));

table("BY DEV SHARE OF SUPPLY (wash filter)",
  bucket((r) => r.devPct >= 50 ? "dev >= 50% (factory)" : r.devPct >= 20 ? "dev 20-50%" : "dev < 20% (organic)",
    ["dev < 20% (organic)", "dev 20-50%", "dev >= 50% (factory)"]));

table("BY BUYOUT SIZE",
  bucket((r) => r.sol >= 200 ? ">= 200 SOL" : r.sol >= 80 ? "80-200 SOL" : r.sol >= 60 ? "60-80 SOL" : "40-60 SOL",
    ["40-60 SOL", "60-80 SOL", "80-200 SOL", ">= 200 SOL"]));

const organicDormant = rows.filter((r) => r.devPct < 50 && r.ageH >= 1 && r.quietH < 50);
table("COMBINED: dormant (>= 1 h old, < 50 curve trades in the prior hour) AND dev < 50 %", [["combined", organicDormant]]);

console.log("\nBIGGEST RUNS AFTER A BUYOUT (6 h)");
console.log("symbol        mint      buyout SOL  age at buyout  prior-h trades  dev%   max6h  max24h  AMM prints");
for (const r of [...rows].sort((a, b) => b.mx6 - a.mx6).slice(0, 25))
  console.log(`${(r.symbol ?? "?").slice(0, 12).padEnd(12)}  ${r.mint.slice(0, 6)}  ${r.sol.toFixed(0).padStart(10)}  ${(r.ageH < 1 ? (r.ageH * 60).toFixed(0) + " min" : r.ageH.toFixed(1) + " h").padStart(13)}  ${String(r.quietH).padStart(14)}  ${r.devPct.toFixed(0).padStart(4)}  ${r.mx6.toFixed(1).padStart(6)}  ${r.mx24.toFixed(1).padStart(6)}  ${String(r.n).padStart(10)}`);
