/**
 * Habit persistence test - the honest version of "operators repeat the same play".
 *
 *   npm run habits -- [--hours 72]
 *
 * Walks every finalized launch in time order. For each launch, the creator's record is computed from
 * their EARLIER launches whose watch window had already ended when this one was created (nothing from
 * the future, nothing still in progress). The launch's own outcome for an outsider who bought at
 * creation is then bucketed by that prior record. If a creator's past predicts their next launch,
 * the buckets separate; if they do not, every bucket looks like the base rate.
 *
 * Outsider return = price N minutes after launch / launch price, times 0.97 for the round-trip fee.
 * "paper x" = what the baseline-all paper strategy (entry at 2 s, default exits) actually closed at.
 * A tradeable graduation is one that took >= 60 s (an instant graduation is dev-funded, nobody else got in).
 *
 * Section 2 does the same for early buyer wallets: does a wallet's record on its earlier tokens predict
 * the next token it buys within 60 s of launch?
 */
import { config } from "../src/config.ts";
import { openDb } from "../src/db.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const hours = Number(args.get("hours") ?? 72);
const since = Date.now() - hours * 3600_000;
const FEE = 0.97;
const WATCH_MS = config.watchMinutes * 60_000;

const db = openDb(config.dbPath);
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const f = (n: number | null | undefined, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? "-" : Number(n).toFixed(d));
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
const short = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const table = (rows: Record<string, string | number>[]) => {
  if (!rows.length) return console.log("  (none)");
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  console.log("  " + cols.map((c, i) => c.padEnd(w[i])).join("  "));
  for (const r of rows) console.log("  " + cols.map((c, i) => String(r[c]).padEnd(w[i])).join("  "));
};
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

interface Tok {
  mint: string; symbol: string; creator: string; created_at: number; launch_price: number;
  p_5m: number | null; p_15m: number | null; p_60m: number | null; peak_price: number;
  graduated: number; graduated_at: number | null; dev_sold_at: number | null; dev_pct: number; unique_buyers: number;
  paper_x: number | null;
}
const toks = q<Tok>(
  `SELECT t.mint, t.symbol, t.creator, t.created_at, t.launch_price, t.p_5m, t.p_15m, t.p_60m, t.peak_price, t.graduated, t.graduated_at,
          t.dev_sold_at, t.dev_pct, t.unique_buyers,
          (SELECT p.multiple FROM positions p WHERE p.mint = t.mint AND p.strategy = 'baseline-all' AND p.suspect = 0 AND p.exit_reason != 'shutdown' LIMIT 1) paper_x
   FROM tokens t WHERE t.created_at >= ? AND t.finalized = 1 AND t.late_discovery = 0 AND t.launch_price > 0 AND t.creator != ''
   ORDER BY t.created_at, t.rowid`,
  since,
);

/** what an outsider buying at creation saw */
interface Outcome { r5: number | null; r15: number | null; r60: number | null; peak: number; grad: boolean; gradTradeable: boolean; devSoldFast: boolean; paperX: number | null }
const MAX_X = 50; // above this a multiple is a price-source artifact (see ASSUMPTIONS.md); treated as unknown
const CAP_X = 20; // means are winsorized here so one 40x does not carry a bucket
const ret = (p: number | null, launch: number) => (p === null ? null : (FEE * p) / launch > MAX_X ? null : (FEE * p) / launch);
const outcome = (t: Tok): Outcome => ({
  r5: ret(t.p_5m, t.launch_price),
  r15: ret(t.p_15m, t.launch_price),
  r60: ret(t.p_60m, t.launch_price),
  peak: Math.min(t.peak_price / t.launch_price, MAX_X),
  grad: t.graduated === 1,
  gradTradeable: t.graduated === 1 && (t.graduated_at === null || t.graduated_at - t.created_at >= 60_000),
  devSoldFast: t.dev_sold_at !== null && t.dev_sold_at - t.created_at <= 5 * 60_000,
  paperX: t.paper_x,
});

/** a creator's (or wallet's) record, built only from launches already finished */
class Rec {
  n = 0; sumR15 = 0; n15 = 0; wins15 = 0; grads = 0; gradsT = 0; devFast = 0; sumPeak = 0; sumPaper = 0; nPaper = 0; lastR15: number | null = null; lastAt = 0;
  add(o: Outcome, at: number) {
    this.n++;
    if (o.r15 !== null) { this.sumR15 += o.r15; this.n15++; if (o.r15 > 1) this.wins15++; this.lastR15 = o.r15; }
    if (o.grad) this.grads++;
    if (o.gradTradeable) this.gradsT++;
    if (o.devSoldFast) this.devFast++;
    this.sumPeak += o.peak;
    if (o.paperX !== null) { this.sumPaper += o.paperX; this.nPaper++; }
    this.lastAt = at;
  }
  get avgR15() { return this.n15 ? this.sumR15 / this.n15 : null; }
  get winRate() { return this.n15 ? this.wins15 / this.n15 : null; }
  get gradTRate() { return this.n ? this.gradsT / this.n : 0; }
  get devFastRate() { return this.n ? this.devFast / this.n : 0; }
  get avgPaper() { return this.nPaper ? this.sumPaper / this.nPaper : null; }
  get avgPeak() { return this.n ? this.sumPeak / this.n : null; }
}

/** aggregate outcomes of the NEXT launch, per bucket */
class Bucket {
  n = 0; r15: number[] = []; wins = 0; gradsT = 0; paper: number[] = []; peaks: number[] = []; devFast = 0;
  add(o: Outcome) {
    this.n++;
    if (o.r15 !== null) { this.r15.push(o.r15); if (o.r15 > 1) this.wins++; }
    if (o.gradTradeable) this.gradsT++;
    if (o.paperX !== null) this.paper.push(o.paperX);
    this.peaks.push(o.peak);
    if (o.devSoldFast) this.devFast++;
  }
  row(label: string, base: Bucket) {
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + Math.min(b, CAP_X), 0) / xs.length : null);
    const a15 = avg(this.r15), b15 = avg(base.r15);
    return {
      bucket: label, n: this.n,
      "avg 15m x (cap20)": f(a15), "med 15m x": f(median(this.r15)), "win 15m": pct(this.wins, this.r15.length),
      "lift": a15 !== null && b15 ? `${f(a15 / b15)}x` : "-",
      "paper x": f(avg(this.paper)), "avg peak": f(avg(this.peaks)), "grad>=60s": pct(this.gradsT, this.n), "dev sold<5m": pct(this.devFast, this.n),
      "SOL/100 buys": a15 !== null ? f(100 * 0.1 * (a15 - 1), 1) : "-",
    };
  }
}
const bin = (x: number | null, edges: number[], labels: string[]) => { if (x === null) return null; let i = 0; while (i < edges.length && x >= edges[i]) i++; return labels[i]; };

console.log(`\n=== habit persistence - ${toks.length} finalized launches (last ${hours}h), evaluated strictly in time order ===`);
console.log("Each launch is bucketed by its creator's record from launches whose watch window had ENDED before this launch. Outcomes are the launch's own.\n");

// ---------- 1. creators ----------
const creators = new Map<string, { rec: Rec; queue: { at: number; o: Outcome }[] }>();
const base = new Bucket();
const byCount = new Map<string, Bucket>(), byAvg = new Map<string, Bucket>(), byWin = new Map<string, Bucket>(), byGrad = new Map<string, Bucket>(), byDev = new Map<string, Bucket>(), byLast = new Map<string, Bucket>(), byGap = new Map<string, Bucket>(), byPaper = new Map<string, Bucket>();
const get = (m: Map<string, Bucket>, k: string | null) => { if (k === null) return null; return m.get(k) ?? m.set(k, new Bucket()).get(k)!; };
// what a follower of "good" creators would have banked, prospectively
const follower = { n: 0, sol: 0, byCreator: new Map<string, { n: number; sol: number; symbols: string[] }>() };
const COUNT_L = ["0 prior", "1-2 prior", "3-9 prior", "10-29 prior", "30+ prior"];
const AVG_L = ["<0.7", "0.7-0.9", "0.9-1.0", "1.0-1.2", "1.2-1.5", ">=1.5"];
const WIN_L = ["<25%", "25-50%", "50-75%", ">=75%"];
const GRAD_L = ["none", "<10%", "10-30%", ">=30%"];
const DEV_L = ["<25%", "25-50%", "50-80%", ">=80%"];
const GAP_L = ["<2 min", "2-10 min", "10-60 min", "1-6 h", ">6 h"];
const PAPER_L = ["<0.8", "0.8-0.95", "0.95-1.05", "1.05-1.3", ">=1.3"];
for (const t of toks) {
  const c = creators.get(t.creator) ?? creators.set(t.creator, { rec: new Rec(), queue: [] }).get(t.creator)!;
  // promote earlier launches whose watch has ended into the record
  while (c.queue.length && c.queue[0].at + WATCH_MS <= t.created_at) { const x = c.queue.shift()!; c.rec.add(x.o, x.at); }
  const o = outcome(t);
  const r = c.rec;
  base.add(o);
  get(byCount, bin(r.n, [1, 3, 10, 30], COUNT_L))!.add(o);
  if (r.n >= 3) {
    get(byAvg, bin(r.avgR15, [0.7, 0.9, 1.0, 1.2, 1.5], AVG_L))?.add(o);
    get(byWin, bin(r.winRate, [0.25, 0.5, 0.75], WIN_L))?.add(o);
    get(byGrad, bin(r.gradTRate, [0.001, 0.1, 0.3], GRAD_L))?.add(o);
    get(byDev, bin(r.devFastRate, [0.25, 0.5, 0.8], DEV_L))?.add(o);
    get(byPaper, bin(r.avgPaper, [0.8, 0.95, 1.05, 1.3], PAPER_L))?.add(o);
    get(byLast, r.lastR15 === null ? null : r.lastR15 > 1 ? "last launch paid" : "last launch lost")?.add(o);
    get(byGap, bin((t.created_at - r.lastAt) / 60_000, [2, 10, 60, 360], GAP_L))?.add(o);
    // the prospective follower rule: creator has paid outsiders on average and more often than not
    if (r.avgR15 !== null && r.avgR15 >= 1.2 && (r.winRate ?? 0) >= 0.5 && r.devFastRate <= 0.5 && o.r15 !== null) {
      follower.n++;
      follower.sol += 0.1 * (o.r15 - 1);
      const fc = follower.byCreator.get(t.creator) ?? follower.byCreator.set(t.creator, { n: 0, sol: 0, symbols: [] }).get(t.creator)!;
      fc.n++; fc.sol += 0.1 * (o.r15 - 1); if (fc.symbols.length < 6) fc.symbols.push(t.symbol);
    }
  }
  c.queue.push({ at: t.created_at, o });
}
const show = (title: string, m: Map<string, Bucket>, order: string[]) => {
  console.log(title);
  table(order.filter((k) => m.has(k)).map((k) => m.get(k)!.row(k, base)));
  console.log();
};
console.log("1. CREATORS\n");
console.log(`  base (every launch): ${JSON.stringify(base.row("all", base))}\n`);
show("BY NUMBER OF PRIOR (FINISHED) LAUNCHES", byCount, COUNT_L);
show("CREATORS WITH 3+ PRIOR LAUNCHES - BY THEIR PRIOR AVERAGE 15-MIN OUTSIDER RETURN", byAvg, AVG_L);
show("… BY PRIOR SHARE OF LAUNCHES THAT PAID AN OUTSIDER AT 15 MIN", byWin, WIN_L);
show("… BY PRIOR BASELINE PAPER RESULT (entry 2 s, default exits)", byPaper, PAPER_L);
show("… BY PRIOR TRADEABLE-GRADUATION RATE (graduation took >= 60 s)", byGrad, GRAD_L);
show("… BY PRIOR SHARE WHERE THE DEV SOLD WITHIN 5 MIN", byDev, DEV_L);
show("… BY WHETHER THEIR LAST FINISHED LAUNCH PAID", byLast, ["last launch paid", "last launch lost"]);
show("… BY TIME SINCE THEIR LAST FINISHED LAUNCH", byGap, GAP_L);

console.log(`FOLLOWER RULE (prospective): buy 0.1 SOL at creation when the creator's prior avg 15-min return >= 1.2, win rate >= 50 %, dev sold fast on <= 50 %; hold 15 min`);
console.log(`  ${follower.n} entries → ${follower.sol >= 0 ? "+" : ""}${f(follower.sol, 2)} SOL (avg ${follower.n ? f(follower.sol / follower.n / 0.1 + 1, 2) : "-"}x per entry)`);
const fcs = [...follower.byCreator].sort((a, b) => b[1].sol - a[1].sol);
table(fcs.slice(0, 12).map(([w, s]) => ({ creator: short(w), entries: s.n, "SOL": (s.sol >= 0 ? "+" : "") + f(s.sol, 2), symbols: s.symbols.join(",").slice(0, 50) })));
if (fcs.length > 12) { console.log("  worst:"); table(fcs.slice(-5).map(([w, s]) => ({ creator: short(w), entries: s.n, "SOL": (s.sol >= 0 ? "+" : "") + f(s.sol, 2), symbols: s.symbols.join(",").slice(0, 50) }))); }
console.log();

// ---------- 2. early buyer wallets ----------
console.log("2. EARLY BUYER WALLETS (bought on the curve within 60 s of launch; record from their earlier tokens whose watch had ended)\n");
interface WRow { wallet: string; mint: string; first_buy_at: number; sol_in: number; realized_pnl_sol: number; unrealized_sol: number; first_buy_slot_delta: number | null }
const wrows = q<WRow>(
  `SELECT w.wallet, w.mint, w.first_buy_at, w.sol_in, w.realized_pnl_sol, w.unrealized_sol, w.first_buy_slot_delta
   FROM wallet_token_stats w WHERE w.token_created_at >= ? AND w.is_dev = 0 AND w.first_buy_age_s <= 60 AND w.sol_in >= 0.05
   ORDER BY w.first_buy_at`,
  since,
);
const tokByMint = new Map(toks.map((t) => [t.mint, t] as const));
const wrec = new Map<string, { n: number; ownPnl: number; ownIn: number; sumR15: number; n15: number; wins: number; gradsT: number; sameblock: number; queue: { at: number; o: Outcome; pnl: number; in: number; sb: boolean }[] }>();
const wbase = new Bucket();
const wByCount = new Map<string, Bucket>(), wByOwn = new Map<string, Bucket>(), wByTok = new Map<string, Bucket>(), wByWin = new Map<string, Bucket>(), wByWinReal = new Map<string, Bucket>(), wByTokReal = new Map<string, Bucket>();
const OWN_L = ["lost >20%", "lost 0-20%", "made 0-50%", "made >=50%"];
const wfollower = { n: 0, sol: 0 };
const wfollowerReal = { n: 0, sol: 0, wins: 0, big: 0 };
// realistic copy-trade entry: the first stored trade >= 1.5 s after the wallet's buy (its price is what we would have paid)
const fillStmt = db.prepare("SELECT price FROM trades WHERE mint = ? AND market = 'curve' AND ts >= ? ORDER BY ts, id LIMIT 1");
const wbaseReal = new Bucket();
for (const r of wrows) {
  const t = tokByMint.get(r.mint);
  if (!t) continue;
  const w = wrec.get(r.wallet) ?? wrec.set(r.wallet, { n: 0, ownPnl: 0, ownIn: 0, sumR15: 0, n15: 0, wins: 0, gradsT: 0, sameblock: 0, queue: [] }).get(r.wallet)!;
  while (w.queue.length && w.queue[0].at + WATCH_MS <= t.created_at) {
    const x = w.queue.shift()!;
    w.n++; w.ownPnl += x.pnl; w.ownIn += x.in; if (x.o.r15 !== null) { w.sumR15 += x.o.r15; w.n15++; if (x.o.r15 > 1) w.wins++; } if (x.o.gradTradeable) w.gradsT++; if (x.sb) w.sameblock++;
  }
  const o = outcome(t);
  wbase.add(o);
  get(wByCount, bin(w.n, [1, 3, 10, 30], COUNT_L))!.add(o);
  if (w.n >= 3 && w.sameblock * 2 < w.n) {
    const own = w.ownIn > 0 ? w.ownPnl / w.ownIn : null;
    const avgTok = w.n15 ? w.sumR15 / w.n15 : null, winTok = w.n15 ? w.wins / w.n15 : null;
    get(wByOwn, bin(own, [-0.2, 0, 0.5], OWN_L))?.add(o);
    get(wByTok, bin(avgTok, [0.7, 0.9, 1.0, 1.2, 1.5], AVG_L))?.add(o);
    get(wByWin, bin(winTok, [0.25, 0.5, 0.75], WIN_L))?.add(o);
    if (own !== null && own >= 0.5 && w.n15 && w.sumR15 / w.n15 >= 1.2 && o.r15 !== null) { wfollower.n++; wfollower.sol += 0.1 * (o.r15 - 1); }
    // same buckets with a realistic fill
    const fill = (fillStmt.get(r.mint, r.first_buy_at + 1500) as any)?.price as number | undefined;
    if (fill && fill > 0 && t.p_15m !== null) {
      const r15 = (FEE * t.p_15m) / fill;
      const oR: Outcome = { ...o, r15: r15 > MAX_X ? null : r15, peak: Math.min(t.peak_price / fill, MAX_X) };
      wbaseReal.add(oR);
      get(wByWinReal, bin(winTok, [0.25, 0.5, 0.75], WIN_L))?.add(oR);
      get(wByTokReal, bin(avgTok, [0.7, 0.9, 1.0, 1.2, 1.5], AVG_L))?.add(oR);
      if (winTok !== null && winTok >= 0.5 && avgTok !== null && avgTok >= 1.2 && oR.r15 !== null) { wfollowerReal.n++; wfollowerReal.sol += 0.1 * (oR.r15 - 1); if (oR.r15 > 1) wfollowerReal.wins++; if (oR.r15 >= 2) wfollowerReal.big++; }
    }
  }
  w.queue.push({ at: t.created_at, o, pnl: r.realized_pnl_sol + r.unrealized_sol, in: r.sol_in, sb: r.first_buy_slot_delta !== null && r.first_buy_slot_delta <= 1 });
}
console.log(`  base (every early buy >= 0.05 SOL): ${JSON.stringify(wbase.row("all", wbase))}\n`);
show("BY NUMBER OF PRIOR (FINISHED) TOKENS THE WALLET BOUGHT EARLY", wByCount, COUNT_L);
show("WALLETS WITH 3+ PRIOR (not mostly same-block) - BY THE WALLET'S OWN PRIOR RETURN ON ITS BUYS", wByOwn, OWN_L);
show("… BY THE PRIOR AVERAGE 15-MIN OUTSIDER RETURN OF THE TOKENS IT BOUGHT", wByTok, AVG_L);
show("… BY THE PRIOR SHARE OF ITS TOKENS THAT PAID AN OUTSIDER AT 15 MIN", wByWin, WIN_L);
console.log(`REALISTIC FILL (entry = first stored trade >= 1.5 s after the wallet's buy; ${wbaseReal.n} of the 3+-prior rows had one)`);
console.log(`  base with realistic fill: ${JSON.stringify(wbaseReal.row("all", wbaseReal))}\n`);
show("… BY THE PRIOR AVERAGE 15-MIN OUTSIDER RETURN OF THE TOKENS IT BOUGHT - realistic fill", wByTokReal, AVG_L);
show("… BY THE PRIOR SHARE OF ITS TOKENS THAT PAID AN OUTSIDER AT 15 MIN - realistic fill", wByWinReal, WIN_L);
console.log(`FOLLOWER RULE, realistic fill: copy a wallet whose prior tokens paid outsiders >= 50 % of the time and >= 1.2x on average; hold 15 min`);
console.log(`  ${wfollowerReal.n} entries → ${wfollowerReal.sol >= 0 ? "+" : ""}${f(wfollowerReal.sol, 2)} SOL (avg ${wfollowerReal.n ? f(wfollowerReal.sol / wfollowerReal.n / 0.1 + 1, 2) : "-"}x, win ${pct(wfollowerReal.wins, wfollowerReal.n)}, >=2x on ${pct(wfollowerReal.big, wfollowerReal.n)})\n`);
console.log(`FOLLOWER RULE (prospective, optimistic: assumes entry at launch price): copy a wallet whose own prior return >= +50 % and whose tokens paid outsiders >= 1.2x on average; hold 15 min`);
console.log(`  ${wfollower.n} entries → ${wfollower.sol >= 0 ? "+" : ""}${f(wfollower.sol, 2)} SOL (avg ${wfollower.n ? f(wfollower.sol / wfollower.n / 0.1 + 1, 2) : "-"}x per entry)\n`);
console.log("Reading: a habit is real when the buckets separate AND the same direction holds tomorrow. Lift is vs the base row. SOL/100 buys = what 100 entries of 0.1 SOL held 15 min would net.\n");
