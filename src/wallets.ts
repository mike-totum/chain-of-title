/**
 * Wallet analysis over everything the monitor has recorded.
 *
 *   npm run wallets -- [--hours 48] [--min-tokens 3] [--top 40]
 *
 * Sections:
 *   1. Universe of wallets: how many, how concentrated, how many "buy everything" bots.
 *   2. Bundlers: wallets that repeatedly buy in the creation block; their graduation rate vs the rest.
 *   3. Smart wallets: early buyers with a graduation rate several times the base rate, positive PnL,
 *      and enough distinct tokens to matter - written to smart_wallets (used live by the smart-wallet strategy).
 *   4. Creators: dev wallets with multiple launches and their graduation record.
 *   5. Graduated-token anatomy: who the first 10 buyers of graduations were, and whether they were repeat winners.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const hours = Number(args.get("hours") ?? 48);
const minTokens = Number(args.get("min-tokens") ?? 3);
const top = Number(args.get("top") ?? 40);
const since = Date.now() - hours * 3600_000;

const db = openDb(config.dbPath);
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const one = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as any[])) as T;
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

console.log(`\n=== wallet analysis - tokens finalized in the last ${hours}h ===\n`);

const u = one(
  `SELECT COUNT(DISTINCT mint) tokens, COUNT(DISTINCT wallet) wallets, COUNT(*) pairs,
          SUM(token_graduated) grad_pairs, (SELECT COUNT(*) FROM tokens WHERE finalized=1 AND late_discovery=0 AND created_at>=?) fin,
          (SELECT SUM(graduated) FROM tokens WHERE finalized=1 AND late_discovery=0 AND created_at>=?) fin_grad
   FROM wallet_token_stats WHERE token_created_at >= ? AND is_dev = 0`,
  since, since, since,
);
const base = u.fin ? u.fin_grad / u.fin : 0.035;
console.log("1. UNIVERSE");
table([
  { metric: "tokens with wallet stats", value: u.tokens ?? 0 },
  { metric: "distinct non-dev wallets", value: u.wallets ?? 0 },
  { metric: "wallet×token pairs", value: u.pairs ?? 0 },
  { metric: "base graduation rate", value: pct(u.fin_grad, u.fin) },
]);
if (!u.tokens) {
  console.log("\nNo finalized tokens with trade data yet. The monitor writes wallet stats when a token's watch window ends (>= 4 min after launch for dead tokens).");
  process.exit(0);
}

// ---------- activity distribution ----------
const dist = q(
  `SELECT CASE WHEN n>=100 THEN '100+' WHEN n>=20 THEN '20-99' WHEN n>=5 THEN '5-19' WHEN n>=2 THEN '2-4' ELSE '1' END bucket, COUNT(*) wallets, SUM(n) pairs
   FROM (SELECT wallet, COUNT(*) n FROM wallet_token_stats WHERE token_created_at>=? AND is_dev=0 GROUP BY wallet) GROUP BY bucket ORDER BY MIN(n)`,
  since,
);
console.log("\n  wallets by number of tokens traded:");
table(dist.map((r) => ({ "tokens traded": r.bucket, wallets: r.wallets, "share of all trading pairs": pct(r.pairs, u.pairs) })));

// ---------- bundlers ----------
console.log("\n2. BUNDLERS (wallets buying in the creation block, slot delta <= 1, on 3+ tokens)");
const bund = q(
  `SELECT wallet, COUNT(*) tokens, SUM(first_buy_slot_delta<=1) sameblock, SUM(token_graduated) grads,
          SUM(realized_pnl_sol + unrealized_sol) pnl, AVG(sol_in) avg_in, AVG(hold_s) hold
   FROM wallet_token_stats WHERE token_created_at>=? AND is_dev=0 GROUP BY wallet HAVING sameblock >= 3 ORDER BY sameblock DESC LIMIT 15`,
  since,
);
table(
  bund.map((r) => ({
    wallet: short(r.wallet), tokens: r.tokens, "same-block buys": r.sameblock, graduated: `${r.grads} (${pct(r.grads, r.tokens)})`,
    "pnl SOL": (r.pnl >= 0 ? "+" : "") + f(r.pnl), "avg buy": f(r.avg_in), "avg hold": r.hold === null ? "-" : `${f(r.hold / 60, 1)}m`,
  })),
);
const bstat = one(
  `SELECT AVG(token_graduated) g_bundled FROM wallet_token_stats WHERE token_created_at>=? AND is_dev=0 AND first_buy_slot_delta<=1`, since,
);
const nstat = one(
  `SELECT AVG(token_graduated) g_normal FROM wallet_token_stats WHERE token_created_at>=? AND is_dev=0 AND (first_buy_slot_delta IS NULL OR first_buy_slot_delta>1)`, since,
);
console.log(`  graduation rate of tokens where a wallet bought in the creation block: ${pct(bstat.g_bundled, 1)} vs other buys: ${pct(nstat.g_normal, 1)}`);

// ---------- smart wallets ----------
console.log(`\n3. SMART WALLETS (>= ${minTokens} tokens, bought ON THE CURVE within 10 min, not the creator, not a same-block bundler on most of them)`);
console.log("   graduation credit only when the token took >= 60 s to graduate - instant graduations are operator-funded and cannot be entered from outside");
// first_buy_age_s is NULL for wallets whose only buys were on the PumpSwap AMM (post-graduation snipers), so the
// age filter also excludes them. Graduations that happened within 60 s of creation are not credited: those are
// dev-bundled operator launches whose AMM buyers looked like "100% graduation rate insiders" on 2026-09-03.
const smart = q(
  `SELECT w.wallet, COUNT(*) tokens,
          SUM(w.token_graduated AND (t.graduated_at IS NULL OR t.graduated_at - t.created_at >= 60000)) grads, SUM(w.token_peak_x >= 3) runners,
          SUM(w.first_buy_age_s <= 60) early60, SUM(w.first_buy_slot_delta <= 1) sameblock,
          SUM(w.realized_pnl_sol + w.unrealized_sol) pnl, SUM(w.realized_pnl_sol + w.unrealized_sol > 0) wins,
          AVG(w.sol_in) avg_in, AVG(w.first_buy_rank) avg_rank, AVG(w.hold_s) hold
   FROM wallet_token_stats w JOIN tokens t ON t.mint = w.mint
   WHERE w.token_created_at >= ? AND w.is_dev = 0 AND w.first_buy_age_s <= 600
   GROUP BY w.wallet HAVING tokens >= ? AND sameblock * 2 < tokens
   ORDER BY (grads * 1.0 / tokens) DESC, pnl DESC LIMIT 400`,
  since, minTokens,
);
const allTokens = u.tokens as number;
const scored = smart
  .map((r) => {
    const gradRate = r.grads / r.tokens;
    const coverage = r.tokens / allTokens; // "buys everything" bots have high coverage and base-rate precision
    const lift = gradRate / Math.max(base, 0.005);
    const confidence = Math.min(1, r.tokens / 10);
    const score = lift * confidence * (r.pnl > 0 ? 1.25 : 0.75) * (coverage > 0.2 ? 0.25 : 1);
    return { ...r, gradRate, coverage, lift, score };
  })
  .sort((a, b) => b.score - a.score);
table(
  scored.slice(0, top).map((r) => ({
    wallet: short(r.wallet), tokens: r.tokens, graduated: `${r.grads} (${pct(r.grads, r.tokens)})`, "3x+": r.runners, "lift vs base": `${f(r.lift, 1)}x`,
    "in first 60s": pct(r.early60, r.tokens), "avg rank": f(r.avg_rank, 0), "avg buy SOL": f(r.avg_in), "pnl SOL": (r.pnl >= 0 ? "+" : "") + f(r.pnl),
    "win%": pct(r.wins, r.tokens), "avg hold": r.hold === null ? "-" : `${f(r.hold / 60, 0)}m`, coverage: pct(r.coverage, 1), score: f(r.score, 1),
  })),
);
console.log("  lift = wallet's graduation rate / base rate. coverage = share of all tokens this wallet touched (high = indiscriminate bot).");

// persist the smart set used by the live strategy
const keep = scored.filter((r) => r.grads >= 2 && r.lift >= 3 && r.coverage <= 0.2 && r.avg_in >= 0.05).slice(0, 100);
db.exec("DELETE FROM smart_wallets");
const ins = db.prepare(`INSERT INTO smart_wallets (wallet, score, tokens, grads, runners, early_share, pnl_sol, updated_at) VALUES (?,?,?,?,?,?,?,?)`);
for (const r of keep) ins.run(r.wallet, r.score, r.tokens, r.grads, r.runners, r.early60 / r.tokens, r.pnl, Date.now());
console.log(`\n  → ${keep.length} wallets saved to smart_wallets (>=2 graduations, >=3x lift, <=20% coverage, avg buy >= 0.05 SOL). The live smart-wallet strategy reloads this set every 10 min.`);

// ---------- creators ----------
console.log("\n4. CREATORS with 2+ launches");
const creators = q(
  `SELECT creator, COUNT(*) launches, SUM(graduated) grads, SUM(dev_sold) sold, AVG(dev_pct) devpct, MAX(peak_price/launch_price) best,
          GROUP_CONCAT(DISTINCT symbol) symbols
   FROM tokens WHERE created_at>=? AND late_discovery=0 AND creator!='' GROUP BY creator HAVING launches>=2 ORDER BY launches DESC, grads DESC LIMIT 20`,
  since,
);
table(
  creators.map((r) => ({
    creator: short(r.creator), launches: r.launches, graduated: `${r.grads} (${pct(r.grads, r.launches)})`, "dev sold": pct(r.sold, r.launches),
    "avg dev %": f(r.devpct, 1), "best peak": `${f(r.best, 1)}x`, symbols: String(r.symbols).slice(0, 50),
  })),
);
const cstat = one(`SELECT COUNT(*) n, SUM(launches>=2) serial FROM (SELECT creator, COUNT(*) launches FROM tokens WHERE created_at>=? AND late_discovery=0 GROUP BY creator)`, since);
console.log(`  ${cstat.serial} of ${cstat.n} creators launched more than once in the window.`);

// ---------- anatomy of graduations ----------
console.log("\n5. ANATOMY OF GRADUATED TOKENS: first 10 non-dev buyers");
const smartSet = new Set(keep.map((r) => r.wallet));
const gradRows = q(
  `SELECT w.mint, t.symbol, w.wallet, w.first_buy_rank, w.first_buy_age_s, w.first_buy_slot_delta, w.sol_in, w.realized_pnl_sol + w.unrealized_sol pnl
   FROM wallet_token_stats w JOIN tokens t ON t.mint = w.mint
   WHERE w.token_created_at>=? AND w.token_graduated=1 AND w.is_dev=0 AND w.first_buy_rank <= 10`,
  since,
);
const nGrad = new Set(gradRows.map((r) => r.mint)).size;
const repeat = q(`SELECT wallet, COUNT(*) n FROM wallet_token_stats WHERE token_created_at>=? AND is_dev=0 GROUP BY wallet HAVING n>=3`, since);
const repeatSet = new Set(repeat.map((r) => r.wallet));
let sameBlock = 0, repeaters = 0, smartHits = 0, profitable = 0;
for (const r of gradRows) {
  if (r.first_buy_slot_delta !== null && r.first_buy_slot_delta <= 1) sameBlock++;
  if (repeatSet.has(r.wallet)) repeaters++;
  if (smartSet.has(r.wallet)) smartHits++;
  if (r.pnl > 0) profitable++;
}
table([
  { metric: "graduated tokens analysed", value: nGrad },
  { metric: "first-10 buyer slots", value: gradRows.length },
  { metric: "bought in the creation block", value: pct(sameBlock, gradRows.length) },
  { metric: "wallet active on 3+ tokens (repeat player)", value: pct(repeaters, gradRows.length) },
  { metric: "wallet in the smart set", value: pct(smartHits, gradRows.length) },
  { metric: "ended profitable on that token", value: pct(profitable, gradRows.length) },
]);
console.log();
