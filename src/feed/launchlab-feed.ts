/**
 * The live Raydium LaunchLab feed.
 *
 * A subclass rather than an edit. `RpcFeed`'s connection, backoff and watchdog are venue-neutral and worth reusing;
 * its `handleLogs` is pump.fun's decoder and is not. Overriding one method leaves pump.fun's path byte-for-byte
 * unchanged, which matters more than tidiness here: the collector is the one process where a mistake loses launches
 * that cannot be recovered, so the second venue must not be able to break the first. The worst this class can do is
 * record nothing, which is exactly where the archive stands without it.
 *
 * HOW IT RESOLVES IDENTITY, which clause 8 in venues.ts says the interface has to admit.
 *
 * LaunchLab events do not name the mint. They do name the pool, in the first field of both events, so this keys on
 * the pool and reads the pool account once - `getAccountInfo`, cached forever after. That account carries both
 * mints, both decimal scales and the creator. About 9,400 reads a day at current launch rates, nothing per trade,
 * and no transaction fetches at all. Streaming every trade's accounts would have been ~490,000 fetches a day, which
 * is the wrong design rather than the price of the venue.
 *
 * ORDERING. A create must reach the database before its own trades, and resolving a pool is asynchronous, so events
 * are serialised per pool: every event for a pool joins that pool's chain and they emit in arrival order. Different
 * pools proceed independently, so one slow lookup cannot stall the feed.
 *
 * WHAT THIS DOES NOT PRODUCE, and says so rather than inventing it. LaunchLab's TradeEvent carries no trader
 * wallet, so `traderPublicKey` is null on trades. Distinct-buyer counts and creator-sold are therefore not
 * answerable from this stream, and resolve later from the pool's own bounded signature history for curves that
 * actually completed - roughly 0.32 requests a second, the rate backfill.ts already runs at. A null trader must
 * never be read as "no trader" or counted as a distinct one.
 */
import { RpcFeed } from "./rpc.ts";
import type { CreateEvent, TradeEvent } from "./pumpportal.ts";
import { rpc } from "../rpc-http.ts";
import {
  LAUNCHLAB_PROGRAM, WSOL, poolOf, isCreateEvent, isTradeEvent, createParts, tradeParts, decodePool,
  type LaunchLabPool,
} from "./launchlab.ts";

/** What a pool read tells us, kept so no later event on this pool costs anything. */
type Resolved = Pick<LaunchLabPool, "baseMint" | "quoteMint" | "baseDecimals" | "quoteDecimals" | "solQuoted" | "creator">;

export class LaunchLabFeed extends RpcFeed {
  venueId = "launchlab";
  private pools = new Map<string, Resolved | null>();
  private chains = new Map<string, Promise<void>>();
  /** Reads in flight, so two events on one new pool do not both fetch it. */
  private inflight = new Map<string, Promise<Resolved | null>>();

  constructor(url: string) {
    super(url, LAUNCHLAB_PROGRAM);
  }

  /**
   * One read per pool, ever. A failed read caches nothing, so it is retried on the next event rather than turning
   * one bad RPC response into a permanently unnamed launch.
   */
  private async resolve(pool: string): Promise<Resolved | null> {
    const known = this.pools.get(pool);
    if (known !== undefined) return known;
    const running = this.inflight.get(pool);
    if (running) return running;
    const p = (async () => {
      try {
        const a: any = await rpc("getAccountInfo", [pool, { encoding: "base64", commitment: "confirmed" }], 15_000);
        const decoded = a?.value?.data?.[0] ? decodePool(a.value.data[0]) : null;
        if (!decoded) return null;
        const r: Resolved = {
          baseMint: decoded.baseMint, quoteMint: decoded.quoteMint, baseDecimals: decoded.baseDecimals,
          quoteDecimals: decoded.quoteDecimals, solQuoted: decoded.solQuoted, creator: decoded.creator,
        };
        this.pools.set(pool, r);
        return r;
      } catch {
        // Deliberately not cached. An endpoint that refused once is a fact about the endpoint, not about the pool.
        return null;
      } finally {
        this.inflight.delete(pool);
      }
    })();
    this.inflight.set(pool, p);
    return p;
  }

  protected handleLogs(signature: string, logs: string[], slot: number): void {
    const now = Date.now();
    const payloads: Buffer[] = [];
    for (const l of logs) {
      if (!l.startsWith("Program data: ")) continue;
      const d = Buffer.from(l.slice(14), "base64");
      if (d.length >= 8) payloads.push(d);
    }
    if (!payloads.length) return;
    // Every payload in one transaction is about one pool in practice; grouping by pool keeps that true even if not.
    const byPool = new Map<string, Buffer[]>();
    for (const d of payloads) {
      const pool = poolOf(d);
      if (!pool) continue;
      (byPool.get(pool) ?? byPool.set(pool, []).get(pool)!).push(d);
    }
    for (const [pool, ds] of byPool) {
      const prev = this.chains.get(pool) ?? Promise.resolve();
      const next = prev.then(() => this.flush(pool, ds, signature, slot, now)).catch(() => {});
      this.chains.set(pool, next);
      // Drop the chain once it settles, or a long-running collector accumulates one promise per pool forever.
      next.finally(() => { if (this.chains.get(pool) === next) this.chains.delete(pool); });
    }
  }

  private async flush(pool: string, ds: Buffer[], signature: string, slot: number, now: number): Promise<void> {
    const info = await this.resolve(pool);
    // No pool account, no launch record. Emitting with a null mint would put a row in the archive that names
    // nothing, which is worse than the gap it papers over.
    if (!info) return;
    const bScale = 10 ** info.baseDecimals, qScale = 10 ** info.quoteDecimals;
    const create = ds.find(isCreateEvent);
    const trades = ds.filter(isTradeEvent);
    // The creator's own buy rides in the create transaction: five of five sampled. It is the dev buy, and it is the
    // only trade in that batch, so it is not re-emitted as an ordinary trade below.
    const devBuy = create ? trades[0] : undefined;

    if (create) {
      const c = createParts(create);
      if (!c) return;
      const t = devBuy ? tradeParts(devBuy) : null;
      this.stats.creates++;
      this.emit("create", {
        signature,
        mint: info.baseMint,
        traderPublicKey: c.creator,
        txType: "create",
        initialBuy: t ? t.baseRaw / bScale : 0,
        // Only a wrapped-SOL pool has a SOL amount, and 21.4% of pools are not one. `solAmount: 0` on those would
        // be indistinguishable from a launch that raised nothing, which is inventing a zero - the fault this
        // codebase keeps producing. `quoteMint` and `solQuoted` travel with the event so no consumer has to guess,
        // and a consumer that ignores them still sees 0 rather than a quantity of some other token read as SOL.
        solAmount: t && info.solQuoted ? t.quoteRaw / qScale : 0,
        quoteMint: info.quoteMint,
        solQuoted: info.solQuoted,
        /** Raw quote units, whatever the quote asset is. Present even when it cannot be called SOL. */
        quoteAmountRaw: t ? t.quoteRaw : 0,
        bondingCurveKey: c.poolState,
        vTokensInBondingCurve: t ? t.vBaseRaw / bScale : 0,
        vSolInBondingCurve: t && info.solQuoted ? t.vQuoteRaw / qScale : 0,
        marketCapSol: 0,
        venue: this.venueId,
        name: c.name, symbol: c.symbol, uri: c.uri,
        pool: c.poolState,
        slot,
      } as unknown as CreateEvent, now);
    }

    for (const d of trades) {
      if (d === devBuy) continue;
      const t = tradeParts(d);
      if (!t) continue;
      this.stats.trades++;
      this.emit("trade", {
        signature,
        mint: info.baseMint,
        // Not in the event. Null, never a placeholder: a fabricated wallet would be counted as a distinct buyer.
        traderPublicKey: null,
        txType: t.isBuy ? "buy" : "sell",
        tokenAmount: t.baseRaw / bScale,
        solAmount: info.solQuoted ? t.quoteRaw / qScale : 0,
        quoteMint: info.quoteMint,
        solQuoted: info.solQuoted,
        quoteAmountRaw: t.quoteRaw,
        newTokenBalance: NaN,
        bondingCurveKey: t.poolState,
        vTokensInBondingCurve: t.vBaseRaw / bScale,
        vSolInBondingCurve: info.solQuoted ? t.vQuoteRaw / qScale : 0,
        marketCapSol: 0,
        pool: t.poolState,
        slot,
        feeBps: null,
      } as unknown as TradeEvent, now);
    }
  }
}
