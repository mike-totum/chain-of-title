/**
 * Post-graduation analysis: which graduated tokens attract OUTSIDE money afterwards, and what does the
 * PumpSwap flow look like in the first minutes that separates them from the 95% that dump?
 *
 *   npm run postgrad -- [--hours 24] [--window 120] [--entry 120]
 *
 * For every graduated token with PumpSwap trade data: features over the first `window` seconds after
 * graduation (distinct AMM buyers, buy/sell counts and SOL, net SOL flow, insider share of sells where
 * insiders = dev + first-10 curve buyers + known crew wallets, median buy size, buyers >= 0.5 SOL),
 * outcomes (price at +15m/+60m vs graduation, peak after, verified on-chain real-runner label when known),
 * a rule search for entries at +`entry` seconds, and a rip-cord simulation on the AMM path.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { isRealOutcome, organicDemand } from "./label.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const hours = Number(args.get("hours") ?? 24);
const WIN = Number(args.get("window") ?? 120) * 1000;
const ENTRY = Number(args.get("entry") ?? 120) * 1000;
const db = openDb(config.dbPath);
const since = Date.now() - hours * 3600_000;
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "-");
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");

const toks = q(`SELECT t.mint, t.symbol, t.creator, t.created_at, t.graduated_at, t.launch_price, t.dev_pct, t.unique_buyers, t.late_discovery, o.mcap_sol, o.mcap_usd, o.pool_sol, o.verified
  FROM tokens t LEFT JOIN token_outcomes o ON o.mint=t.mint
  WHERE t.graduated=1 AND t.graduated_at IS NOT NULL AND t.late_discovery=0 AND t.created_at >= ? AND t.finalized=1
    AND t.mint IN (SELECT DISTINCT mint FROM trades WHERE market='amm')`, since);
const crew = new Set((q(`SELECT wallet FROM wallet_teams`) as any[]).map((r) => r.wallet));
const first10Stmt = db.prepare(`SELECT wallet FROM wallet_token_stats WHERE mint=? AND first_buy_rank<=10`);
const ammStmt = db.prepare(`SELECT ts, wallet, side, sol, tokens, price FROM trades WHERE mint=? AND market='amm' AND tokens>=1000 AND sol>=0.0005 ORDER BY ts, id`);

interface Row {
  sym: string; buyers: number; buys: number; sells: number; buySol: number; sellSol: number; net: number; insiderSellShare: number; medBuy: number; bigBuyers: number;
  gradX: number; xEntry: number | null; x15: number | null; x60: number | null; peakAfterEntry: number | null; held60: boolean; real: boolean | null; verified: boolean; secsToGrad: number;
  path: { ts: number; price: number; side: string; sol: number; wallet: string }[]; entryPx: number | null; entryTs: number | null; devSellAfter: boolean; creator: string;
}
const rows: Row[] = [];
for (const t of toks) {
  const tr = ammStmt.all(t.mint) as any[];
  if (tr.length < 5) continue;
  // outlier clean
  const clean: any[] = []; for (const x of tr) { const p = clean[clean.length - 1]; if (!p || (x.price / p.price < 3 && p.price / x.price < 3)) clean.push(x); }
  const g0 = t.graduated_at as number;
  const insiders = new Set<string>([t.creator, ...((first10Stmt.all(t.mint) as any[]).map((r) => r.wallet))]);
  const w = clean.filter((x) => x.ts >= g0 && x.ts < g0 + WIN);
  const buyers = new Set<string>(); let buys = 0, sells = 0, buySol = 0, sellSol = 0, insiderSell = 0; const buySizes: number[] = []; const big = new Set<string>();
  for (const x of w) {
    if (x.side === "buy") { buys++; buySol += x.sol; buyers.add(x.wallet); buySizes.push(x.sol); if (x.sol >= 0.5) big.add(x.wallet); }
    else { sells++; sellSol += x.sol; if (insiders.has(x.wallet) || crew.has(x.wallet)) insiderSell += x.sol; }
  }
  const gradPx = clean[0].price;
  const at = (ts: number) => { let b: any = null; for (const x of clean) { if (x.ts <= ts) b = x; else break; } return b?.price ?? null; };
  const entryPt = clean.find((x) => x.ts >= g0 + ENTRY) ?? null;
  const entryPx = entryPt?.price ?? null;
  const p15 = at(g0 + 15 * 60_000), p60 = at(g0 + 60 * 60_000);
  const after = entryPt ? clean.filter((x) => x.ts >= entryPt.ts) : [];
  const real = t.verified ? isRealOutcome({ mcapSol: t.mcap_sol, mcapUsd: t.mcap_usd, poolSol: t.pool_sol, verified: true }) && organicDemand(db, t) : null;
  rows.push({
    sym: t.symbol, buyers: buyers.size, buys, sells, buySol, sellSol, net: buySol - sellSol, insiderSellShare: sellSol > 0 ? insiderSell / sellSol : 0, medBuy: median(buySizes), bigBuyers: big.size,
    gradX: gradPx / t.launch_price, xEntry: entryPx ? entryPx / gradPx : null, x15: p15 ? p15 / gradPx : null, x60: p60 ? p60 / gradPx : null,
    peakAfterEntry: after.length && entryPx ? Math.max(...after.map((x) => x.price)) / entryPx : null,
    held60: p60 !== null && p60 >= 1.5 * gradPx, real, verified: !!t.verified, secsToGrad: (g0 - t.created_at) / 1000,
    path: after, entryPx, entryTs: entryPt?.ts ?? null, devSellAfter: after.some((x) => x.side === "sell" && x.wallet === t.creator), creator: t.creator,
  });
}
const nVer = rows.filter((r) => r.verified).length, nReal = rows.filter((r) => r.real).length;
console.log(`\n=== post-graduation analysis - ${rows.length} graduated tokens with PumpSwap data (last ${hours}h); ${nVer} verified on-chain, ${nReal} real runners (>=2x graduation mcap and >=40 SOL in pool) ===`);
console.log(`base rates: held >=1.5x graduation price at +60m: ${pct(rows.filter((r) => r.held60).length, rows.length)}   verified real: ${pct(nReal, nVer)}\n`);

function feature(name: string, fn: (r: Row) => string | null, order?: string[]) {
  const b = new Map<string, { n: number; held: number; real: number; ver: number; x60: number[]; pk: number[] }>();
  for (const r of rows) { const k = fn(r); if (k === null) continue; const e = b.get(k) ?? b.set(k, { n: 0, held: 0, real: 0, ver: 0, x60: [], pk: [] }).get(k)!; e.n++; if (r.held60) e.held++; if (r.verified) { e.ver++; if (r.real) e.real++; } if (r.x60 !== null) e.x60.push(r.x60); if (r.peakAfterEntry !== null) e.pk.push(r.peakAfterEntry); }
  console.log(name.toUpperCase() + `  (features over the first ${WIN / 1000}s after graduation)`);
  console.log("  bucket".padEnd(26) + "n".padStart(5) + "  held@60m" + "  real(verified)" + "  median x@60m" + "  median peak after +" + ENTRY / 1000 + "s entry");
  for (const k of order ? order.filter((k) => b.has(k)) : [...b.keys()].sort()) { const e = b.get(k)!; console.log(("  " + k).padEnd(26) + String(e.n).padStart(5) + pct(e.held, e.n).padStart(10) + `${e.real}/${e.ver}`.padStart(16) + `${f(median(e.x60))}x`.padStart(14) + `${f(median(e.pk))}x`.padStart(22)); }
  console.log();
}
const bin = (v: number, edges: number[], labels: string[]) => { for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i]; return labels[edges.length]; };
feature("distinct outside buyers", (r) => bin(r.buyers, [3, 8, 15, 30], ["0-2", "3-7", "8-14", "15-29", "30+"]), ["0-2", "3-7", "8-14", "15-29", "30+"]);
feature("net SOL flow (buys - sells)", (r) => bin(r.net, [-5, 0, 2, 10], ["< -5", "-5..0", "0..2", "2..10", "10+"]), ["< -5", "-5..0", "0..2", "2..10", "10+"]);
feature("sells / buys (SOL)", (r) => (r.buySol > 0 ? bin(r.sellSol / r.buySol, [0.25, 0.5, 1, 2], ["<25%", "25-50%", "50-100%", "100-200%", ">200%"]) : null), ["<25%", "25-50%", "50-100%", "100-200%", ">200%"]);
feature("insider share of sells (dev + first-10 + crews)", (r) => (r.sells ? bin(r.insiderSellShare, [0.01, 0.3, 0.7], ["none", "<30%", "30-70%", ">=70%"]) : "no sells"), ["no sells", "none", "<30%", "30-70%", ">=70%"]);
feature("buyers with >= 0.5 SOL", (r) => bin(r.bigBuyers, [1, 3, 6], ["0", "1-2", "3-5", "6+"]), ["0", "1-2", "3-5", "6+"]);
feature("seconds from launch to graduation", (r) => bin(r.secsToGrad, [5, 60, 600], ["<=5s (instant)", "5-60s", "1-10 min", ">10 min"]), ["<=5s (instant)", "5-60s", "1-10 min", ">10 min"]);
feature("price at entry vs graduation price", (r) => (r.xEntry === null ? null : bin(r.xEntry, [0.7, 0.9, 1.1, 1.5], ["<0.7x (dumped)", "0.7-0.9", "0.9-1.1 (flat)", "1.1-1.5", ">1.5x"])), ["<0.7x (dumped)", "0.7-0.9", "0.9-1.1 (flat)", "1.1-1.5", ">1.5x"]);

// ---------- rip-cord simulation for candidate entry rules ----------
function ripcord(r: Row): number | null {
  if (!r.entryPx || !r.path.length) return null;
  const e = r.entryPx, FEE = 0.0155; let peak = e, banked = 0, tokensLeft = 1, exitPx: number | null = null;
  const win: { ts: number; side: string; sol: number }[] = [];
  for (const x of r.path) {
    if (x.price > peak) peak = x.price;
    win.push(x); while (win.length && win[0].ts < x.ts - 30_000) win.shift();
    const m = x.price / e, held = (x.ts - r.entryTs!) / 1000;
    if (banked === 0 && m >= 2) { banked = 0.5 * 2 * (1 - FEE); tokensLeft = 0.5; }
    const buy = win.filter((w) => w.side === "buy").reduce((a, w) => a + w.sol, 0), sell = win.filter((w) => w.side === "sell").reduce((a, w) => a + w.sol, 0);
    const hi10 = Math.max(...r.path.filter((w) => w.ts >= x.ts - 10_000 && w.ts <= x.ts).map((w) => w.price));
    if ((x.side === "sell" && x.wallet === r.creator) || (1 - x.price / hi10 >= 0.45) || (sell >= 2 * Math.max(buy, 0.05) && x.price <= peak * 0.75) || m <= 0.4 || (banked > 0 && x.price <= peak * 0.55) || held >= 90 * 60) { exitPx = x.price; break; }
  }
  if (exitPx === null) exitPx = r.path[r.path.length - 1].price;
  return banked + tokensLeft * (exitPx / e) * (1 - FEE) - 0.02;
}
console.log(`RULE SEARCH - enter ${ENTRY / 1000}s after graduation when the first ${WIN / 1000}s flow passes the rule; rip-cord exits simulated on the AMM path`);
console.log("  rule".padEnd(64) + "n".padStart(5) + "  held@60m" + "  real/ver" + "  mean exit" + "  win%" + "  median peak");
const rules: [string, (r: Row) => boolean][] = [
  ["all graduated (baseline)", () => true],
  ["net flow > 0", (r) => r.net > 0],
  ["buyers >= 8", (r) => r.buyers >= 8],
  ["buyers >= 15", (r) => r.buyers >= 15],
  ["buyers >= 8 & net > 2 SOL", (r) => r.buyers >= 8 && r.net > 2],
  ["buyers >= 8 & sells < 50% of buys", (r) => r.buyers >= 8 && r.sellSol < 0.5 * r.buySol],
  ["buyers >= 8 & insider sells < 30%", (r) => r.buyers >= 8 && r.insiderSellShare < 0.3],
  ["buyers >= 15 & net > 5 & insider sells < 30%", (r) => r.buyers >= 15 && r.net > 5 && r.insiderSellShare < 0.3],
  ["buyers >= 8 & >= 3 buyers of 0.5+ SOL & net > 0", (r) => r.buyers >= 8 && r.bigBuyers >= 3 && r.net > 0],
  ["not instant graduation & buyers >= 8 & net > 0", (r) => r.secsToGrad > 5 && r.buyers >= 8 && r.net > 0],
  ["instant graduation & buyers >= 15 & net > 5", (r) => r.secsToGrad <= 5 && r.buyers >= 15 && r.net > 5],
  ["price at entry >= 0.9x grad & buyers >= 8 & net > 0", (r) => (r.xEntry ?? 0) >= 0.9 && r.buyers >= 8 && r.net > 0],
];
for (const [name, fn] of rules) {
  const g = rows.filter((r) => fn(r) && r.entryPx !== null);
  if (g.length < 5) continue;
  const ex = g.map(ripcord).filter((x): x is number => x !== null);
  const ver = g.filter((r) => r.verified);
  console.log(("  " + name).padEnd(64) + String(g.length).padStart(5) + pct(g.filter((r) => r.held60).length, g.length).padStart(10) + `${ver.filter((r) => r.real).length}/${ver.length}`.padStart(10) + `${f(ex.reduce((a, b) => a + b, 0) / ex.length)}x`.padStart(11) + pct(ex.filter((x) => x > 1).length, ex.length).padStart(6) + `${f(median(g.map((r) => r.peakAfterEntry ?? NaN).filter(Number.isFinite)))}x`.padStart(13));
}
console.log("\n  held@60m = price 60 min after graduation >= 1.5x graduation price (our own trade data). real/ver = verified on-chain real runners among verified tokens.");
console.log("  mean exit = rip cord (bank half at 2x, flow/crash/dev-sell exits, 0.4x floor, 90 min) applied from the entry point; fees+slippage 1.55% per side.\n");
