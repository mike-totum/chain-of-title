/**
 * Backtest entry rules against every stored trade history.
 *
 *   npm run backtest -- [--hours 24] [--sweep] [--min-entries 5] [--sort real|grad|ret15|pnl] [--top 30] [--tp 2] [--sl 0.5] [--hold 1800]
 *
 * Labels per token:
 *   grad  = left the bonding curve
 *   real  = graduated AND still above ~300 SOL market cap an hour after launch (a runner that held, not a bundle spike)
 * Metrics per rule:
 *   entries, precision on `real` and `grad` (with lift vs the base rate), median return at +15m after entry,
 *   share reaching 2x after entry, and a simulated exit PnL (fees, latency, TP/SL/trail/dev-sell/time-stop) on
 *   tokens whose full trade history was kept.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { baseRules, sweepRules, type BtRule, type BtState } from "./backtest-rules.ts";
import { TOTAL_SUPPLY } from "./curve.ts";
import { labelRealRunners, REAL_MIN_MCAP_SOL, REAL_MIN_AGE_MS } from "./label.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const hours = Number(args.get("hours") ?? 24);
const minEntries = Number(args.get("min-entries") ?? 5);
const sortBy = args.get("sort") ?? "real";
const topN = Number(args.get("top") ?? 30);
const TP = Number(args.get("tp") ?? 2);
const SL = Number(args.get("sl") ?? 0.5);
const HOLD_S = Number(args.get("hold") ?? 1800);
const TRAIL_ARM = 1.5, TRAIL_DROP = 0.35, LATENCY_MS = config.fillLatencyMs, PRIO = config.prioFeeSol, SIZE = config.buySol;
/** fee (1.25%, the low-mcap worst case of the dynamic schedule) plus a fill impact / slippage allowance, applied on both sides */
const FEE = 0.0125 + Number(args.get("slippage-bps") ?? 30) / 10_000;


const db = openDb(config.dbPath);
const since = Date.now() - hours * 3600_000;
const rules: BtRule[] = args.has("sweep") ? [...baseRules, ...sweepRules()] : baseRules;

interface Tok {
  mint: string; symbol: string; creator: string; created_at: number; launch_price: number; peak_price: number; last_price: number;
  dev_pct: number; graduated: number; graduated_at: number | null; p_1m: number | null; p_5m: number | null; p_15m: number | null; p_60m: number | null;
  buys: number; sells: number; twitter: string | null; telegram: string | null; website: string | null; finalized: number; uri: string;
}
const tokens = db
  .prepare(`SELECT mint, symbol, creator, created_at, launch_price, peak_price, last_price, dev_pct, graduated, graduated_at, p_1m, p_5m, p_15m, p_60m, buys, sells, twitter, telegram, website, finalized, uri
            FROM tokens WHERE created_at >= ? AND late_discovery = 0 AND finalized = 1 AND launch_price > 0
              AND mint IN (SELECT DISTINCT mint FROM trades) ORDER BY created_at`)
  .all(since) as unknown as Tok[];
const smart = new Set((db.prepare("SELECT wallet FROM smart_wallets").all() as any[]).map((r) => r.wallet));
const teamOf = new Map<string, number>((db.prepare("SELECT wallet, team_id FROM wallet_teams").all() as any[]).map((r) => [r.wallet, r.team_id]));
const hostOf = (uri: string) => { try { const h = new URL(uri).hostname; return h.includes("ipfs") ? "ipfs" : h; } catch { return "invalid"; } };
const signalsByMint = new Map<string, number>();
for (const r of db.prepare("SELECT mint, MIN(posted_at) t FROM signals WHERE mint IS NOT NULL GROUP BY mint").all() as any[]) signalsByMint.set(r.mint, r.t);

// creator history: launches before this token
const creatorRows = db.prepare("SELECT creator, created_at, dev_sold, graduated FROM tokens WHERE late_discovery=0 AND creator!='' ORDER BY created_at").all() as any[];
const byCreator = new Map<string, any[]>();
for (const r of creatorRows) (byCreator.get(r.creator) ?? byCreator.set(r.creator, []).get(r.creator)!).push(r);
const creatorPrior = (creator: string, before: number) => {
  const rows = (byCreator.get(creator) ?? []).filter((r) => r.created_at < before);
  return { launches: rows.length, sold: rows.filter((r) => r.dev_sold).length, graduated: rows.filter((r) => r.graduated).length };
};

process.stdout.write("labelling real runners from post-graduation market caps… ");
const realSet = await labelRealRunners(db, since, { log: (s) => process.stdout.write(s + " ") });
console.log(`${realSet.size} real`);
const isReal = (t: Tok) => realSet.has(t.mint);
// node:sqlite StatementSync objects were observed to be finalized mid-run; prepare per call (cheap at this scale)
const TRADES_SQL = "SELECT wallet, side, sol, tokens, price, ts, slot, age_ms, is_dev FROM trades WHERE mint = ? ORDER BY ts, id";
const loadTrades = (mint: string) => db.prepare(TRADES_SQL).all(mint) as any[];
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

interface Entry { mint: string; symbol: string; ageS: number; entryPrice: number; entryTs: number; real: boolean; grad: boolean; ret15: number | null; ret60: number | null; peakAfter: number | null; exitX: number | null; exitReason: string | null; full: boolean; path: { ts: number; price: number; devSell: boolean; grad: boolean }[] | null }
const EXIT_SWEEP = args.has("exit-sweep");

/** Re-simulate exits over a stored path with arbitrary parameters. Returns the net multiple. */
function simExit(e: Entry, tp: number, sl: number, trailArm: number, trailDrop: number, holdS: number): number {
  if (!e.path) return NaN;
  let peak = e.entryPrice, exitPrice: number | null = null;
  for (const x of e.path) {
    if (x.price > peak) peak = x.price;
    const m = x.price / e.entryPrice;
    const held = (x.ts - e.entryTs) / 1000;
    if (x.grad || x.devSell || m >= tp || m <= sl || (peak >= e.entryPrice * trailArm && x.price <= peak * (1 - trailDrop)) || held >= holdS) { exitPrice = x.price; break; }
  }
  if (exitPrice === null) exitPrice = e.path.length ? e.path[e.path.length - 1].price : e.entryPrice;
  return (exitPrice * (1 - FEE)) / e.entryPrice - (2 * PRIO) / SIZE;
}
const results = new Map<string, Entry[]>(rules.map((r) => [r.name, []]));
let nFull = 0, nTrunc = 0;

for (const t of tokens) {
  const trades = loadTrades(t.mint);
  if (!trades.length) continue;
  const full = trades.length >= t.buys + t.sells; // every trade of the token is stored
  full ? nFull++ : nTrunc++;
  const createdSlot = trades.find((x) => x.is_dev && x.age_ms === 0)?.slot ?? trades[0].slot;
  const devSol = trades.find((x) => x.is_dev && x.age_ms === 0)?.sol ?? 0;
  const teamCounts = new Map<number, number>();
  const hasSocials = !!(t.twitter || t.telegram || t.website);
  const prior = creatorPrior(t.creator, t.created_at);
  const signalAt = signalsByMint.get(t.mint) ?? Infinity;

  // replay
  const st: BtState = {
    ageMs: 0, price: t.launch_price, launchPrice: t.launch_price, buys: 0, sells: 0, buyers: new Set(), buyVolSol: 0, sellVolSol: 0, sameBlockBuyers: 0,
    devPct: t.dev_pct, devSold: false, topHolderPct: 0, buyersLast60s: 0, medianBuySol: 0, hasSocials, creatorPrior: prior, devSol, metaHost: hostOf(t.uri),
    last: { wallet: "", side: "buy", sol: 0, isDev: false, smart: false }, smartBuys: 0, teamHits: 0, signalSeen: false, graduated: false,
  };
  const balances = new Map<string, number>([[t.creator, (t.dev_pct / 100) * TOTAL_SUPPLY]]);
  const buySizes: number[] = [];
  const recentBuyers: { ts: number; w: string }[] = [];
  const pending: { rule: BtRule; idx: number; reason: string }[] = [];
  const entered = new Set<string>();

  for (let i = 0; i < trades.length; i++) {
    const tr = trades[i];
    if (tr.is_dev && tr.age_ms === 0) continue; // creation buy already reflected in launch price / dev pct
    st.ageMs = tr.age_ms;
    st.price = tr.price;
    const isDev = !!tr.is_dev;
    if (tr.side === "buy") {
      st.buys++;
      st.buyVolSol += tr.sol;
      if (!st.buyers.has(tr.wallet)) {
        st.buyers.add(tr.wallet);
        const team = teamOf.get(tr.wallet);
        if (team !== undefined) { teamCounts.set(team, (teamCounts.get(team) ?? 0) + 1); st.teamHits = Math.max(st.teamHits, teamCounts.get(team)!); }
        if (!isDev && createdSlot && tr.slot && tr.slot - createdSlot <= 1) st.sameBlockBuyers++;
      }
      buySizes.push(tr.sol);
      recentBuyers.push({ ts: tr.ts, w: tr.wallet });
      balances.set(tr.wallet, (balances.get(tr.wallet) ?? 0) + tr.tokens);
    } else {
      st.sells++;
      st.sellVolSol += tr.sol;
      balances.set(tr.wallet, Math.max(0, (balances.get(tr.wallet) ?? 0) - tr.tokens));
      if (isDev) st.devSold = true;
    }
    while (recentBuyers.length && recentBuyers[0].ts < tr.ts - 60_000) recentBuyers.shift();
    st.buyersLast60s = new Set(recentBuyers.map((x) => x.w)).size;
    st.medianBuySol = median(buySizes);
    let top = 0;
    for (const [w, b] of balances) if (w !== t.creator && b > top) top = b;
    st.topHolderPct = (top / TOTAL_SUPPLY) * 100;
    const isSmart = smart.has(tr.wallet);
    if (tr.side === "buy" && isSmart && !isDev) st.smartBuys++;
    st.last = { wallet: tr.wallet, side: tr.side, sol: tr.sol, isDev, smart: isSmart };
    st.signalSeen = tr.ts >= signalAt;
    st.graduated = t.graduated_at !== null && tr.ts >= t.graduated_at;

    for (const rule of rules) {
      if (entered.has(rule.name) || st.ageMs > rule.windowS * 1000) continue;
      const reason = rule.enter(st);
      if (reason) {
        entered.add(rule.name);
        pending.push({ rule, idx: i, reason });
      }
    }
  }

  // resolve entries: fill at first trade >= decision + latency (or the deciding trade's price if none)
  for (const p of pending) {
    const decided = trades[p.idx];
    const fillIdx = trades.findIndex((x, j) => j > p.idx && x.ts >= decided.ts + LATENCY_MS);
    const fill = fillIdx >= 0 ? trades[fillIdx] : decided;
    if (!(fill.price > 0)) continue; // no usable fill price
    const entryPrice = fill.price * (1 + FEE); // fee on the way in, impact ignored (small size)
    const entryTs = fillIdx >= 0 ? fill.ts : decided.ts + LATENCY_MS;
    const ageS = (entryTs - t.created_at) / 1000;
    const cp = (ageAtCp: number, priceAtCp: number | null) => (priceAtCp !== null && ageS < ageAtCp ? priceAtCp / entryPrice : null);
    const e: Entry = {
      mint: t.mint, symbol: t.symbol, ageS, entryPrice, entryTs, real: isReal(t), grad: t.graduated === 1,
      ret15: cp(900, t.p_15m), ret60: cp(3600, t.p_60m), peakAfter: null, exitX: null, exitReason: null, full, path: null,
    };
    const after = trades.slice(fillIdx >= 0 ? fillIdx : p.idx + 1);
    if (full) e.path = after.map((x) => ({ ts: x.ts, price: x.price, devSell: !!(x.is_dev && x.side === "sell"), grad: t.graduated_at !== null && x.ts >= t.graduated_at }));
    if (after.length) { let mx = 0; for (const x of after) if (x.price > mx) mx = x.price; e.peakAfter = mx / entryPrice; }
    if (!full && e.peakAfter !== null) e.peakAfter = Math.max(e.peakAfter, t.peak_price / entryPrice); // upper bound when truncated
    if (full) {
      // simulate exits over the remaining trades
      let peak = fill.price, exitPrice: number | null = null, reason: string | null = null;
      for (const x of after) {
        const px = x.price;
        if (px > peak) peak = px;
        const m = px / entryPrice;
        const held = (x.ts - entryTs) / 1000;
        if (t.graduated_at !== null && x.ts >= t.graduated_at) { exitPrice = px; reason = "graduated"; break; }
        if (x.is_dev && x.side === "sell") { exitPrice = px; reason = "dev-sold"; break; }
        if (m >= TP) { exitPrice = px; reason = "take-profit"; break; }
        if (m <= SL) { exitPrice = px; reason = "stop-loss"; break; }
        if (peak >= entryPrice * TRAIL_ARM && px <= peak * (1 - TRAIL_DROP)) { exitPrice = px; reason = "trailing-stop"; break; }
        if (held >= HOLD_S) { exitPrice = px; reason = "time-stop"; break; }
      }
      if (exitPrice === null) { exitPrice = after.length ? after[after.length - 1].price : fill.price; reason = "end-of-data"; }
      e.exitX = ((exitPrice as number) * (1 - FEE)) / entryPrice - (2 * PRIO) / SIZE;
      e.exitReason = reason;
    }
    results.get(p.rule.name)!.push(e);
  }
}

// ---------- report ----------
const nTok = tokens.length;
const nReal = tokens.filter(isReal).length;
const nGrad = tokens.filter((t) => t.graduated === 1).length;
const baseReal = nReal / Math.max(1, nTok), baseGrad = nGrad / Math.max(1, nTok);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "-");
console.log(`\n=== backtest over ${nTok} finalized tokens with trade data (last ${hours}h) — ${nFull} full histories, ${nTrunc} truncated ===`);
console.log(`base rates: graduated ${pct(nGrad, nTok)}   real runner (graduated >= ${REAL_MIN_AGE_MS / 60000} min ago and still >= ${REAL_MIN_MCAP_SOL} SOL mcap = ${(REAL_MIN_MCAP_SOL / 411).toFixed(1)}x graduation) ${pct(nReal, nTok)}`);
console.log(`exit model: TP ${TP}x, SL ${SL}x, trail ${TRAIL_DROP * 100}% after ${TRAIL_ARM}x, time-stop ${HOLD_S}s, fee+slippage ${(FEE * 100).toFixed(2)}% each way, ${LATENCY_MS}ms latency, ${SIZE} SOL per entry\n`);

interface Row { name: string; n: number; real: number; grad: number; ret15: number; ret60: number; hit2x: number; n2x: number; exitX: number; nExit: number; winExit: number; pnl: number; age: number }
const rows: Row[] = [];
for (const r of rules) {
  const es = results.get(r.name)!;
  if (es.length < minEntries) continue;
  const r15 = es.map((e) => e.ret15).filter((x): x is number => x !== null);
  const r60 = es.map((e) => e.ret60).filter((x): x is number => x !== null);
  const pk = es.filter((e) => e.peakAfter !== null);
  const ex = es.filter((e) => e.exitX !== null && Number.isFinite(e.exitX));
  rows.push({
    name: r.name, n: es.length, real: es.filter((e) => e.real).length, grad: es.filter((e) => e.grad).length,
    ret15: median(r15), ret60: median(r60), hit2x: pk.filter((e) => e.peakAfter! >= 2).length, n2x: pk.length,
    exitX: ex.length ? ex.reduce((a, e) => a + e.exitX!, 0) / ex.length : NaN, nExit: ex.length, winExit: ex.filter((e) => e.exitX! > 1).length,
    pnl: ex.reduce((a, e) => a + (e.exitX! - 1) * SIZE, 0), age: median(es.map((e) => e.ageS)),
  });
}
const key = (r: Row) => (sortBy === "grad" ? r.grad / r.n : sortBy === "ret15" ? r.ret15 : sortBy === "pnl" ? (r.nExit ? r.exitX : -1) : r.real / r.n);
rows.sort((a, b) => key(b) - key(a));
const head = "  rule".padEnd(58) + "entries".padStart(8) + "real".padStart(13) + "lift".padStart(6) + "graduated".padStart(13) + "med +15m".padStart(10) + "med +60m".padStart(10) + "hit 2x".padStart(9) + "sim exit".padStart(10) + "win%".padStart(6) + "pnl SOL".padStart(9) + "  entry age";
console.log(head);
for (const r of rows.slice(0, topN)) {
  console.log(
    ("  " + r.name).slice(0, 57).padEnd(58) +
      String(r.n).padStart(8) +
      `${r.real} (${pct(r.real, r.n)})`.padStart(13) +
      `${f(r.real / r.n / Math.max(baseReal, 1e-9), 1)}x`.padStart(6) +
      `${r.grad} (${pct(r.grad, r.n)})`.padStart(13) +
      `${f(r.ret15)}x`.padStart(10) +
      `${f(r.ret60)}x`.padStart(10) +
      pct(r.hit2x, r.n2x).padStart(9) +
      (r.nExit ? `${f(r.exitX)}x/${r.nExit}` : "-").padStart(10) +
      pct(r.winExit, r.nExit).padStart(6) +
      ((r.pnl >= 0 ? "+" : "") + f(r.pnl, 3)).padStart(9) +
      `  ${f(r.age, 0)}s`,
  );
}
if (EXIT_SWEEP) {
  console.log("\nEXIT SWEEP — best exit parameters per rule (mean net multiple over full-history entries; n >= 8)");
  console.log("  rule".padEnd(58) + "n".padStart(4) + "  default".padStart(10) + "  best".padStart(8) + "   TP    SL  trail  hold");
  for (const r of rows) {
    const es = results.get(r.name)!.filter((e) => e.path && e.path.length && Number.isFinite(e.entryPrice) && e.entryPrice > 0);
    if (es.length < 8) continue;
    let best = { x: -Infinity, tp: 0, sl: 0, drop: 0, hold: 0 };
    for (const tp of [1.3, 1.5, 2, 3, 5, 100])
      for (const sl of [0.3, 0.5, 0.7, 0.85])
        for (const drop of [0.15, 0.25, 0.35, 0.5])
          for (const hold of [120, 300, 600, 1800, 3600]) {
            const xs = es.map((e) => simExit(e, tp, sl, 1.3, drop, hold));
            const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
            if (mean > best.x) best = { x: mean, tp, sl, drop, hold };
          }
    const def = es.map((e) => simExit(e, TP, SL, TRAIL_ARM, TRAIL_DROP, HOLD_S)).reduce((a, b) => a + b, 0) / es.length;
    console.log(("  " + r.name).slice(0, 57).padEnd(58) + String(es.length).padStart(4) + `${def.toFixed(2)}x`.padStart(10) + `${best.x.toFixed(2)}x`.padStart(8) + `  ${best.tp === 100 ? "none" : best.tp + "x"}`.padEnd(7) + `${best.sl}x`.padStart(5) + `${(best.drop * 100).toFixed(0)}%`.padStart(6) + `${best.hold}s`.padStart(7));
  }
  console.log("  Grid: TP {1.3,1.5,2,3,5,none} × SL {0.3,0.5,0.7,0.85} × trailing drop {15,25,35,50}% (armed at 1.3x) × hold {2,5,10,30,60} min. Optimised in-sample: treat as a direction, not a setting.");

  // anatomy of runners vs the rest, from launch
  console.log("\nRUNNER ANATOMY (from launch, full-history tokens)");
  interface Anat { ttpS: number; peakX: number; ddPct: number; x5: number | null; x15: number | null; x60: number | null }
  const groups: Record<string, Anat[]> = { "real runners": [], "graduated but faded": [], "never graduated": [] };
  for (const t of tokens) {
    const tr = loadTrades(t.mint);
    if (!tr.length || tr.length < t.buys + t.sells) continue;
    let peak = t.launch_price, peakTs = t.created_at, minAfterPeak = Infinity;
    for (const x of tr) {
      if (x.price > peak) { peak = x.price; peakTs = x.ts; minAfterPeak = x.price; }
      else if (x.price < minAfterPeak) minAfterPeak = x.price;
    }
    const a: Anat = { ttpS: (peakTs - t.created_at) / 1000, peakX: peak / t.launch_price, ddPct: minAfterPeak === Infinity ? 0 : (1 - minAfterPeak / peak) * 100, x5: t.p_5m ? t.p_5m / t.launch_price : null, x15: t.p_15m ? t.p_15m / t.launch_price : null, x60: t.p_60m ? t.p_60m / t.launch_price : null };
    (isReal(t) ? groups["real runners"] : t.graduated ? groups["graduated but faded"] : groups["never graduated"]).push(a);
  }
  console.log("  group".padEnd(24) + "n".padStart(6) + "  median time to peak" + "  median peak" + "  median drawdown after peak" + "  median x at 5m / 15m / 60m");
  for (const [g, xs] of Object.entries(groups)) {
    if (!xs.length) continue;
    const m = (k: keyof Anat) => median(xs.map((a) => a[k]).filter((v): v is number => v !== null && Number.isFinite(v)));
    const ttp = m("ttpS");
    console.log(("  " + g).padEnd(24) + String(xs.length).padStart(6) + `  ${ttp < 3600 ? (ttp / 60).toFixed(1) + " min" : (ttp / 3600).toFixed(1) + " h"}`.padEnd(22) + `${m("peakX").toFixed(1)}x`.padStart(12) + `${m("ddPct").toFixed(0)}%`.padStart(28) + `  ${m("x5").toFixed(2)} / ${m("x15").toFixed(2)} / ${m("x60").toFixed(2)}`);
  }
  console.log("  Bonding-curve data ends at graduation, so 'real runners' peak/drawdown here describe the curve phase only; their post-graduation move is in token_outcomes.");
}

console.log(`\n${rules.length - rows.length} rule(s) hidden with fewer than ${minEntries} entries. "sim exit" = mean exit multiple over tokens with full histories (n after slash).`);
console.log(`real = graduated and still >= ${REAL_MIN_MCAP_SOL} SOL market cap at analysis time (pump.fun/DexScreener); lift = rule precision on real / base rate.`);
console.log("Caveat: precision is measured on tokens that had at least one trade after launch; only-dev-buy launches are excluded from both numerator and denominator.");
