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
 * WHAT THIS DOES NOT PRODUCE, and says so by emitting a different event rather than a hollow one.
 *
 * LaunchLab's TradeEvent carries no trader wallet. An earlier draft of this file emitted `trade` anyway with
 * `traderPublicKey: null`, and that was the wrong shape: `trades.wallet` is NOT NULL, so those rows could only ever
 * reach the database by relaxing the one constraint that makes the table answerable, or by being dropped at the
 * writer - a feed emitting events nobody may store. Either way the null would have had to be read as something, and
 * the thing it would have been read as is "a buyer", which is how a distinct-buyer count gets a wallet that does not
 * exist.
 *
 * So the curve reading and the trade are separate events (`CurveUpdate` in feed/rpc.ts). This feed emits `create`
 * and `curve` and never `trade`, which is enforced rather than described: see venues.test.ts. Distinct-buyer counts
 * and creator-sold are not answerable from this stream and the venue says so in `tradeAttribution`, so the record
 * publishes NULL for them instead of a zero nobody measured. They resolve later, if they resolve at all, from the
 * pool's own bounded signature history for curves that actually completed - roughly 0.32 requests a second, the rate
 * backfill.ts already runs at.
 */
import { RpcFeed, type CurveUpdate } from "./rpc.ts";
import type { CreateEvent } from "./pumpportal.ts";
import { rpc } from "../rpc-http.ts";
import {
  LAUNCHLAB_PROGRAM, WSOL, poolOf, isCreateEvent, isTradeEvent, createParts, tradeParts, decodePool,
  type LaunchLabPool,
} from "./launchlab.ts";

/** What a pool read tells us, kept so no later event on this pool costs anything. */
type Resolved = Pick<LaunchLabPool, "baseMint" | "quoteMint" | "baseDecimals" | "quoteDecimals" | "solQuoted" | "creator" | "supply">;

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
          supply: decoded.supply,
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
    // The creator's own buy rides in the create transaction: confirmed on chain, not assumed. In the sampled
    // creation transactions the `initialize` instruction and the `buy_exact_in` beside it share one signer, and that
    // signer is the `creator` the PoolCreateEvent names. So this buy may be attributed to the creator, which is the
    // one wallet attribution this venue's stream does support - and the only reason `dev_pct` is answerable here.
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
        /**
         * Tokens this launch minted, read from its own pool account.
         *
         * `dev_pct` is `initialBuy / totalSupply`, and until now the denominator was `curve.ts`'s TOTAL_SUPPLY -
         * 1,000,000,000, which is a fact about pump.fun. LaunchLab sets supply per pool. Carrying the real number
         * with the event is what stops the most load-bearing field in the file from being computed against another
         * venue's constant.
         */
        totalSupply: info.supply,
        decimals: info.baseDecimals,
        // Only a wrapped-SOL pool has a SOL amount, and most are not one (34 of 41 launches sampled). `solAmount: 0`
        // on those would be indistinguishable from a launch that raised nothing, which is inventing a zero - the
        // fault this codebase keeps producing. `quoteMint` and `solQuoted` travel with the event so no consumer has
        // to guess, and one that ignores them sees 0 rather than a quantity of some other token read as SOL.
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

    /**
     * Every swap is a reading of the curve and nothing else.
     *
     * Not a `trade`: the event names no wallet, and an event that cannot name a wallet is not a trade this archive
     * can record. The devBuy is included rather than skipped, because as a curve reading it is not a duplicate of
     * anything - the create carried the same reserves as a launch fact, and this carries them as the curve's state
     * at that moment, which is the series `curve` exists to build.
     */
    for (const d of trades) {
      const t = tradeParts(d);
      if (!t) continue;
      this.stats.curves++;
      this.emit("curve", {
        venue: this.venueId,
        mint: info.baseMint,
        curveAccount: t.poolState,
        signature,
        slot,
        vTokens: t.vBaseRaw / bScale,
        // Null, not zero, when the pool is quoted in something else. See CurveUpdate in feed/rpc.ts.
        vSol: info.solQuoted ? t.vQuoteRaw / qScale : null,
        realTokens: t.realBaseRaw / bScale,
        quoteReserve: t.realQuoteRaw / qScale,
        quoteMint: info.quoteMint,
        // The pool's own status field, carried in the event the program emitted. Leaving Fund (0) is this venue's
        // graduation, and it is the venue saying so rather than us inferring it from a threshold.
        complete: t.status !== 0,
      } satisfies CurveUpdate, now);
    }
  }
}
