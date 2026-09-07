/**
 * PumpSwap (post-graduation) replay — entry rules x exit rules on our own decoded AMM trade paths.
 *
 *   npm run ammreplay -- [--hours 96] [--min-n 25] [--top 30]
 *
 * For every graduated token with stored PumpSwap trades, the path is replayed trade by trade. Entry rules fire
 * on the first trade that satisfies them (within the first hour after the token's first AMM trade); the fill is
 * the first trade >= 1.5 s later. Exit rules run on the trades after the fill, also with a 1.5 s sell latency.
 * Fees: 1 % per side (0.25-0.30 % PumpSwap fee + slippage allowance). 0.1 SOL into a >= 85 SOL pool moves
 * price ~0.1 %, ignored.
 *
 * Data hygiene:
 *   - dust trades (< 1 000 tokens or < 0.0005 SOL) are dropped;
 *   - a token is skipped when its first AMM price is not within 0.25-4x of the curve graduation price
 *     (4.1e-7 SOL per token): those pools were decoded wrongly before the vault check existed;
 *   - paths that hit the storage cap (exactly 1500 AMM trades kept for uninteresting tokens) are TRUNCATED:
 *     an exit at the end of such a path is reported separately, because the token's later history is unknown.
 *
 * Reading: the grid is ~15 entries x 9 exits = many comparisons. A cell is a candidate only if it holds on
 * both days shown in the persistence table, and with n >= --min-n on each.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { isRealOutcome, organicDemand } from "./label.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]); }
const hours = Number(args.get("hours") ?? 96);
const minN = Number(args.get("min-n") ?? 25);
const top = Number(args.get("top") ?? 30);
const since = Date.now() - hours * 3600_000;
const FEE_SIDE = 0.99, LAT = 1500, MAX_X = 50, CAP_X = 20, ENTRY_WINDOW_MS = 60 * 60_000;
const GRAD_PRICE = 115 / 279_900_000; // curve price at graduation, SOL per token
const KEEP_AMM_CAPS = new Set([1500, 6000]); // storage caps ever used for uninteresting tokens' AMM trades (see index.ts finalize)

const db = openDb(config.dbPath);
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const f = (n: number | null, d = 2) => (n === null || Number.isNaN(n) ? "-" : n.toFixed(d));
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");

interface Trade { ts: number; wallet: string; side: "buy" | "sell"; sol: number; price: number }
interface Tok { mint: string; symbol: string; creator: string; created_at: number; graduated_at: number | null; mcap_sol: number | null; mcap_usd: number | null; pool_sol: number | null; verified: number | null; kol_signals: number; dev_pct: number; unique_buyers: number; late_discovery: number }
const toks = q<Tok>(
  `SELECT t.mint, t.symbol, t.creator, t.created_at, t.graduated_at, t.kol_signals, t.dev_pct, t.unique_buyers, t.late_discovery, o.mcap_sol, o.mcap_usd, o.pool_sol, o.verified
   FROM tokens t LEFT JOIN token_outcomes o ON o.mint = t.mint
   WHERE t.graduated = 1 AND t.created_at >= ? AND EXISTS (SELECT 1 FROM trades x WHERE x.mint = t.mint AND x.venue = 'amm')`,
  since,
);
const tradeStmt = db.prepare(`SELECT ts, wallet, side, sol, price FROM trades WHERE mint = ? AND venue = 'amm' AND tokens >= 1000 AND sol >= 0.0005 ORDER BY ts, id`);
const countStmt = db.prepare(`SELECT COUNT(*) n FROM trades WHERE mint = ? AND venue = 'amm'`);
const first10Stmt = db.prepare(`SELECT wallet FROM wallet_token_stats WHERE mint = ? AND first_buy_rank <= 10`);

// ---------- exits ----------
interface Exit { name: string; tp?: number; sl?: number; trailArm?: number; trailDrop?: number; maxHoldS: number; bankHalfAt?: number; flowRatio?: number; flowDrop?: number; crashDrop?: number; devSell?: boolean; flowOut?: number }
const EXITS: Exit[] = [
  { name: "time 5m", maxHoldS: 300 },
  { name: "time 30m", maxHoldS: 1800 },
  { name: "tp1.5 sl0.8 15m", tp: 1.5, sl: 0.8, maxHoldS: 900 },
  { name: "tp2 sl0.7 60m", tp: 2, sl: 0.7, maxHoldS: 3600 },
  { name: "trail15 arm1.2 sl0.8 60m", trailArm: 1.2, trailDrop: 0.15, sl: 0.8, maxHoldS: 3600 },
  { name: "trail25 arm1.5 sl0.7 6h", trailArm: 1.5, trailDrop: 0.25, sl: 0.7, maxHoldS: 6 * 3600 },
  { name: "trail35 arm1.3 sl0.6 6h devsell", trailArm: 1.3, trailDrop: 0.35, sl: 0.6, maxHoldS: 6 * 3600, devSell: true },
  { name: "ripcord (bank½@2x, flow, crash, 0.4 floor, 90m)", bankHalfAt: 2, flowRatio: 2, flowDrop: 0.25, crashDrop: 0.45, sl: 0.4, trailArm: 2, trailDrop: 0.45, maxHoldS: 5400, devSell: true },
  { name: "flow-out: net -3 SOL/60s or sl0.75, 60m", flowOut: 3, sl: 0.75, maxHoldS: 3600 },
];

/** simulate one exit rule from fill index; returns multiple after fees and the reason */
function simulate(path: Trade[], fi: number, ex: Exit, dev: string, truncated: boolean): { x: number; reason: string } | null {
  const fill = path[fi];
  const entry = fill.price / FEE_SIDE;
  const sellAt = (j: number) => { let k = j; while (k + 1 < path.length && path[k + 1].ts <= path[j].ts + LAT) k++; return path[k].price * FEE_SIDE; };
  let peak = fill.price, banked: number | null = null, high = fill.price;
  let trailing = ex.trailArm !== undefined;
  let reason: string | null = null, out: number | null = null;
  for (let j = fi + 1; j < path.length; j++) {
    const x = path[j];
    const held = (x.ts - fill.ts) / 1000;
    const m = x.price / entry;
    if (x.price > peak) peak = x.price;
    if (x.price > high) high = x.price;
    if (held >= ex.maxHoldS) { out = sellAt(j); reason = "time"; break; }
    if (ex.devSell && x.wallet === dev && x.side === "sell") { out = sellAt(j); reason = "dev-sold"; break; }
    if (ex.bankHalfAt !== undefined && banked === null && m >= ex.bankHalfAt) { banked = sellAt(j) / 2; trailing = true; peak = x.price; continue; }
    if (ex.tp !== undefined && m >= ex.tp) { out = sellAt(j); reason = "take-profit"; break; }
    if (ex.sl !== undefined && m <= ex.sl) { out = sellAt(j); reason = "stop-loss"; break; }
    if (trailing && ex.trailArm !== undefined && ex.trailDrop !== undefined && (banked !== null || peak >= entry * ex.trailArm) && x.price <= peak * (1 - ex.trailDrop)) { out = sellAt(j); reason = "trail"; break; }
    if (ex.crashDrop !== undefined) { // 10 s dump
      let k = j; while (k > fi && path[k - 1].ts >= x.ts - 10_000) k--;
      let hi = x.price; for (let z = k; z <= j; z++) hi = Math.max(hi, path[z].price);
      if (x.price <= hi * (1 - ex.crashDrop)) { out = sellAt(j); reason = "crash"; break; }
    }
    if (ex.flowRatio !== undefined || ex.flowOut !== undefined) { // 30 s / 60 s flow
      const win = ex.flowOut !== undefined ? 60_000 : 30_000;
      let bought = 0, sold = 0; for (let k = j; k >= fi && path[k].ts >= x.ts - win; k--) { if (path[k].side === "buy") bought += path[k].sol; else sold += path[k].sol; }
      if (ex.flowRatio !== undefined && ex.flowDrop !== undefined && sold >= ex.flowRatio * bought && bought > 0 && x.price <= high * (1 - ex.flowDrop)) { out = sellAt(j); reason = "flow"; break; }
      if (ex.flowOut !== undefined && bought - sold <= -ex.flowOut) { out = sellAt(j); reason = "flow-out"; break; }
    }
  }
  if (out === null) {
    if (fi === path.length - 1) return null; // nothing after the fill: unknown
    out = path[path.length - 1].price * FEE_SIDE; reason = truncated ? "end-truncated" : "end-of-data";
  }
  const x = banked !== null ? (banked + out / 2) / entry : out / entry;
  return { x: Math.min(x, MAX_X), reason: reason ?? "end-of-data" };
}

// ---------- entries ----------
interface Ctx { t0: number; p0: number; path: Trade[]; i: number; hi: number; hiIdx: number; insiders: Set<string>; buyers60: number; net60: number; buyers60prev: number; net120: number; insiderSellShare120: number; sinceLow: number; low: number }
type EntryRule = { name: string; fire: (c: Ctx) => boolean };
const ENTRIES: EntryRule[] = [
  { name: "at +10s", fire: (c) => c.path[c.i].ts >= c.t0 + 10_000 },
  { name: "at +60s", fire: (c) => c.path[c.i].ts >= c.t0 + 60_000 },
  { name: "at +5m", fire: (c) => c.path[c.i].ts >= c.t0 + 300_000 },
  { name: "at +15m", fire: (c) => c.path[c.i].ts >= c.t0 + 900_000 },
  { name: "flow: net>=+5 SOL & 10+ buyers /60s", fire: (c) => c.net60 >= 5 && c.buyers60 >= 10 },
  { name: "flow: net>=+15 SOL & 20+ buyers /60s", fire: (c) => c.net60 >= 15 && c.buyers60 >= 20 },
  { name: "flow: net>=+5 SOL/60s after +2m", fire: (c) => c.path[c.i].ts >= c.t0 + 120_000 && c.net60 >= 5 && c.buyers60 >= 10 },
  { name: "accel: buyers/60s >= 15 and 2x prior 60s", fire: (c) => c.buyers60 >= 15 && c.buyers60 >= 2 * c.buyers60prev && c.path[c.i].ts >= c.t0 + 120_000 },
  { name: "breakout: new high >= 1.3x grad after +60s", fire: (c) => c.path[c.i].ts >= c.t0 + 60_000 && c.path[c.i].price >= 1.3 * c.p0 && c.hiIdx === c.i },
  { name: "breakout: new high >= 2x grad after +5m", fire: (c) => c.path[c.i].ts >= c.t0 + 300_000 && c.path[c.i].price >= 2 * c.p0 && c.hiIdx === c.i },
  { name: "pullback: -15% from high, still >= grad, then +5% off low", fire: (c) => c.hi >= 1.15 * c.low && c.path[c.i].price >= 1.05 * c.low && c.path[c.i].price >= c.p0 && c.sinceLow > 0 && c.path[c.i].ts >= c.t0 + 60_000 },
  { name: "insiders quiet: <=20% of sells in first 2m are dev/first-10, net>0", fire: (c) => c.path[c.i].ts >= c.t0 + 120_000 && c.insiderSellShare120 <= 0.2 && c.net120 > 0 },
  { name: "insiders out: >=60% of sells in first 2m are dev/first-10, price >= grad", fire: (c) => c.path[c.i].ts >= c.t0 + 120_000 && c.insiderSellShare120 >= 0.6 && c.path[c.i].price >= c.p0 },
  { name: "held: price >= 1.5x grad at +15m", fire: (c) => c.path[c.i].ts >= c.t0 + 900_000 && c.path[c.i].price >= 1.5 * c.p0 },
  { name: "called: kol signal on this token, at +60s", fire: (c) => c.path[c.i].ts >= c.t0 + 60_000 && (c as any).kol },
];

class Agg {
  n = 0; sum = 0; wins = 0; big = 0; xs: number[] = []; reasons = new Map<string, number>(); truncEnd = 0;
  add(r: { x: number; reason: string }) { this.n++; this.sum += Math.min(r.x, CAP_X); if (r.x > 1) this.wins++; if (r.x >= 2) this.big++; this.xs.push(r.x); this.reasons.set(r.reason, (this.reasons.get(r.reason) ?? 0) + 1); if (r.reason === "end-truncated") this.truncEnd++; }
  get avg() { return this.n ? this.sum / this.n : null; }
  get med() { if (!this.n) return null; const s = [...this.xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
  get win() { return this.n ? this.wins / this.n : null; }
}
const grid = new Map<string, Agg>(); // entry|exit
const gridDay = new Map<string, Agg>(); // entry|exit|day
const cell = (m: Map<string, Agg>, k: string) => m.get(k) ?? m.set(k, new Agg()).get(k)!;
const entryCount = new Map<string, { fired: number; tokens: number }>();

let used = 0, skippedPrice = 0, skippedShort = 0, truncated = 0, realN = 0;
const perToken: { symbol: string; mint: string; day: string; truncated: boolean; minutes: number; x60: number | null; peak: number; real: boolean }[] = [];
for (const t of toks) {
  const path = tradeStmt.all(t.mint) as unknown as Trade[];
  if (path.length < 5) { skippedShort++; continue; }
  const p0 = path[0].price;
  if (!(p0 >= GRAD_PRICE * 0.25 && p0 <= GRAD_PRICE * 4)) { skippedPrice++; continue; }
  const stored = (countStmt.get(t.mint) as any).n as number;
  const trunc = KEEP_AMM_CAPS.has(stored);
  if (trunc) truncated++;
  used++;
  const t0 = path[0].ts;
  const day = new Date(t0).toISOString().slice(5, 10);
  const insiders = new Set<string>([t.creator, ...(first10Stmt.all(t.mint) as any[]).map((r) => r.wallet)]);
  const real = !!t.verified && isRealOutcome({ mcapSol: t.mcap_sol, mcapUsd: t.mcap_usd, poolSol: t.pool_sol, verified: true }) && organicDemand(db, t);
  if (real) realN++;
  // outcome summary for the token
  let x60: number | null = null; for (const x of path) { if (x.ts <= t0 + 3600_000) x60 = x.price / p0; else break; }
  perToken.push({ symbol: t.symbol, mint: t.mint, day, truncated: trunc, minutes: (path[path.length - 1].ts - t0) / 60_000, x60, peak: Math.min(Math.max(...path.map((x) => x.price)) / p0, MAX_X), real });

  const c: Ctx & { kol: boolean } = { t0, p0, path, i: 0, hi: p0, hiIdx: 0, insiders, buyers60: 0, net60: 0, buyers60prev: 0, net120: 0, insiderSellShare120: 0, sinceLow: 0, low: p0, kol: t.kol_signals > 0 };
  const fired = new Set<string>();
  let insSell120 = 0, allSell120 = 0, net120 = 0;
  let lowSinceHigh = p0;
  for (let i = 0; i < path.length; i++) {
    const x = path[i];
    if (x.ts > t0 + ENTRY_WINDOW_MS || fired.size === ENTRIES.length) break;
    c.i = i;
    if (x.price > c.hi) { c.hi = x.price; c.hiIdx = i; lowSinceHigh = x.price; c.sinceLow = 0; }
    if (x.price < lowSinceHigh) { lowSinceHigh = x.price; c.sinceLow = 0; } else c.sinceLow++;
    c.low = lowSinceHigh;
    // rolling 60 s and previous 60 s
    const b1 = new Set<string>(), b2 = new Set<string>(); let n1 = 0;
    for (let k = i; k >= 0 && path[k].ts >= x.ts - 120_000; k--) {
      const y = path[k];
      if (y.ts >= x.ts - 60_000) { if (y.side === "buy") { b1.add(y.wallet); n1 += y.sol; } else n1 -= y.sol; }
      else if (y.side === "buy") b2.add(y.wallet);
    }
    c.buyers60 = b1.size; c.net60 = n1; c.buyers60prev = b2.size;
    if (x.ts <= t0 + 120_000) { if (x.side === "sell") { allSell120 += x.sol; if (insiders.has(x.wallet)) insSell120 += x.sol; } net120 += x.side === "buy" ? x.sol : -x.sol; c.net120 = net120; c.insiderSellShare120 = allSell120 > 0 ? insSell120 / allSell120 : 0; }
    for (const e of ENTRIES) {
      if (fired.has(e.name) || !e.fire(c)) continue;
      fired.add(e.name);
      const ec = entryCount.get(e.name) ?? entryCount.set(e.name, { fired: 0, tokens: 0 }).get(e.name)!;
      ec.fired++;
      let fi = i; while (fi < path.length && path[fi].ts < x.ts + LAT) fi++;
      if (fi >= path.length) continue;
      ec.tokens++;
      for (const ex of EXITS) {
        const r = simulate(path, fi, ex, t.creator, trunc);
        if (!r) continue;
        cell(grid, `${e.name}|${ex.name}`).add(r);
        cell(gridDay, `${e.name}|${ex.name}|${day}`).add(r);
      }
    }
  }
}

console.log(`\n=== PumpSwap replay — ${used} graduated tokens with usable AMM paths (last ${hours}h); skipped ${skippedPrice} with implausible pool prices, ${skippedShort} with < 5 trades; ${truncated} paths truncated at the AMM storage cap; ${realN} verified real runners ===`);
const days = [...new Set(perToken.map((p) => p.day))].sort();
console.log("TOKEN OUTCOMES (from the first AMM trade)");
console.log("  day    n    median minutes of data  x@60m median  x@60m >= 1.5  peak >= 2x  peak >= 5x  truncated");
for (const d of days) {
  const ps = perToken.filter((p) => p.day === d);
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const x60 = ps.map((p) => p.x60).filter((v): v is number => v !== null);
  console.log(`  ${d}  ${String(ps.length).padStart(3)}  ${f(med(ps.map((p) => p.minutes)), 0).padStart(22)}  ${f(med(x60)).padStart(12)}  ${pct(x60.filter((v) => v >= 1.5).length, x60.length).padStart(12)}  ${pct(ps.filter((p) => p.peak >= 2).length, ps.length).padStart(10)}  ${pct(ps.filter((p) => p.peak >= 5).length, ps.length).padStart(10)}  ${pct(ps.filter((p) => p.truncated).length, ps.length).padStart(9)}`);
}
console.log();
console.log("ENTRY RULES: how often they fire");
for (const e of ENTRIES) { const ec = entryCount.get(e.name); console.log(`  ${e.name.padEnd(68)} fired on ${String(ec?.fired ?? 0).padStart(4)} tokens, filled ${String(ec?.tokens ?? 0).padStart(4)}`); }
console.log();
console.log("GRID — avg x (winsorized 20x) / median / win % / >=2x share, fees 1 % per side, 1.5 s latency both ways");
const exitHead = EXITS.map((x) => x.name.slice(0, 26).padEnd(28)).join("");
console.log("  entry".padEnd(70) + exitHead);
for (const e of ENTRIES) {
  let line = `  ${e.name.slice(0, 66)}`.padEnd(70);
  for (const ex of EXITS) { const a = grid.get(`${e.name}|${ex.name}`); line += (a && a.n ? `${f(a.avg)}/${f(a.med)}/${pct(a.wins, a.n)}/${pct(a.big, a.n)} n${a.n}` : "-").padEnd(28); }
  console.log(line);
}
console.log();
console.log(`BEST CELLS (n >= ${minN}), with the same cell on each day — a rule counts only if it is positive on every day`);
const rows = [...grid].filter(([, a]) => a.n >= minN).map(([k, a]) => ({ k, a })).sort((x, y) => (y.a.avg ?? 0) - (x.a.avg ?? 0)).slice(0, top);
console.log("  entry | exit".padEnd(100) + "n".padStart(5) + "  avg x" + "  median" + "  win%" + "  >=2x" + "  trunc-end" + "  " + days.map((d) => `${d}: avg/n`).join("  "));
for (const { k, a } of rows) {
  const per = days.map((d) => { const b = gridDay.get(`${k}|${d}`); return b && b.n ? `${f(b.avg)}/${b.n}` : "-"; });
  console.log(`  ${k.slice(0, 96).padEnd(98)}${String(a.n).padStart(5)}  ${f(a.avg).padStart(5)}  ${f(a.med).padStart(6)}  ${pct(a.wins, a.n).padStart(4)}  ${pct(a.big, a.n).padStart(4)}  ${pct(a.truncEnd, a.n).padStart(9)}  ${per.join("  ")}`);
}
console.log("\n  trunc-end = share of entries whose exit was forced by the end of a truncated path (unknown later history).");
console.log("  Exit reasons for the top cell:", rows.length ? [...rows[0].a.reasons].map(([r, n]) => `${r} ${n}`).join(", ") : "-");
console.log("\nA cell that is positive on one day and negative on the next is noise. Require both days, then paper-trade it live before believing it.\n");
