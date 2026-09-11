/**
 * Real-runner labelling. Bonding-curve data ends at graduation (trading moves to PumpSwap), so
 * "did it hold" must come from an external price source. Graduation happens at ~411 SOL market cap;
 * a token counts as a real runner when, at analysis time, it trades at >= REAL_MIN_MCAP_SOL
 * (default 822 SOL = 2x graduation), i.e. it did not round-trip back to the curve price.
 */
import type { DatabaseSync } from "node:sqlite";
import { ensureOutcomeTable, getOutcome } from "./outcomes.ts";

export const GRADUATION_MCAP_SOL = 411;
export const REAL_MIN_MCAP_SOL = Number(process.env.REAL_MIN_MCAP_SOL ?? 2 * GRADUATION_MCAP_SOL);
/** minimum age since graduation before a token is judged, so "held" means something */
export const REAL_MIN_AGE_MS = Number(process.env.REAL_MIN_AGE_MIN ?? 60) * 60_000;

/** minimum SOL actually in the PumpSwap pool for a "runner" to count - a wash-printed price over a 1 SOL pool is not a runner */
export const REAL_MIN_POOL_SOL = Number(process.env.REAL_MIN_POOL_SOL ?? 40);
export function isRealOutcome(o: { mcapSol: number | null; mcapUsd: number | null; poolSol?: number | null; verified?: boolean }): boolean {
  if (o.verified) return (o.mcapSol ?? 0) >= REAL_MIN_MCAP_SOL && (o.poolSol ?? 0) >= REAL_MIN_POOL_SOL;
  return false; // unverified API prices are not trusted for the label
}

/** minimum distinct outside buyers (curve or AMM) for a runner to count: an operator who bought the whole curve and parked
 *  thousands of their own SOL in the pool prints any market cap they like (the 85 SOL / 79.3 % "WOTF" factory, 2026-09-03) */
export const REAL_MIN_BUYERS = Number(process.env.REAL_MIN_BUYERS ?? 30);
export const REAL_MAX_DEV_PCT = Number(process.env.REAL_MAX_DEV_PCT ?? 50);
const ammBuyersStmt = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();
/** Does this token show organic demand? Tokens we did not watch from launch (late discoveries) are judged on AMM buyers only. */
export function organicDemand(db: DatabaseSync, t: { mint: string; dev_pct?: number | null; unique_buyers?: number | null; late_discovery?: number | null }): boolean {
  if (!t.late_discovery && (t.dev_pct ?? 0) >= REAL_MAX_DEV_PCT) return false;
  if ((t.unique_buyers ?? 0) >= REAL_MIN_BUYERS) return true;
  let st = ammBuyersStmt.get(db);
  if (!st) { st = db.prepare("SELECT COUNT(DISTINCT wallet) n FROM trades WHERE mint = ? AND market = 'amm' AND side = 'buy'"); ammBuyersStmt.set(db, st); }
  return ((st.get(t.mint) as any)?.n ?? 0) >= REAL_MIN_BUYERS;
}

export async function labelRealRunners(db: DatabaseSync, since: number, opts: { maxAgeMs?: number; log?: (s: string) => void } = {}): Promise<Set<string>> {
  ensureOutcomeTable(db);
  const grads = db.prepare("SELECT mint, graduated_at, dev_pct, unique_buyers, late_discovery FROM tokens WHERE graduated=1 AND created_at >= ?").all(since) as { mint: string; graduated_at: number | null; dev_pct: number; unique_buyers: number; late_discovery: number }[];
  const real = new Set<string>();
  let fetched = 0;
  for (const g of grads) {
    if (g.graduated_at && Date.now() - g.graduated_at < REAL_MIN_AGE_MS) continue;
    const o = await getOutcome(db, g.mint, opts.maxAgeMs ?? 2 * 3600_000);
    fetched++;
    if (o && o.verified) {
      if (isRealOutcome(o) && organicDemand(db, g)) real.add(g.mint);
      continue;
    }
  }
  return real;
}
