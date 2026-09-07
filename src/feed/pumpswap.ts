import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { base58 } from "./rpc.ts";

export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const BUY_DISC = createHash("sha256").update("event:BuyEvent").digest().subarray(0, 8);
const SELL_DISC = createHash("sha256").update("event:SellEvent").digest().subarray(0, 8);
const CREATE_POOL_DISC = createHash("sha256").update("event:CreatePoolEvent").digest().subarray(0, 8);
const LAMPORTS = 1e9, TOKEN_DECIMALS = 1e6;

export interface AmmTrade {
  pool: string;
  user: string;
  side: "buy" | "sell";
  baseTokens: number; // tokens moved (6 decimals applied)
  quoteSol: number; // SOL moved (user side, before fees)
  poolBaseTokens: number; // pool reserves after the trade
  poolQuoteSol: number;
  price: number; // SOL per token = quote / base reserves
  timestamp: number; // unix seconds
  feeBps: number; // lp + protocol (+ creator) fee in bps
}

/**
 * pump-swap BuyEvent / SellEvent (anchor). Field order per the program IDL:
 *   timestamp i64, <amount fields x13 u64>, pool, user, user_base_ata, user_quote_ata, protocol_fee_recipient, ...
 * Buy amount fields:  base_amount_out, max_quote_amount_in, user_base_reserves, user_quote_reserves,
 *   pool_base_reserves, pool_quote_reserves, quote_amount_in, lp_fee_bps, lp_fee, protocol_fee_bps, protocol_fee,
 *   quote_amount_in_with_lp_fee, user_quote_amount_in
 * Sell amount fields: base_amount_in, min_quote_amount_out, user_base_reserves, user_quote_reserves,
 *   pool_base_reserves, pool_quote_reserves, quote_amount_out, lp_fee_bps, lp_fee, protocol_fee_bps, protocol_fee,
 *   quote_amount_out_without_lp_fee, user_quote_amount_out
 */
export function decodeAmmTrade(d: Buffer): AmmTrade | null {
  if (d.length < 184) return null;
  const disc = d.subarray(0, 8);
  const side = disc.equals(BUY_DISC) ? "buy" : disc.equals(SELL_DISC) ? "sell" : null;
  if (!side) return null;
  const u64 = (o: number) => Number(d.readBigUInt64LE(o));
  const timestamp = Number(d.readBigInt64LE(8));
  const base = u64(16); // base_amount_out (buy) / base_amount_in (sell)
  const poolBase = u64(48);
  const poolQuote = u64(56);
  const quote = u64(112); // user_quote_amount_in (buy) / user_quote_amount_out (sell): the SOL that actually moved, fees included
  const lpBps = u64(72), protoBps = u64(88);
  const pool = base58(d.subarray(120, 152));
  const user = base58(d.subarray(152, 184));
  const creatorBps = d.length >= 344 ? u64(336) : 0;
  if (!(poolBase > 0) || !(base > 0) || !(quote > 0)) return null;
  return {
    pool, user, side,
    baseTokens: base / TOKEN_DECIMALS,
    quoteSol: quote / LAMPORTS,
    poolBaseTokens: poolBase / TOKEN_DECIMALS,
    poolQuoteSol: poolQuote / LAMPORTS,
    // execution price (SOL per token, fees included). Pool-reserve fields are misaligned in one of the two
    // event layouts seen in the wild, so reserves are exposed only as approximate depth.
    price: base > 0 ? quote / LAMPORTS / (base / TOKEN_DECIMALS) : poolQuote / LAMPORTS / (poolBase / TOKEN_DECIMALS),
    timestamp,
    feeBps: lpBps + protoBps + (creatorBps < 10_000 ? creatorBps : 0),
  };
}

/** CreatePoolEvent: timestamp i64, index u16, creator, base_mint, quote_mint, base_mint_decimals u8, quote_mint_decimals u8, ... pool at a later offset */
export function decodeCreatePool(d: Buffer): { pool: string; baseMint: string; quoteMint: string; creator: string } | null {
  if (!d.subarray(0, 8).equals(CREATE_POOL_DISC) || d.length < 8 + 8 + 2 + 32 * 3 + 2) return null;
  let o = 8 + 8 + 2;
  const creator = base58(d.subarray(o, o + 32)); o += 32;
  const baseMint = base58(d.subarray(o, o + 32)); o += 32;
  const quoteMint = base58(d.subarray(o, o + 32)); o += 32;
  o += 2; // decimals
  // base_amount_in u64, quote_amount_in u64, pool_base_amount u64, pool_quote_amount u64, minimum_liquidity u64, initial_liquidity u64, lp_token_amount_out u64, pool_bump u8, pool pubkey, lp_mint, user_base_ata, user_quote_ata, coin_creator
  o += 8 * 7 + 1;
  if (d.length < o + 32) return null;
  const pool = base58(d.subarray(o, o + 32));
  return { pool, baseMint, quoteMint, creator };
}

export interface PumpSwapFeed {
  on(event: "trade", l: (t: AmmTrade, receivedAt: number, slot: number) => void): this;
  on(event: "pool", l: (p: { pool: string; baseMint: string; quoteMint: string; creator: string }, receivedAt: number) => void): this;
  on(event: "status", l: (msg: string) => void): this;
}

/** Program-wide PumpSwap log stream on its own websocket. Emits every trade; the consumer filters by pool. */
export class PumpSwapFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 1000;
  private lastMessageAt = 0;
  private openedAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  readonly stats = { messages: 0, trades: 0, pools: 0, reconnects: 0 };
  constructor(private url: string) {
    super();
  }
  connect(): void {
    this.closed = false;
    this.open();
    this.watchdog = setInterval(() => {
      if (this.closed) return;
      const state = this.ws?.readyState;
      if (state === WebSocket.OPEN && this.lastMessageAt && Date.now() - this.lastMessageAt > 30_000) { this.emit("status", "no messages for 30s, reconnecting"); this.ws!.close(); return; }
      const stuck = state === WebSocket.CONNECTING && Date.now() - this.openedAt > 20_000;
      const dead = (state === WebSocket.CLOSED || state === undefined) && !this.reconnectTimer;
      if (stuck || dead) { try { this.ws?.close(); } catch {} this.open(); }
    }, 10_000);
  }
  close(): void {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }
  private open(): void {
    this.openedAt = Date.now();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 1000;
      this.lastMessageAt = Date.now();
      this.emit("status", "connected");
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMPSWAP_PROGRAM] }, { commitment: "processed" }] }));
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      const v = m.params?.result?.value;
      if (!v || v.err) return;
      this.stats.messages++;
      const now = Date.now();
      const slot = Number(m.params?.result?.context?.slot ?? 0);
      for (const l of v.logs as string[]) {
        if (!l.startsWith("Program data: ")) continue;
        const d = Buffer.from(l.slice(14), "base64");
        const t = decodeAmmTrade(d);
        if (t) { this.stats.trades++; this.emit("trade", t, now, slot); continue; }
        const p = decodeCreatePool(d);
        if (p) { this.stats.pools++; this.emit("pool", p, now); }
      }
    };
    ws.onerror = () => this.emit("status", "socket error");
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return;
      this.stats.reconnects++;
      this.emit("status", `disconnected, reconnecting in ${this.backoffMs}ms`);
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.open(); }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }
}
