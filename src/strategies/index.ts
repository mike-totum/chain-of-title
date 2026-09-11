import type { TokenState, Tracker } from "../tracker.ts";
import { config } from "../config.ts";
import { TOTAL_SUPPLY } from "../curve.ts";

export interface ExitRules {
  /** sell when price >= entry * takeProfitX */
  takeProfitX: number;
  /** sell when price <= entry * stopLossX */
  stopLossX: number;
  /** once price has reached entry * trailArmX, sell if it falls trailDropPct % from its peak */
  trailArmX: number;
  trailDropPct: number;
  /** sell after this many seconds regardless */
  maxHoldS: number;
  exitOnDevSell: boolean;
  /** rip cord (post-graduation style): sell half at this multiple, then let the rest ride on flow */
  bankHalfAtX?: number;
  /** exit the remainder when SOL sold >= flowSellRatio x SOL bought over 30 s while price is >= flowDropPct below its high since entry */
  flowSellRatio?: number;
  flowDropPct?: number;
  /** exit when price falls this much within 10 s (a single-block dump) */
  crashDropPct?: number;
  /** eat with the farm: exit when operator-cluster wallets sold >= ratio x what they bought over the last windowS seconds (and >= 1 SOL) */
  exitOnOperatorSell?: { windowS: number; ratio: number };
}

export interface EntryContext {
  tracker: Tracker;
  now: number;
  /** ms since the token was created (or first seen, for late discoveries) */
  ageMs: number;
  /** true when a KOL signal for this mint was recorded */
  kolSignal: boolean;
  /** wallets currently ranked as "smart" by `npm run wallets` */
  smartWallets: Set<string>;
  /** wallet -> team id, from `npm run patterns` */
  wallesTeams: Map<string, number>;
  /** wallet -> cluster name, from `npm run clusters` (operator wallet farms) */
  operatorWallets: Map<string, string>;
  /** what operator wallets have done on this token so far (index.ts keeps it) */
  operatorActivity: OperatorActivity | undefined;
  /** cluster -> follow | watch | avoid, from `npm run clusters` (operator_policy) */
  operatorPolicy: Map<string, string>;
}

/** Operator-cluster activity on one token: the curve buyout (if seen) and every cluster wallet's AMM buying. */
export interface OperatorActivity {
  firstAt: number;
  priceAtFirst: number | null;
  buyout: { wallet: string; sol: number; ts: number; cluster: string } | null;
  buys: Map<string, { sol: number; first: number; last: number; cluster: string }>;
  solIn: number;
  solOut: number;
  lastBuyAt: number;
  clusters: Set<string>;
  notified: boolean;
  /** cluster trades on this token over the last 2 h, for the farm-sell exit */
  recent: { ts: number; side: "buy" | "sell"; sol: number }[];
}

export interface Strategy {
  name: string;
  description: string;
  /** Only consider entering while token age <= this (seconds). */
  entryWindowS: number;
  shouldEnter(t: TokenState, ctx: EntryContext): string | null; // returns reason or null
  exit: ExitRules;
}

/** Launch-bot metadata hosts observed at <1% graduation across thousands of launches. */
const KILL_HOSTS = new Set(["metadata.j7tracker.io", "meta.uxento.io", "m.rapidlaunch.io", "pump.mypinata.cloud", "metadata.levitatingbananatree.xyz"]);
const isRound = (sol: number) => sol > 0 && Math.abs(sol * 10 - Math.round(sol * 10)) < 0.005;

/**
 * Kill filters from the pattern miner (2026-09-02): each bucket graduated at <=0.2x the base rate.
 * Returns the reason a token is excluded, or null if it passes.
 */
export function killReason(t: TokenState): string | null {
  if (KILL_HOSTS.has(t.metaHost)) return `host ${t.metaHost}`;
  if (isRound(t.devInitialSol)) return "round dev buy";
  if (t.devInitialSol >= 0.5 && t.devInitialSol < 5) return "mid-sized dev buy";
  if (t.devSold) return "dev sold";
  if (t.snap30 && t.snap30.sells >= t.snap30.buys && t.snap30.buys > 0) return "sells >= buys in 30s";
  return null;
}

const DEFAULT_EXIT: ExitRules = {
  takeProfitX: 2.0,
  stopLossX: 0.5,
  trailArmX: 1.5,
  trailDropPct: 35,
  maxHoldS: 30 * 60,
  exitOnDevSell: true,
};

/**
 * Rip-cord exits for tokens that trade on PumpSwap (called tokens, post-graduation runners).
 * From 111 graduated tokens on 2026-09-02: runners and faders dip almost identically before their peak
 * (median ~30%, 75th pct 55%), so a price stop cannot separate them; what separates them is time and flow.
 *   1. bank half at 2x, so a quick win can never become a loss
 *   2. exit the rest on flow: dev sells, or sells >= 2x buys over 30 s while price is 25% off its high, or a 45% dump inside 10 s
 *   3. floor 0.4x, trail 45% from the high after banking, 90 min time stop
 */
export const RIPCORD_EXIT: ExitRules = {
  takeProfitX: 100,
  stopLossX: 0.4,
  trailArmX: 2.0,
  trailDropPct: 45,
  maxHoldS: 90 * 60,
  exitOnDevSell: true,
  bankHalfAtX: 2.0,
  flowSellRatio: 2.0,
  flowDropPct: 25,
  crashDropPct: 45,
};

/** Buys every launch right after creation. This is the base rate everything else must beat. */
export const baselineAll: Strategy = {
  name: "baseline-all",
  description: "buy every launch at creation, hold with default exits",
  entryWindowS: 5,
  shouldEnter: (t) => (t.lateDiscovery ? null : "every launch"),
  exit: DEFAULT_EXIT,
};

/** Early organic-looking demand: several distinct buyers quickly, few sells, dev not oversized, not bundled. */
export const earlyMomentum: Strategy = {
  name: "early-momentum",
  description: "8+ distinct buyers in 60s, sells < 1/3 of buys, dev <= 6%, not bundled, dev has not sold",
  entryWindowS: 60,
  shouldEnter: (t, ctx) => {
    if (t.lateDiscovery) return null;
    if (t.devSold) return null;
    if (t.devPct > 6) return null;
    if (t.bundledBuyers >= 3) return null;
    if (t.buyers.size < 8) return null;
    if (t.sells * 3 > t.buys) return null;
    if (t.buyVolSol < 2) return null;
    if (ctx.tracker.topHolderPct(t) > 8) return null;
    return `buyers=${t.buyers.size} buys=${t.buys} sells=${t.sells} vol=${t.buyVolSol.toFixed(2)}`;
  },
  exit: DEFAULT_EXIT,
};

/** Stricter momentum: waits for more evidence, accepts a later entry. */
export const strictMomentum: Strategy = {
  name: "strict-momentum",
  description: "15+ buyers within 120s, sells < 1/4 of buys, dev <= 4%, not bundled, price >= 1.3x launch",
  entryWindowS: 120,
  shouldEnter: (t, ctx) => {
    if (t.lateDiscovery) return null;
    if (t.devSold) return null;
    if (t.devPct > 4) return null;
    if (t.bundledBuyers >= 3) return null;
    if (t.buyers.size < 15) return null;
    if (t.sells * 4 > t.buys) return null;
    if (t.lastPrice < t.launchPrice * 1.3) return null;
    if (ctx.tracker.topHolderPct(t) > 6) return null;
    return `buyers=${t.buyers.size} buys=${t.buys} sells=${t.sells} x=${(t.lastPrice / t.launchPrice).toFixed(2)}`;
  },
  exit: { ...DEFAULT_EXIT, takeProfitX: 2.5 },
};

/** Enters as soon as a watched account posts the mint / ticker. */
export const kolSignal: Strategy = {
  name: "kol-signal",
  description: "buy when a watched X account posts the mint, pump.fun link, or matching $TICKER",
  entryWindowS: 6 * 3600,
  shouldEnter: (t, ctx) => {
    if (!ctx.kolSignal || !(t.lastPrice > 0)) return null;
    if (t.lateDiscovery && t.pumpOrigin !== true) return null; // unknown or non-pump.fun token
    const mcapSol = t.lastPrice * TOTAL_SUPPLY;
    if (mcapSol > config.kolMaxMcapSol) return null;
    return `kol signals=${t.kolSignals} mcap=${mcapSol.toFixed(0)} SOL`;
  },
  exit: RIPCORD_EXIT,
};

/** Enters when a wallet with a proven early-winner record buys within the first 10 minutes. */
export const smartWallet: Strategy = {
  name: "smart-wallet",
  description: "buy when a top-ranked wallet (npm run wallets) buys within 10 min of launch; dev has not sold",
  entryWindowS: 600,
  shouldEnter: (t, ctx) => {
    const lt = t.lastTrade;
    if (t.graduated || lt?.buyerRank === null) return null; // the set is ranked on bonding-curve buys; a post-graduation AMM buy is a different animal
    if (!lt || lt.side !== "buy" || !ctx.smartWallets.has(lt.wallet)) return null;
    if (t.devSold || lt.wallet === t.creator) return null;
    if (lt.sol < 0.1) return null; // dust bots buy 0.001 SOL on everything
    if (KILL_HOSTS.has(t.metaHost) || isRound(t.devInitialSol)) return null;
    return `smart wallet ${lt.wallet.slice(0, 4)}…${lt.wallet.slice(-4)} bought ${lt.sol.toFixed(2)} SOL as buyer #${lt.buyerRank ?? "?"}`;
  },
  exit: { ...DEFAULT_EXIT, takeProfitX: 2.5 },
};

/**
 * Operator teams: wallets that repeatedly appear together among the first buyers of tokens that
 * graduate. When two members of the same team buy within the first 60 s, the token is very likely
 * being pushed to graduation; ride it with a fast exit.
 */
export const teamWallet: Strategy = {
  name: "team-wallet",
  description: "2+ wallets of a known operator team (npm run patterns) buy within 60 s; fast exit",
  entryWindowS: 60,
  shouldEnter: (t, ctx) => {
    if (t.devSold || t.graduated) return null; // teams are scored on curve-phase co-buying; once graduated the buyers set includes AMM traders
    const teamsHit = new Map<number, number>();
    for (const w of t.buyers) {
      const team = ctx.wallesTeams.get(w);
      if (team !== undefined) teamsHit.set(team, (teamsHit.get(team) ?? 0) + 1);
    }
    for (const [team, k] of teamsHit) if (k >= 2) return `team #${team}: ${k} members among ${t.buyers.size} buyers`;
    return null;
  },
  exit: { ...DEFAULT_EXIT, takeProfitX: 1.8, stopLossX: 0.6, trailArmX: 1.3, trailDropPct: 25, maxHoldS: 600 },
};

/** Every launch that passes the kill filters, entered at 30 s. Measures the filter set itself. */
export const filteredAll: Strategy = {
  name: "filtered-all",
  description: "buy every launch that passes the kill filters (host, round/mid dev buy, dev sold, sells>=buys) at 30 s",
  entryWindowS: 45,
  shouldEnter: (t, ctx) => (!t.lateDiscovery && ctx.ageMs >= 30_000 && !killReason(t) ? "passes kill filters" : null),
  exit: DEFAULT_EXIT,
};

/**
 * Play 2: real runners are launched with a big dev buy by an operator with momentum and fill the curve in
 * under a minute. The only entry an outsider gets is on PumpSwap after graduation: wait for the first
 * pullback of >=15% from the post-graduation high while price still holds above the graduation price.
 */
export const gradRunner: Strategy = {
  name: "grad-runner",
  description: "fast graduation (<=120 s) + dev buy >=5 SOL (not round) + <=40 curve buyers + no dev sell; enter on PumpSwap on the first 15% pullback that holds above graduation price",
  entryWindowS: 6 * 3600,
  shouldEnter: (t) => {
    if (!t.graduated || !t.externalPriced || t.gradPrice === null || t.postGradHigh === null || !t.graduatedAt) return null;
    if (t.lateDiscovery) return null;
    if (t.graduatedAt - t.createdAt > 120_000) return null;
    if (t.devInitialSol < 5 || isRound(t.devInitialSol)) return null;
    if ((t.buyersAtGrad ?? t.buyers.size) > 40 || t.devSold) return null;
    if (KILL_HOSTS.has(t.metaHost)) return null;
    const sinceGrad = Date.now() - t.graduatedAt;
    if (sinceGrad < 60_000 || sinceGrad > 45 * 60_000 || t.postGradSamples < 3) return null;
    if (t.lastPrice < t.gradPrice) return null; // dumped below graduation: not a runner
    if (t.lastPrice > 0.85 * t.postGradHigh) return null; // no pullback yet
    return `pullback ${((1 - t.lastPrice / t.postGradHigh) * 100).toFixed(0)}% from post-grad high, ${(t.lastPrice / t.gradPrice).toFixed(2)}x grad price, dev ${t.devInitialSol.toFixed(1)} SOL${t.creatorMomentum ? ", creator momentum" : ""}`;
  },
  exit: RIPCORD_EXIT,
};

/** curve price at graduation (115 SOL virtual / 279.9M remaining virtual tokens); mcap at graduation ~411 SOL */
const GRAD_CURVE_PRICE = 115 / 279_900_000;
/**
 * Survivors: graduated tokens trading at >= 2.5x the graduation cap (~$200k+) with real outside demand. Enter on the next
 * outside buy >= 0.5 SOL; exit on a 30 % trail armed at 1.3x, hard stop 0.7, 6 h. From the 2026-09-03 PumpSwap copy-trade
 * replay (npm run ammfollow): 41k such entries averaged 1.13x under this exit vs 0.57x when held. The entry is close to
 * fair; the exit is the edge. Requires a trusted AMM price stream (pool reconciled with its vaults).
 */
export const survivorTrail: Strategy = {
  name: "survivor-trail",
  description: "graduated, trusted AMM price >= 2.5x graduation cap, pool >= 300 SOL, dev < 50% supply, >= 30 buyers, price <= 1.15x its level 2 min ago; enter on an outside buy >= 0.5 SOL; trail 30% armed at 1.3x, stop 0.7, 6 h",
  entryWindowS: 6 * 3600,
  shouldEnter: (t, ctx) => {
    if (!t.graduated || !t.externalPriced || t.ammTrusted !== true) return null;
    if (t.devPct >= 50 || t.buyers.size < 30) return null; // operator-owned supply / no organic demand: the wash-factory signature
    // liquidity floor: in the hourly snapshots, survivors with 100-300 SOL pools averaged 0.68x over 6 h with 30 % halving and 42 % of
    // pools gone; 300-1000 SOL pools averaged 1.01x with none halved and every pool alive. Below 300 SOL it is still the trench.
    if ((t.vaultSol ?? 0) < 300) return null;
    const lt = t.lastTrade;
    if (!lt || lt.side !== "buy" || lt.sol < 0.5 || lt.wallet === t.creator) return null;
    const x = t.lastPrice / GRAD_CURVE_PRICE;
    if (x < 2.5) return null;
    // no chasing: the replay splits cleanly on this - entries <= 1.15x the price 2 min earlier averaged 1.12x under the trail,
    // entries above it 0.96x (the live rule's first day bought spikes and stopped out 15 times in 18). Needs 2 min of prints.
    let ref: number | null = null;
    for (const r of t.recent) { if (r.ts <= ctx.now - 120_000) ref = r.price; else break; }
    if (ref === null) return null;
    if (t.lastPrice > 1.15 * ref) return null;
    return `survivor at ${x.toFixed(1)}x graduation cap, pool ${(t.vaultSol ?? 0).toFixed(0)} SOL, outside buy ${lt.sol.toFixed(2)} SOL, ${t.buyers.size} buyers, ${((t.lastPrice / ref - 1) * 100).toFixed(0)}% vs 2 min ago`;
  },
  exit: { takeProfitX: 1000, stopLossX: 0.7, trailArmX: 1.3, trailDropPct: 30, maxHoldS: 6 * 3600, exitOnDevSell: false },
};

/**
 * Follow the operator farms (2026-09-04). The two verified $10M+ winners were dormant curves bought out in one 85 SOL
 * transaction by a farm wallet, then accumulated on PumpSwap by dozens of sibling wallets from the same funder; on Kshama
 * the farm drip-bought for ~3 h at a flat price before the run. Two entries: the buyout itself (enter on the first trusted
 * AMM price after it), or >= CLUSTER_MIN_WALLETS distinct cluster wallets buying within the last hour. No chasing above
 * 2x the price at first cluster activity. Exit: wide trail (the run took hours), no take-profit, no dev-sell exit.
 */
const CLUSTER_MIN_WALLETS = Number(process.env.CLUSTER_MIN_WALLETS || 3);
export const clusterFollow: Strategy = {
  name: "cluster-follow",
  description: `graduated token where an operator-cluster wallet bought out the curve (>= 40 SOL) or >= ${CLUSTER_MIN_WALLETS} cluster wallets bought on the AMM within 1 h; enter at the first trusted AMM price <= 2x the price at first cluster activity; trail 35% armed at 1.5x, stop 0.6, 12 h`,
  entryWindowS: 72 * 3600,
  shouldEnter: (t, ctx) => {
    const a = ctx.operatorActivity;
    if (!a) return null;
    // verified pool only: the first live entry (WOTF, a wash-factory ticker) filled at a printed $60M cap from a pool not yet checked against its vaults
    if (!t.graduated || !t.externalPriced || !(t.lastPrice > 0) || t.ammTrusted !== true) return null;
    if ((t.vaultSol ?? 0) < 20) return null;
    // organic gate: factory pools (79% dev buy, instant graduation, own SOL parked) pass the vault check and show as HOLD in the behaviour table
    if (t.devPct >= 50 || Math.max(t.buyersAtGrad ?? 0, t.buyers.size) < 30) return null;
    if (a.priceAtFirst && t.lastPrice > 2 * a.priceAtFirst) return null;
    const recent = [...a.buys.values()].filter((b) => ctx.now - b.last <= 3600_000);
    // per-cluster policy: dump farms (Bwpr1K: Squads, onoda) sell to followers within minutes; only hold farms and unknowns are entered
    const pol = (c: string) => ctx.operatorPolicy.get(c) ?? "watch";
    if (a.buyout && pol(a.buyout.cluster) === "avoid") return null;
    const allowed = [...a.clusters].filter((c) => pol(c) !== "avoid");
    if (allowed.length === 0) return null;
    if (a.buyout) return `[${pol(a.buyout.cluster)}] ` + `operator buyout ${a.buyout.sol.toFixed(0)} SOL by ${a.buyout.cluster} cluster${recent.length ? `, ${recent.length} cluster wallets buying on AMM` : ""}, ${a.solIn.toFixed(1)} SOL in`;
    // a farm acts as one cluster: count wallets per cluster, not across clusters (nine wallets from eight clusters on a hot launch are sniper bots)
    const perCluster = new Map<string, { n: number; sol: number }>();
    for (const b of recent) { if (pol(b.cluster) === "avoid") continue; const c = perCluster.get(b.cluster) ?? { n: 0, sol: 0 }; c.n++; c.sol += b.sol; perCluster.set(b.cluster, c); }
    const lead = [...perCluster.entries()].sort((x, y) => y[1].n - x[1].n)[0];
    if (lead && lead[1].n >= CLUSTER_MIN_WALLETS && lead[1].sol >= 1) return `[${pol(lead[0])}] ${lead[1].n} ${lead[0]} cluster wallets bought ${lead[1].sol.toFixed(1)} SOL on the AMM in the last hour${perCluster.size > 1 ? ` (+${perCluster.size - 1} other clusters)` : ""}`;
    return null;
  },
  // the farm's own selling is the exit: on Kshama its sells jumped at the 9x top; in the 7-day behaviour table most plays are sold within the first hour
  exit: { takeProfitX: 1000, stopLossX: 0.6, trailArmX: 1.5, trailDropPct: 35, maxHoldS: 12 * 3600, exitOnDevSell: false, exitOnOperatorSell: { windowS: 1800, ratio: 1.5 } },
};

/**
 * Every paper strategy ever written here, and by default none of them run.
 *
 * These belong to the trading thesis, which was tested and is dead: zero of 19,412 bonding-curve positions ever
 * reached 5x, because graduation caps the curve near 15x, so any strategy paying bounded losses to catch a big
 * winner is *required* to fail there. That is a proof of impossibility rather than a weak result, and it is why
 * every strategy below lands at roughly the fee.
 *
 * They kept running anyway, inside the collector - ten of them, evaluated on every launch and every trade, in the
 * one process whose only irreplaceable job is ingestion. On 2026-09-11 the collector's health endpoint timed out
 * for four minutes while its log carried 225 `baseline-all` events in a forty-second sample. Ingestion survived;
 * it should not have had to compete. The thing that must never be starved of attention was sharing a thread with a
 * question that has already been answered.
 *
 * Kept in the file, not deleted: re-checking a settled claim is worth being able to do, and a dead thesis with its
 * apparatus intact is evidence. `PAPER=1` brings them back for a local run. Nothing in the archive depends on them
 * - an empty list makes every loop in PaperBroker a no-op, which is why this is the whole of the change.
 */
export const ALL_STRATEGIES: Strategy[] = [baselineAll, filteredAll, earlyMomentum, strictMomentum, kolSignal, smartWallet, teamWallet, gradRunner, survivorTrail, clusterFollow];

export const strategies: Strategy[] = process.env.PAPER === "1" ? ALL_STRATEGIES : [];
