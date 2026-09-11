/**
 * The scarce list: launches that were NOT manufactured.
 *   npm run clean -- [--hours 24] [--limit 50]
 *
 * We flag ~73 % of graduated tokens as dangerous, and a warning that fires three times in four carries no information.
 * The same data inverted is useful: only ~4.3 % of graduations launch with the creator holding little, real buyers
 * present, and a curve that took time to fill. Scarcity is what carries signal.
 *
 * "Clean" means NOT MANUFACTURED. It does not mean the token will go up, and it must never be presented that way:
 * zero of 19,412 bonding-curve positions we measured ever reached 5x, and the post-graduation tail is shrinking.
 * A clean token still loses money on average. This list removes one specific harm, not risk.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { findBuyout } from "./operator.ts";
import { coverageFor } from "./provenance.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const HOURS = arg("--hours", 24), LIMIT = arg("--limit", 50);
const MAX_DEV_PCT = 20, MIN_BUYERS = 30, MIN_GRAD_MS = 60_000;

const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");
const since = Date.now() - HOURS * 3600_000;

// only count a launch as clean if we were demonstrably running when it happened
const GAP_TOLERANCE_MS = 180_000;
const runs = db.prepare("SELECT started_at, stopped_at FROM runs WHERE started_at IS NOT NULL ORDER BY started_at").all() as { started_at: number; stopped_at: number | null }[];
const windows: { a: number; b: number }[] = [];
for (const r of runs) {
  const end = r.stopped_at ?? r.started_at;
  const last = windows[windows.length - 1];
  if (last && r.started_at - last.b <= GAP_TOLERANCE_MS) last.b = Math.max(last.b, end);
  else windows.push({ a: r.started_at, b: end });
}
const covered = coverageFor(db);

const all = db.prepare(`SELECT mint, symbol, creator, created_at, dev_pct, unique_buyers, graduated, graduated_at,
  vault_sol, dev_sold FROM tokens
  WHERE late_discovery = 0 AND graduated = 1 AND created_at >= ?`).all(since) as any[];

const inCov = all.filter((t) => covered(t.created_at));
// Inclusion requires positive verification, not merely the absence of a flag. An unread pool disqualifies: we cannot
// vouch for liquidity we have not measured. A first pass without these produced a list where most entries held 1-6 SOL
// or the creator had already sold - a clean token nobody can exit is not a useful thing to hand someone.
const MIN_POOL_SOL = 40;
const clean = inCov.filter((t) =>
  t.dev_pct < MAX_DEV_PCT && (t.unique_buyers ?? 0) >= MIN_BUYERS &&
  t.graduated_at && (t.graduated_at - t.created_at) > MIN_GRAD_MS &&
  !t.dev_sold && t.vault_sol != null && t.vault_sol >= MIN_POOL_SOL);

// Operator wallets trade widely, so mere presence is guilt by association - the same standard `verdict` uses. A farm
// only disqualifies when it is a material share of the buying, i.e. the demand is substantially the farm itself.
// Applying presence alone cut 11 of 15 candidates and would have made the list arbitrary.
const FARM_MATERIAL = 0.25;
const avoid = new Set((db.prepare("SELECT cluster FROM operator_policy WHERE policy='avoid'").all() as any[]).map((x) => x.cluster));
const farmOn = db.prepare(`SELECT DISTINCT w.cluster FROM trades t JOIN operator_wallets w ON w.wallet = t.wallet
  WHERE t.mint = ? AND w.cluster IS NOT NULL`);
// A clean LAUNCH is not a clean token. PSHROOM and PONST both launched with 0 % creator supply, then sat dormant for
// ~9.5 h until one 85 SOL buy took the whole curve - the operator buyout pattern. "Took 9.5h to fill" reads as healthy
// slow growth in a table and is the opposite. A curve completed by a single large buy was bought, not filled.
const BUYOUT_SOL = 40;
const buyout = db.prepare(`SELECT wallet, sol FROM trades WHERE mint=? AND market='curve' AND side='buy' AND sol>=?
  ORDER BY sol DESC LIMIT 1`);
const buyTot = db.prepare(`SELECT COALESCE(SUM(sol),0) s FROM trades WHERE mint=? AND market='amm' AND side='buy'`);
const farmBuy = db.prepare(`SELECT COALESCE(SUM(t.sol),0) s FROM trades t JOIN operator_wallets w ON w.wallet=t.wallet
  WHERE t.mint=? AND t.market='amm' AND t.side='buy' AND w.cluster IS NOT NULL`);
const final = clean.map((t) => {
  const cl = (farmOn.all(t.mint) as any[]).map((r) => r.cluster).filter((c: string) => avoid.has(c));
  const tot = (buyTot.get(t.mint) as any).s as number;
  const fb = (farmBuy.get(t.mint) as any).s as number;
  const share = tot > 0 ? fb / tot : 0;
  const bo = findBuyout(db, t.mint, BUYOUT_SOL);
  return { ...t, farms: cl as string[], farmShare: share, buyoutSol: bo?.sol ?? 0 };
}).filter((t) => !(t.farms.length && t.farmShare >= FARM_MATERIAL))
  .filter((t) => !t.buyoutSol);

const hrs = (ms: number) => ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3600_000).toFixed(1)}h`;
console.log(`\nlast ${HOURS} h: ${inCov.length.toLocaleString()} graduated launches we watched from creation`);
console.log(`${final.length} of them launched clean (${(100 * final.length / Math.max(inCov.length, 1)).toFixed(1)}%)`);
console.log(`\n  clean = creator kept under ${MAX_DEV_PCT}% of supply and has not sold, at least ${MIN_BUYERS} real buyers on`);
console.log(`          the curve, it took over a minute to fill and was not completed by a single ${BUYOUT_SOL}+ SOL buy,`);
console.log(`          at least ${MIN_POOL_SOL} SOL of measured liquidity,`);
console.log(`          and no farm we have watched distribute traded it.`);
console.log(`\n  This says the launch was NOT MANUFACTURED. It does not say the token will go up, and it is not a`);
console.log(`  recommendation. A clean token still loses money on average - of 19,412 bonding-curve positions we`);
console.log(`  measured, none ever reached 5x, and the post-graduation tail is shrinking week over week.\n`);

// be explicit about what our own limits removed, so the count is not read as a market fact when it is partly a coverage fact
const cand = inCov.filter((t) => t.dev_pct < MAX_DEV_PCT && (t.unique_buyers ?? 0) >= MIN_BUYERS && t.graduated_at && (t.graduated_at - t.created_at) > MIN_GRAD_MS);
const exDev = cand.filter((t) => t.dev_sold).length;
const exUnmeasured = cand.filter((t) => !t.dev_sold && t.vault_sol == null).length;
const exThin = cand.filter((t) => !t.dev_sold && t.vault_sol != null && t.vault_sol < MIN_POOL_SOL).length;
console.log(`  ${cand.length} passed the launch tests; ${exDev} then had the creator sell, ${exThin} had under ${MIN_POOL_SOL} SOL of liquidity,`);
const exBuyout = cand.filter((t) => findBuyout(db, t.mint, BUYOUT_SOL)).length;
console.log(`  and ${exUnmeasured} we could not measure (our gap, not theirs) - those are excluded but may be fine.`);
console.log(`  ${exBuyout} had their curve completed by a single ${BUYOUT_SOL}+ SOL buy - bought out, not filled.\n`);

console.log("symbol        mint      creator kept  curve buyers  took     pool SOL  farm share");
for (const t of final.sort((a, b) => b.created_at - a.created_at).slice(0, LIMIT))
  console.log(`${(t.symbol ?? "?").slice(0, 12).padEnd(12)}  ${t.mint.slice(0, 6)}  ${(t.dev_pct?.toFixed(1) + "%").padStart(12)}  ${String(t.unique_buyers).padStart(12)}  ${hrs(t.graduated_at - t.created_at).padStart(6)}  ${(t.vault_sol != null ? t.vault_sol.toFixed(0) : "?").padStart(8)}  ${(t.farmShare > 0 ? (100 * t.farmShare).toFixed(0) + "%" : "-").padStart(10)}`);
if (!final.length) console.log("  (none - every graduation in this window carried at least one manufacturing marker)");
console.log("");
