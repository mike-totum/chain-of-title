/** Per-token warning verdict: is what a buyer is being shown actually true?
 *  npm run verdict -- [--hours 24] [--mint <mint>]
 *  Every check is on-chain-verifiable and states the evidence. Precision matters more than recall:
 *  a false warning on a real token costs more trust than a missed warning. */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HOURS = Number(arg("--hours", "24")), ONE = arg("--mint", "");
const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");

const GRAD_PRICE = 115 / 279_900_000; // SOL per token at graduation
type Tok = {
  mint: string; symbol: string; dev_pct: number; graduated: number; graduated_at: number | null; created_at: number;
  unique_buyers: number; vault_sol: number | null; vault_at: number | null; amm_trusted: number | null; last_price: number | null; pool: string | null;
  late_discovery: number;
};
const where = ONE ? "tk.mint = ?" : "tk.created_at >= ?";
const rows = db.prepare(`SELECT mint, symbol, dev_pct, graduated, graduated_at, created_at, unique_buyers, vault_sol, vault_at, amm_trusted, last_price, pool, late_discovery
  FROM tokens tk WHERE ${where}`).all(ONE ? ONE : Date.now() - HOURS * 3600_000) as Tok[];

const opWallets = new Set((db.prepare("SELECT wallet FROM operator_wallets WHERE cluster IS NOT NULL").all() as { wallet: string }[]).map((r) => r.wallet));
const avoidClusters = new Set((db.prepare("SELECT cluster FROM operator_policy WHERE policy='avoid'").all() as { cluster: string }[]).map((r) => r.cluster));
const opOnToken = db.prepare(`SELECT DISTINCT w.cluster FROM trades t JOIN operator_wallets w ON w.wallet = t.wallet WHERE t.mint = ? AND w.cluster IS NOT NULL`);
const buyerConc = db.prepare(`SELECT wallet, SUM(sol) s FROM trades WHERE mint=? AND venue='amm' AND side='buy' GROUP BY wallet ORDER BY s DESC LIMIT 1`);
const buyTotal = db.prepare(`SELECT COALESCE(SUM(sol),0) s, COUNT(DISTINCT wallet) w FROM trades WHERE mint=? AND venue='amm' AND side='buy'`);

type Flag = { level: "danger" | "caution"; code: string; why: string };
function verdict(t: Tok): Flag[] {
  const f: Flag[] = [];
  const mcapSol = (t.last_price ?? 0) * 1e9;      // 1B supply
  // Only a balance whose reading time we know can support a present-tense claim. Rows written before `vault_at`
  // existed have no such time, so the two pool-dependent flags below simply do not fire on them — a stale low reading
  // would otherwise print `no-exit-liquidity` on a pool that has since been refilled, which is a false warning, and
  // false warnings are the one thing this tool cannot afford. Launch-fact flags are unaffected: they never decay.
  const pool = t.vault_at === null ? null : t.vault_sol;

  // 1. The cap is fiction: the pool cannot support anything like the number on screen.
  //    Constant product says a genuine k-fold move leaves ~85*sqrt(k) SOL in the pool. Far below that = the price
  //    was printed by someone buying their own pool, not by a market. This is the WOFI case ($240M cap, 1.24 SOL).
  if (t.graduated && pool !== null && mcapSol > 0) {
    const k = mcapSol / 411;                       // multiple of the graduation cap
    const expected = 85 * Math.sqrt(Math.max(k, 1));
    if (k >= 2 && pool < expected * 0.25)
      f.push({ level: "danger", code: "cap-fiction", why: `pool holds ${pool.toFixed(0)} SOL; a genuine ${k.toFixed(0)}x move leaves ~${expected.toFixed(0)} SOL. The displayed cap is not backed by the pool.` });
  }
  // 2. Cannot exit: whatever the cap says, this is the money actually available to sell into.
  if (t.graduated && pool !== null && pool < 40)
    f.push({ level: "danger", code: "no-exit-liquidity", why: `only ${pool.toFixed(1)} SOL in the pool — a position cannot be sold at anything near the shown price.` });
  // 3. The dev owns the supply: every buyer is bidding against the creator's inventory.
  if (t.dev_pct >= 50 && !t.late_discovery)
    f.push({ level: "danger", code: "dev-owns-supply", why: `the creator holds ${t.dev_pct.toFixed(0)}% of supply.` });
  // 4. Dev-funded instant graduation: no outside demand was involved in "graduating".
  //    Only meaningful for a token watched from launch. restoreToken ages a restored token from the moment we found
  //    it, so created_at == graduated_at for late discoveries and this fired on 210 of 832 tokens with no history at
  //    all (avg 9.3 buyers seen, against 151 for tracked ones). Absence of evidence must never become a warning.
  if (t.graduated && !t.late_discovery && t.graduated_at && t.graduated_at - t.created_at <= 60_000) {
    // state the mechanism accurately: with dev_pct ~0 the curve was taken at birth by bundled snipers, not the creator.
    // Claiming the wrong cause is worse than saying nothing when the whole product is trust.
    const secs = Math.round((t.graduated_at - t.created_at) / 1000);
    const who = t.dev_pct >= 20 ? "the creator funded it" : "a bundle of wallets bought the whole curve in the first block";
    f.push({ level: "danger", code: "instant-graduation", why: `left the curve ${secs}s after launch — ${who}, so the float was taken before anyone could buy at a normal price.` });
  }
  // 5. Decoded trades disagree with the pool's own balances: the reported price is unreliable.
  if (t.amm_trusted === 0)
    f.push({ level: "caution", code: "price-unverified", why: `trade prices disagree with the pool's on-chain balances; treat any quoted price as unverified.` });
  // 6. One wallet is the market.
  const bt = buyTotal.get(t.mint) as { s: number; w: number };
  if (bt && bt.s > 5) {
    const top = buyerConc.get(t.mint) as { wallet: string; s: number } | undefined;
    if (top && top.s / bt.s > 0.5)
      f.push({ level: "danger", code: "one-wallet-market", why: `a single wallet is ${(100 * top.s / bt.s).toFixed(0)}% of all buying (${bt.w} buyers total).` });
  }
  // 7. A farm we have already watched distribute is on the book.
  // Operator wallets trade widely; their mere presence is not fraud. Only warn when the farm is a material share of the
  // buying, i.e. the token's demand is substantially the farm itself. Otherwise note it and stay quiet.
  const cl = (opOnToken.all(t.mint) as { cluster: string }[]).map((r) => r.cluster);
  const bad = cl.filter((c) => avoidClusters.has(c));
  if (bad.length && bt && bt.s > 5) {
    const opBuy = (db.prepare(`SELECT COALESCE(SUM(t.sol),0) s FROM trades t JOIN operator_wallets w ON w.wallet=t.wallet
      WHERE t.mint=? AND t.venue='amm' AND t.side='buy' AND w.cluster IS NOT NULL`).get(t.mint) as { s: number }).s;
    const share = opBuy / bt.s;
    if (share >= 0.25)
      f.push({ level: "danger", code: "farm-is-the-demand", why: `${(100 * share).toFixed(0)}% of all buying comes from operator cluster${bad.length > 1 ? "s" : ""} ${bad.join(", ")}, which sell into buyers on the plays we have measured.` });
    else if (share >= 0.05)
      f.push({ level: "caution", code: "operator-present", why: `operator cluster${bad.length > 1 ? "s" : ""} ${bad.join(", ")} are ${(100 * share).toFixed(0)}% of buying.` });
  }
  return f;
}

/** A clean verdict must mean "checked and nothing is wrong", never "we have no data". */
function insufficient(t: Tok): string | null {
  if (t.late_discovery && t.unique_buyers < 5) return "restored after launch; its curve history was never observed";
  if (t.graduated && t.vault_sol === null) return "pool balances not yet read";
  if (t.graduated && t.vault_at === null) return "pool balance on file has no recorded measurement time";
  return null;
}

if (ONE) {
  for (const t of rows) {
    const f = verdict(t);
    const un = insufficient(t);
    console.log(`\n${t.symbol} ${t.mint}`);
    const age = t.vault_at ? `${((Date.now() - t.vault_at) / 3600_000).toFixed(1)} h ago` : "measurement time unknown";
    console.log(`  pool ${t.vault_sol ?? "?"} SOL (read ${age}), dev ${t.dev_pct?.toFixed(0)}%, buyers ${t.unique_buyers}, graduated ${t.graduated ? "yes" : "no"}`);
    if (un) console.log(`  [UNKNOWN] ${un} — not enough observed to judge`);
    if (!f.length && !un) console.log("  no warning — nothing measurable is wrong with what is displayed");
    for (const x of f) console.log(`  [${x.level.toUpperCase()}] ${x.code}: ${x.why}`);
  }
} else {
  const counts = new Map<string, number>();
  let danger = 0, caution = 0, clean = 0, unknown = 0;
  for (const t of rows) {
    const f = verdict(t);
    for (const x of f) counts.set(x.code, (counts.get(x.code) ?? 0) + 1);
    if (f.some((x) => x.level === "danger")) danger++;
    else if (insufficient(t)) unknown++;
    else if (f.length) caution++; else clean++;
  }
  console.log(`${rows.length} tokens seen in the last ${HOURS} h\n`);
  console.log(`  danger   ${danger}  (${(100 * danger / rows.length).toFixed(1)}%)`);
  console.log(`  caution  ${caution}  (${(100 * caution / rows.length).toFixed(1)}%)`);
  console.log(`  unknown  ${unknown}  (${(100 * unknown / rows.length).toFixed(1)}%)  — not enough observed to judge`);
  console.log(`  clean    ${clean}  (${(100 * clean / rows.length).toFixed(1)}%)\n`);
  console.log("flag                  tokens");
  for (const [c, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${c.padEnd(20)}  ${String(n).padStart(6)}`);
  const grad = rows.filter((r) => r.graduated);
  const gd = grad.filter((r) => verdict(r).some((x) => x.level === "danger")).length;
  console.log(`\nof ${grad.length} graduated tokens, ${gd} (${(100 * gd / Math.max(grad.length, 1)).toFixed(1)}%) carry a danger flag`);
}
