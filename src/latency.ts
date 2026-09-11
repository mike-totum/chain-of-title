/**
 * Latency and hold-time sensitivity for copy-trading early buyers.
 *
 *   npm run latency -- [--hours 72] [--sample 20000]
 *
 * For each early curve buy (>= 0.05 SOL within 60 s of launch) by a wallet with 3+ finished prior tokens,
 * the path of stored trades after that buy is replayed: we "fill" at the first trade >= L ms after the
 * wallet's buy, and "exit" at the last trade <= H s after our fill (fees 3 % round trip). Rows are split
 * into wallets whose prior tokens paid outsiders >= 50 % of the time (the "good" set) and the rest.
 * If the good set only beats the rest at L = 0, the edge is latency, not judgement.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]); }
const hours = Number(args.get("hours") ?? 72);
const sample = Number(args.get("sample") ?? 20000);
const since = Date.now() - hours * 3600_000;
const FEE = 0.97, WATCH_MS = config.watchMinutes * 60_000, MAX_X = 50, CAP_X = 20;
const LAT = [0, 300, 700, 1500, 3000];
const HOLD = [5, 15, 30, 60, 180, 900];

const db = openDb(config.dbPath);
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const f = (n: number | null, d = 2) => (n === null || Number.isNaN(n) ? "-" : n.toFixed(d));

const toks = new Map<string, { created_at: number; launch_price: number; p_15m: number | null; graduated_at: number | null }>();
for (const t of q(`SELECT mint, created_at, launch_price, p_15m, graduated_at FROM tokens WHERE created_at >= ? AND finalized = 1 AND late_discovery = 0 AND launch_price > 0`, since)) toks.set(t.mint, t);
const rows = q<{ wallet: string; mint: string; first_buy_at: number; first_buy_slot_delta: number | null }>(
  `SELECT wallet, mint, first_buy_at, first_buy_slot_delta FROM wallet_token_stats WHERE token_created_at >= ? AND is_dev = 0 AND first_buy_age_s <= 60 AND sol_in >= 0.05 ORDER BY first_buy_at`, since);
const pathStmt = db.prepare(`SELECT ts, price FROM trades WHERE mint = ? AND market = 'curve' AND ts >= ? AND ts <= ? ORDER BY ts, id`);

class Agg { n = 0; sum = 0; wins = 0; xs: number[] = []; add(x: number) { if (x > MAX_X) return; this.n++; this.sum += Math.min(x, CAP_X); if (x > 1) this.wins++; this.xs.push(x); }
  get avg() { return this.n ? this.sum / this.n : null; } get win() { return this.n ? this.wins / this.n : null; }
  get med() { if (!this.n) return null; const s = [...this.xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; } }
const grid = { good: new Map<string, Agg>(), rest: new Map<string, Agg>() };
const TP = [1.05, 1.1, 1.15, 1.25, 1.5], TSTOP = [15, 30, 60, 180];
const scalp = { good: new Map<string, Agg>(), rest: new Map<string, Agg>(), launch: new Map<string, Agg>() };
const scell = (g: keyof typeof scalp, k: string) => scalp[g].get(k) ?? scalp[g].set(k, new Agg()).get(k)!;
/** replay a scalp from `fi` (fill index) on `path`: returns exit/fill multiple after fees, for each TP x time-stop, with and without a -30 % stop */
function replayScalp(g: keyof typeof scalp, path: { ts: number; price: number }[], fi: number, end: number) {
  const fill = path[fi];
  const sellAfter = (j: number) => { // we see the print at j, our sell lands 1.5 s later at the curve price then
    let k = j; while (k + 1 < path.length && path[k + 1].ts <= path[j].ts + 1500) k++;
    return path[k].price;
  };
  for (const tp of TP) for (const T of TSTOP) for (const sl of [false, true]) {
    let ex: number | null = null, last = fill;
    for (let j = fi + 1; j < path.length && path[j].ts <= end; j++) {
      const x = path[j];
      if (x.ts > fill.ts + T * 1000) break;
      last = x;
      if (x.price >= fill.price * tp) { ex = sellAfter(j); break; }
      if (sl && x.price <= fill.price * 0.7) { ex = sellAfter(j); break; }
    }
    if (ex === null) { if (last === fill) continue; ex = last.price; } // time stop at the last print before T (unknown if nothing printed)
    scell(g, `${tp}|${T}|${sl ? "sl" : "nosl"}`).add((FEE * ex) / fill.price);
  }
}
const peak60 = { good: new Agg(), rest: new Agg() };
const cell = (g: "good" | "rest", L: number, H: number) => { const k = `${L}|${H}`; return grid[g].get(k) ?? grid[g].set(k, new Agg()).get(k)!; };

// prospective wallet records (same definition as habits.ts): share of prior tokens that paid an outsider at 15 min
const rec = new Map<string, { n: number; wins: number; sb: number; queue: { at: number; win: boolean; sb: boolean }[] }>();
let used = { good: 0, rest: 0 }, skipped = 0;
const stride = Math.max(1, Math.floor(rows.length / sample));
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const t = toks.get(r.mint);
  if (!t) continue;
  const w = rec.get(r.wallet) ?? rec.set(r.wallet, { n: 0, wins: 0, sb: 0, queue: [] }).get(r.wallet)!;
  while (w.queue.length && w.queue[0].at + WATCH_MS <= t.created_at) { const x = w.queue.shift()!; w.n++; if (x.win) w.wins++; if (x.sb) w.sb++; }
  const win = t.p_15m !== null && (FEE * t.p_15m) / t.launch_price > 1;
  w.queue.push({ at: t.created_at, win, sb: r.first_buy_slot_delta !== null && r.first_buy_slot_delta <= 1 });
  if (w.n < 3 || w.sb * 2 >= w.n) continue;
  if (i % stride !== 0) continue;
  const g: "good" | "rest" = w.wins / w.n >= 0.5 ? "good" : "rest";
  const path = pathStmt.all(r.mint, r.first_buy_at, r.first_buy_at + 16 * 60_000) as { ts: number; price: number }[];
  if (path.length < 2) { skipped++; continue; }
  const end = t.graduated_at ?? Infinity;
  let any = false;
  for (const L of LAT) {
    const fi = path.findIndex((x) => x.ts >= r.first_buy_at + L);
    if (fi < 0 || path[fi].ts > end) continue;
    const fill = path[fi];
    if (!(fill.price > 0)) continue;
    any = true;
    for (const H of HOLD) {
      // exit = last trade at or before fill + H s (the curve price then); if the token graduated first, exit at the last curve trade
      let ex = fill;
      for (let j = fi; j < path.length && path[j].ts <= fill.ts + H * 1000; j++) ex = path[j];
      if (ex === fill && H > 0 && path.length - 1 === fi) continue; // no trade after fill: unknown
      cell(g, L, H).add((FEE * ex.price) / fill.price);
    }
    if (L === 1500) replayScalp(g, path, fi, end);
    if (L === 1500) { let mx = fill.price; for (let j = fi; j < path.length && path[j].ts <= fill.ts + 60_000; j++) mx = Math.max(mx, path[j].price); peak60[g].add(mx / fill.price); }
  }
  if (any) used[g]++;
}
// control: every launch, entry at the first trade >= 2 s after creation
const allToks = [...toks.entries()];
const tstride = Math.max(1, Math.floor(allToks.length / 8000));
let launchUsed = 0;
for (let i = 0; i < allToks.length; i += tstride) {
  const [mint, t] = allToks[i];
  const path = pathStmt.all(mint, t.created_at, t.created_at + 16 * 60_000) as { ts: number; price: number }[];
  const fi = path.findIndex((x) => x.ts >= t.created_at + 2000);
  if (fi < 0 || fi === path.length - 1 || !(path[fi].price > 0)) continue;
  launchUsed++;
  replayScalp("launch", path, fi, t.graduated_at ?? Infinity);
}
console.log(`\n=== copy-trade latency / hold sensitivity - ${used.good} "good"-wallet buys, ${used.rest} other early buys replayed (sample stride ${stride}, ${skipped} without a stored path) ===`);
console.log(`"good" = wallet whose prior finished tokens paid an outsider at 15 min >= 50 % of the time (prospective). Return = 0.97 x exit / fill; avg winsorized at 20x.\n`);
for (const g of ["good", "rest"] as const) {
  console.log(`${g.toUpperCase()} - rows: fill latency after the wallet's buy; columns: hold time. Each cell: avg x / median x / win %`);
  const head = "  latency ".padEnd(12) + HOLD.map((h) => `hold ${h}s`.padEnd(22)).join("");
  console.log(head);
  for (const L of LAT) {
    let line = `  ${L} ms`.padEnd(12);
    for (const H of HOLD) { const a = grid[g].get(`${L}|${H}`); line += (a && a.n ? `${f(a.avg)} / ${f(a.med)} / ${a.win === null ? "-" : (100 * a.win).toFixed(0)}% (n=${a.n})` : "-").padEnd(22); }
    console.log(line);
  }
  console.log(`  best price within 60 s of a 1.5 s fill: avg ${f(peak60[g].avg)}x, median ${f(peak60[g].med)}x, reached >1x on ${peak60[g].win === null ? "-" : (100 * peak60[g].win).toFixed(0)}%\n`);
}
for (const g of ["good", "rest", "launch"] as const) {
  console.log(`SCALP after a 1.5 s fill - ${g === "launch" ? `every launch, entry 2 s after creation (${launchUsed} sampled)` : g + " wallets"}: take profit at +X % (sold 1.5 s after the print), else out at the time stop. Cells: avg x / win % [with a -30 % stop: avg x]`);
  console.log("  take-profit".padEnd(14) + TSTOP.map((T) => `stop ${T}s`.padEnd(30)).join(""));
  for (const tp of TP) {
    let line = `  +${Math.round((tp - 1) * 100)}%`.padEnd(14);
    for (const T of TSTOP) { const a = scalp[g].get(`${tp}|${T}|nosl`), b = scalp[g].get(`${tp}|${T}|sl`); line += (a && a.n ? `${f(a.avg)} / ${a.win === null ? "-" : (100 * a.win).toFixed(0)}% [${f(b?.avg ?? null)}] n=${a.n}` : "-").padEnd(30); }
    console.log(line);
  }
  console.log();
}
console.log("Reading: the 0 ms row is the wallet's own price (unreachable). The gap between 0 ms and 1500 ms is what latency costs; a column that stays > 1.0 down the rows is a hold time that works for a follower.\n");
