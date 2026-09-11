import type { DatabaseSync } from "node:sqlite";
import type { TokenState, Tracker, CheckpointKey } from "../src/tracker.ts";
import type { Strategy, OperatorActivity } from "./strategies/index.ts";
import { simulateBuy, simulateSell, price, FEE_BPS } from "../src/curve.ts";
import { flow } from "../src/tracker.ts";
const feeOf = (t: TokenState) => t.feeBps ?? FEE_BPS;
import { EventEmitter } from "node:events";

export interface Position {
  id: number;
  strategy: string;
  mint: string;
  symbol: string;
  reason: string;
  decidedAt: number;
  openedAt: number;
  entryPrice: number;
  solIn: number;
  tokens: number;
  feesSol: number;
  peakPrice: number;
  hold: Partial<Record<CheckpointKey, number>>; // multiple at t+N seconds after open
  closed: boolean;
  /** SOL already realised by a partial exit, and when */
  bankedSol: number;
  bankedAt: number | null;
}

interface PendingOrder {
  strategy: Strategy;
  mint: string;
  reason: string;
  decidedAt: number;
  fillAfter: number;
}

export interface PaperBroker {
  on(event: "open", l: (p: Position, t: TokenState) => void): this;
  on(event: "close", l: (p: Position, t: TokenState, exit: { price: number; solOut: number; pnl: number; multiple: number; reason: string }) => void): this;
  on(event: "partial", l: (p: Position, t: TokenState, x: { solOut: number; multiple: number }) => void): this;
}

/**
 * Simulates buys/sells against the live bonding curve state.
 * - fills happen FILL_LATENCY_MS after the decision, at the curve as it is then
 * - fill impact is computed with the real constant-product formula and 1% fee
 * - a flat priority fee is charged per transaction
 * - one open position per (strategy, mint); a strategy may re-enter a token only once it has exited
 */
export class PaperBroker extends EventEmitter {
  private open_ = new Map<string, Position>(); // key strategy|mint
  private entered = new Set<string>(); // strategy|mint ever entered
  private pending: PendingOrder[] = [];
  private nextId = 1;
  smartWallets = new Set<string>();
  walletTeams = new Map<string, number>();
  /** wallet -> cluster name (operator farms from `npm run clusters`) */
  operatorWallets = new Map<string, string>();
  /** mint -> what operator wallets did on it (maintained by index.ts) */
  operatorActivity = new Map<string, OperatorActivity>();
  /** cluster -> follow | watch | avoid */
  operatorPolicy = new Map<string, string>();

  constructor(
    private db: DatabaseSync,
    private tracker: Tracker,
    private strategies: Strategy[],
    private opts: { buySol: number; prioFeeSol: number; fillLatencyMs: number },
  ) {
    super();
    const row = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM positions").get() as { m: number };
    this.nextId = row.m + 1;
  }

  /** Whether any of the given strategies ever entered this mint (used to decide which raw trade histories to keep). */
  everEntered(mint: string, strategyNames: string[]): boolean {
    return strategyNames.some((s) => this.entered.has(`${s}|${mint}`));
  }

  hasOpenPosition(mint: string): boolean {
    for (const p of this.open_.values()) if (p.mint === mint) return true;
    return false;
  }

  openPositions(): Position[] {
    return [...this.open_.values()];
  }

  /** Evaluate entry rules for a token. `kolSignal` marks that a watched account just posted it. */
  evaluateEntries(t: TokenState, now: number, kolSignal = false): void {
    if (t.finalized) return;
    const ageMs = now - t.createdAt;
    for (const s of this.strategies) {
      const key = `${s.name}|${t.mint}`;
      if (this.entered.has(key)) continue;
      if (ageMs > s.entryWindowS * 1000) continue;
      const reason = s.shouldEnter(t, { tracker: this.tracker, now, ageMs, kolSignal, smartWallets: this.smartWallets, wallesTeams: this.walletTeams, operatorWallets: this.operatorWallets, operatorActivity: this.operatorActivity.get(t.mint), operatorPolicy: this.operatorPolicy });
      if (!reason) continue;
      this.entered.add(key);
      this.pending.push({ strategy: s, mint: t.mint, reason, decidedAt: now, fillAfter: now + this.opts.fillLatencyMs });
    }
  }

  /** Called on every trade for a token and on every 1s tick. */
  update(t: TokenState, now: number): void {
    this.fillPending(now);
    for (const s of this.strategies) {
      const p = this.open_.get(`${s.name}|${t.mint}`);
      if (p) this.checkExit(p, s, t, now);
    }
  }

  tick(now: number): void {
    this.fillPending(now);
    for (const p of [...this.open_.values()]) {
      const t = this.tracker.tokens.get(p.mint);
      const s = this.strategies.find((x) => x.name === p.strategy)!;
      if (!t) {
        // token expired from tracker while position open: close at last known price
        this.close(p, s, null, now, "watch-window-ended");
        continue;
      }
      this.checkExit(p, s, t, now);
    }
  }

  /** Close any open positions on a token (e.g. its watch window ended) at its current curve. */
  closeForToken(t: TokenState, now: number, reason: string): void {
    for (const p of [...this.open_.values()]) {
      if (p.mint !== t.mint) continue;
      const s = this.strategies.find((x) => x.name === p.strategy)!;
      this.close(p, s, t, now, reason);
    }
  }

  /** Force-close everything (shutdown) */
  closeAll(now: number, reason: string): void {
    for (const p of [...this.open_.values()]) {
      const s = this.strategies.find((x) => x.name === p.strategy)!;
      this.close(p, s, this.tracker.tokens.get(p.mint) ?? null, now, reason);
    }
  }

  private fillPending(now: number): void {
    if (!this.pending.length) return;
    const keep: PendingOrder[] = [];
    for (const o of this.pending) {
      if (o.fillAfter > now) {
        keep.push(o);
        continue;
      }
      const t = this.tracker.tokens.get(o.mint);
      if (!t || t.finalized || (t.graduated && !t.externalPriced) || t.lastPrice <= 0) continue; // nothing to buy into
      const { tokensOut } = simulateBuy(t.curve, this.opts.buySol, feeOf(t));
      const p: Position = {
        id: this.nextId++,
        strategy: o.strategy.name,
        mint: o.mint,
        symbol: t.symbol,
        reason: o.reason,
        decidedAt: o.decidedAt,
        openedAt: now,
        entryPrice: this.opts.buySol / tokensOut, // effective price incl. impact + fee
        solIn: this.opts.buySol,
        tokens: tokensOut,
        feesSol: this.opts.prioFeeSol,
        peakPrice: t.lastPrice,
        hold: {},
        closed: false,
        bankedSol: 0,
        bankedAt: null,
      };
      this.open_.set(`${p.strategy}|${p.mint}`, p);
      this.db
        .prepare(
          `INSERT INTO positions (id, strategy, mint, symbol, reason, decided_at, opened_at, token_age_s, entry_price, sol_in, tokens, fees_sol)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(p.id, p.strategy, p.mint, p.symbol, p.reason, p.decidedAt, p.openedAt, (now - t.createdAt) / 1000, p.entryPrice, p.solIn, p.tokens, p.feesSol);
      this.emit("open", p, t);
    }
    this.pending = keep;
  }

  private checkExit(p: Position, s: Strategy, t: TokenState, now: number): void {
    const cur = t.lastPrice;
    if (cur > p.peakPrice) p.peakPrice = cur;
    const held = (now - p.openedAt) / 1000;
    // record hold multiples (what if we had simply held) using the marked curve value
    for (const cp of [60, 300, 900, 3600] as CheckpointKey[]) {
      if (p.hold[cp] === undefined && held >= cp) p.hold[cp] = this.markMultiple(p, t);
    }
    const x = cur / p.entryPrice;
    const r = s.exit;
    let reason: string | null = null;
    // rip cord: bank half once, then flow / crash exits for the remainder
    if (r.bankHalfAtX && p.bankedAt === null && x >= r.bankHalfAtX) {
      const half = p.tokens / 2;
      const { solOut } = simulateSell(t.curve, half, feeOf(t));
      p.tokens -= half;
      p.bankedSol = solOut;
      p.bankedAt = now;
      p.feesSol += this.opts.prioFeeSol;
      this.db.prepare("UPDATE positions SET partial_sol_out=?, partial_at=? WHERE id=?").run(solOut, now, p.id);
      this.emit("partial", p, t, { solOut, multiple: x });
    }
    const fl = r.flowSellRatio || r.crashDropPct ? flow(t, now) : null;
    if (t.graduated && !t.externalPriced) reason = "graduated";
    else if (r.exitOnDevSell && t.devSold && t.devSoldAt! >= p.decidedAt) reason = "dev-sold";
    else if (fl && r.crashDropPct && fl.drop10s >= r.crashDropPct / 100) reason = "crash";
    else if (r.exitOnOperatorSell && this.operatorSelling(t.mint, now, r.exitOnOperatorSell)) reason = "farm-sell";
    else if (fl && r.flowSellRatio && fl.sellSol >= r.flowSellRatio * Math.max(fl.buySol, 0.05) && cur <= p.peakPrice * (1 - (r.flowDropPct ?? 25) / 100)) reason = "flow-exit";
    else if (x >= r.takeProfitX) reason = "take-profit";
    else if (x <= r.stopLossX) reason = "stop-loss";
    else if (p.peakPrice >= p.entryPrice * r.trailArmX && cur <= p.peakPrice * (1 - r.trailDropPct / 100)) reason = "trailing-stop";
    else if (held >= r.maxHoldS) reason = "time-stop";
    if (reason) this.close(p, s, t, now, reason);
  }

  /** operator-cluster wallets are net sellers of this token over the window: they are leaving, so do we */
  private operatorSelling(mint: string, now: number, rule: { windowS: number; ratio: number }): boolean {
    const a = this.operatorActivity.get(mint);
    if (!a) return false;
    let buy = 0, sell = 0;
    for (const r of a.recent) if (r.ts >= now - rule.windowS * 1000) { if (r.side === "buy") buy += r.sol; else sell += r.sol; }
    return sell >= 1 && sell >= rule.ratio * Math.max(buy, 0.5);
  }

  /** Value of the position if sold into the current curve, as a multiple of SOL in. */
  private markMultiple(p: Position, t: TokenState): number {
    if (t.lastPrice <= 0) return 0;
    const { solOut } = simulateSell(t.curve, p.tokens, feeOf(t));
    return solOut / p.solIn;
  }

  private close(p: Position, s: Strategy, t: TokenState | null, now: number, reason: string): void {
    let solOut: number;
    let exitPrice: number;
    if (t && t.lastPrice > 0) {
      const r = simulateSell(t.curve, p.tokens, feeOf(t));
      solOut = r.solOut;
      exitPrice = price(t.curve);
    } else {
      solOut = 0;
      exitPrice = 0;
    }
    solOut += p.bankedSol; // include what a partial exit already realised
    const fees = p.feesSol + this.opts.prioFeeSol;
    const pnl = solOut - p.solIn - fees;
    const multiple = solOut / p.solIn;
    p.closed = true;
    this.open_.delete(`${p.strategy}|${p.mint}`);
    const suspect = multiple > 50 || p.peakPrice / p.entryPrice > 50 ? 1 : 0; // impossible on a curve, implausible in <90 min on PumpSwap: a price-source artifact
    this.db
      .prepare(
        `UPDATE positions SET closed_at=?, exit_price=?, sol_out=?, pnl_sol=?, multiple=?, exit_reason=?, peak_multiple=?, fees_sol=?,
           hold_1m=?, hold_5m=?, hold_15m=?, hold_60m=?, suspect=? WHERE id=?`,
      )
      .run(now, exitPrice, solOut, pnl, multiple, reason, p.peakPrice / p.entryPrice, fees, p.hold[60] ?? null, p.hold[300] ?? null, p.hold[900] ?? null, p.hold[3600] ?? null, suspect, p.id);
    if (t) this.emit("close", p, t, { price: exitPrice, solOut, pnl, multiple, reason });
  }

  /** Back-fill hold multiples for an open position once the token hits a checkpoint. */
  onTokenCheckpoint(t: TokenState): void {
    for (const p of this.open_.values()) if (p.mint === t.mint) this.checkExit(p, this.strategies.find((s) => s.name === p.strategy)!, t, Date.now());
  }
}
