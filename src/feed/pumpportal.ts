import { EventEmitter } from "node:events";

/** Shape observed on wss://pumpportal.fun/api/data (method: subscribeNewToken) */
export interface CreateEvent {
  /**
   * Which launch venue decoded this event, as `LaunchVenue.id`.
   *
   * Optional only because a second source (PumpPortal) predates the field. Every feed that decodes a program's logs
   * sets it, and `upsertToken` writes it straight through, so a launch is stamped with the venue that produced it
   * rather than inheriting a column default. `tokens.venue` is NOT NULL DEFAULT 'pumpfun' and that default is a trap
   * for exactly one situation: the day a second venue's decoder forgets this field, its launches are published as
   * pump.fun launches and nothing anywhere says otherwise. See clause 4 in venues.ts.
   */
  venue?: string;
  signature: string;
  mint: string;
  traderPublicKey: string; // creator / dev wallet
  txType: "create";
  initialBuy: number; // tokens the dev bought at creation
  solAmount: number; // SOL the dev spent
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  name: string;
  symbol: string;
  uri: string;
  pool: string;
  is_mayhem_mode?: boolean;
  slot?: number;
}

/** Shape from subscribeTokenTrade */
export interface TradeEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  newTokenBalance: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
  pool: string;
  slot?: number;
  feeBps?: number | null;
}

export interface PumpPortalFeed {
  on(event: "create", listener: (e: CreateEvent, receivedAt: number) => void): this;
  on(event: "trade", listener: (e: TradeEvent, receivedAt: number) => void): this;
  on(event: "status", listener: (msg: string) => void): this;
}

/**
 * Single websocket to PumpPortal (they allow one connection per client) with
 * automatic reconnect and re-subscription. Subscriptions are batched so a
 * burst of new launches does not spam the socket.
 */
export class PumpPortalFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private tradeSubs = new Set<string>();
  private pendingSub = new Set<string>();
  private pendingUnsub = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private closed = false;
  private stats = { messages: 0, creates: 0, trades: 0, reconnects: 0 };

  constructor(apiKey = "") {
    super();
    this.url = "wss://pumpportal.fun/api/data" + (apiKey ? `?api-key=${encodeURIComponent(apiKey)}` : "");
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  get subscriptionCount(): number {
    return this.tradeSubs.size;
  }

  getStats() {
    return { ...this.stats, subscriptions: this.tradeSubs.size };
  }

  subscribeTrades(mint: string): void {
    if (this.tradeSubs.has(mint)) return;
    this.tradeSubs.add(mint);
    this.pendingUnsub.delete(mint);
    this.pendingSub.add(mint);
    this.scheduleFlush();
  }

  unsubscribeTrades(mint: string): void {
    if (!this.tradeSubs.has(mint)) return;
    this.tradeSubs.delete(mint);
    this.pendingSub.delete(mint);
    this.pendingUnsub.add(mint);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 500);
  }

  private flush(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.pendingSub.size) {
      this.send({ method: "subscribeTokenTrade", keys: [...this.pendingSub] });
      this.pendingSub.clear();
    }
    if (this.pendingUnsub.size) {
      this.send({ method: "unsubscribeTokenTrade", keys: [...this.pendingUnsub] });
      this.pendingUnsub.clear();
    }
  }

  private send(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 1000;
      this.emit("status", "connected");
      this.send({ method: "subscribeNewToken" });
      // Re-subscribe everything we were tracking before a reconnect.
      if (this.tradeSubs.size) this.send({ method: "subscribeTokenTrade", keys: [...this.tradeSubs] });
      this.pendingSub.clear();
      this.pendingUnsub.clear();
    };

    ws.onmessage = (ev) => {
      this.stats.messages++;
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const now = Date.now();
      if (msg.txType === "create") {
        this.stats.creates++;
        this.emit("create", msg as CreateEvent, now);
      } else if (msg.txType === "buy" || msg.txType === "sell") {
        this.stats.trades++;
        this.emit("trade", msg as TradeEvent, now);
      } else if (msg.message) {
        this.emit("status", String(msg.message));
      }
    };

    ws.onerror = () => {
      this.emit("status", "socket error");
    };

    ws.onclose = () => {
      if (this.closed) return;
      this.stats.reconnects++;
      this.emit("status", `disconnected, reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.open(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }
}
