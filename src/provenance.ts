/**
 * The clean criteria, in one place.
 *
 * These rules decide whether we tell a stranger a token was not manufactured, which is the only claim this project
 * makes and the only one that can destroy it. They live here rather than inside the site generator so that the site,
 * the API and the labelled-set validator (`npm run labels`) all execute the *same* code — a validator that re-implements
 * the rules it is checking proves nothing about what visitors are shown.
 *
 * Two invariants hold everywhere below:
 *   1. Absence of evidence is never evidence. A launch we did not watch, a buyer count with no trade rows behind it,
 *      or a pool we could not read all produce UNKNOWN, never a clean result.
 *   2. Launch facts are permanent; pool balances are not. Nothing here quotes a pool balance — that is the caller's
 *      job, and the caller must read it at the moment it makes the claim. See `Reading` in site.ts.
 */
import type { DatabaseSync } from "node:sqlite";
import { profile, verdictLine, findBuyout } from "./operator.ts";

/** A single large buy that completes a curve is a buyout, not demand. */
export const BUYOUT_SOL = 40;
/** Above this share of supply in the first block, the creator is the market. */
export const MAX_DEV_PCT = 20;
/** Distinct non-dev wallets that had to buy on the curve before it graduated. */
export const MIN_BUYERS = 30;
/** A curve that fills faster than this was taken, not bought. */
export const MIN_GRAD_MS = 60_000;
/** SOL that has to be in the pool for a position to be sellable near the quoted price. */
export const MIN_POOL_SOL = 40;

export type Level = "DANGER" | "CAUTION" | "UNKNOWN";
export type Flag = { level: Level; text: string };
export type Assessment = {
  flags: Flag[];
  /** we watched this launch happen, so its creator share and buyer count are real observations */
  watched: boolean;
  buyout: ReturnType<typeof findBuyout>;
  /** distinct non-dev curve buyers, or null when no trade rows exist — null is unknown, not zero */
  curveBuyers: number | null;
};

export const TOKEN_COLUMNS = `mint, symbol, name, creator, created_at, late_discovery, dev_pct, dev_sold, unique_buyers,
  snap30_buyers, bundled_buyers, graduated, graduated_at, pool, vault_sol, vault_at, last_price, updated_at,
  rebuilt_at, rebuilt_complete, curve_buyers`;

/** Union of the collector's run intervals. A launch outside them happened while we were blind. */
export function coverageWindows(db: DatabaseSync): { a: number; b: number }[] {
  const runs = db.prepare("SELECT started_at, stopped_at FROM runs WHERE started_at IS NOT NULL ORDER BY started_at").all() as any[];
  const win: { a: number; b: number }[] = [];
  for (const r of runs) {
    const end = r.stopped_at ?? r.started_at, last = win[win.length - 1];
    if (last && r.started_at - last.b <= 180_000) last.b = Math.max(last.b, end); else win.push({ a: r.started_at, b: end });
  }
  return win;
}

// assess() runs once per token over every graduation in the window, so its statements are prepared once per database
// rather than once per call — preparing this inside the loop cost more than the queries themselves.
const curveBuyersStmt = new WeakMap<DatabaseSync, any>();
function curveBuyersQ(db: DatabaseSync) {
  let s = curveBuyersStmt.get(db);
  if (!s) {
    s = db.prepare(`SELECT COUNT(DISTINCT wallet) n, COUNT(*) rows FROM trades
      WHERE mint = ? AND venue='curve' AND side='buy' AND COALESCE(is_dev,0)=0`);
    curveBuyersStmt.set(db, s);
  }
  return s;
}

export function assess(db: DatabaseSync, t: any, covered: (ts: number) => boolean): Assessment {
  const flags: Flag[] = [];
  // A launch is judgeable if we watched it, or if its complete history was rebuilt from chain — the same on-chain
  // events, read later. This must be decided here rather than patched onto the result afterwards: the checks below
  // are skipped entirely for an unjudgeable token, so flipping the flag after the fact produced a rebuilt page for
  // USWS (wash factory: graduated instantly with one buyer) carrying no warnings at all.
  const watched = (!t.late_discovery && covered(t.created_at)) || !!t.rebuilt_complete;
  const bo = findBuyout(db, t.mint, BUYOUT_SOL);
  // tokens.unique_buyers also counts post-graduation AMM buyers, which is not what "outside buyers before it
  // graduated" means. Count from the trade rows; no rows at all is unknown, and unknown never certifies.
  // Prefer the stored count when it exists: it is the same number, and it is the only way the public service can
  // answer without carrying the whole trades table.
  const cb = t.curve_buyers != null ? { n: t.curve_buyers as number, rows: 1 } : curveBuyersQ(db).get(t.mint) as { n: number; rows: number };
  // A completely rebuilt launch has no rows in `trades` — its history was read from chain long afterwards and the
  // count was taken over the whole of it. Falling through to "unknown" there would make every rebuilt token
  // permanently unjudgeable, which defeats the point of rebuilding it.
  const curveBuyers = cb.rows > 0 ? cb.n : (t.rebuilt_complete ? (t.unique_buyers ?? null) : null);
  if (!watched) {
    flags.push({ level: "UNKNOWN", text: "We did not observe this launch, so its creator share and outside-buyer count are unknown. A manufactured token is indistinguishable from a real one once its float has been spread." });
    return { flags, watched, buyout: bo, curveBuyers };
  }
  const gradS = t.graduated_at ? (t.graduated_at - t.created_at) / 1000 : null;
  if (t.dev_pct >= 50) flags.push({ level: "DANGER", text: `The creator took ${t.dev_pct.toFixed(1)}% of the entire supply in the first block. Nothing visible on-chain today shows this — the float has since been spread across wallets.` });
  else if (t.dev_pct >= MAX_DEV_PCT) flags.push({ level: "CAUTION", text: `The creator took ${t.dev_pct.toFixed(1)}% of supply at launch.` });
  if (curveBuyers === 0) flags.push({ level: "DANGER", text: "It completed its bonding curve with zero outside buyers. The graduation was funded by the creator, not by demand." });
  else if (curveBuyers !== null && curveBuyers < 10) flags.push({ level: "DANGER", text: `Only ${curveBuyers} outside buyer${curveBuyers === 1 ? "" : "s"} bought on the bonding curve before it graduated.` });
  if (gradS !== null && gradS <= 60) flags.push({ level: "DANGER", text: `It left the curve ${Math.round(gradS)}s after launch — the float was taken before anyone could buy at a normal price.` });
  if (t.dev_sold) flags.push({ level: "CAUTION", text: "The creator sold while we were watching." });
  if (bo) {
    const p = profile(db, bo.wallet);
    const line = verdictLine(p);
    if (line) flags.push({ level: p.ammSell > p.ammBuy * 3 && p.ammSell >= 20 ? "DANGER" : "CAUTION", text: line });
  }
  return { flags, watched, buyout: bo, curveBuyers };
}

/**
 * Everything the launch record has to say about whether a token was manufactured. Facts about the past: once true,
 * always true. The liquidity gate is deliberately NOT here — it decays, so the caller applies it against a balance it
 * has just read.
 */
export const cleanAtBirth = (t: any, a: Assessment): boolean =>
  a.watched && !a.buyout && t.dev_pct < MAX_DEV_PCT && !t.dev_sold &&
  a.curveBuyers !== null && a.curveBuyers >= MIN_BUYERS && !!t.graduated_at && (t.graduated_at - t.created_at) > MIN_GRAD_MS &&
  !a.flags.some((f) => f.level === "DANGER");
