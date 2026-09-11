/**
 * Copy-trading on PumpSwap: does following a wallet with a visible profit record pay, and how much of the
 * result is the exit rule rather than the entry?
 *
 *   npm run ammfollow -- [--hours 96] [--min-buy 0.5]
 *
 * Every AMM buy >= --min-buy SOL on a usable path (same hygiene as ammreplay) is a candidate signal. The buying
 * wallet's record is built only from tokens whose stored path had ENDED at least 60 min before the signal:
 * realized SOL profit, number of tokens, win share. Buckets: unknown wallet (no finished tokens), losers,
 * small winners, big winners (>= +5 SOL realized and >= 60 % wins). For each signal the follower fills at the
 * first trade >= 1.5 s later and is scored under several exits (1 % fee per side, 1.5 s sell latency):
 * hold to end of data (what "held too long" looks like), 30 min time stop, tp 2x / sl 0.7, trailing exits.
 * Signals are also split by how old the token was on the AMM (fresh graduation vs hours-old survivor).
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]); }
const hours = Number(args.get("hours") ?? 96);
const minBuy = Number(args.get("min-buy") ?? 0.5);
const since = Date.now() - hours * 3600_000;
const FEE_SIDE = 0.99, LAT = 1500, MAX_X = 50, CAP_X = 20, GRAD_PRICE = 115 / 279_900_000;

const db = openDb(config.dbPath);
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const f = (n: number | null, d = 2) => (n === null || Number.isNaN(n) ? "-" : n.toFixed(d));
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");

interface Trade { ts: number; wallet: string; side: "buy" | "sell"; sol: number; price: number }
const toks = q<{ mint: string; symbol: string; creator: string; dev_pct: number }>(
  `SELECT t.mint, t.symbol, t.creator, t.dev_pct FROM tokens t WHERE t.graduated = 1 AND t.created_at >= ? AND EXISTS (SELECT 1 FROM trades x WHERE x.mint = t.mint AND x.venue = 'amm')`, since);
const tradeStmt = db.prepare(`SELECT ts, wallet, side, sol, price FROM trades WHERE mint = ? AND venue = 'amm' AND tokens >= 1000 AND sol >= 0.0005 ORDER BY ts, id`);

// load usable paths
const paths = new Map<string, { t: (typeof toks)[0]; path: Trade[]; end: number }>();
let skipped = 0;
for (const t of toks) {
  const path = tradeStmt.all(t.mint) as unknown as Trade[];
  if (path.length < 5) { skipped++; continue; }
  const p0 = path[0].price;
  if (!(p0 >= GRAD_PRICE * 0.25 && p0 <= GRAD_PRICE * 4) || t.dev_pct >= 50) { skipped++; continue; }
  paths.set(t.mint, { t, path, end: path[path.length - 1].ts });
}

// per-wallet per-token realized result (SOL out - SOL in over the stored path), keyed for the prospective record
interface WT { mint: string; end: number; pnl: number; in: number }
const walletTokens = new Map<string, WT[]>();
for (const { t, path, end } of paths.values()) {
  const acc = new Map<string, { in: number; out: number }>();
  for (const x of path) { const a = acc.get(x.wallet) ?? acc.set(x.wallet, { in: 0, out: 0 }).get(x.wallet)!; if (x.side === "buy") a.in += x.sol; else a.out += x.sol; }
  for (const [w, a] of acc) { if (w === t.creator) continue; (walletTokens.get(w) ?? walletTokens.set(w, []).get(w)!).push({ mint: t.mint, end, pnl: a.out - a.in, in: a.in }); }
}
for (const arr of walletTokens.values()) arr.sort((a, b) => a.end - b.end);

const recordAt = (w: string, ts: number) => {
  const arr = walletTokens.get(w);
  if (!arr) return { n: 0, pnl: 0, wins: 0 };
  let n = 0, pnl = 0, wins = 0;
  for (const x of arr) { if (x.end + 60 * 60_000 > ts) break; n++; pnl += x.pnl; if (x.pnl > 0) wins++; }
  return { n, pnl, wins };
};

// exits
interface Exit { name: string; tp?: number; sl?: number; trailArm?: number; trailDrop?: number; maxHoldS: number }
const EXITS: Exit[] = [
  { name: "hold to end of data", maxHoldS: 1e9 },
  { name: "time 30m", maxHoldS: 1800 },
  { name: "tp2 sl0.7 6h", tp: 2, sl: 0.7, maxHoldS: 6 * 3600 },
  { name: "trail20 arm1.15 sl0.8 6h", trailArm: 1.15, trailDrop: 0.2, sl: 0.8, maxHoldS: 6 * 3600 },
  { name: "trail30 arm1.3 sl0.7 6h", trailArm: 1.3, trailDrop: 0.3, sl: 0.7, maxHoldS: 6 * 3600 },
  { name: "sl0.85 only, 6h", sl: 0.85, maxHoldS: 6 * 3600 },
];
function simulate(path: Trade[], fi: number, ex: Exit): { x: number; reason: string } | null {
  const fill = path[fi], entry = fill.price / FEE_SIDE;
  const sellAt = (j: number) => { let k = j; while (k + 1 < path.length && path[k + 1].ts <= path[j].ts + LAT) k++; return path[k].price * FEE_SIDE; };
  let peak = fill.price, out: number | null = null, reason = "";
  for (let j = fi + 1; j < path.length; j++) {
    const x = path[j], m = x.price / entry, held = (x.ts - fill.ts) / 1000;
    if (x.price > peak) peak = x.price;
    if (held >= ex.maxHoldS) { out = sellAt(j); reason = "time"; break; }
    if (ex.tp !== undefined && m >= ex.tp) { out = sellAt(j); reason = "tp"; break; }
    if (ex.sl !== undefined && m <= ex.sl) { out = sellAt(j); reason = "sl"; break; }
    if (ex.trailArm !== undefined && ex.trailDrop !== undefined && peak >= entry * ex.trailArm && x.price <= peak * (1 - ex.trailDrop)) { out = sellAt(j); reason = "trail"; break; }
  }
  if (out === null) { if (fi >= path.length - 1) return null; out = path[path.length - 1].price * FEE_SIDE; reason = "end"; }
  return { x: Math.min(out / entry, MAX_X), reason };
}

class Agg {
  n = 0; sum = 0; wins = 0; big = 0; xs: number[] = []; endShare = 0;
  add(r: { x: number; reason: string }) { this.n++; this.sum += Math.min(r.x, CAP_X); if (r.x > 1) this.wins++; if (r.x >= 2) this.big++; this.xs.push(r.x); if (r.reason === "end") this.endShare++; }
  get avg() { return this.n ? this.sum / this.n : null; }
  get med() { if (!this.n) return null; const s = [...this.xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
  cell() { return this.n ? `${f(this.avg)}/${f(this.med)}/${pct(this.wins, this.n)}/${pct(this.big, this.n)} n${this.n}` : "-"; }
}
const grid = new Map<string, Agg>();
const cell = (k: string) => grid.get(k) ?? grid.set(k, new Agg()).get(k)!;
const gridDay = new Map<string, Agg>(); // bucket|exit|day
const dcell = (k: string) => gridDay.get(k) ?? gridDay.set(k, new Agg()).get(k)!;
const BUCKETS = ["unknown wallet", "loser (<0 SOL)", "small winner (0-5 SOL)", "big winner (>=5 SOL, >=60% wins)", "big winner, token >= 1h on AMM", "big winner, token < 10m on AMM", "big winner, mcap >= 2.5x grad (~$200k+)", "any buy (control)", "any buy, token >= 1h on AMM (control)", "any buy, mcap >= 2.5x grad (~$200k+) (control)", "any buy, mcap 2.5-35x grad (~$200k-3M) (control)", "LIVE RULE: first buy >=0.5 SOL at >=2.5x grad with >=30 buyers so far (one per token)", "in band >= 10 min already (any buy)", "in band >= 10 min, 2nd+ hour on AMM (any buy)", "band, NOT chasing (price <= 1.15x price 2 min ago)", "band, chasing (price > 1.15x price 2 min ago)", "band, >= 1h on AMM, not chasing", "band, >= 1h on AMM, >= 30 AMM buyers, not chasing"];
const perWalletFollow = new Map<string, { n: number; sum: number }>();
let signals = 0;
for (const { path } of paths.values()) {
  const t0 = path[0].ts;
  const seen = new Set<string>(); // one signal per wallet per token
  const buyersSoFar = new Set<string>();
  let liveFired = false, firstInBand: number | null = null;
  for (let i = 0; i < path.length; i++) {
    const x = path[i];
    if (x.side === "buy") buyersSoFar.add(x.wallet);
    if (firstInBand === null && x.price / GRAD_PRICE >= 2.5) firstInBand = x.ts;
    if (x.side !== "buy" || x.sol < minBuy || seen.has(x.wallet)) continue;
    seen.add(x.wallet);
    let fi = i + 1; while (fi < path.length && path[fi].ts < x.ts + LAT) fi++;
    if (fi >= path.length) continue;
    const r = recordAt(x.wallet, x.ts);
    const ageMin = (x.ts - t0) / 60_000;
    const big = r.n >= 3 && r.pnl >= 5 && r.wins / r.n >= 0.6;
    const labels = [
      r.n === 0 ? "unknown wallet" : r.pnl < 0 ? "loser (<0 SOL)" : big ? "big winner (>=5 SOL, >=60% wins)" : "small winner (0-5 SOL)",
      "any buy (control)",
    ];
    if (big && ageMin >= 60) labels.push("big winner, token >= 1h on AMM");
    if (big && ageMin < 10) labels.push("big winner, token < 10m on AMM");
    if (ageMin >= 60) labels.push("any buy, token >= 1h on AMM (control)");
    const mc = x.price / GRAD_PRICE; // multiple of the graduation cap at the signal
    if (mc >= 2.5) { labels.push("any buy, mcap >= 2.5x grad (~$200k+) (control)"); if (big) labels.push("big winner, mcap >= 2.5x grad (~$200k+)"); }
    if (mc >= 2.5 && mc <= 35) labels.push("any buy, mcap 2.5-35x grad (~$200k-3M) (control)");
    if (mc >= 2.5) {
      let k = i; while (k > 0 && path[k - 1].ts >= x.ts - 120_000) k--;
      const chasing = x.price > 1.15 * path[k].price;
      labels.push(chasing ? "band, chasing (price > 1.15x price 2 min ago)" : "band, NOT chasing (price <= 1.15x price 2 min ago)");
      if (!chasing && ageMin >= 60) { labels.push("band, >= 1h on AMM, not chasing"); if (buyersSoFar.size >= 30) labels.push("band, >= 1h on AMM, >= 30 AMM buyers, not chasing"); }
    }
    if (!liveFired && mc >= 2.5 && buyersSoFar.size >= 30) { liveFired = true; labels.push("LIVE RULE: first buy >=0.5 SOL at >=2.5x grad with >=30 buyers so far (one per token)"); }
    if (mc >= 2.5 && firstInBand !== null && x.ts - firstInBand >= 10 * 60_000) { labels.push("in band >= 10 min already (any buy)"); if (ageMin >= 60) labels.push("in band >= 10 min, 2nd+ hour on AMM (any buy)"); }
    signals++;
    for (const ex of EXITS) {
      const res = simulate(path, fi, ex);
      if (!res) continue;
      const day = new Date(x.ts).toISOString().slice(5, 10);
      for (const l of labels) { cell(`${l}|${ex.name}`).add(res); dcell(`${l}|${ex.name}|${day}`).add(res); }
      if (big && ex.name === "trail30 arm1.3 sl0.7 6h") { const pw = perWalletFollow.get(x.wallet) ?? perWalletFollow.set(x.wallet, { n: 0, sum: 0 }).get(x.wallet)!; pw.n++; pw.sum += Math.min(res.x, CAP_X); }
    }
  }
}
console.log(`\n=== PumpSwap copy-trading - ${paths.size} usable graduated tokens (${skipped} skipped), ${signals} AMM buys >= ${minBuy} SOL replayed as follow signals (last ${hours}h) ===`);
console.log("Wallet record = realized SOL on tokens whose stored path ended >= 60 min before the signal (prospective). Cells: avg x (winsorized 20x) / median / win % / >=2x share, fees 1 % per side, 1.5 s latency both ways.\n");
console.log("  signal bucket".padEnd(44) + EXITS.map((e) => e.name.padEnd(30)).join(""));
for (const b of BUCKETS) console.log(`  ${b}`.padEnd(44) + EXITS.map((e) => (grid.get(`${b}|${e.name}`)?.cell() ?? "-").padEnd(30)).join(""));
const endShare = grid.get("any buy (control)|hold to end of data");
console.log(`\n  "hold to end of data" is bounded by our watch window (median ~30 min of AMM data per token); ${endShare ? pct(endShare.endShare, endShare.n) : "-"} of those exits are the data ending, not a decision.`);
{
  const days = [...new Set([...gridDay.keys()].map((k) => k.split("|")[2]))].sort();
  console.log("\n  DAY BY DAY (persistence) - avg x / win % / n per day of the signal");
  for (const b of ["any buy (control)", "any buy, mcap 2.5-35x grad (~$200k-3M) (control)", "any buy, token >= 1h on AMM (control)", "LIVE RULE: first buy >=0.5 SOL at >=2.5x grad with >=30 buyers so far (one per token)", "in band >= 10 min already (any buy)", "in band >= 10 min, 2nd+ hour on AMM (any buy)", "band, NOT chasing (price <= 1.15x price 2 min ago)", "band, chasing (price > 1.15x price 2 min ago)", "band, >= 1h on AMM, not chasing", "band, >= 1h on AMM, >= 30 AMM buyers, not chasing", "big winner (>=5 SOL, >=60% wins)"])
    for (const e of ["hold to end of data", "trail30 arm1.3 sl0.7 6h", "trail20 arm1.15 sl0.8 6h"]) {
      const cells = days.map((d) => { const a = gridDay.get(`${b}|${e}|${d}`); return a && a.n ? `${d}: ${f(a.avg)}/${pct(a.wins, a.n)}/n${a.n}` : `${d}: -`; });
      console.log(`    ${(b + " | " + e).slice(0, 78).padEnd(80)} ${cells.join("   ")}`);
    }
}
const pw = [...perWalletFollow].filter(([, v]) => v.n >= 5).map(([w, v]) => ({ w, n: v.n, avg: v.sum / v.n })).sort((a, b) => b.avg - a.avg);
if (pw.length) {
  console.log(`\n  Followed "big winner" wallets with >= 5 signals (trail30 exit): best and worst`);
  for (const r of [...pw.slice(0, 5), ...pw.slice(-5)]) console.log(`    ${r.w.slice(0, 4)}…${r.w.slice(-4)}  signals ${String(r.n).padStart(3)}  avg ${f(r.avg)}x`);
}
console.log("\nReading: if 'big winner' rows beat 'any buy' rows under the same exit, the wallet's record carries information. If every row is < 1 under 'hold' but > 1 under a trailing exit, the exit was the leak.\n");
