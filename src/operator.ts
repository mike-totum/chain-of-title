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
  /** Who funded the wallet, and how big the group it belongs to is. Computed already; it was simply never returned. */
  funder: string | null; clusterWallets: number; clusterCurves: number;
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
      // `sig` is bare beside an aggregate on purpose: SQLite guarantees a bare column in a MAX()/MIN() query comes
      // from the row that supplied the extreme value, so this is the signature of the largest buy and not some other
      // row's. That guarantee is specific to a single MAX or MIN, which is why it is spelled out rather than assumed.
      live: dbh.prepare(`SELECT wallet, MAX(sol) sol, MIN(ts) ts, sig FROM trades
        WHERE mint = ? AND venue='curve' AND side='buy' AND sol >= ? GROUP BY wallet ORDER BY sol DESC LIMIT 1`),
      hist: (() => {
        try {
          return dbh.prepare(`SELECT wallet, MAX(sol) sol, MIN(ts) ts, sig FROM hist_trades
            WHERE mint = ? AND side='buy' AND sol >= ? GROUP BY wallet ORDER BY sol DESC LIMIT 1`);
        } catch { return null; }
      })(),
    };
    buyoutStmts.set(dbh, s);
  }
  return s;
}

export function findBuyout(dbh: any, mint: string, minSol = 40): { wallet: string; sol: number; ts: number; sig?: string | null } | null {
  const s = stmts(dbh);
  const live = s.live.get(mint, minSol) as any;
  if (live) return live;
  try {
    return (s.hist?.get(mint, minSol) as any) ?? null;
  } catch { return null; }
}

/**
 * One buyout is one (wallet, mint) pair, whichever table it was recorded in.
 *
 * A purchase watched live lands in `trades`; the same purchase recovered from chain history lands in `hist_trades`
 * with its timestamp truncated to the second, so the two copies cannot be matched on time and must be matched on
 * the pair. Every count of a cluster's curves goes through this, because the alternative is what happened: three
 * call sites, two of them reading only `trades`, and two pages linked to each other disagreeing by five.
 */
const CLUSTER_BUYS = `SELECT t.wallet wallet, t.mint mint FROM trades t JOIN operator_wallets w ON w.wallet = t.wallet
     WHERE t.venue='curve' AND t.side='buy' AND t.sol >= ${BUYOUT_SOL} AND w.cluster = ?
     GROUP BY t.wallet, t.mint
   UNION
   SELECT h.wallet, h.mint FROM hist_trades h JOIN operator_wallets w ON w.wallet = h.wallet
     WHERE h.side='buy' AND h.sol >= ${BUYOUT_SOL} AND w.cluster = ?
     GROUP BY h.wallet, h.mint`;

/** How many distinct bonding curves a cluster has taken. Null-safe against a database with no `hist_trades`. */
export function clusterCurveCount(dbh: any, cluster: string): number {
  try {
    return Number((dbh.prepare(`SELECT COUNT(DISTINCT mint) c FROM (${CLUSTER_BUYS})`).get(cluster, cluster) as any).c);
  } catch {
    return Number((dbh.prepare(`SELECT COUNT(DISTINCT t.mint) c FROM trades t JOIN operator_wallets w ON w.wallet = t.wallet
      WHERE t.venue='curve' AND t.side='buy' AND t.sol >= ${BUYOUT_SOL} AND w.cluster = ?`).get(cluster) as any).c);
  }
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
  const op = dbh.prepare("SELECT cluster, funder FROM operator_wallets WHERE wallet = ?").get(w) as any;
  /**
   * The size of the group, which is the whole reason a cluster is worth naming.
   *
   * "This wallet bought a curve" is one event. "This wallet is one of 32 seeded by a single funder, which together
   * took 14 curves" is a machine, and it is the sentence no contract scanner can produce because it needs a
   * wallet's history across many tokens rather than one token's state. It was computed and stored and then not
   * carried out of this function, so no page could say it.
   */
  const grp = op?.cluster ? {
    wallets: (dbh.prepare("SELECT COUNT(*) c FROM operator_wallets WHERE cluster = ?").get(op.cluster) as any).c,
    // Counted by clusterCurveCount and not here, because this sentence and the cluster page it links to are two
    // renderings of one fact. Reading `trades` alone made a wallet page say "together took 22 bonding curves"
    // above a link to a page that said 27: the same group, counted twice, differing by the curves we reconstructed
    // from chain history rather than watched live. Neither number was wrong, which is what made it unfixable by
    // looking at either page.
    curves: clusterCurveCount(dbh, op.cluster),
  } : null;
  const pol = op?.cluster ? (dbh.prepare("SELECT policy FROM operator_policy WHERE cluster = ?").get(op.cluster) as any) : null;
  return {
    buyouts: buyouts.map((b) => ({ mint: b.mint, symbol: b.symbol, sol: b.sol, ts: b.ts,
      dormantH: b.created_at ? (b.ts - b.created_at) / 3600_000 : null })),
    curveSol: flow.curveSol, ammBuy: flow.ammBuy, ammSell: flow.ammSell, tokens: flow.tokens,
    cluster: op?.cluster ?? null, policy: pol?.policy ?? null,
    funder: op?.funder || null, clusterWallets: Number(grp?.wallets ?? 0), clusterCurves: Number(grp?.curves ?? 0),
  };
}

/**
 * The verdict on a wallet, as a label and its reason rather than one long sentence.
 *
 * It used to be a single string, and the wallet page split it on the first "." to get a heading — which worked until
 * a wallet had bought back 0.0 SOL, at which point the decimal point WAS the first full stop: the heading swallowed
 * the whole sentence and the reason under it read "0." Splitting prose on punctuation to recover structure that was
 * thrown away is the bug; giving the structure a shape is the fix.
 */
export type WalletVerdict = { label: string; why: string };

export function walletVerdict(p: Profile): WalletVerdict | null {
  if (!p.buyouts.length) return null;
  // Same figure, same shape, wherever it appears. The prose said 2956 while the stat beside it said 2,956.
  const sol = (n: number) => Math.round(n).toLocaleString();
  const n = p.buyouts.length;
  const curves = `${n} bonding curve${n > 1 ? "s" : ""}`;
  // "only 0.0" was arithmetic where a word was meant. A wallet that bought back nothing bought back nothing.
  const back = p.ammBuy > 0 ? `${sol(p.ammBuy)} SOL` : "nothing";
  const ratio = p.ammBuy > 0 ? p.ammSell / p.ammBuy : Infinity;
  if (p.ammSell >= 20 && ratio >= 3)
    return { label: "It distributes; it does not hold",
      why: `Took ${curves} outright for ${sol(p.curveSol)} SOL and sold ${sol(p.ammSell)} SOL into buyers on the open market, buying back ${back}.` };
  if (p.ammSell >= 20 && ratio >= 1.2)
    return { label: "A net seller on the open market",
      why: `Took ${curves} and sold ${sol(p.ammSell)} SOL against ${sol(p.ammBuy)} SOL bought back.` };
  if (p.ammBuy === 0 && p.ammSell === 0)
    return { label: `Took ${curves} outright`,
      why: `${sol(p.curveSol)} SOL spent on curves. We hold no market trades for it in either direction, so what it did with the tokens afterwards is not on our record.` };
  return { label: `Took ${curves} outright`,
    why: `${sol(p.curveSol)} SOL spent on curves. It is not yet a net seller in our data (${p.ammBuy.toFixed(0)} SOL in, ${p.ammSell.toFixed(0)} out).` };
}

/** The same verdict as one line, for the CLI and anything that wants prose. */
export function verdictLine(p: Profile): string | null {
  const v = walletVerdict(p);
  return v ? `${v.label}. ${v.why}` : null;
}


/** One curve a cluster wallet bought outright: the dot on the swimlane, and one row of the table under it. */
export interface ClusterEvent {
  wallet: string; mint: string; symbol: string | null; name: string | null;
  ts: number; sol: number; sig: string | null;
  /** When the token was created, so the wait between launch and buyout can be drawn rather than described. */
  createdAt: number | null;
  danger: boolean;
}

export interface ClusterProfile {
  cluster: string; funder: string | null; policy: string | null;
  /** Every wallet on file for the cluster, including those seeded and never used: the size of the machine. */
  wallets: { wallet: string; role: string | null; curves: number; sol: number }[];
  events: ClusterEvent[];
  curves: number; sol: number;
}

/**
 * A whole operator cluster, rather than one of its wallets.
 *
 * `profile()` answers "who is this wallet"; nothing answered "what is this group doing", even though the group is
 * the unit that actually operates. A farm rotates wallets precisely so that no single address carries the pattern:
 * FC9BqG took 27 curves in a week and no wallet in it took more than eleven, so a reader on any one wallet page
 * sees a fraction of the machine and has no way to reach the rest of it.
 *
 * One event per wallet per mint, not one per trade row. A buyout recorded live and again by chain reconstruction is
 * one purchase, and `hist_trades` stores its timestamp to the second where `trades` has milliseconds, so the two
 * copies cannot be matched on time. They are matched on (wallet, mint) and the live row wins, which is the rule
 * `profile()` already uses. Counting rows instead plotted six of FC9BqG's curves twice.
 */
export function clusterProfile(dbh: any, cluster: string): ClusterProfile {
  const wallets = dbh.prepare(
    `SELECT wallet, role, funder FROM operator_wallets WHERE cluster = ? ORDER BY wallet`
  ).all(cluster) as any[];
  if (!wallets.length) return { cluster, funder: null, policy: null, wallets: [], events: [], curves: 0, sol: 0 };

  const list = wallets.map((w) => w.wallet);
  const holes = list.map(() => "?").join(",");
  const ev = new Map<string, ClusterEvent>();
  const add = (r: any) => {
    const key = `${r.wallet} ${r.mint}`;
    if (ev.has(key)) return;
    ev.set(key, {
      wallet: r.wallet, mint: r.mint, symbol: r.symbol ?? null, name: r.name ?? null,
      ts: Number(r.ts), sol: Number(r.sol), sig: r.sig ?? null,
      createdAt: r.created_at == null ? null : Number(r.created_at),
      // The same flag the token pages and the relaunch strip use, so a dot here means what a mark there means.
      danger: (r.dev_pct ?? 0) >= 50 || (r.graduated_confirmed_by != null && r.curve_buyers === 0),
    });
  };

  // `sig` bare beside MAX(sol) for the reason spelled out in stmts() above: it comes from the row that supplied the
  // maximum, so it is the signature of the buy being reported.
  const cols = `tk.symbol, tk.name, tk.created_at, tk.dev_pct, tk.curve_buyers, tk.graduated_confirmed_by`;
  for (const r of dbh.prepare(
    `SELECT t.wallet, t.mint, MIN(t.ts) ts, MAX(t.sol) sol, t.sig, ${cols}
     FROM trades t LEFT JOIN tokens tk ON tk.mint = t.mint
     WHERE t.wallet IN (${holes}) AND t.venue='curve' AND t.side='buy' AND t.sol >= ?
     GROUP BY t.wallet, t.mint`).all(...list, BUYOUT_SOL) as any[]) add(r);
  // Reconstructed curves count too, exactly as they do on a wallet page. A collector database has no `hist_trades`
  // at all, so its absence is normal and not a fault.
  try {
    for (const r of dbh.prepare(
      `SELECT h.wallet, h.mint, MIN(h.ts) ts, MAX(h.sol) sol, h.sig, ${cols}
       FROM hist_trades h LEFT JOIN tokens tk ON tk.mint = h.mint
       WHERE h.wallet IN (${holes}) AND h.side='buy' AND h.sol >= ?
       GROUP BY h.wallet, h.mint`).all(...list, BUYOUT_SOL) as any[]) add(r);
  } catch {}

  const events = [...ev.values()].sort((a, b) => a.ts - b.ts);
  const per = new Map<string, { curves: number; sol: number }>();
  for (const e of events) {
    const p = per.get(e.wallet) ?? { curves: 0, sol: 0 };
    p.curves++; p.sol += e.sol; per.set(e.wallet, p);
  }
  return {
    cluster,
    funder: wallets.find((w) => w.funder)?.funder ?? null,
    policy: (dbh.prepare("SELECT policy FROM operator_policy WHERE cluster = ?").get(cluster) as any)?.policy ?? null,
    wallets: wallets.map((w) => ({
      wallet: w.wallet, role: w.role ?? null,
      curves: per.get(w.wallet)?.curves ?? 0, sol: per.get(w.wallet)?.sol ?? 0,
    })).sort((a, b) => b.curves - a.curves || b.sol - a.sol || a.wallet.localeCompare(b.wallet)),
    events,
    curves: new Set(events.map((e) => e.mint)).size,
    sol: events.reduce((s, e) => s + e.sol, 0),
  };
}

/** A cluster as one row of a list: enough to decide whether to open it, and nothing that needs a caveat of its own. */
export interface ClusterRow {
  cluster: string; funded: number; used: number; curves: number; sol: number; last: number;
}

/**
 * The clusters with the most curves taken, for a page that wants to list them.
 *
 * Deliberately the same arithmetic as `clusterProfile`, including the UNION over `hist_trades` and the one-event-per
 * (wallet, mint) rule, because a list that says 22 above a page that says 27 is worse than no list: the reader has
 * no way to tell which is wrong, and the answer would be "neither, they counted different things". The cheaper
 * trades-only version was measured at 4 ms against 6 ms for this one, which is not a saving worth a discrepancy.
 *
 * `used >= 2` because a cluster of one wallet is a wallet. Nothing about a single address is made clearer by
 * calling the group it belongs to an operator, and the wallet page already says everything we know about it.
 */
export function clusterTable(dbh: any, limit = 10): ClusterRow[] {
  const shape = (from: string) => `SELECT cluster, COUNT(DISTINCT wallet) used, COUNT(DISTINCT mint) curves,
      SUM(sol) sol, MAX(ts) last, (SELECT COUNT(*) FROM operator_wallets x WHERE x.cluster = b.cluster) funded
    FROM (${from}) b GROUP BY cluster HAVING used >= 2 ORDER BY curves DESC, sol DESC LIMIT ?`;
  const live = `SELECT w.cluster cluster, t.wallet wallet, t.mint mint, MIN(t.ts) ts, MAX(t.sol) sol
      FROM trades t JOIN operator_wallets w ON w.wallet = t.wallet
     WHERE t.venue='curve' AND t.side='buy' AND t.sol >= ${BUYOUT_SOL} AND w.cluster IS NOT NULL
     GROUP BY t.wallet, t.mint`;
  // A collector database has no `hist_trades` at all, so the reconstructed half is attempted and not required.
  const both = `${live}
    UNION
    SELECT w.cluster, h.wallet, h.mint, MIN(h.ts), MAX(h.sol)
      FROM hist_trades h JOIN operator_wallets w ON w.wallet = h.wallet
     WHERE h.side='buy' AND h.sol >= ${BUYOUT_SOL} AND w.cluster IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM trades t2 WHERE t2.wallet = h.wallet AND t2.mint = h.mint
                        AND t2.venue='curve' AND t2.side='buy' AND t2.sol >= ${BUYOUT_SOL})
     GROUP BY h.wallet, h.mint`;
  const run = (sql: string) => (dbh.prepare(sql).all(limit) as any[]).map((r): ClusterRow => ({
    cluster: r.cluster, funded: Number(r.funded), used: Number(r.used),
    curves: Number(r.curves), sol: Number(r.sol), last: Number(r.last),
  }));
  try { return run(shape(both)); } catch { return run(shape(live)); }
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
