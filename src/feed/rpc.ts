import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { CreateEvent, TradeEvent } from "./pumpportal.ts";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TRADE_DISC = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);
const CREATE_DISC = createHash("sha256").update("event:CreateEvent").digest().subarray(0, 8);
const LAMPORTS = 1e9;
const TOKEN_DECIMALS = 1e6;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(buf: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export interface DecodedTrade {
  mint: string;
  solAmount: number; // SOL
  tokenAmount: number; // tokens (6 decimals applied)
  isBuy: boolean;
  user: string;
  timestamp: number; // unix seconds
  vSol: number;
  vTokens: number;
  realSol: number;
  realTokens: number;
  feeBps: number | null;
  creator: string | null;
  creatorFeeBps: number | null;
}

/** Anchor-encoded pump.fun TradeEvent (fixed-offset prefix; trailing fields vary by program version). */
export function decodeTrade(d: Buffer): DecodedTrade | null {
  if (d.length < 129 || !d.subarray(0, 8).equals(TRADE_DISC)) return null;
  const u64 = (o: number) => Number(d.readBigUInt64LE(o));
  const t: DecodedTrade = {
    mint: base58(d.subarray(8, 40)),
    solAmount: u64(40) / LAMPORTS,
    tokenAmount: u64(48) / TOKEN_DECIMALS,
    isBuy: d[56] === 1,
    user: base58(d.subarray(57, 89)),
    timestamp: Number(d.readBigInt64LE(89)),
    vSol: u64(97) / LAMPORTS,
    vTokens: u64(105) / TOKEN_DECIMALS,
    realSol: u64(113) / LAMPORTS,
    realTokens: u64(121) / TOKEN_DECIMALS,
    feeBps: null,
    creator: null,
    creatorFeeBps: null,
  };
  if (d.length >= 225) {
    t.feeBps = u64(161);
    t.creator = base58(d.subarray(177, 209));
    t.creatorFeeBps = u64(209);
  }
  return t;
}

export interface DecodedCreate {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string | null;
}

export function decodeCreate(d: Buffer): DecodedCreate | null {
  if (!d.subarray(0, 8).equals(CREATE_DISC)) return null;
  let o = 8;
  const str = () => {
    const len = d.readUInt32LE(o);
    o += 4;
    const s = d.subarray(o, o + len).toString("utf8");
    o += len;
    return s;
  };
  const pk = () => {
    const s = base58(d.subarray(o, o + 32));
    o += 32;
    return s;
  };
  try {
    const name = str();
    const symbol = str();
    const uri = str();
    const mint = pk();
    const bondingCurve = pk();
    const user = pk();
    const creator = d.length >= o + 32 ? pk() : null;
    return { name, symbol, uri, mint, bondingCurve, user, creator };
  } catch {
    return null;
  }
}

/**
 * A reading of a venue's curve account, with nobody attached to it.
 *
 * The second venue needed this and pump.fun did not, which is the whole reason it exists as a separate event.
 * pump.fun's TradeEvent carries the trading wallet, so every curve reading arrives welded to the person who caused
 * it and one event can be both. LaunchLab's does not: its TradeEvent names a pool and an amount and no wallet at
 * all, so the same log line is a fact about the curve and nothing whatsoever about a trader.
 *
 * Splitting them is what lets the collector record the first without inventing the second. A `trade` carries a
 * wallet by definition - `trades.wallet` is NOT NULL, and a trade row with no wallet cannot answer the question
 * that table exists for - so a venue that cannot name the trader emits `curve` and stays silent about who.
 *
 * `vSol` is null rather than 0 for a pool quoted in something other than wrapped SOL, because 0 SOL in a curve is a
 * real and different state (a launch nobody has bought) and this archive has already published one invented zero
 * per quarter. A consumer that wants the number in the pool's own units reads `quoteReserve` and `quoteMint`.
 */
export interface CurveUpdate {
  /** Which venue read this. Stamped at decode, never defaulted. venues.ts clause 4. */
  venue: string;
  mint: string;
  /** The account the reading came from: pump.fun's bonding curve, LaunchLab's pool state. */
  curveAccount: string;
  signature: string;
  slot: number;
  vTokens: number;
  /** Virtual SOL, or null when this curve is not quoted in SOL and therefore has no SOL figure at all. */
  vSol: number | null;
  realTokens: number;
  /** Real reserve of the quote asset, in that asset's own units. Named for what it is, not assumed to be SOL. */
  quoteReserve: number;
  quoteMint: string;
  /**
   * Did the curve finish, according to the program's own status field?
   *
   * Not an inference from a threshold. pump.fun's ~115 vSOL rule is a guess that `graduated_confirmed_by` exists to
   * mark as unconfirmed; this is the venue saying so itself, which is the same authority as reading the account.
   */
  complete: boolean;
}

export interface RpcFeed {
  on(event: "create", listener: (e: CreateEvent, receivedAt: number) => void): this;
  on(event: "trade", listener: (e: TradeEvent & { feeBps?: number | null }, receivedAt: number) => void): this;
  on(event: "curve", listener: (u: CurveUpdate, receivedAt: number) => void): this;
  on(event: "status", listener: (msg: string) => void): this;
}

/**
 * Subscribes to every pump.fun program log via a Solana RPC websocket and
 * emits the same CreateEvent / TradeEvent shapes as the PumpPortal feed, so the
 * rest of the system does not care which source is in use. Works on the free
 * public endpoint; a private RPC (Helius, QuickNode, Triton) is more reliable.
 */
export class RpcFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 1000;
  /**
   * `protected`, not private, so a venue whose events are shaped differently can subclass this rather than fork the
   * connection, backoff and watchdog logic. Nothing about pump.fun's path changes: `handleLogs` below is still the
   * only implementation this class uses.
   */
  protected stats = { messages: 0, creates: 0, trades: 0, curves: 0, reconnects: 0 };
  private lastMessageAt = 0;
  private openedAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;

  /**
   * The venue this feed observes. Defaults to pump.fun so every existing caller is unchanged, and exists so that
   * adding a second venue is a second construction rather than an edit to this file - which is the whole point of
   * the seam in venues.ts, and the reason that file had no importer until now.
   */
  venueId = "pumpfun";
  constructor(private url: string, private program: string = PUMP_PROGRAM) {
    super();
  }

  connect(): void {
    this.closed = false;
    this.open();
    this.watchdog = setInterval(() => {
      if (this.closed) return;
      const state = this.ws?.readyState;
      // pump.fun never goes quiet for 30s; if it does, the socket is dead.
      if (state === WebSocket.OPEN && this.lastMessageAt && Date.now() - this.lastMessageAt > 30_000) {
        this.emit("status", "no messages for 30s, reconnecting");
        this.ws!.close();
        return;
      }
      // Socket errored/closed without a reconnect being scheduled (e.g. failed initial connect), or stuck connecting.
      const stuckConnecting = state === WebSocket.CONNECTING && Date.now() - this.openedAt > 20_000;
      const deadNoTimer = (state === WebSocket.CLOSED || state === undefined) && !this.reconnectTimer;
      if (stuckConnecting || deadNoTimer) {
        this.emit("status", "socket not open and no reconnect pending, reconnecting");
        try {
          this.ws?.close();
        } catch {}
        this.open();
      }
    }, 10_000);
  }

  close(): void {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  getStats() {
    return { ...this.stats, subscriptions: -1 };
  }

  // Per-token subscriptions are not needed: the program-wide log stream carries every trade.
  subscribeTrades(_mint: string): void {}
  unsubscribeTrades(_mint: string): void {}

  private open(): void {
    this.openedAt = Date.now();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 1000;
      this.lastMessageAt = Date.now();
      this.emit("status", `connected to ${this.url.replace(/\?.*$/, "")}`);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [this.program] }, { commitment: "processed" }] }));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let m: any;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.error) return this.emit("status", `rpc error ${JSON.stringify(m.error)}`);
      if (m.result !== undefined) return this.emit("status", `logsSubscribe id ${m.result}`);
      const v = m.params?.result?.value;
      if (!v || v.err) return; // skip failed txs
      this.stats.messages++;
      this.handleLogs(v.signature as string, v.logs as string[], Number(m.params?.result?.context?.slot ?? 0));
    };
    ws.onerror = () => this.emit("status", "socket error");
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return; // a newer socket has taken over
      this.stats.reconnects++;
      this.emit("status", `disconnected, reconnecting in ${this.backoffMs}ms`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.open();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }

  protected handleLogs(signature: string, logs: string[], slot: number): void {
    const now = Date.now();
    let create: DecodedCreate | null = null;
    const trades: DecodedTrade[] = [];
    for (const l of logs) {
      if (!l.startsWith("Program data: ")) continue;
      const d = Buffer.from(l.slice(14), "base64");
      if (d.length < 8) continue;
      if (d.subarray(0, 8).equals(TRADE_DISC)) {
        const t = decodeTrade(d);
        if (t) trades.push(t);
      } else if (d.subarray(0, 8).equals(CREATE_DISC)) {
        create = decodeCreate(d);
      }
    }
    if (create) {
      // The dev's initial buy (if any) is a TradeEvent in the same transaction.
      const devBuy = trades.find((t) => t.mint === create!.mint && t.isBuy);
      const vSol = devBuy ? devBuy.vSol : 30;
      const vTokens = devBuy ? devBuy.vTokens : 1_073_000_000;
      this.stats.creates++;
      this.emit(
        "create",
        {
          signature,
          mint: create.mint,
          traderPublicKey: create.creator ?? create.user,
          txType: "create",
          initialBuy: devBuy?.tokenAmount ?? 0,
          solAmount: devBuy?.solAmount ?? 0,
          bondingCurveKey: create.bondingCurve,
          vTokensInBondingCurve: vTokens,
          vSolInBondingCurve: vSol,
          marketCapSol: (vSol / vTokens) * 1_000_000_000,
          venue: this.venueId,
          name: create.name,
          symbol: create.symbol,
          uri: create.uri,
          pool: "pump",
          slot,
        } satisfies CreateEvent,
        now,
      );
      // the dev buy is already reflected in the create's curve state
      const rest = trades.filter((t) => t !== devBuy);
      trades.length = 0;
      trades.push(...rest);
    }
    for (const t of trades) {
      this.stats.trades++;
      this.emit(
        "trade",
        {
          signature,
          mint: t.mint,
          traderPublicKey: t.user,
          txType: t.isBuy ? "buy" : "sell",
          tokenAmount: t.tokenAmount,
          solAmount: t.solAmount,
          newTokenBalance: NaN, // not available from logs
          bondingCurveKey: "",
          vTokensInBondingCurve: t.vTokens,
          vSolInBondingCurve: t.vSol,
          marketCapSol: (t.vSol / t.vTokens) * 1_000_000_000,
          pool: "pump",
          slot,
          feeBps: t.feeBps === null ? null : t.feeBps + (t.creatorFeeBps ?? 0),
        },
        now,
      );
    }
  }
}
