/**
 * Who is about to sell to you. Profiles a wallet's behaviour across every token in our archive.
 *   npm run operator -- <wallet>
 *
 * A flag says "be careful". This says who took the curve and what they did the last five times. It is the one thing
 * we hold that no configuration scanner can produce, because it needs the history of the wallet across many tokens.
 * Everything is stated as "in our data" — coverage starts 2026-09-02 and only tokens we tracked have per-trade rows.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const BUYOUT_SOL = 40;

export interface Profile {
  buyouts: { mint: string; symbol: string | null; sol: number; ts: number; dormantH: number | null }[];
  curveSol: number; ammBuy: number; ammSell: number; tokens: number;
  cluster: string | null; policy: string | null;
}

/**
 * A curve buyout may be recorded in either table: `trades` if we watched it live, `hist_trades` if it came from chain
 * reconstruction. Checking only `trades` certified Squads as a clean launch on 2026-09-06 — a token whose 85 SOL
 * buyout is in `hist_trades` and which the farm dumped 283 SOL into within half an hour. Always check both.
 */
// findBuyout is called once per token across every graduation in a reporting window, so its two statements are
// prepared once per database handle instead of on every call.
const buyoutStmts = new WeakMap<object, { live: any; hist: any | null }>();
function stmts(dbh: any) {
  let s = buyoutStmts.get(dbh);
  if (!s) {
    s = {
      live: dbh.prepare(`SELECT wallet, MAX(sol) sol, MIN(ts) ts FROM trades
        WHERE mint = ? AND venue='curve' AND side='buy' AND sol >= ? GROUP BY wallet ORDER BY sol DESC LIMIT 1`),
      hist: (() => {
        try {
          return dbh.prepare(`SELECT wallet, MAX(sol) sol, MIN(ts) ts FROM hist_trades
            WHERE mint = ? AND side='buy' AND sol >= ? GROUP BY wallet ORDER BY sol DESC LIMIT 1`);
        } catch { return null; }
      })(),
    };
    buyoutStmts.set(dbh, s);
  }
  return s;
}

export function findBuyout(dbh: any, mint: string, minSol = 40): { wallet: string; sol: number; ts: number } | null {
  const s = stmts(dbh);
  const live = s.live.get(mint, minSol) as any;
  if (live) return live;
  try {
    return (s.hist?.get(mint, minSol) as any) ?? null;
  } catch { return null; }
}

export function profile(dbh: any, w: string): Profile {
  const buyouts = dbh.prepare(`SELECT t.mint, tk.symbol, MAX(t.sol) sol, MIN(t.ts) ts, tk.created_at
    FROM trades t LEFT JOIN tokens tk ON tk.mint = t.mint
    WHERE t.wallet = ? AND t.venue='curve' AND t.side='buy' AND t.sol >= ?
    GROUP BY t.mint ORDER BY ts DESC`).all(w, BUYOUT_SOL) as any[];
  // reconstructed curves count too, or a wallet's record is understated by exactly the winners we rebuilt by hand
  try {
    const seen = new Set(buyouts.map((b: any) => b.mint));
    for (const h of dbh.prepare(`SELECT h.mint, ht.symbol, MAX(h.sol) sol, MIN(h.ts) ts, ht.first_ts created_at
      FROM hist_trades h LEFT JOIN hist_tokens ht ON ht.mint = h.mint
      WHERE h.wallet = ? AND h.side='buy' AND h.sol >= ? GROUP BY h.mint`).all(w, BUYOUT_SOL) as any[])
      if (!seen.has(h.mint)) buyouts.push(h);
  } catch {}
  // What the wallet did after taking the curve — the only reason these pages exist. It is derived from every trade
  // the wallet made, so a database that carries only the buyouts cannot compute it. `wallet_flow` holds the answer
  // precomputed, one row per wallet; without it, a record database silently reported "0 SOL sold" for a wallet that
  // sold 3,512, which is an exculpatory claim built out of missing data. Prefer the stored row; never invent a zero.
  let flow = (() => {
    try { return dbh.prepare("SELECT curve_sol curveSol, amm_buy ammBuy, amm_sell ammSell, tokens FROM wallet_flow WHERE wallet = ?").get(w) as any; }
    catch { return null; }
  })();
  if (!flow) flow = dbh.prepare(`SELECT
      COALESCE(SUM(CASE WHEN venue='curve' AND side='buy' THEN sol END),0) curveSol,
      COALESCE(SUM(CASE WHEN venue='amm'   AND side='buy' THEN sol END),0) ammBuy,
      COALESCE(SUM(CASE WHEN venue='amm'   AND side='sell' THEN sol END),0) ammSell,
      COUNT(DISTINCT mint) tokens
    FROM trades WHERE wallet = ?`).get(w) as any;
  const op = dbh.prepare("SELECT cluster FROM operator_wallets WHERE wallet = ?").get(w) as any;
  const pol = op?.cluster ? (dbh.prepare("SELECT policy FROM operator_policy WHERE cluster = ?").get(op.cluster) as any) : null;
  return {
    buyouts: buyouts.map((b) => ({ mint: b.mint, symbol: b.symbol, sol: b.sol, ts: b.ts,
      dormantH: b.created_at ? (b.ts - b.created_at) / 3600_000 : null })),
    curveSol: flow.curveSol, ammBuy: flow.ammBuy, ammSell: flow.ammSell, tokens: flow.tokens,
    cluster: op?.cluster ?? null, policy: pol?.policy ?? null,
  };
}

/** one plain sentence a reader can act on, or null when the wallet has no pattern worth stating */
export function verdictLine(p: Profile): string | null {
  if (!p.buyouts.length) return null;
  const n = p.buyouts.length;
  const ratio = p.ammBuy > 0 ? p.ammSell / p.ammBuy : Infinity;
  if (p.ammSell >= 20 && ratio >= 3)
    return `This wallet has taken ${n} bonding curve${n > 1 ? "s" : ""} outright (${p.curveSol.toFixed(0)} SOL) and sold ${p.ammSell.toFixed(0)} SOL into buyers on the open market while buying back only ${p.ammBuy.toFixed(1)}. It distributes; it does not hold.`;
  if (p.ammSell >= 20 && ratio >= 1.2)
    return `This wallet has taken ${n} bonding curve${n > 1 ? "s" : ""} and is a net seller on the open market (${p.ammSell.toFixed(0)} SOL out against ${p.ammBuy.toFixed(0)} in).`;
  // Zero in and zero out is an absence of data, not a measured neutral, and it must not read as one: most
  // graduations have no market trades on our record at all, so "not yet a net seller (0 SOL in, 0 out)" was
  // reporting silence as a finding.
  if (p.ammBuy === 0 && p.ammSell === 0)
    return `This wallet has taken ${n} bonding curve${n > 1 ? "s" : ""} outright (${p.curveSol.toFixed(0)} SOL). We hold no market trades for it in either direction, so what it did with the tokens afterwards is not on our record.`;
  return `This wallet has taken ${n} bonding curve${n > 1 ? "s" : ""} outright (${p.curveSol.toFixed(0)} SOL). It is not yet a net seller in our data (${p.ammBuy.toFixed(0)} SOL in, ${p.ammSell.toFixed(0)} out).`;
}

// CLI only. check.ts imports profile()/verdictLine(); importing must not run a report.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\u0000");
if (isMain) {
  const wallet = process.argv[2];
  if (!wallet) { console.error("usage: npm run operator -- <wallet>"); process.exit(1); }
  const db = openDb(config.dbPath);
  db.exec("PRAGMA query_only = 1");
  const p = profile(db, wallet);
  const cov = db.prepare("SELECT MIN(created_at) a FROM tokens WHERE late_discovery=0").get() as any;
  console.log(`\n${wallet}`);
  console.log(`  our archive starts ${new Date(cov.a).toISOString().slice(0, 10)}; everything below is what this wallet did inside it\n`);
  if (p.cluster) console.log(`  operator cluster  ${p.cluster}${p.policy ? ` (policy: ${p.policy})` : ""}`);
  console.log(`  tokens touched    ${p.tokens}`);
  console.log(`  curve buyouts     ${p.buyouts.length} (>= ${BUYOUT_SOL} SOL in a single buy)`);
  console.log(`  spent on curves   ${p.curveSol.toFixed(1)} SOL`);
  console.log(`  open market       bought ${p.ammBuy.toFixed(1)} SOL, sold ${p.ammSell.toFixed(1)} SOL`);
  const line = verdictLine(p);
  if (line) console.log(`\n  ${line}`);
  if (p.buyouts.length) {
    console.log("\n  curve buyouts");
    console.log("  when              symbol        mint      SOL    curve age at buyout");
    for (const b of p.buyouts.slice(0, 20))
      console.log(`  ${new Date(b.ts).toISOString().slice(5, 16).replace("T", " ")}  ${(b.symbol ?? "?").slice(0, 12).padEnd(12)}  ${b.mint.slice(0, 6)}  ${b.sol.toFixed(0).padStart(5)}  ${b.dormantH === null ? "unknown" : b.dormantH < 1 ? `${(b.dormantH * 60).toFixed(0)} min` : `${b.dormantH.toFixed(1)} h`}`);
  }
  console.log("");
}
