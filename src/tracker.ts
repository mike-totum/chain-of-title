import { EventEmitter } from "node:events";
import type { CreateEvent, TradeEvent } from "./feed/pumpportal.ts";
import { TOTAL_SUPPLY, isGraduated, price, type Curve } from "./curve.ts";

export const CHECKPOINTS_S = [60, 300, 900, 3600] as const;
export type CheckpointKey = (typeof CHECKPOINTS_S)[number];

export interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  createdAt: number; // ms, receipt time
  createdSlot: number;
  /** Launchpad slug, e.g. "pumpfun". Omitted by the pump.fun collector, which is the default in `upsertToken`. */
  venue?: string;
  /**
   * How we know the curve completed: "pool" or "curve_complete". Left undefined when `graduated` was inferred from
   * decoded trade events reaching the threshold, which is not proof — see `graduated_confirmed_by` in db.ts.
   */
  graduatedConfirmedBy?: string;
  /** per-token override of the max watch window (operator-cluster tokens get 24 h) */
  watchCapMs?: number;
  /** most recent trade, for strategies that react to who is buying */
  lastTrade: { wallet: string; side: "buy" | "sell"; sol: number; buyerRank: number | null } | null;
  /** true when we first saw this token via a trade or KOL signal rather than its create event */
  lateDiscovery: boolean;
  curve: Curve;
  launchPrice: number; // price right after the create tx (dev buy included)
  lastPrice: number;
  lastTradeAt: number;
  peakPrice: number;
  peakAt: number;
  devInitialTokens: number;
  devInitialSol: number;
  devPct: number; // % of total supply the dev bought at creation
  devTokenBalance: number;
  devSold: boolean;
  devSoldAt: number | null;
  buys: number;
  sells: number;
  buyVolSol: number;
  sellVolSol: number;
  buyers: Set<string>;
  sellers: Set<string>;
  /** distinct non-dev wallets that bought within 2s of creation (bundle heuristic) */
  bundledBuyers: number;
  balances: Map<string, number>;
  graduated: boolean;
  graduatedAt: number | null;
  checkpoints: Partial<Record<CheckpointKey, number>>; // price at t+N seconds
  /** first 30s activity snapshot for the report */
  snap30: { buyers: number; buys: number; sells: number; volSol: number } | null;
  meta: TokenMeta | null;
  kolSignals: number;
  /** fee in basis points observed on the latest trade (protocol + creator) */
  feeBps: number | null;
  /** price comes from DexScreener (token trades on PumpSwap), not the bonding curve */
  externalPriced: boolean;
  /** for late discoveries: does the token have a pump.fun / PumpSwap pair? null = unknown yet */
  pumpOrigin: boolean | null;
  /** hostname of the metadata uri (launch-bot platforms are a strong negative signal) */
  metaHost: string;
  /** creator's earlier token (in our data) graduated */
  creatorMomentum: boolean;
  /** price at graduation and the high since, from external pricing */
  gradPrice: number | null;
  postGradHigh: number | null;
  postGradSamples: number;
  /** distinct curve buyers at the moment of graduation (AMM buyers are added to `buyers` afterwards) */
  buyersAtGrad: number | null;
  /** token decimals (pump.fun-created tokens are 6; late-discovered tokens are looked up) */
  decimals: number;
  /** a price sample that disagreed >10x with the previous one; accepted only if the next sample agrees */
  suspectPrice: number | null;
  /** last 60 s of trades on either venue, for flow-based exits */
  recent: { ts: number; side: "buy" | "sell"; sol: number; wallet: string; price: number }[];
  /** PumpSwap pool address once known */
  pool: string | null;
  /** SOL/token implied by the pool's vault balances (ground truth), and whether decoded AMM trades reconcile with it */
  vaultPrice: number | null;
  vaultSol: number | null;
  /** when vaultSol was actually read from chain. Never inferred from any other timestamp: a pool balance we did not
   *  re-read is old, and saying how old is the difference between evidence and a claim. */
  vaultAt: number | null;
  ammTrusted: boolean | null;
  ammBuys: number;
  ammSells: number;
  ammBuyVolSol: number;
  ammSellVolSol: number;
  finalized: boolean;
}

export interface TokenMeta {
  twitter?: string;
  telegram?: string;
  website?: string;
  description?: string;
}

export interface Tracker {
  on(event: "new", l: (t: TokenState) => void): this;
  on(event: "trade", l: (t: TokenState, e: TradeEvent, now: number) => void): this;
  on(event: "checkpoint", l: (t: TokenState, key: CheckpointKey) => void): this;
  on(event: "finalize", l: (t: TokenState) => void): this;
  on(event: "preannounced", l: (t: TokenState, signals: number) => void): this;
}

/** In-memory state for every token we are currently watching. */
function pushRecent(t: TokenState, x: TokenState["recent"][number]): void {
  t.recent.push(x);
  const cutoff = x.ts - 180_000; // 3 min: flow() uses <= 30 s windows, survivor-trail needs the price 2 min ago
  while (t.recent.length && t.recent[0].ts < cutoff) t.recent.shift();
}

/** Flow over the trailing window: SOL sold vs bought, distinct buyers, and the worst drop inside 10 s. */
export function flow(t: TokenState, now: number, windowMs = 30_000) {
  let buy = 0, sell = 0;
  const buyers = new Set<string>();
  let hi10 = 0;
  for (const x of t.recent) {
    if (x.ts < now - windowMs) continue;
    if (x.side === "buy") { buy += x.sol; buyers.add(x.wallet); } else sell += x.sol;
  }
  for (const x of t.recent) if (x.ts >= now - 10_000 && x.price > hi10) hi10 = x.price;
  const drop10s = hi10 > 0 && t.lastPrice > 0 ? 1 - t.lastPrice / hi10 : 0;
  return { buySol: buy, sellSol: sell, buyers: buyers.size, drop10s };
}

export function hostOf(uri: string): string {
  try {
    const h = new URL(uri).hostname;
    return h.includes("ipfs") ? "ipfs" : h;
  } catch {
    return "invalid";
  }
}

export class Tracker extends EventEmitter {
  readonly tokens = new Map<string, TokenState>();
  /** creator wallets with at least one graduated token (seeded from the DB, updated live) */
  readonly gradCreators = new Set<string>();
  private watchMs: number;
  private maxWatchMs: number;
  private deadMs: number;
  constructor(opts: { watchMinutes: number; deadAfterSeconds: number; watchMaxMinutes?: number }) {
    super();
    this.watchMs = opts.watchMinutes * 60_000;
    this.maxWatchMs = Math.max(this.watchMs, (opts.watchMaxMinutes ?? opts.watchMinutes) * 60_000);
    this.deadMs = opts.deadAfterSeconds * 1000;
  }

  onCreate(e: CreateEvent, now: number): TokenState {
    const curve = { vSol: e.vSolInBondingCurve, vTokens: e.vTokensInBondingCurve };
    const p = price(curve);
    // a signal may have named this mint BEFORE launch (pre-generated "pump" mints are posted ahead of time)
    const placeholder = this.tokens.get(e.mint);
    const preSignals = placeholder?.lateDiscovery ? placeholder.kolSignals : 0;
    const t: TokenState = {
      mint: e.mint,
      name: e.name,
      symbol: e.symbol,
      uri: e.uri,
      creator: e.traderPublicKey,
      createdAt: now,
      createdSlot: e.slot ?? 0,
      lastTrade: null,
      lateDiscovery: false,
      curve,
      launchPrice: p,
      lastPrice: p,
      lastTradeAt: now,
      peakPrice: p,
      peakAt: now,
      devInitialTokens: e.initialBuy,
      devInitialSol: e.solAmount,
      devPct: (e.initialBuy / TOTAL_SUPPLY) * 100,
      devTokenBalance: e.initialBuy,
      devSold: false,
      devSoldAt: null,
      buys: 0,
      sells: 0,
      buyVolSol: 0,
      sellVolSol: 0,
      buyers: new Set(),
      sellers: new Set(),
      bundledBuyers: 0,
      balances: new Map([[e.traderPublicKey, e.initialBuy]]),
      graduated: isGraduated(curve),
      graduatedAt: null,
      checkpoints: {},
      snap30: null,
      meta: null,
      kolSignals: preSignals,
      feeBps: null,
      externalPriced: false,
      pumpOrigin: true,
      metaHost: hostOf(e.uri),
      creatorMomentum: this.gradCreators.has(e.traderPublicKey),
      gradPrice: null,
      postGradHigh: null,
      postGradSamples: 0,
      buyersAtGrad: null,
      decimals: 6,
      suspectPrice: null,
      recent: [],
      pool: null,
      vaultPrice: null,
      vaultSol: null,
      vaultAt: null,
      ammTrusted: null,
      ammBuys: 0,
      ammSells: 0,
      ammBuyVolSol: 0,
      ammSellVolSol: 0,
      finalized: false,
    };
    this.tokens.set(e.mint, t);
    if (preSignals > 0) this.emit("preannounced", t, preSignals);
    this.emit("new", t);
    return t;
  }

  /** Create a placeholder for a token we did not see launch (e.g. a KOL posted an older mint). */
  ensureLate(mint: string, now: number, symbol = "?", prior?: { createdAt: number; graduated: boolean; graduatedAt: number | null; pool: string | null; launchPrice: number; name?: string; pumpCreated: boolean }): TokenState {
    let t = this.tokens.get(mint);
    if (t) return t;
    t = {
      mint,
      name: prior?.name ?? symbol,
      symbol,
      uri: "",
      creator: "",
      createdAt: prior?.createdAt ?? now,
      createdSlot: 0,
      lastTrade: null,
      lateDiscovery: true,
      curve: { vSol: 0, vTokens: 1 },
      launchPrice: prior?.launchPrice ?? 0,
      lastPrice: 0,
      lastTradeAt: now, // grace period: no curve trade may ever arrive for an AMM-traded token
      peakPrice: 0,
      peakAt: now,
      devInitialTokens: 0,
      devInitialSol: 0,
      devPct: 0,
      devTokenBalance: 0,
      devSold: false,
      devSoldAt: null,
      buys: 0,
      sells: 0,
      buyVolSol: 0,
      sellVolSol: 0,
      buyers: new Set(),
      sellers: new Set(),
      bundledBuyers: 0,
      balances: new Map(),
      graduated: prior?.graduated ?? false,
      graduatedAt: prior?.graduatedAt ?? null,
      checkpoints: {},
      snap30: null,
      meta: null,
      kolSignals: 0,
      feeBps: null,
      externalPriced: false,
      pumpOrigin: prior?.pumpCreated ? true : null, // a token we tracked from its pump.fun create event
      metaHost: "",
      creatorMomentum: false,
      gradPrice: null,
      postGradHigh: null,
      postGradSamples: 0,
      buyersAtGrad: null,
      decimals: prior?.pumpCreated ? 6 : -1, // pump.fun-created tokens have 6 decimals; otherwise unknown until looked up, AMM prices ignored until then
      suspectPrice: null,
      recent: [],
      pool: prior?.pool ?? null,
      vaultPrice: null,
      vaultSol: null,
      vaultAt: null,
      ammTrusted: null,
      ammBuys: 0,
      ammSells: 0,
      ammBuyVolSol: 0,
      ammSellVolSol: 0,
      finalized: false,
    };
    this.tokens.set(mint, t);
    this.emit("new", t);
    return t;
  }

  onTrade(e: TradeEvent & { feeBps?: number | null }, now: number): TokenState | null {
    const t = this.tokens.get(e.mint);
    if (!t || t.finalized) return null;
    let buyerRank: number | null = null;
    t.curve = { vSol: e.vSolInBondingCurve, vTokens: e.vTokensInBondingCurve };
    const p = price(t.curve);
    if (t.lateDiscovery && t.launchPrice === 0) t.launchPrice = p;
    t.lastPrice = p;
    t.lastTradeAt = now;
    if (p > t.peakPrice) {
      t.peakPrice = p;
      t.peakAt = now;
    }
    if (e.feeBps !== undefined && e.feeBps !== null) t.feeBps = e.feeBps;
    if (Number.isFinite(e.newTokenBalance)) t.balances.set(e.traderPublicKey, e.newTokenBalance);
    else {
      // RPC log source: reconstruct balances from observed trades
      const prev = t.balances.get(e.traderPublicKey) ?? 0;
      t.balances.set(e.traderPublicKey, Math.max(0, prev + (e.txType === "buy" ? e.tokenAmount : -e.tokenAmount)));
    }
    if (e.txType === "buy") {
      t.buys++;
      t.buyVolSol += e.solAmount;
      const isNew = !t.buyers.has(e.traderPublicKey);
      t.buyers.add(e.traderPublicKey);
      if (isNew) buyerRank = t.buyers.size; // 1 = first non-dev buyer
      // bundle heuristic: a distinct non-dev buyer in the creation slot or the next one (or within 2s when slots are unknown)
      const sameBlock = t.createdSlot && e.slot ? e.slot - t.createdSlot <= 1 : now - t.createdAt <= 2000;
      if (isNew && e.traderPublicKey !== t.creator && sameBlock) t.bundledBuyers++;
    } else {
      t.sells++;
      t.sellVolSol += e.solAmount;
      t.sellers.add(e.traderPublicKey);
    }
    if (e.traderPublicKey === t.creator) {
      t.devTokenBalance = t.balances.get(t.creator) ?? 0;
      if (e.txType === "sell" && !t.devSold) {
        t.devSold = true;
        t.devSoldAt = now;
      }
    }
    if (!t.graduated && (isGraduated(t.curve) || e.pool !== "pump")) {
      t.graduated = true;
      t.graduatedAt = now;
      t.gradPrice = p;
      t.postGradHigh = p;
      t.buyersAtGrad = t.buyers.size;
      if (t.creator) this.gradCreators.add(t.creator);
    }
    t.lastTrade = { wallet: e.traderPublicKey, side: e.txType, sol: e.solAmount, buyerRank };
    pushRecent(t, { ts: now, side: e.txType, sol: e.solAmount, wallet: e.traderPublicKey, price: p });
    this.emit("trade", t, e, now);
    return t;
  }

  /**
   * Price update from an external source (DexScreener) for tokens trading on PumpSwap after
   * graduation. Models the AMM as a very deep constant-product pool so fill impact is negligible
   * and the paper broker's curve math keeps working.
   */
  setExternalPrice(mint: string, priceSol: number, now: number, meta?: { symbol?: string; name?: string; pumpOrigin?: boolean }): TokenState | null {
    const t = this.tokens.get(mint);
    if (!t || t.finalized || !(priceSol > 0)) return null;
    if (!this.acceptPrice(t, priceSol)) return null;
    if (meta?.symbol && (t.symbol === "?" || !t.symbol)) t.symbol = meta.symbol;
    if (meta?.name && (t.name === "?" || !t.name)) t.name = meta.name;
    if (meta?.pumpOrigin !== undefined) t.pumpOrigin = meta.pumpOrigin;
    const vTokens = 1e12;
    t.curve = { vSol: priceSol * vTokens, vTokens };
    if (t.launchPrice === 0) t.launchPrice = priceSol;
    t.lastPrice = priceSol;
    t.lastTradeAt = now;
    if (priceSol > t.peakPrice) {
      t.peakPrice = priceSol;
      t.peakAt = now;
    }
    t.feeBps = 125; // ~0.25% PumpSwap fee + ~1% assumed slippage
    t.externalPriced = true;
    t.graduated = true;
    if (!t.graduatedAt) t.graduatedAt = now;
    if (t.gradPrice === null) t.gradPrice = priceSol;
    t.postGradHigh = Math.max(t.postGradHigh ?? 0, priceSol);
    t.postGradSamples++;
    return t;
  }

  /** A PumpSwap trade on this token's pool. Price is the execution price (fees included). */
  onAmmTrade(mint: string, tr0: { user: string; side: "buy" | "sell"; baseTokens: number; quoteSol: number; price: number }, now: number): TokenState | null {
    const t = this.tokens.get(mint);
    if (!t || t.finalized || !(tr0.price > 0)) return null;
    if (t.decimals < 0) return null; // decimals unknown: cannot price this token yet
    const scale = 10 ** (t.decimals - 6); // decoder assumed 6 decimals
    const tr = scale === 1 ? tr0 : { ...tr0, baseTokens: tr0.baseTokens / scale, price: tr0.price * scale };
    if (tr.baseTokens < 1000 || tr.quoteSol < 0.0005) return null; // dust: execution price is meaningless
    // the pool must reconcile with its on-chain vault balances before its decoded trades are trusted
    if (t.vaultPrice === null) return null;
    if (t.ammTrusted === null) t.ammTrusted = tr.price / t.vaultPrice < 5 && tr.price / t.vaultPrice > 0.2;
    if (!t.ammTrusted) return null;
    if (!this.acceptPrice(t, tr.price)) return null;
    const vTokens = 1e12;
    t.curve = { vSol: tr.price * vTokens, vTokens };
    t.externalPriced = true;
    t.feeBps = 125;
    if (!t.graduated) {
      t.graduated = true;
      t.graduatedAt = now;
      t.buyersAtGrad = t.buyers.size;
      if (t.creator) this.gradCreators.add(t.creator);
    }
    if (t.gradPrice === null) t.gradPrice = tr.price;
    if (t.launchPrice === 0) t.launchPrice = tr.price;
    t.lastPrice = tr.price;
    t.lastTradeAt = now;
    t.postGradSamples++;
    t.postGradHigh = Math.max(t.postGradHigh ?? 0, tr.price);
    if (tr.price > t.peakPrice) {
      t.peakPrice = tr.price;
      t.peakAt = now;
    }
    const prev = t.balances.get(tr.user) ?? 0;
    t.balances.set(tr.user, Math.max(0, prev + (tr.side === "buy" ? tr.baseTokens : -tr.baseTokens)));
    if (tr.side === "buy") {
      t.ammBuys++;
      t.ammBuyVolSol += tr.quoteSol;
      t.buyers.add(tr.user);
    } else {
      t.ammSells++;
      t.ammSellVolSol += tr.quoteSol;
      t.sellers.add(tr.user);
      if (tr.user === t.creator && !t.devSold) {
        t.devSold = true;
        t.devSoldAt = now;
      }
    }
    t.lastTrade = { wallet: tr.user, side: tr.side, sol: tr.quoteSol, buyerRank: null };
    pushRecent(t, { ts: now, side: tr.side, sol: tr.quoteSol, wallet: tr.user, price: tr.price });
    return t;
  }

  /**
   * Reject a price that jumps >10x against the last accepted price unless the next sample agrees with it.
   * Catches decimals mismatches and one-off feed glitches; a genuine 10x move is accepted on its second print.
   */
  private acceptPrice(t: TokenState, px: number): boolean {
    if (!(t.lastPrice > 0)) return true;
    const ratio = px / t.lastPrice;
    if (ratio < 10 && ratio > 0.1) { t.suspectPrice = null; return true; }
    if (t.suspectPrice !== null && px / t.suspectPrice < 2 && px / t.suspectPrice > 0.5) { t.suspectPrice = null; return true; }
    t.suspectPrice = px;
    return false;
  }

  /** Largest non-dev holder as % of total supply (from balances observed via trades). */
  topHolderPct(t: TokenState): number {
    let max = 0;
    for (const [w, bal] of t.balances) if (w !== t.creator && bal > max) max = bal;
    return (max / TOTAL_SUPPLY) * 100;
  }

  /** Called every second: record checkpoints, expire dead/old tokens. Returns mints to unsubscribe. */
  tick(now: number, hasOpenPosition: (mint: string) => boolean): string[] {
    const expire: string[] = [];
    for (const t of this.tokens.values()) {
      if (t.finalized) continue;
      const age = now - t.createdAt;
      if (!t.snap30 && age >= 30_000) {
        t.snap30 = { buyers: t.buyers.size, buys: t.buys, sells: t.sells, volSol: t.buyVolSol + t.sellVolSol };
      }
      for (const cp of CHECKPOINTS_S) {
        if (t.checkpoints[cp] === undefined && age >= cp * 1000) {
          t.checkpoints[cp] = t.lastPrice;
          this.emit("checkpoint", t, cp);
        }
      }
      const idle = now - t.lastTradeAt;
      const dead = idle >= this.deadMs;
      // Finalize when: hard cap reached; past the normal window and no longer trading;
      // or dead within the first hour with no open position. Tokens that keep trading are
      // followed up to the cap so slow builders and graduations are measured.
      const cap = t.watchCapMs ?? this.maxWatchMs;
      // a leashed token (operator activity) with open interest is not dropped for going quiet: its pool can pause for minutes between farm buys
      const leashed = t.watchCapMs !== undefined && hasOpenPosition(t.mint);
      const expireNow = age >= cap || (age >= this.watchMs && dead && !leashed) || (dead && !hasOpenPosition(t.mint) && age >= 60_000);
      if (expireNow) {
        {
          for (const cp of CHECKPOINTS_S) if (t.checkpoints[cp] === undefined) t.checkpoints[cp] = t.lastPrice;
        }
        t.finalized = true;
        expire.push(t.mint);
        this.emit("finalize", t);
      }
    }
    for (const m of expire) this.tokens.delete(m);
    return expire;
  }
}

/** Fetch token metadata JSON (socials) with a short timeout. Never throws. */
export async function fetchMeta(uri: string): Promise<TokenMeta | null> {
  if (!uri || !/^https?:/.test(uri)) return null;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const pick = (k: string) => (typeof j?.[k] === "string" && j[k] ? j[k] : undefined);
    return { twitter: pick("twitter"), telegram: pick("telegram"), website: pick("website"), description: pick("description")?.slice(0, 200) };
  } catch {
    return null;
  }
}
