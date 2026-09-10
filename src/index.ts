import { config } from "./config.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { openDb, upsertToken, TradeWriter, finalizeTokenTrades, recoverOrphans } from "./db.ts";
import { poolReserves } from "./outcomes.ts";
import { price } from "./curve.ts";
import { PumpPortalFeed } from "./feed/pumpportal.ts";
import { RpcFeed } from "./feed/rpc.ts";
import { PumpSwapFeed } from "./feed/pumpswap.ts";
import { Tracker, fetchMeta, fetchMetaResult } from "./tracker.ts";
import { PaperBroker } from "./paper.ts";
import { strategies, type OperatorActivity } from "./strategies/index.ts";
import { rpc as rpcHttpCall } from "./rpc-http.ts";
import { BUYOUT_SOL, TOKEN_COLUMNS, KEEP_TRADE_EVIDENCE, keepTweetEvidence, coverageWindows, assess } from "./provenance.ts";
import { base58 } from "./feed/rpc.ts";
import type { TokenState } from "./tracker.ts";
import { KolWatcher, StreetListener, loadKols, parseTags, parseTweet, twitterApiIoProvider, xApiProvider } from "./signals/twitter.ts";
import { BuzzTracker } from "./signals/buzz.ts";
import { telegramNotifier, telegramSend } from "./signals/telegram-notify.ts";
import { startWatchdog, startHeartbeat, fmtAge } from "./watchdog.ts";
import { TelegramWatcher } from "./signals/telegram.ts";
import { createClient, loadChannels, telegramConfigured } from "./signals/telegram-client.ts";
import type { KolSignal } from "./signals/twitter.ts";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtX = (x: number) => `${x.toFixed(2)}x`;
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-6)}`;

const db = openDb(config.dbPath);

/**
 * Inherit an archive, once, before anything else happens.
 *
 * Here rather than as a `railway run` one-shot: a second process writing this file while the collector is live means
 * a multi-second write transaction against a 10 s busy_timeout, and the cost of losing that race is dropped launches,
 * which are unrecoverable. It runs before the feed is constructed and before this run's row is written, so the merge
 * sees a quiet database and the coverage it imports is already in place when the run begins.
 *
 * Gated twice: only when SEED_PATH points at a file, and only when no `seed_merges` row matches that file's size and
 * hash. A redeploy is therefore a no-op, and a collector in a crash-loop cannot merge twice - which is a claim about
 * the second boot, so it is tested on the second boot (see the merge's own notes).
 *
 * A failure here must never take the collector down: being unseeded is a smaller problem than not collecting, and
 * every minute not collecting is a permanent hole in the archive.
 */
if (process.env.SEED_PATH) {
  try {
    const { mergeSeed } = await import("./mergeseed.ts");
    const { existsSync } = await import("node:fs");
    if (!existsSync(process.env.SEED_PATH)) log(`[seed] SEED_PATH=${process.env.SEED_PATH} does not exist, skipping`);
    else {
      const r = await mergeSeed(db, process.env.SEED_PATH, { log });
      if (r.skipped) log(`[seed] ${r.reason}`);
      else log(`[seed] inherited ${Object.entries(r.after).map(([t, n]) => `${t} ${n - r.before[t]}`).join(", ")}`);
    }
  } catch (e) {
    log(`[seed] MERGE FAILED, continuing without it: ${(e as Error).message}`);
  }
}

const runId = (db.prepare("INSERT INTO runs (started_at) VALUES (?)").run(Date.now()) as any).lastInsertRowid;
const feed = config.tradeSource === "pumpportal" ? new PumpPortalFeed(config.pumpportalApiKey) : new RpcFeed(config.solanaWsUrl);
const tracker = new Tracker({ watchMinutes: config.watchMinutes, deadAfterSeconds: config.deadAfterSeconds, watchMaxMinutes: config.watchMaxMinutes });
const broker = new PaperBroker(db, tracker, strategies, config);
const botNotify = telegramNotifier(config.telegramBotToken, config.telegramChatId);
let selfNotify: ((text: string) => void) | null = null;
/** System alerts: the collector stopped ingesting, or started again. Always sent. */
const notify = (text: string) => {
  botNotify(text);
  selfNotify?.(text);
};
/**
 * Per-token signal alerts. Silent unless ALERT_SIGNALS=1 — see `config.alertSignals` for why the default is off.
 * The signals are still computed, still written to the `signals` table, and still visible in the log; what stops is
 * the interruption. Muting these is what keeps the two alerts above worth reading.
 */
const signalNotify = (text: string) => {
  if (config.alertSignals) notify(text);
};
const trades = new TradeWriter(db);
for (const r of db.prepare("SELECT DISTINCT creator FROM tokens WHERE graduated=1 AND creator!='' AND created_at >= ?").all(Date.now() - 7 * 86400_000) as { creator: string }[])
  tracker.gradCreators.add(r.creator);
log(`[db] ${tracker.gradCreators.size} creator wallet(s) with a prior graduation loaded for momentum`);
try {
  const recovered = recoverOrphans(db);
  if (recovered) log(`[db] recovered ${recovered} token(s) left unfinalized by a previous run`);
} catch (e) {
  log("[db] orphan recovery failed:", (e as Error).message);
}

function loadSmartWallets(): void {
  const rows = db.prepare("SELECT wallet FROM smart_wallets ORDER BY score DESC LIMIT 100").all() as { wallet: string }[];
  broker.smartWallets = new Set(rows.map((r) => r.wallet));
  const teams = db.prepare("SELECT team_id, wallet FROM wallet_teams").all() as { team_id: number; wallet: string }[];
  broker.walletTeams = new Map(teams.map((r) => [r.wallet, r.team_id]));
}
loadSmartWallets();
setInterval(loadSmartWallets, 10 * 60_000);
/** operator farms from `npm run clusters`: wallet -> cluster name */
function loadOperatorWallets(): void {
  try {
    const rows = db.prepare("SELECT wallet, cluster FROM operator_wallets WHERE cluster IS NOT NULL").all() as { wallet: string; cluster: string }[];
    broker.operatorWallets = new Map(rows.map((r) => [r.wallet, r.cluster]));
    const pol = db.prepare("SELECT cluster, policy FROM operator_policy").all() as { cluster: string; policy: string }[];
    broker.operatorPolicy = new Map(pol.map((r) => [r.cluster, r.policy]));
  } catch { broker.operatorWallets = new Map(); }
}
loadOperatorWallets();
setInterval(loadOperatorWallets, 10 * 60_000);

/** Bring back a token the monitor dropped (or never saw) so operator activity on it can be followed. Aged from now: the tracker
 *  finalizes anything older than the 6 h cap at the next tick, and the real creation time is kept in the database row. */
function restoreToken(mint: string, now: number, symbol = "?"): TokenState {
  let t = tracker.tokens.get(mint);
  if (t && t.finalized) { tracker.tokens.delete(mint); t = undefined; }
  if (t) return t;
  const prior = db.prepare("SELECT name, symbol, created_at, late_discovery, graduated, graduated_at, pool, launch_price, dev_pct, unique_buyers, creator FROM tokens WHERE mint = ?").get(mint) as any;
  t = tracker.ensureLate(mint, now, symbol !== "?" ? symbol : prior?.symbol ?? "?", prior ? { createdAt: now, graduated: !!prior.graduated, graduatedAt: prior.graduated_at ?? null, pool: prior.pool ?? null, launchPrice: prior.launch_price ?? 0, name: prior.name ?? undefined, pumpCreated: !prior.late_discovery } : undefined);
  if (prior) {
    // carry the curve-phase facts the organic gate needs: a restored token starts with an empty buyer set
    if (typeof prior.dev_pct === "number") t.devPct = prior.dev_pct;
    if (typeof prior.unique_buyers === "number" && t.buyersAtGrad === null) t.buyersAtGrad = prior.unique_buyers;
    if (prior.creator && !t.creator) t.creator = prior.creator;
  }
  // a curve we never tracked can still have a known pool: its CreatePoolEvent was recorded when it graduated
  if (!t.pool) {
    const pm = db.prepare("SELECT pool FROM pool_map WHERE mint = ? ORDER BY created_at DESC LIMIT 1").get(mint) as { pool: string } | undefined;
    if (pm) { t.pool = pm.pool; t.graduated = true; t.graduatedAt = t.graduatedAt ?? now; }
  }
  if (t.pool) { poolToMint.set(t.pool, mint); void checkVault(mint); }
  if (t.decimals < 0) void lookupDecimals(mint);
  if (!prior) void lookupMeta(mint);
  return t;
}

/** Record what an operator-cluster wallet just did on a token; alert on the buyout and when the farm shows up in force. */
function noteOperator(t: TokenState, wallet: string, cluster: string, side: "buy" | "sell", sol: number, venue: "curve" | "amm", px: number, now: number): void {
  let a = broker.operatorActivity.get(t.mint);
  if (!a) { a = { firstAt: now, priceAtFirst: px > 0 ? px : null, buyout: null, buys: new Map(), solIn: 0, solOut: 0, lastBuyAt: 0, clusters: new Set(), notified: false, recent: [] }; broker.operatorActivity.set(t.mint, a); }
  a.clusters.add(cluster);
  t.watchCapMs = 24 * 3600_000; // a hold farm sells hours after graduation (Simba: 7 h and counting); the default 6 h cap would close first
  a.recent.push({ ts: now, side, sol });
  while (a.recent.length && a.recent[0].ts < now - 2 * 3600_000) a.recent.shift();
  if (a.priceAtFirst === null && px > 0) a.priceAtFirst = px;
  let event: string | null = null;
  if (side === "buy") {
    const b = a.buys.get(wallet) ?? { sol: 0, first: now, last: now, cluster };
    b.sol += sol; b.last = now; a.buys.set(wallet, b); a.solIn += sol; a.lastBuyAt = now;
    if (venue === "curve" && sol >= 40 && !a.buyout) { a.buyout = { wallet, sol, ts: now, cluster }; event = `buyout ${sol.toFixed(1)} SOL on the curve`; }
    else if (!a.notified && a.buys.size >= 3) { a.notified = true; event = `${a.buys.size} cluster wallets buying (${a.solIn.toFixed(1)} SOL)`; }
  } else a.solOut += sol;
  if (event) {
    log(`[cluster] ${cluster} ${event} on ${t.symbol} ${short(t.mint)} (${venue}${t.graduated ? ", graduated" : ""})`);
    signalNotify(`🕸 operator cluster ${cluster}: ${event}\n${t.symbol} https://pump.fun/coin/${t.mint}`);
    db.prepare("INSERT INTO signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)").run("cluster", `cluster:${cluster}`, t.mint, t.symbol, a.buyout && event.startsWith("buyout") ? "buyout" : "amm-accumulation", `${event}; ${venue} price ${px}`, `https://pump.fun/coin/${t.mint}`, now, now);
  }
}
/** a token operator wallets touched in the last 2 h counts as open interest: the pool can take minutes to start printing after a buyout,
 *  and the dead-token rule deleted Simba (FC9BqG buyout 07:04 UTC 5 Sep, 46x seven hours later) before its first AMM trade */
function operatorInterest(mint: string): boolean {
  const a = broker.operatorActivity.get(mint);
  return !!a && Date.now() - Math.max(a.firstAt, a.lastBuyAt) < 2 * 3600_000;
}
/** name a restored token we never saw launch (pump.fun API), so alerts and the report do not say "?" */
async function lookupMeta(mint: string): Promise<void> {
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
    if (!res.ok) return;
    const j: any = await res.json();
    const t = tracker.tokens.get(mint);
    if (!t || typeof j?.symbol !== "string") return;
    if (t.symbol === "?" || !t.symbol) t.symbol = j.symbol;
    if (t.name === "?" || !t.name) t.name = j.name ?? j.symbol;
    if (!t.creator && typeof j.creator === "string") t.creator = j.creator;
    if (!t.pool && typeof j.pump_swap_pool === "string") setPool(mint, j.pump_swap_pool);
    upsertToken(db, t);
  } catch {}
}
const poolMintCache = new Map<string, { mint: string | null; at: number }>();
/** PumpSwap Pool account: base_mint at byte 43 (verified against the Squads pool). Rare: only for cluster-wallet trades on unknown pools. */
async function poolMint(pool: string): Promise<string | null> {
  const c = poolMintCache.get(pool);
  if (c && (c.mint || Date.now() - c.at < 10 * 60_000)) return c.mint;
  let mint: string | null = null;
  try {
    const r = await rpcHttpCall("getAccountInfo", [pool, { encoding: "base64" }], 10_000);
    const b = r?.value?.data?.[0] ? Buffer.from(r.value.data[0], "base64") : null;
    if (b && b.length >= 107) mint = base58(b.subarray(43, 75));
  } catch {}
  poolMintCache.set(pool, { mint, at: Date.now() });
  return mint;
}

let seen = 0;
/** Pre-launch heads-ups from watched accounts: "$TICKER" posted before any matching mint exists. */
/**
 * A single large buy on a curve we are NOT tracking is, by construction, a buyout of a dormant curve:
 * every launch is tracked from creation, so an untracked mint is one we already dropped (>= 6 h old) or
 * never saw (launched before this monitor, or days/weeks ago). This is the event the verified winners came
 * from (Kshama, Squads, Simba, Axolotl, onoda) and until now it was only detected when the buyer's wallet
 * happened to already be in operator_wallets — which, measured over 72 h, was 13 of 988 buyouts.
 * The pump.fun feed already carries every trade on every curve; this stops throwing them away.
 */
const BUYOUT_MIN_SOL = Number(process.env.BUYOUT_MIN_SOL || 40);
const seenBuyout = new Set<string>();
/**
 * Wallets caught doing a buyout without being in operator_wallets. They must keep being followed after the buy, or the
 * `farm-sell` exit is blind: it fires on cluster wallets selling, and a wallet that is not in the loaded cluster map
 * never reaches noteOperator again. Found 2026-09-06 on 8UfkYXd2… — five 85 SOL buyouts, 17.8 SOL bought on the AMM
 * against 421.1 SOL sold, i.e. a pure distributor — while cluster-follow held two positions alongside it with no exit.
 */
const blindOperators = new Set<string>();
/**
 * The slow graduation. Of 19 reconstructed organic $1M+ winners, only 4 graduated through an 85 SOL buyout; the other
 * 15 filled their curve gradually, and several took days (ZTH 6 d, SOL777 4 d, WSOLP 7.6 d). The tracker drops a token
 * after 6 h, so a curve completing days after launch was invisible whatever its size. Any untracked curve within reach
 * of graduation is therefore worth restoring: vSol >= this, against ~115 at completion.
 */
const LATE_GRAD_VSOL = Number(process.env.LATE_GRAD_VSOL || 100);
/** Peak vSOL across reconstructed curves clusters hard at 110-120 (1,578 of them), so graduation is ~115 as modelled.
 *  A curve reading far above that is a drained or non-standard one still trading, not a token about to graduate. */
const LATE_GRAD_VSOL_MAX = Number(process.env.LATE_GRAD_VSOL_MAX || 140);
const seenLateGrad = new Set<string>();

const expectations = new Map<string, { account: string; url: string; postedAt: number }>();
const EXPECTATION_TTL_MS = 6 * 3600_000;
const watchedAccounts = new Set<string>();
function recordKolSignal(t: import("./tracker.ts").TokenState, account: string, kind: string, url: string, postedAt: number, now: number) {
  t.kolSignals++;
  db.prepare("INSERT INTO signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    "matcher", account, t.mint, t.symbol, kind, "", url, postedAt, now,
  );
  log(`[kol] @${account} ${kind} → ${t.symbol} ${short(t.mint)} (lead ${((now - postedAt) / 60000).toFixed(1)}m)`);
  signalNotify(`🎯 @${account} ${kind}: ${t.symbol} launched\nhttps://pump.fun/coin/${t.mint}`);
  broker.evaluateEntries(t, now, true);
  upsertToken(db, t);
}
const realized = new Map<string, { n: number; pnl: number; wins: number }>();
for (const s of strategies) realized.set(s.name, { n: 0, pnl: 0, wins: 0 });

// ---------- launches ----------
/**
 * The last few minutes of launches, in memory, for the live wall.
 *
 * Deliberately a ring and not a query. "What launched in the last two minutes" is answerable from the database, but
 * only by polling it on a timer from another service, and the answer would be as old as the poll. This is the same
 * event the collector already handles to record the launch — the wall shows what the archive saw, at the moment it
 * saw it, or it is not a live wall.
 *
 * Bounded and lossy on purpose: at ~25,000 launches a day this holds a couple of minutes and drops the rest. Nothing
 * here is a record — every one of these is written to `tokens` by the line below, and the ring is a view of the last
 * moments of that, thrown away on restart. A consumer that misses events has missed nothing it cannot look up.
 */
const RECENT_MAX = 400;
const recent: { mint: string; symbol: string; name: string; creator: string; at: number; devPct: number; sig: string | null }[] = [];

feed.on("create", (e, now) => {
  seen++;
  const t = tracker.onCreate(e, now);
  recent.push({ mint: e.mint, symbol: e.symbol ?? "?", name: e.name ?? "", creator: e.traderPublicKey ?? "",
    at: now, devPct: t.devPct, sig: e.signature ?? null });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  feed.subscribeTrades(e.mint);
  broker.evaluateEntries(t, now);
  upsertToken(db, t);
  if (e.initialBuy > 0)
    trades.push({ mint: e.mint, wallet: e.traderPublicKey, side: "buy", sol: e.solAmount, tokens: e.initialBuy, price: t.launchPrice, ts: now, slot: e.slot ?? 0, sig: e.signature, ageMs: 0, buyerRank: 0, isDev: true });
  // 1) a watched account pre-announced this ticker
  const exp = expectations.get(e.symbol.toUpperCase());
  if (exp && now - exp.postedAt <= EXPECTATION_TTL_MS) {
    expectations.delete(e.symbol.toUpperCase());
    recordKolSignal(t, exp.account, "pre-announced", exp.url, exp.postedAt, now);
  }
  void fetchMeta(e.uri).then((meta) => {
    if (!meta) return;
    t.meta = meta;
    if (t.finalized) return;
    // 2) the token's own metadata links to a watched account's profile or tweet
    const m = meta.twitter?.match(/(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/);
    if (m && watchedAccounts.has(m[1].toLowerCase()) && t.kolSignals === 0) recordKolSignal(t, m[1], "metadata-link", meta.twitter!, now, Date.now());
    else upsertToken(db, t);
  });
});

feed.on("trade", (e, now) => {
  const cluster = broker.operatorWallets.get(e.traderPublicKey) ?? (blindOperators.has(e.traderPublicKey) ? "unknown" : undefined);
  const untracked = !tracker.tokens.has(e.mint);
  // detect the operator by what it does, not by whether we already know its wallet: farms burn a fresh wallet per buyout
  const blindBuyout = untracked && e.txType === "buy" && e.solAmount >= BUYOUT_MIN_SOL && !seenBuyout.has(e.mint);
  const lateGrad = untracked && !blindBuyout && e.vSolInBondingCurve >= LATE_GRAD_VSOL && e.vSolInBondingCurve <= LATE_GRAD_VSOL_MAX && !seenLateGrad.has(e.mint);
  if (cluster && untracked) restoreToken(e.mint, now); // a farm wallet touching a token we dropped: follow it again
  else if (blindBuyout || lateGrad) restoreToken(e.mint, now);
  const t = tracker.onTrade(e, now);
  if (!t) return;
  if (blindBuyout) {
    seenBuyout.add(e.mint);
    // restoreToken ages a token from discovery, so t.createdAt is "now"; the real launch time is the stored row
    const born = (db.prepare("SELECT created_at FROM tokens WHERE mint = ?").get(e.mint) as { created_at: number } | undefined)?.created_at;
    const ageH = born ? (now - born) / 3600_000 : null;
    log(`[buyout] ${e.solAmount.toFixed(1)} SOL took the curve of ${t.symbol} ${short(e.mint)} by ${short(e.traderPublicKey)} (${ageH === null ? "age unknown, never seen" : `dormant ${ageH.toFixed(1)} h`}, restored)`);
    signalNotify(`💰 curve buyout ${e.solAmount.toFixed(0)} SOL — ${t.symbol}\nwallet ${e.traderPublicKey}\nhttps://pump.fun/coin/${e.mint}`);
    db.prepare("INSERT INTO signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("buyout", `wallet:${e.traderPublicKey}`, e.mint, t.symbol, "curve-buyout", `${e.solAmount.toFixed(1)} SOL, ${ageH === null ? "age unknown" : `dormant ${ageH.toFixed(1)} h`}`, `https://pump.fun/coin/${e.mint}`, now, now);
    blindOperators.add(e.traderPublicKey);
    noteOperator(t, e.traderPublicKey, cluster ?? "unknown", "buy", e.solAmount, "curve", price(t.curve), now);
  }
  if (lateGrad) {
    seenLateGrad.add(e.mint);
    t.watchCapMs = Math.max(t.watchCapMs ?? 0, 12 * 3600_000);
    log(`[lategrad] ${t.symbol} ${short(e.mint)} curve at ${e.vSolInBondingCurve.toFixed(0)} vSOL and not tracked — restored`);
    db.prepare("INSERT INTO signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("lategrad", "curve-scan", e.mint, t.symbol, "late-graduation", `curve at ${e.vSolInBondingCurve.toFixed(1)} vSOL`, `https://pump.fun/coin/${e.mint}`, now, now);
  }
  if (cluster) noteOperator(t, e.traderPublicKey, cluster, e.txType === "buy" ? "buy" : "sell", e.solAmount, "curve", price(t.curve), now);
  trades.push({
    mint: e.mint, wallet: e.traderPublicKey, side: e.txType, sol: e.solAmount, tokens: e.tokenAmount, price: price(t.curve), ts: now,
    slot: e.slot ?? 0, sig: e.signature, ageMs: now - t.createdAt, buyerRank: t.lastTrade?.buyerRank ?? null, isDev: e.traderPublicKey === t.creator,
  });
  broker.evaluateEntries(t, now, t.kolSignals > 0);
  broker.update(t, now);
});

feed.on("status", (m) => log("[feed]", m));

tracker.on("preannounced", (t, k) => {
  log(`[kol] PRE-ANNOUNCED launch: ${t.symbol} ${short(t.mint)} was posted ${k}x before it existed — evaluating entry at creation`);
  signalNotify(`🚨 pre-announced launch: ${t.symbol} — mint was posted before launch\nhttps://pump.fun/coin/${t.mint}`);
  db.prepare("INSERT INTO signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)").run("matcher", "pre-announced", t.mint, t.symbol, "pre-announced-mint", "", "", Date.now(), Date.now());
  broker.evaluateEntries(t, Date.now(), true);
});
tracker.on("checkpoint", (t) => {
  upsertToken(db, t);
  broker.onTokenCheckpoint(t);
});
tracker.on("finalize", (t) => {
  broker.closeForToken(t, Date.now(), "watch-window-ended");
  upsertToken(db, t);
  feed.unsubscribeTrades(t.mint);
  trades.flush();
  const entered = broker.everEntered(t.mint, ["kol-signal", "smart-wallet", "team-wallet", "grad-runner", "survivor-trail", "early-momentum", "strict-momentum"]);
  const interesting = t.kolSignals > 0 || entered || (t.graduated && t.lastPrice >= 2 * (t.gradPrice ?? Infinity));
  try {
    finalizeTokenTrades(db, t, { keepAll: interesting, keepCurve: t.graduated || t.buyers.size >= 8 || (t.launchPrice > 0 && t.peakPrice >= 2 * t.launchPrice) ? 400 : 100, keepAmm: t.graduated ? 6000 : 1500 }); // graduated tokens keep enough AMM trades for the post-graduation replay (npm run ammreplay)
  } catch (e) {
    log("[db] finalize failed for", t.mint, (e as Error).message);
  }
});

// ---------- PumpSwap: post-graduation trades ----------
const poolToMint = new Map<string, string>();
const savePool = db.prepare("INSERT OR IGNORE INTO pool_map (pool, mint, created_at) VALUES (?,?,?)");
// a restart used to lose every pool it had learned and re-discover them one per 400 ms through the lookup queue
for (const r of db.prepare("SELECT pool, mint FROM pool_map").all() as { pool: string; mint: string }[]) poolToMint.set(r.pool, r.mint);
for (const r of db.prepare("SELECT pool, mint FROM tokens WHERE pool IS NOT NULL").all() as { pool: string; mint: string }[]) poolToMint.set(r.pool, r.mint);
log(`[amm] ${poolToMint.size} known pools preloaded`);
const amm = config.pumpswapWsUrl ? new PumpSwapFeed(config.pumpswapWsUrl) : null;
let ammMatched = 0;
const poolLookupQueue: string[] = [];
const rpcHttp = config.solanaWsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
async function lookupDecimals(mint: string): Promise<void> {
  const t = tracker.tokens.get(mint);
  if (!t || t.decimals >= 0) return;
  try {
    const res = await fetch(rpcHttp, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] }), signal: AbortSignal.timeout(6000) });
    const j: any = await res.json();
    const d = j?.result?.value?.decimals;
    if (typeof d === "number") t.decimals = d;
  } catch {}
}
function setPool(mint: string, pool: string): void {
  if (mint === WSOL_MINT) return;
  poolToMint.set(pool, mint);
  savePool.run(pool, mint, Date.now());
  const t = tracker.tokens.get(mint);
  if (!t || t.pool) return;
  t.pool = pool;
  void checkVault(mint);
}
async function lookupPool(mint: string): Promise<void> {
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } });
    if (res.ok) {
      const j: any = await res.json();
      if (typeof j?.pump_swap_pool === "string") { setPool(mint, j.pump_swap_pool); return; }
    }
  } catch {}
  // pump.fun often omits pump_swap_pool for graduated tokens; DexScreener's pumpswap pair address is the pool
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const j: any = await res.json();
    const pair = (j?.pairs ?? []).find((p: any) => p?.dexId === "pumpswap" && typeof p?.pairAddress === "string" && p?.baseToken?.address === mint && p?.quoteToken?.address === WSOL_MINT);
    if (pair) setPool(mint, pair.pairAddress);
  } catch {}
}
const extPriceRejected = new Set<string>();
/** Ground truth for a pool: its vault balances. Sets the reference price the decoded trades must reconcile with. */
async function checkVault(mint: string): Promise<void> {
  const t = tracker.tokens.get(mint);
  if (!t?.pool) return;
  const r = await poolReserves(t.pool, mint);
  if (!r) return;
  // a pool still being seeded (migration in progress) or drained to dust has meaningless reserves: a pump.fun migration deposits
  // ~200M tokens and ~85 SOL, so anything under 1M tokens or 0.5 SOL is not a price. Also refuse a vault price above 1000x the
  // graduation price unless live AMM trades agree (two kol-signal trades printed 800,000x from a freshly created pool on 4 Sep).
  if (r.baseTokens < 1e6 || r.quoteSol < 0.5) return;
  if (r.priceSol > 1000 * (115 / 279_900_000) && t.ammBuys + t.ammSells === 0) { if (!extPriceRejected.has(mint)) { extPriceRejected.add(mint); log(`[vault] rejected implausible vault price for ${t.symbol} ${short(mint)}: ${r.priceSol.toExponential(3)} (${r.quoteSol.toFixed(1)} SOL / ${r.baseTokens.toExponential(2)} tokens)`); } return; }
  t.vaultPrice = r.priceSol;
  t.vaultSol = r.quoteSol;
  t.vaultAt = Date.now();
  if (t.ammTrusted === false || t.ammBuys + t.ammSells === 0) {
    // no trustworthy trade stream: price from the vault itself (a pool exists, so the token has graduated)
    const now = Date.now();
    const u = tracker.setExternalPrice(mint, r.priceSol, now);
    if (u) { broker.evaluateEntries(u, now, u.kolSignals > 0); broker.update(u, now); }
  }
}
/** a fast, dev-funded graduation with few buyers: the grad-runner strategy's candidate set, priced externally after graduation */
const gradCandidate = (t: import("./tracker.ts").TokenState) =>
  t.graduated && !t.lateDiscovery && t.graduatedAt !== null && t.graduatedAt - t.createdAt <= 120_000 && t.devInitialSol >= 5 && (t.buyersAtGrad ?? t.buyers.size) <= 40 && !t.devSold && Date.now() - t.graduatedAt <= 50 * 60_000;
setInterval(() => {
  for (const t of tracker.tokens.values()) {
    if (t.finalized || !t.pool) continue;
    // onAmmTrade discards every trade while vaultPrice or decimals are unknown, and both lookups were fire-and-forget:
    // one failed RPC call left a token restored by a buyout or a movement silently mute for its whole watch. Retry them.
    if (t.vaultPrice === null) { void checkVault(t.mint); continue; }
    if (t.decimals < 0) { void lookupDecimals(t.mint); continue; }
    if (t.ammTrusted === false || t.kolSignals > 0 || broker.hasOpenPosition(t.mint) || (t.ammBuys + t.ammSells === 0 && gradCandidate(t)) || (t.ammTrusted === true && t.lastPrice >= 2.5 * (115 / 279_900_000))) void checkVault(t.mint); // survivors in the band: keep vault SOL current for the liquidity gate
  }
}, 60_000);
setInterval(() => {
  const mint = poolLookupQueue.shift();
  if (mint) void lookupPool(mint);
}, 400);
/**
 * Movement detector over the WHOLE PumpSwap stream (2026-09-05).
 * The AMM websocket delivers every trade on every pool — ~5.3 M events per run — but only trades on a token still in
 * the tracker were used, about 2 % of them. A token we dropped (the 6 h cap) that starts running hours later was
 * therefore invisible, which is precisely the shape of the verified winners: the run happens on PumpSwap, hours after
 * the curve. This keeps a small rolling window per pool, with no database writes, and raises a signal when real buying
 * lifts a price. On a hit the token is restored, so the pricing, vault and strategy machinery pick it up as usual.
 */
const MOVE_WINDOW_MS = 5 * 60_000;
const MOVE_MIN_NET_SOL = Number(process.env.MOVE_MIN_NET_SOL || 25);
const MOVE_MIN_BUYERS = Number(process.env.MOVE_MIN_BUYERS || 8);
const MOVE_MIN_LIFT = Number(process.env.MOVE_MIN_LIFT || 1.5);
/**
 * Anti-wash gates. The pool-capital wash of 3 Sep defeats a price-and-volume test by design: the operator buys ~99 % of
 * its own pool with thousands of its own SOL, so the print is enormous and nobody can sell into it. Its signature in the
 * first live hour of this detector was unmistakable — TRUMPCARD 388x, HOOD 522x, PONS 333x, each "+1500-1900 SOL net
 * from 8 buyers" (the factory tickers of `npm run buyouts`). Two gates kill it without touching a real run: nothing
 * genuine moves 20x in five minutes, and a real move is not one wallet's money.
 */
const MOVE_MAX_LIFT = Number(process.env.MOVE_MAX_LIFT || 20);
// Tightened from 0.6 on the first 19 graded signals, where the top-buyer share was cleanly bimodal with nothing
// between them: crowd moves at 4-8 % (PILL, zolana, SOULANA, STONK) and single-wallet moves at 53-60 % (HODL 58 % on
// 9 buyers, ZCAT 60 %, PONS 58 %). 0.6 sat at the top edge of the bad cluster; 0.4 sits in the empty gap.
const MOVE_MAX_TOP_SHARE = Number(process.env.MOVE_MAX_TOP_SHARE || 0.4);
const MOVE_COOLDOWN_MS = 60 * 60_000;
type MoveTrade = { ts: number; sol: number; side: "buy" | "sell"; price: number; user: string };
const movement = new Map<string, MoveTrade[]>();
const movementFired = new Map<string, number>();

function noteMovement(tr: { pool: string; user: string; side: "buy" | "sell"; quoteSol: number; price: number }, now: number): void {
  if (!(tr.quoteSol > 0 && tr.quoteSol < 5000) || !(tr.price > 0)) return; // the misaligned event layout, not a trade
  let w = movement.get(tr.pool);
  if (!w) { w = []; movement.set(tr.pool, w); }
  w.push({ ts: now, sol: tr.quoteSol, side: tr.side, price: tr.price, user: tr.user });
  while (w.length && w[0].ts < now - MOVE_WINDOW_MS) w.shift();
  if (w.length < MOVE_MIN_BUYERS) return;
  const last = movementFired.get(tr.pool) ?? 0;
  if (now - last < MOVE_COOLDOWN_MS) return;
  let net = 0, buyVol = 0;
  const buyers = new Set<string>();
  const perBuyer = new Map<string, number>();
  for (const t of w) {
    net += t.side === "buy" ? t.sol : -t.sol;
    if (t.side !== "buy") continue;
    buyers.add(t.user); buyVol += t.sol;
    perBuyer.set(t.user, (perBuyer.get(t.user) ?? 0) + t.sol);
  }
  if (net < MOVE_MIN_NET_SOL || buyers.size < MOVE_MIN_BUYERS) return;
  const lift = w[0].price > 0 ? tr.price / w[0].price : 0;
  if (lift < MOVE_MIN_LIFT || lift > MOVE_MAX_LIFT) return;
  const topShare = buyVol > 0 ? Math.max(...perBuyer.values()) / buyVol : 1;
  if (topShare > MOVE_MAX_TOP_SHARE) return; // one wallet buying its own pool
  movementFired.set(tr.pool, now);
  const known = poolToMint.get(tr.pool);
  const act = (mint: string) => {
    if (mint === WSOL_MINT) return; // the quote side of the pair, not a token
    // a token can have more than one pool; the cooldown has to hold per token as well, or one run alerts repeatedly
    const lastForMint = movementFired.get(mint) ?? 0;
    if (now - lastForMint < MOVE_COOLDOWN_MS) return;
    movementFired.set(mint, now);

    const t = restoreToken(mint, now);
    // always map the pool that is actually trading: a stale tokens.pool row would otherwise leave these trades unattributed
    poolToMint.set(tr.pool, mint);
    savePool.run(tr.pool, mint, now);
    if (!t.pool) t.pool = tr.pool;
    void checkVault(mint);
    if (!t.graduated) { t.graduated = true; t.graduatedAt = t.graduatedAt ?? now; }
    t.watchCapMs = Math.max(t.watchCapMs ?? 0, 12 * 3600_000);
    log(`[movement] ${t.symbol} ${short(mint)} +${net.toFixed(0)} SOL net from ${buyers.size} buyers, ${lift.toFixed(1)}x in 5 min (top buyer ${(topShare * 100).toFixed(0)} %)`);
    signalNotify(`🚀 movement: ${t.symbol} ${lift.toFixed(1)}x in 5 min on +${net.toFixed(0)} SOL from ${buyers.size} buyers\nhttps://pump.fun/coin/${mint}`);
    db.prepare("INSERT INTO signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("movement", "amm-scan", mint, t.symbol, "amm-movement", `+${net.toFixed(1)} SOL net, ${buyers.size} buyers, ${lift.toFixed(2)}x in 5 min, top buyer ${(topShare * 100).toFixed(0)}%`, `https://pump.fun/coin/${mint}`, now, now);
    broker.evaluateEntries(t, now);
  };
  if (known) act(known);
  else void poolMint(tr.pool).then((m) => { if (m) { poolToMint.set(tr.pool, m); savePool.run(tr.pool, m, now); act(m); } });
}
// the window map would otherwise hold every pool that ever traded
setInterval(() => {
  const cutoff = Date.now() - MOVE_WINDOW_MS * 3;
  for (const [pool, w] of movement) if (!w.length || w[w.length - 1].ts < cutoff) movement.delete(pool);
  for (const [pool, at] of movementFired) if (at < Date.now() - MOVE_COOLDOWN_MS * 2) movementFired.delete(pool);
}, 5 * 60_000);

if (amm) {
  amm.on("status", (m) => log("[amm]", m));
  amm.on("pool", (p) => {
    // record every pool, tracked or not: this event is the only free, exact pool -> mint pair, and a token restored
    // hours later (a dormant-curve buyout) then has a price immediately instead of waiting on the lookup queue
    if (p.baseMint !== WSOL_MINT) { poolToMint.set(p.pool, p.baseMint); savePool.run(p.pool, p.baseMint, Date.now()); }
    if (tracker.tokens.has(p.baseMint)) {
      tracker.tokens.get(p.baseMint)!.pool = p.pool;
      void checkVault(p.baseMint);
    }
  });
  amm.on("trade", (tr, now, slot) => {
    const cluster = broker.operatorWallets.get(tr.user) ?? (blindOperators.has(tr.user) ? "unknown" : undefined);
    noteMovement(tr, now);
    const mint = poolToMint.get(tr.pool);
    if (!mint) {
      if (!cluster) return;
      if (!(tr.quoteSol > 0 && tr.quoteSol < 5000)) return; // one of the two PumpSwap event layouts misaligns amounts; a "958,397 SOL" buy is that, not a trade
      // a farm wallet trading a pool we do not know: resolve the pool's mint, restore the token, and count this trade
      void poolMint(tr.pool).then((m) => {
        if (!m) return;
        const t = restoreToken(m, now);
        if (!t.pool) { t.pool = tr.pool; poolToMint.set(tr.pool, m); void checkVault(m); }
        if (!t.graduated) { t.graduated = true; t.graduatedAt = t.graduatedAt ?? now; }
        noteOperator(t, tr.user, cluster, tr.side, tr.quoteSol, "amm", tr.price, now);
      });
      return;
    }
    const t = tracker.onAmmTrade(mint, tr, now);
    if (!t) return;
    if (cluster) noteOperator(t, tr.user, cluster, tr.side, tr.quoteSol, "amm", tr.price, now);
    ammMatched++;
    trades.push({ mint, wallet: tr.user, side: tr.side, sol: tr.quoteSol, tokens: tr.baseTokens, price: tr.price, ts: now, slot, sig: "", ageMs: now - t.createdAt, buyerRank: null, isDev: tr.user === t.creator, venue: "amm" });
    broker.evaluateEntries(t, now, t.kolSignals > 0);
    broker.update(t, now);
  });
  amm.connect();
}
// when a token graduates (or is discovered late), find its pool so AMM trades can be attributed
setInterval(() => {
  for (const t of tracker.tokens.values()) {
    if (t.finalized || t.pool !== null) continue;
    if ((t.graduated || t.lateDiscovery) && !poolLookupQueue.includes(t.mint) && poolLookupQueue.length < 200) poolLookupQueue.push(t.mint);
  }
}, 5000);

// ---------- paper broker ----------
broker.on("open", (p, t) => {
  log(`[${p.strategy}] BUY  ${t.symbol.padEnd(8)} ${short(t.mint)} age=${((p.openedAt - t.createdAt) / 1000).toFixed(0)}s mcap=${(t.curve.vSol / t.curve.vTokens * 1e9).toFixed(1)} SOL  ${p.reason}`);
  upsertToken(db, t);
  if (p.strategy !== "baseline-all") signalNotify(`📈 [${p.strategy}] paper BUY ${t.symbol} (${t.name})\n${p.reason}\nhttps://pump.fun/coin/${t.mint}`);
});
broker.on("partial", (p, t, x) => {
  log(`[${p.strategy}] BANK ${t.symbol.padEnd(8)} ${short(t.mint)} half out at ${fmtX(x.multiple)} (+${x.solOut.toFixed(4)} SOL realised), rest rides on flow`);
  signalNotify(`💰 [${p.strategy}] banked half of ${t.symbol} at ${fmtX(x.multiple)}`);
});
broker.on("close", (p, t, x) => {
  const r = realized.get(p.strategy)!;
  if (x.reason !== "shutdown") {
    r.n++;
    r.pnl += x.pnl;
    if (x.pnl > 0) r.wins++;
  }
  log(`[${p.strategy}] SELL ${t.symbol.padEnd(8)} ${short(t.mint)} ${fmtX(x.multiple)} pnl=${x.pnl >= 0 ? "+" : ""}${x.pnl.toFixed(4)} SOL  ${x.reason}  held=${((Date.now() - p.openedAt) / 1000).toFixed(0)}s`);
  upsertToken(db, t);
  if (p.strategy !== "baseline-all") signalNotify(`${x.pnl >= 0 ? "✅" : "❌"} [${p.strategy}] paper SELL ${t.symbol} ${fmtX(x.multiple)} (${x.reason})`);
});

// ---------- KOL twitter watcher ----------
const kols = loadKols(config.kolFile);
const provider =
  config.twitterProvider === "twitterapi" && config.twitterApiIoKey
    ? twitterApiIoProvider(config.twitterApiIoKey)
    : config.twitterProvider === "x" && config.xBearerToken
      ? xApiProvider(config.xBearerToken)
      : null;
let watcher: KolWatcher | null = null;
for (const k of kols) watchedAccounts.add(k.toLowerCase());
/** Shared handler for X and Telegram signals. */
const recentSignal = new Map<string, number>(); // account|mint -> last seen, to collapse repeats
function handleSignal(sourceName: string, s: KolSignal): void {
  const now = Date.now();
  const dedupeKey = `${s.account}|${s.mint ?? "$" + s.symbol}`;
  if (now - (recentSignal.get(dedupeKey) ?? 0) < 30 * 60_000) return; // same account, same token, within 30 min
  recentSignal.set(dedupeKey, now);
  let mint = s.mint;
  let symbol = s.symbol;
  if (!mint && symbol) {
    // match a $TICKER to a token launched recently; prefer the most-bought one
    const cands = [...tracker.tokens.values()].filter((t) => t.symbol.toUpperCase() === symbol && !t.finalized);
    cands.sort((a, b) => b.buyers.size - a.buyers.size);
    if (cands.length) mint = cands[0].mint;
  }
  db.prepare("INSERT INTO signals (source, account, mint, symbol, kind, text, url, posted_at, seen_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    sourceName, s.account, mint, symbol, s.kind, s.text.slice(0, 500), s.url, s.postedAt, now,
  );
  log(`[${sourceName}] ${s.account} ${s.kind} ${mint ? short(mint) : "$" + symbol} ${mint ? "" : "(no launch yet — will buy a matching launch within 6h)"}`);
  signalNotify(`🐦 ${s.account} posted ${s.kind}: ${mint ?? "$" + symbol}\n${s.url}`);
  if (!mint) {
    if (symbol) expectations.set(symbol, { account: s.account, url: s.url, postedAt: s.postedAt });
    return;
  }
  let t = tracker.tokens.get(mint);
  if (!t) {
    // a mint we tracked before (finished watch, evicted): restore its real age and pool so the entry is judged as an old token, not a 10-second-old launch
    const prior = db.prepare("SELECT name, symbol, created_at, late_discovery, graduated, graduated_at, pool, launch_price FROM tokens WHERE mint = ?").get(mint) as any;
    t = tracker.ensureLate(mint, now, symbol ?? prior?.symbol ?? "?", prior ? { createdAt: prior.created_at, graduated: !!prior.graduated, graduatedAt: prior.graduated_at ?? null, pool: prior.pool ?? null, launchPrice: prior.launch_price ?? 0, name: prior.name ?? undefined, pumpCreated: !prior.late_discovery } : undefined);
    if (prior) log(`[kol] ${short(mint)} was seen before (launched ${((now - prior.created_at) / 60_000).toFixed(0)} min ago${prior.graduated ? ", graduated" : ""}); restored`);
    if (t.pool) { poolToMint.set(t.pool, mint); void checkVault(mint); }
  }
  if (t.decimals < 0) void lookupDecimals(mint);
  t.kolSignals++;
  if (t.lateDiscovery) feed.subscribeTrades(mint); // price arrives with the first trade, entry evaluated then
  else broker.evaluateEntries(t, now, true);
  upsertToken(db, t);
}
/**
 * Having a key is not consent to spend it.
 *
 * This started whenever a provider was configured, which meant polling 37 timelines every 60 seconds — about 53,000
 * requests a day. It costs nothing today only because the account has no credits and every request 402s, so the
 * moment anyone tops it up this loop drains the balance before the targeted evidence search gets a single query.
 * That is the exact firehose DEPLOY.md already switched off: ~$390/month for kolSignals=0 and a strategy that
 * measured -13.8% over 543 entries.
 *
 * Presence of a credential must never be the thing that authorises spending it. X_KOL_WATCH=1 is the opt-in, and
 * default off means funding the account buys what someone actually asked for.
 */
if (provider && kols.length && process.env.X_KOL_WATCH === "1") {
  watcher = new KolWatcher(provider, kols, config.kolPollSeconds);
  watcher.on("status", (m) => log("[kol]", m));
  watcher.on("signal", (s) => handleSignal(provider.name, s));
  watcher.start();
} else {
  log(`[kol] watcher disabled (${!provider ? "no TWITTER_PROVIDER/key configured" : !kols.length ? "kols.txt is empty" : "X_KOL_WATCH is not 1 — a configured key is not permission to spend it"})`);
}
let street: StreetListener | null = null;
const buzz = new BuzzTracker({ windowMs: 10 * 60_000, baselineMs: 3 * 3600_000, minAuthors: config.buzzMinAuthors, minLift: config.buzzMinLift, cooldownMs: 60 * 60_000 });
const insertTweet = db.prepare(
  `INSERT OR IGNORE INTO tweets (id, author, followers, created_at, text, urls, query, mints, cashtags, hashtags, likes, retweets, views, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);
if (provider?.search && config.xListenQueries.length) {
  street = new StreetListener(provider, config.xListenQueries, config.xListenSeconds, config.xListenPages);
  street.on("status", (m) => log("[street]", m));
  street.on("signal", (s) => handleSignal("x-street", s));
  street.on("tweet", (t, query) => {
    const { mints, cashtags } = parseTweet(t);
    insertTweet.run(t.id, t.author, t.authorFollowers ?? null, t.createdAt, t.text.slice(0, 1000), t.urls.join(" "), query, mints.map((m) => m.mint).join(" "), cashtags.join(" "), parseTags(t.text).join(" "), t.likes ?? null, t.retweets ?? null, t.views ?? null, Date.now());
    buzz.ingest(t);
  });
  const muteFile = "data/x-mute.json";
  let muted: string[] = [];
  try {
    muted = JSON.parse(readFileSync(muteFile, "utf8"));
  } catch {}
  street.on("muted", () => writeFileSync(muteFile, JSON.stringify([...street!.muted], null, 1)));
  street.start(muted);
  if (muted.length) log(`[street] ${muted.length} account(s) muted from a previous run: ${muted.join(", ")}`);
  setInterval(() => {
    const now = Date.now();
    for (const b of buzz.evaluate(now)) {
      // a token with this symbol launched recently?  -> signal.  none yet? -> expectation (buy the first matching launch)
      const cands = [...tracker.tokens.values()].filter((t) => t.symbol.toUpperCase() === b.term && !t.finalized);
      cands.sort((x, y) => y.buyers.size - x.buyers.size);
      const matched = cands[0]?.mint ?? null;
      db.prepare(`INSERT INTO buzz (term, kind, authors, mentions, followers, prior_rate, matched_mint, sample_url, sample_text, seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        b.term, b.kind, b.authors, b.mentions, b.followers, b.priorMentionsPerWindow, matched, b.sampleUrl, b.sampleText.slice(0, 500), now,
      );
      log(`[buzz] ${b.kind === "cashtag" ? "$" : "#"}${b.term}: ${b.mentions} mentions by ${b.authors} accounts in 10m (baseline ${b.priorMentionsPerWindow.toFixed(1)}/10m)${matched ? ` → matches launch ${short(matched)}` : " → no launch yet, watching for one"}`);
      signalNotify(`📣 buzz ${b.kind === "cashtag" ? "$" : "#"}${b.term}: ${b.mentions} mentions / ${b.authors} accounts in 10m${matched ? ` — token exists https://pump.fun/coin/${matched}` : " — no token yet"}\n${b.sampleUrl}`);
      if (b.kind === "cashtag") handleSignal("x-buzz", { account: "x-buzz", kind: "cashtag", mint: matched, symbol: b.term, text: b.sampleText, url: b.sampleUrl, postedAt: now });
    }
  }, 60_000);
}

// ---------- external prices for tokens that trade on PumpSwap (graduated or called after graduation) ----------
async function pollExternalPrices(): Promise<void> {
  const want = [...tracker.tokens.values()].filter((t) => !t.finalized && (t.lateDiscovery || t.graduated) && (t.kolSignals > 0 || broker.hasOpenPosition(t.mint) || gradCandidate(t)));
  if (!want.length) return;
  for (let i = 0; i < want.length; i += 30) {
    const batch = want.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.map((t) => t.mint).join(",")}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j: any = await res.json();
      const best = new Map<string, { px: number; amm: boolean; implied: number | null; pool: string | null; symbol?: string; name?: string; pump: boolean }>();
      for (const p of j?.pairs ?? []) {
        const mint = p?.baseToken?.address;
        const px = Number(p?.priceNative);
        if (!mint || !(px > 0)) continue;
        if (p?.quoteToken?.address && p.quoteToken.address !== WSOL_MINT) continue; // priceNative/reserves are in the quote token; only SOL pairs are usable
        const amm = p.dexId !== "pumpfun";
        // the pair's own reserves imply a price; a quoted price that disagrees with them is a wash print or a decimals slip
        const liqBase = Number(p?.liquidity?.base), liqQuote = Number(p?.liquidity?.quote);
        const implied = liqBase > 0 && liqQuote > 0 ? liqQuote / liqBase : null;
        const pool = p.dexId === "pumpswap" && typeof p.pairAddress === "string" ? p.pairAddress : null;
        const cur = best.get(mint);
        const pump = (cur?.pump ?? false) || p.dexId === "pumpfun" || p.dexId === "pumpswap" || String(mint).endsWith("pump");
        // prefer the AMM pair (pumpswap/raydium) over the stale bonding-curve pair
        if (!cur || (amm && !cur.amm)) best.set(mint, { px, amm, implied, pool: pool ?? cur?.pool ?? null, symbol: p.baseToken?.symbol, name: p.baseToken?.name, pump });
        else { cur.pump = pump; if (!cur.pool && pool) cur.pool = pool; }
      }
      const now = Date.now();
      for (const [mint, b] of best) {
        const cur = tracker.tokens.get(mint);
        if (cur) {
          // borrow symbol/origin, and the pool address so the vault balances can price the token on-chain
          if (b.symbol && (cur.symbol === "?" || !cur.symbol)) cur.symbol = b.symbol;
          if (cur.pumpOrigin === null) cur.pumpOrigin = b.pump;
          if (!cur.pool && b.pool) setPool(mint, b.pool);
          if (cur.ammBuys + cur.ammSells > 0) continue; // live AMM trades are the truth
          if (cur.vaultPrice !== null) continue; // pool known: priced from its vault balances (checkVault), never from an indexer
        }
        if (!b.amm) continue; // still on the bonding curve: the curve feed prices it, and an indexer price must not mark it graduated
        if (b.implied === null || b.px / b.implied > 5 || b.px / b.implied < 0.2) {
          if (!extPriceRejected.has(mint)) { extPriceRejected.add(mint); log(`[ext] rejected DexScreener price for ${cur?.symbol ?? "?"} ${short(mint)}: ${b.px.toExponential(3)} vs liquidity-implied ${b.implied === null ? "unknown" : b.implied.toExponential(3)}`); }
          continue;
        }
        const t = tracker.setExternalPrice(mint, b.px, now, { symbol: b.symbol, name: b.name, pumpOrigin: b.pump });
        if (!t) continue;
        broker.evaluateEntries(t, now, t.kolSignals > 0);
        broker.update(t, now);
      }
      // tokens DexScreener does not know at all: mark as non-pump so they are not traded
      for (const t of batch) if (!best.has(t.mint) && t.lateDiscovery && t.pumpOrigin === null && Date.now() - t.createdAt > 120_000) t.pumpOrigin = false;
    } catch {}
  }
}
setInterval(() => void pollExternalPrices(), config.extPriceSeconds * 1000);

// ---------- Telegram channel watcher ----------
const channels = loadChannels(config.telegramChannelsFile);
let tg: TelegramWatcher | null = null;
if (telegramConfigured(config.telegramApiId, config.telegramApiHash) && channels.length) {
  for (const c of channels) watchedAccounts.add(`tg:${c.toLowerCase()}`);
  const client = createClient(config.telegramApiId, config.telegramApiHash);
  /**
   * Resume from the newest message already archived, per channel, so a restart does not silently skip everything
   * posted while this process was down. Returns 0 when we hold nothing for a channel, which starts it at "now" —
   * the only honest option, since we cannot claim coverage of a period we were not watching.
   */
  const resumeAt = db.prepare("SELECT MAX(msg_id) m FROM tg_messages WHERE channel = ?");
  tg = new TelegramWatcher(client, channels, (ch) => {
    try { return Number((resumeAt.get(ch) as any)?.m ?? 0); } catch { return 0; }
  });
  tg.on("status", (m) => log("[tg]", m));
  tg.on("signal", (s) => handleSignal("telegram", s));
  /**
   * Store every message, not only the ones that named a token.
   *
   * The promotion layer is unrecoverable in exactly the way the launch image is: it exists while it is posted and
   * not afterwards, and a deletion leaves nothing behind to find. The watcher has been reading these all along and
   * discarding the ones that did not match a mint, because it was built to trade on them.
   *
   * Retained, never published. This does not go into servicedb and must not: the published record carries what a
   * CREATOR claimed about their own launch, which is the subject's own statement and often the only surviving
   * evidence of an impersonation. A channel message is someone else's expression, and most people amplifying a
   * manufactured token were fooled by it rather than party to it — printing their words beside a fraud label under a
   * DOI that cannot be withdrawn would make an accusation this project has no basis to make.
   *
   * Retention is a legal decision and not a technical one. TELEGRAM_RETAIN_DAYS exists so counsel can set one;
   * unset means keep, which is the archival default and the assumption to challenge rather than to inherit. See
   * TELEGRAM.md.
   */
  const tgInsert = db.prepare(`INSERT INTO tg_messages
    (channel, msg_id, posted_at, fetched_at, sender, text, url, mints, cashtags, views, forwards, reply_to, edited_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(channel, msg_id) DO UPDATE SET
      -- An edit is a new fact about an existing message, not a correction to the record of what was first posted.
      -- Counters only ever climb; the original text stays.
      views = MAX(COALESCE(excluded.views,0), COALESCE(tg_messages.views,0)),
      forwards = MAX(COALESCE(excluded.forwards,0), COALESCE(tg_messages.forwards,0)),
      edited_at = COALESCE(tg_messages.edited_at, excluded.edited_at)`);
  /**
   * An open gap per channel, closed by the next message that arrives from it. Written whether or not the archive is
   * enabled: knowing we could not read a channel is not optional the way storing its messages is.
   */
  const gapOpen = db.prepare(`SELECT id FROM tg_gaps WHERE channel = ? AND to_at IS NULL ORDER BY id DESC LIMIT 1`);
  const gapStart = db.prepare(`INSERT INTO tg_gaps (channel, from_at, polls, reason) VALUES (?,?,1,?)`);
  const gapBump = db.prepare(`UPDATE tg_gaps SET polls = polls + 1, reason = ? WHERE id = ?`);
  const gapClose = db.prepare(`UPDATE tg_gaps SET to_at = ? WHERE id = ?`);
  tg.on("gap", (g) => {
    try {
      const open = gapOpen.get(g.channel) as { id: number } | undefined;
      if (open) gapBump.run(g.reason, open.id);
      else { gapStart.run(g.channel, g.at, g.reason); log(`[tg] coverage gap opened on @${g.channel}: ${g.reason}`); }
    } catch { /* never fatal */ }
  });
  let tgStored = 0;
  tg.on("message", (m: any) => {
    // Close any open gap for this channel first: a message arriving proves we can read it again, and that is true
    // whether or not we are storing what it said.
    try {
      const open = gapOpen.get(m.channel) as { id: number } | undefined;
      if (open) { gapClose.run(Date.now(), open.id); log(`[tg] coverage restored on @${m.channel}`); }
    } catch { /* never fatal */ }
    if (process.env.TELEGRAM_ARCHIVE !== "1") return;
    try {
      tgInsert.run(m.channel, m.id, m.postedAt ?? null, Date.now(), m.sender ?? null, m.text ?? null, m.url ?? null,
        m.mints?.length ? m.mints.join(",") : null, m.cashtags?.length ? m.cashtags.join(",") : null,
        m.views ?? null, m.forwards ?? null, m.replyTo ?? null, m.editedAt ?? null);
      if (++tgStored % 100 === 0) log(`[tg] ${tgStored} messages archived this run`);
    } catch (e) {
      // Never fatal: this runs inside the process whose only real obligation is to keep watching launches.
      log(`[tg] archive write failed: ${(e as Error).message}`);
    }
  });
  const tgRef = tg;
  tg.start()
    .then(() => {
      selfNotify = (text) => tgRef.sendSelf(text);
      tgRef.sendSelf(`🟢 pump-monitor started — watching ${channels.length} Telegram channels, ${kols.length} X accounts, ${strategies.length} paper strategies`);
    })
    .catch((e) => log("[tg] failed to start:", e.message));
} else {
  log(`[tg] watcher disabled (${channels.length ? "run `npm run telegram:login` first" : "channels.txt is empty"})`);
}

// ---------- clock ----------
setInterval(() => {
  const now = Date.now();
  broker.tick(now);
  tracker.tick(now, (m) => broker.hasOpenPosition(m) || operatorInterest(m));
}, 1000);

let lastSeenCount = 0, lastSeenChangeAt = Date.now(), staleAlerted = false;
setInterval(() => {
  const st = feed.getStats();
  if (seen !== lastSeenCount) {
    lastSeenCount = seen;
    lastSeenChangeAt = Date.now();
    if (staleAlerted) {
      staleAlerted = false;
      notify("🟢 launch feed recovered");
    }
  } else if (Date.now() - lastSeenChangeAt > 5 * 60_000 && !staleAlerted) {
    staleAlerted = true;
    log("[health] no launches for 5 minutes — feed may be down");
    notify("🔴 pump-monitor: no launches seen for 5 minutes (feed down?)");
  }
  // Heartbeat. The product's whole claim is "we watched this launch happen", so it has to be able to say when it was
  // NOT watching. stopped_at was only written on a clean shutdown, so a crash or a closed lid left a run open and its
  // downtime invisible. Refreshing it every minute makes coverage the union of run intervals and gaps everything else;
  // launch-time facts are unrecoverable, so an honest gap record is part of the archive, not an operational detail.
  //
  // It is stamped with the last moment a launch actually arrived, never with the current time. A timer only proves the
  // process is alive, and this project's characteristic failure is a process that is alive and deaf: on 2026-09-07
  // both websockets errored continuously and ingestion stopped dead at launches=4093 while the process stayed up and
  // looked healthy. An unconditional heartbeat records that window as observed, and a launch inside it is then
  // answered as watched — a clean result about a token nobody saw, which is the one error here that cannot be walked
  // back. Stamping the last arrival makes a deaf collector write a truthful gap by itself, with no detector to get
  // right, and errs toward claiming less coverage than we had rather than more.
  try { db.prepare("UPDATE runs SET stopped_at = ? WHERE id = ?").run(lastSeenChangeAt, runId); } catch {}
  const parts = [...realized].map(([k, v]) => `${k}: ${v.n} closed, ${v.wins}W, ${v.pnl >= 0 ? "+" : ""}${v.pnl.toFixed(3)} SOL`);
  log(`[status] launches=${seen} tracking=${tracker.tokens.size} amm=${ammMatched}/${amm?.stats.trades ?? 0} pools=${poolToMint.size} tradesStored=${trades.written} smartWallets=${broker.smartWallets.size} teamWallets=${broker.walletTeams.size}${st.subscriptions >= 0 ? ` subs=${st.subscriptions}` : ""} trades=${st.trades} reconnects=${st.reconnects} open=${broker.openPositions().length}${watcher ? ` kolPolls=${watcher.stats.polls} kolSignals=${watcher.stats.signals}` : ""}${street ? ` streetTweets=${street.stats.tweets} streetSignals=${street.stats.signals}` : ""}${tg ? ` tgEvents=${tg.stats.allEvents} tgPolls=${tg.stats.polls} tgMsgs=${tg.stats.messages} tgSignals=${tg.stats.signals}` : ""}`);
  for (const p of parts) log("   ", p);
}, 60_000);

/**
 * Self-pruning. On a server nothing else runs: the Dockerfile starts this process and the daily script that prunes
 * never executes, so the database would grow ~1 GB/day into a fixed volume and stop the collector within days. Losing
 * the collector loses coverage, and launch-time facts are unrecoverable, so retention has to be the process's own job.
 * Only working data goes; tokens, signals, operator_*, pool_map and buyout-sized curve buys are the archive and are
 * never touched. That last clause was missing and the sentence was false for as long as it was: see KEEP_EVIDENCE.
 */
/**
 * Go back for the launches whose metadata we failed to fetch the first time.
 *
 * A launch is asked for its metadata once, as it happens. When that request failed — and until 2026-09-08 it failed
 * about three times in four, because every launch declares `ipfs.io` and `ipfs.io` returns 429 to us — nothing tried
 * again and nothing was written down, so the row reads exactly like a launch that declared no metadata at all.
 *
 * This is the only loss here that a cheque cannot undo. On-chain history sits on the chain and an archival node will
 * sell it back whenever someone pays. The image and the description live behind a URI the creator controls, and the
 * window to fetch them closes quietly when they repoint or unpin it — no error, no event, just a document that used
 * to be there. Roughly twenty thousand launches a day were falling through that window.
 *
 * Both ends of the backlog on a slow timer: the obligation this process has is to keep watching the chain, and a
 * sweep for old documents must never compete with it. Bounded by concurrency rather than by batch size, so raising
 * the batch buys throughput without risking a sweep that outlives its own tick.
 */
const META_SWEEP_BATCH = Number(process.env.META_SWEEP_BATCH ?? 200);
/** In flight at once. The batch is network-bound, so this and not the batch size is what bounds the wall clock. */
const META_SWEEP_CONCURRENCY = Number(process.env.META_SWEEP_CONCURRENCY ?? 12);
/** How long a recorded failure stands before it is worth asking again. A refused gateway is not a dropped pin. */
const META_RETRY_MS = Number(process.env.META_RETRY_HOURS ?? 6) * 3600_000;
/**
 * The three-day window is gone, and it was doing real damage.
 *
 * It read as a sensible bound on a sweep running beside ingestion. What it actually did was make the loss permanent
 * for anything it fell behind: live capture only started working on 2026-09-08, and by then 116,739 launches with a
 * URI and no document were already older than three days, so this sweep could never see them again however long it
 * ran. A launch's metadata document is the one artefact in this archive that nobody can rebuild from chain at any
 * price — the creator owns the URI and the pin — so a window here is not a bound on cost, it is a decision to lose
 * the record of everything older than it.
 *
 * The cost it was bounding is also not real: the documents average 306 bytes. Every launch this project has ever
 * seen is 63 MB. The batch size, not the age, is what keeps this from competing with ingestion.
 */
async function sweepMissingMeta(): Promise<void> {
  try {
    /**
     * Both ends, for the same reason the image capture needs both: newest keeps pace with the small fraction the
     * live fetch misses, oldest drains what fell behind before it worked. Newest-first alone could never reach the
     * backlog, because new launches arrive faster than the sweep runs and are always at the head of the ordering —
     * the 09-02 to 09-07 week sat at zero documents in production while this ran every minute for two days.
     */
    const pick = (order: "ASC" | "DESC", n: number) => db.prepare(`SELECT mint, uri FROM tokens
      WHERE meta_at IS NULL AND uri IS NOT NULL AND uri != ''
        AND (meta_error IS NULL OR updated_at < ?)
      ORDER BY created_at ${order} LIMIT ?`).all(Date.now() - META_RETRY_MS, n) as { mint: string; uri: string }[];

    const half = Math.max(1, Math.floor(META_SWEEP_BATCH / 2));
    const seen = new Set<string>();
    const rows = [...pick("DESC", half), ...pick("ASC", META_SWEEP_BATCH - half)]
      .filter((r) => !seen.has(r.mint) && seen.add(r.mint));
    if (!rows.length) return;

    const ok = db.prepare(`UPDATE tokens SET
        image = COALESCE(image, ?), description = COALESCE(description, ?),
        twitter = COALESCE(twitter, ?), telegram = COALESCE(telegram, ?), website = COALESCE(website, ?),
        meta_json = COALESCE(meta_json, ?), meta_bytes = COALESCE(meta_bytes, ?),
        meta_at = COALESCE(meta_at, ?), meta_error = ?, updated_at = ? WHERE mint = ?`);
    /**
     * A failure is now written down. It was not, and that made every permanently dead pin a standing cost: the row
     * stayed `meta_at IS NULL`, so the next sweep asked for it again, and the one after that, forever. Recording the
     * reason both frees the budget for documents that can still be had and turns "we asked and nobody served it"
     * into a fact in the record rather than an absence indistinguishable from never having looked.
     */
    const bad = db.prepare(`UPDATE tokens SET meta_error = ?, updated_at = ? WHERE mint = ?`);

    let got = 0, next = 0;
    // Bounded concurrency so a larger batch still finishes well inside the timer. Sequentially, one slow gateway
    // could hold the whole sweep past the next tick; the work is awaited network I/O and blocks no ingestion.
    await Promise.all(Array.from({ length: META_SWEEP_CONCURRENCY }, async () => {
      for (let i = next++; i < rows.length; i = next++) {
        const r = rows[i];
        let res;
        try { res = await fetchMetaResult(r.uri); }
        catch (e) { res = { meta: null, via: "none", error: `threw: ${(e as Error).message}` }; }
        const now = Date.now();
        // Straight to the row: these tokens are long finalized and are not in the tracker any more. Written with the
        // same keep-first rule as everywhere else, so a later fetch can never overwrite the launch's original claim.
        if (res.meta) {
          const m = res.meta;
          ok.run(m.image ?? null, m.description ?? null, m.twitter ?? null, m.telegram ?? null, m.website ?? null,
                 m.raw ?? null, m.bytes ?? null, now, res.error ?? null, now, r.mint);
          got++;
        } else bad.run(res.error ?? "unreachable", now, r.mint);
      }
    }));

    const left = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE meta_at IS NULL AND uri IS NOT NULL AND uri != ''`)
      .get() as any).c as number;
    if (got) log(`[meta] recovered ${got}/${rows.length} launch claims that the first attempt missed; ` +
                 `${left.toLocaleString()} still without a document`);
  } catch (e) { log("[meta] sweep failed:", (e as Error).message); }
}
setInterval(() => void sweepMissingMeta(), 60_000);
setTimeout(() => void sweepMissingMeta(), 90_000);

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 14);
/**
 * A curve buy large enough to be a buyout is EVIDENCE, not working data, and retention must never take it.
 *
 * The comment above this function claimed only working data goes and that the archive is never touched. That was
 * false, and quietly so: `findBuyout` reads `trades` to answer who took each curve, which is the attribution side of
 * this product and the part no contract scanner can reproduce. Deleting those rows on a timer destroys the proof
 * behind a claim the site keeps making, while every count on the site stays exactly the same — the record still says
 * 169,100 launches and can no longer show you who bought them.
 *
 * Measured 2026-09-08: the collector's record carried 580 buyout trades against the laptop's 2,099, purely because
 * one runs a 3-day window and the other 14. Nobody chose that; it fell out of a retention setting. An authority on
 * provenance cannot let the completeness of its evidence depend on which machine happened to build the file.
 *
 * The exemption is narrow on purpose. Curve buys at or above BUYOUT_SOL are what `servicedb` copies into the record
 * and what `findBuyout` reads; everything else in `trades` really is working data and still goes. At ~2,100 rows
 * over the whole archive this costs nothing to keep and cannot be rebuilt once dropped — the transactions remain on
 * chain, but only an archival node can reach back for them, and by then we are reconstructing what we watched.
 */
const KEEP_EVIDENCE = KEEP_TRADE_EVIDENCE;
let prunedHoldLogged = false;
function pruneWorkingData(): void {
  /**
   * Legal hold, honoured here as well as in prune.ts. A rule that holds in only one of two pruners is not a rule -
   * the same lesson KEEP_TRADE_EVIDENCE learned - and this is the pruner that actually runs unattended in the cloud,
   * deleting millions of trade rows a day. See prune.ts for why the window matters.
   */
  const hold = (process.env.LEGAL_HOLD ?? "").trim();
  if (hold) {
    if (!prunedHoldLogged) {
      prunedHoldLogged = true;
      log(`[prune] LEGAL HOLD set — retention suspended, nothing will be deleted`);
      // Recorded, not just logged: a hold that leaves no trace of when it began cannot be testified to afterwards.
      try {
        const open = db.prepare("SELECT id FROM legal_holds WHERE released_at IS NULL ORDER BY id DESC LIMIT 1").get() as any;
        if (open) db.prepare("UPDATE legal_holds SET last_seen_at = ? WHERE id = ?").run(Date.now(), open.id);
        else db.prepare("INSERT INTO legal_holds (note, set_at, last_seen_at, protect_before) VALUES (?,?,?,?)")
          .run(hold, Date.now(), Date.now(), Date.now() - RETENTION_DAYS * 86400_000);
      } catch (e) { log(`[prune] could not record the hold: ${(e as Error).message}`); }
    }
    return;
  }
  /** Anything older than the earliest hold ever set stays, released or not — see legal_holds.protect_before. */
  let floor = 0;
  try { floor = Number((db.prepare("SELECT MIN(protect_before) m FROM legal_holds").get() as any)?.m ?? 0) || 0; } catch {}
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  const batch = 50_000;
  let removed = 0;
  try {
    /**
     * Each table in its own try, because one missing table used to abort the whole pass.
     *
     * `curve_snapshots` is created by curvepoll.ts, which has only ever run on the laptop — so on this collector the
     * table does not exist, the DELETE threw, the single surrounding catch swallowed it, and every statement AFTER
     * it was skipped. Trades were pruned, tweets never were, and the log said one line about a failure. A retention
     * pass that half-runs looks exactly like one that ran.
     */
    for (const [table, sql] of [
      ["trades", `DELETE FROM trades WHERE rowid IN (SELECT rowid FROM trades WHERE ts < ? AND ts >= ${floor} ${KEEP_EVIDENCE} LIMIT ${batch})`],
      ["curve_snapshots", `DELETE FROM curve_snapshots WHERE rowid IN (SELECT rowid FROM curve_snapshots WHERE ts < ? LIMIT ${batch})`],
      /**
       * Tweets are kept unless someone sets a retention period, the same footing as tg_messages.
       *
       * Until today this DELETE never ran here at all — the curve_snapshots throw above aborted the pass before
       * reaching it — so fixing that fault would have ARMED the deletion of 88,133 posts as its first act. That
       * corpus is the only sample of broad pump.fun X chatter anyone here holds; it is what showed this morning that
       * promotion tracks attention rather than manufacture, and it cannot be re-collected at any price now the
       * account has no credits.
       *
       * Deleting it to tidy up would be a one-way door opened by a bug fix. TWEETS_RETAIN_DAYS is the deliberate
       * decision; unset means keep, and the cited-evidence guard still applies when it is set.
       */
      ...(Number(process.env.TWEETS_RETAIN_DAYS ?? 0) > 0
        ? [["tweets", `DELETE FROM tweets WHERE rowid IN (SELECT rowid FROM tweets WHERE fetched_at < ${Date.now() - Number(process.env.TWEETS_RETAIN_DAYS) * 86400_000} ${keepTweetEvidence(db)} LIMIT ${batch})`] as const]
        : []),
    ] as const) {
      const present = (() => {
        try { return !!(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(table) as any)?.c; }
        catch { return false; }
      })();
      if (!present) continue;
      try {
        for (let i = 0; i < 40; i++) { // bounded so a huge backlog is spread over several passes, never blocking the feed
          const c = Number((db.prepare(sql).run(cutoff) as any).changes ?? 0);
          removed += c;
          if (c < batch) break;
        }
      } catch (e) {
        // Named, and the pass continues. The point of the per-table try is that one broken table cannot silence the rest.
        log(`[prune] ${table} failed: ${(e as Error).message}`);
      }
    }
    if (removed) log(`[prune] removed ${removed.toLocaleString()} working-data rows older than ${RETENTION_DAYS} days`);
  } catch (e) { log("[prune] failed:", (e as Error).message); }
}
setInterval(pruneWorkingData, 6 * 3600_000);
setTimeout(pruneWorkingData, 10 * 60_000); // once shortly after start, not during boot

feed.connect();
log(`source=${config.tradeSource}${config.tradeSource === "rpc" ? ` (${config.solanaWsUrl.replace(/\?.*$/, "")})` : ""}`);
log(`paper trading ${strategies.length} strategies, ${config.buySol} SOL per buy, ${config.fillLatencyMs}ms fill latency, ${config.watchMinutes}m watch window → ${config.dbPath}`);
for (const s of strategies) log(`   ${s.name.padEnd(16)} ${s.description}`);

function shutdown() {
  log("shutting down: closing open paper positions at last price");
  broker.closeAll(Date.now(), "shutdown");
  for (const t of tracker.tokens.values()) upsertToken(db, t);
  trades.close();
  db.prepare("UPDATE runs SET stopped_at=? WHERE id=?").run(Date.now(), runId);
  watcher?.stop();
  street?.stop();
  tg?.stop();
  amm?.close();
  feed.close();
  db.close();
  process.exit(0);
}
/**
 * Publishing the record from the machine that holds it.
 *
 * A Railway volume attaches to exactly one service, and `pump.db` lives on this one — so the record database has to
 * be built here, and handed to the web service over the private network. Until now it was built on a laptop and baked
 * into the image, which meant the published archive was only ever as fresh as the last manual deploy, and twice went
 * missing entirely because an ignore file excluded it.
 *
 * Two rules this follows:
 *   - The build runs in a **child process**. `servicedb` scans the trade table, and this process must not stop
 *     decoding launches while it does: every second not listening is a permanent hole in the archive.
 *   - It runs **before** retention. `servicedb` computes `curve_buyers` from trade rows that `pruneWorkingData`
 *     deletes; a launch pruned before that number is computed can never have it computed again.
 */
const RECORD_PATH = (process.env.DB_PATH ?? "data/pump.db").replace(/pump\.db$/, "record.db");
const RECORD_EVERY_MS = Number(process.env.RECORD_EVERY_HOURS ?? 6) * 3600_000;
let buildingRecord = false;

async function buildRecord(): Promise<void> {
  if (buildingRecord) return;
  buildingRecord = true;
  const started = Date.now();
  try {
    const { spawn } = await import("node:child_process");
    await new Promise<void>((resolve) => {
      const child = spawn("npx", ["tsx", "--no-warnings=ExperimentalWarning", "src/servicedb.ts", "--out", RECORD_PATH, "--read-only"], {
        stdio: ["ignore", "pipe", "pipe"], env: process.env,
      });
      // Keep enough to see the actual failure. The first version kept 400 chars and then logged only the last line,
      // which for a Node crash is the version banner — the exception itself had already been trimmed away.
      let tail = "";
      child.stdout?.on("data", (d) => { tail = (tail + d).slice(-4000); });
      child.stderr?.on("data", (d) => { tail = (tail + d).slice(-4000); });
      child.on("error", (e) => { log(`[record] could not start build: ${e.message}`); resolve(); });
      child.on("exit", (code) => {
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        if (code === 0) log(`[record] rebuilt ${RECORD_PATH} in ${secs}s — ${tail.trim().split("\n").pop() ?? ""}`);
        else {
          const lines = tail.trim().split("\n").filter((l) => l.trim() && !/^Node\.js v/.test(l));
          log(`[record] build FAILED (exit ${code}) after ${secs}s: ${lines.slice(-4).join(" | ").slice(0, 600)}`);
        }
        resolve();
      });
    });
  } finally { buildingRecord = false; }
}

// Off unless explicitly enabled: this runs on the machine that must never stop collecting, so it is opt-in.
if (process.env.RECORD_BUILD === "1") {
  setTimeout(() => void buildRecord(), 3 * 60_000);
  setInterval(() => void buildRecord(), RECORD_EVERY_MS);
}

/**
 * Watch the public site from outside the public site.
 *
 * The web service watches the age of the record it serves, which catches a frozen archive and cannot catch its own
 * death: a container that is gone, crash-looping, or wedged sends nothing, and silence from a watcher is
 * indistinguishable from good news. This probe lives in the other service, in another container, and asks the
 * question the way a visitor does — over the public internet, through Cloudflare, at the canonical host.
 *
 * That makes the two checks genuinely independent rather than two copies of one check: this one alarms when the site
 * is unreachable or answering wrong, and it keeps alarming about staleness even if the process that would normally
 * report its own staleness is not running at all.
 *
 * Three consecutive failures before alarming, because this one crosses a network and a single timeout means nothing.
 * At a 15-minute interval that is a 45-minute worst case, well inside the tolerance it is checking.
 */
const SITE_URL = (process.env.SITE_URL ?? "https://chainoftitle.org").replace(/\/+$/, "");
const SITE_STALE_MS = Number(process.env.SITE_STALE_HOURS ?? 8) * 3600_000;
if (process.env.SITE_WATCH !== "0") {
  if (!config.telegramBotToken || !config.telegramChatId)
    log(`[watch] WARNING: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set. The site watch will run and log, and ` +
      `will not be able to tell anyone.`);
  startWatchdog({
    name: `the public site (${SITE_URL})`,
    everyMs: 15 * 60_000,
    failuresBeforeAlarm: 3,
    repeatMs: 6 * 3600_000,
    log: (line) => log(line),
    send: (text) => telegramSend(config.telegramBotToken, config.telegramChatId, text),
    probe: async () => {
      const res = await fetch(`${SITE_URL}/api/v1/status`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return { ok: false, detail: `${SITE_URL}/api/v1/status answered ${res.status}` };
      const j = await res.json() as any;
      const asOf = Number(j?.asOf?.ms);
      // A 200 carrying no timestamp is a failure, not a pass. The one thing this must never do is read a shape it
      // does not understand as health — that is how a check ends up unable to fail.
      if (!Number.isFinite(asOf) || asOf <= 0) return { ok: false, detail: `${SITE_URL}/api/v1/status carried no readable asOf` };
      const age = Date.now() - asOf;
      const launches = Number(j?.launches) || 0;
      return age < SITE_STALE_MS
        ? { ok: true, detail: `${launches.toLocaleString()} launches, built ${fmtAge(age)} ago` }
        : { ok: false, detail: `${SITE_URL} is serving a record built ${fmtAge(age)} ago (limit ${fmtAge(SITE_STALE_MS)}) — ` +
            `${launches.toLocaleString()} launches. Every route answers; the counts are old. Publishing has stopped.` };
    },
  });
}
/** See watchdog.ts: the only alarm that survives this whole platform going down is one nobody here sends. */
startHeartbeat(process.env.HEARTBEAT_URL ?? "", 5 * 60_000, "collector");

/**
 * Keep the launch images, here, because the laptop cannot be the thing that keeps them.
 *
 * Every other fact this project publishes can be rebuilt from chain by anyone with archival RPC. The picture cannot:
 * it lives on IPFS behind a pin the operator can drop, and when it goes there is no price at which it comes back. It
 * was an hourly launchd job on one machine, which means it stopped whenever that machine slept — collecting the one
 * unrecoverable thing on the least reliable schedule in the system.
 *
 * In-process rather than a child process. `images.ts` argues for a separate job so slow gateways cannot stall the
 * collector, and that reasoning holds against a second WRITER on the same database file, which is what would cost
 * dropped launches. Sharing this connection has no such race: the writes are single-row UPDATEs serialised with
 * ingestion, and the slow part is awaited network I/O, which blocks nothing.
 *
 * Bounded so a bad hour stays bounded: `IMAGES_LIMIT` rows per pass at `IMAGES_CONCURRENCY` in flight, every
 * `IMAGES_EVERY_MINUTES`. Bytes go to the object store when one is configured, and next to the database otherwise.
 *
 * THE DEFAULTS MUST BEAT THE LAUNCH RATE, and for two days they did not. They were sized when capture covered only
 * graduated launches — about 1,400 a day — and 300 rows every 20 minutes is ample for that. Scope was then widened
 * to every launch (`all: true` below, and it is the right call) without resizing the schedule: 900 an hour against
 * roughly 1,070 launches an hour. A deficit of 171 an hour, 4,100 a day, growing forever.
 *
 * It was invisible because every pass reported success. "kept 300 of 300 pending" is what falling behind looks like
 * from inside a pass that can only see its own slice, which is why `backlog` is now in the stats and in this log
 * line: the number that can show the fault is the total, and no pass-level figure can substitute for it.
 */
if (process.env.IMAGES_CAPTURE === "1") {
  const IMAGES_DIR = process.env.IMAGES_DIR ?? (config.dbPath.replace(/[^/]*$/, "") + "images");
  const IMAGES_EVERY_MS = Number(process.env.IMAGES_EVERY_MINUTES ?? 10) * 60_000;
  const IMAGES_LIMIT = Number(process.env.IMAGES_LIMIT ?? 400);
  const IMAGES_CONCURRENCY = Number(process.env.IMAGES_CONCURRENCY ?? 8);
  /**
   * The backlog pass, oldest-first. Separate from the fresh pass because they are on different clocks: keeping up
   * is continuous, draining is finite and urgent. Set to 0 to run only the fresh pass.
   */
  const IMAGES_BACKLOG_LIMIT = Number(process.env.IMAGES_BACKLOG_LIMIT ?? IMAGES_LIMIT);
  /** Highest backlog seen, so the log can say which direction it is moving without keeping a history. */
  let backlogWas: number | null = null;
  let capturing = false;
  const capture = async () => {
    if (capturing) return;
    capturing = true;
    try {
      const { captureImages } = await import("./images.ts");
      const common = { dir: IMAGES_DIR, concurrency: IMAGES_CONCURRENCY, log: () => {} };
      const st = await captureImages(db, {
        ...common, limit: IMAGES_LIMIT, order: "newest" as const,
        /**
         * Every launch, not only the ones that graduated.
         *
         * Restricting capture to graduations meant the archive kept the picture only for launches that had already
         * passed a test — so it could never answer a question about the ones it had filtered out, and could never
         * establish what an ordinary launch looked like to compare a suspicious one against. An archive that keeps
         * evidence only where it already suspects something has made the determination before preserving the record.
         *
         * The store is content-addressed by sha256 and skips bytes it already holds, so the 41% of launches that
         * reuse another launch's picture cost nothing beyond the fetch — and that reuse is itself the signal: 249
         * launches sharing one image is a factory, and it is only visible if the unremarkable ones were kept too.
         */
        all: true,
      });
      /**
       * Then the other end. A launch from two days ago whose picture is still unfetched is closer to losing its pin
       * than one from two minutes ago, and under the old single-ended order it was never going to be asked for.
       */
      const bl = IMAGES_BACKLOG_LIMIT > 0
        ? await captureImages(db, { ...common, limit: IMAGES_BACKLOG_LIMIT, order: "oldest" as const, all: true })
        : null;

      const kept = st.kept + (bl?.kept ?? 0);
      const bytes = st.bytes + (bl?.bytes ?? 0);
      const attempted = st.attempted + (bl?.attempted ?? 0);
      const backlog = bl?.backlog ?? st.backlog;
      if (attempted > 0) {
        const moved = backlogWas === null ? "" : ` (${backlog > backlogWas ? "+" : ""}${backlog - backlogWas} since last pass)`;
        log(`[images] kept ${kept} (${(bytes / 1048576).toFixed(1)} MB, ${st.reused + (bl?.reused ?? 0)} already held), ` +
          `failed ${st.failed + (bl?.failed ?? 0)}, of ${attempted} tried → ${IMAGES_DIR}; ` +
          `backlog ${backlog.toLocaleString()}${moved}`);
        /**
         * Said as a fault, not as a statistic. A backlog that grows across a pass means the schedule is below the
         * launch rate, and every hour it stays there is a fixed number of launches whose picture nobody will ever
         * hold — the one loss in this project that a later pass cannot repair.
         */
        if (backlogWas !== null && backlog > backlogWas)
          log(`[images] FALLING BEHIND: capture is slower than launches arrive. Raise IMAGES_LIMIT or lower ` +
              `IMAGES_EVERY_MINUTES; at this rate the pictures in the gap will not be recoverable.`);
        backlogWas = backlog;
      }
    } catch (e) {
      // Never fatal. Losing images is bad; losing ingestion is worse, and this runs in the ingesting process.
      log(`[images] capture failed: ${(e as Error).message}`);
    } finally { capturing = false; }
  };
  setTimeout(() => void capture(), 90_000);   // after the feeds are up, not competing with them for the boot
  setInterval(() => void capture(), IMAGES_EVERY_MS);
}

/**
 * Keep the launchpad's own record of each launch, and keep it as it changes.
 *
 * pump.fun knows things the chain does not: whether it has BANNED a token, whether it flagged it nsfw, the all-time
 * high it showed people, how many replies it drew. None of it is on chain, none of it can be bought back from an
 * archival node, and all of it can be revised or deleted by the platform without notice. A ban in particular is the
 * closest thing to an admission this market produces and it is never announced.
 *
 * The re-check half is the point. One snapshot at graduation cannot show a ban, because the ban comes later; only a
 * second look does, and only if it is kept beside the first rather than overwriting it. See platform.ts.
 */
if (process.env.PLATFORM_CAPTURE === "1") {
  const EVERY_MS = Number(process.env.PLATFORM_EVERY_MINUTES ?? 10) * 60_000;
  const LIMIT = Number(process.env.PLATFORM_LIMIT ?? 60);
  const RECHECK = Number(process.env.PLATFORM_RECHECK ?? 40);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { capturePlatform } = await import("./platform.ts");
      const st = await capturePlatform(db, { limit: LIMIT, recheck: RECHECK, concurrency: 3, log });
      if (st.attempted > 0)
        log(`[platform] ${st.kept} stored (${st.changed} changed), ${st.unchanged} unchanged, ${st.failed} failed, of ${st.attempted}`);
    } catch (e) {
      // Never fatal, for the same reason as images: this runs inside the process whose only real obligation is to
      // keep watching launches.
      log(`[platform] capture failed: ${(e as Error).message}`);
    } finally { running = false; }
  };
  setTimeout(() => void run(), 150_000);
  setInterval(() => void run(), EVERY_MS);
}

/**
 * Confirm recorded graduations against the bonding curve account, continuously.
 *
 * Confirmation used to arrive only through pool discovery, so it inherited pool discovery's coverage and stalled
 * near half of all graduations — and `assess()` withholds every statement about how a curve filled until a
 * graduation is confirmed. This closes the loop in the process that records them: the backlog is a few dozen
 * `getMultipleAccounts` calls, and a pass costs less than a single image fetch.
 *
 * Newest-first here on purpose. The old end of the backlog is a one-off backfill worth running by hand
 * (`npm run confirm -- --oldest`); what the collector needs is for today's graduations to stop accumulating
 * unconfirmed behind it. Bounded per pass, never fatal, and it shares this process's database connection for the
 * same reason images does — a second writer against the busy timeout costs dropped launches, and a launch dropped
 * is the one loss here that cannot be repaired.
 */
if (process.env.CONFIRM_SWEEP === "1") {
  const EVERY_MS = Number(process.env.CONFIRM_EVERY_MINUTES ?? 15) * 60_000;
  let pass = 0;
  const LIMIT = Number(process.env.CONFIRM_LIMIT ?? 500);
  const BATCH = Number(process.env.CONFIRM_BATCH ?? 100);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { confirmGraduations } = await import("./confirm.ts");
      /**
       * Alternate ends. Newest-first stops today's graduations accumulating unconfirmed; oldest-first works the
       * backlog, where the yield is far higher — measured 2026-09-09, the newest 2,000 unconfirmed returned 9
       * completions and the oldest 2,000 returned 824, because the old end is where pool discovery was blind and
       * the new end is mostly the vSOL inference firing on curves that never completed. Running only one end would
       * either let the front edge rot or never reach the backlog.
       */
      pass++;
      const st = await confirmGraduations(db, { limit: LIMIT, batch: BATCH, order: pass % 2 ? "newest" : "oldest", log: () => {} });
      if (st.read > 0)
        log(`[confirm] ${st.confirmed} confirmed, ${st.notComplete} not complete, ${st.missing} account gone, ` +
          `${st.unreadable} unreadable, of ${st.candidates} due`);
    } catch (e) {
      log(`[confirm] sweep failed: ${(e as Error).message}`);
    } finally { running = false; }
  };
  setTimeout(() => void run(), 120_000);
  setInterval(() => void run(), EVERY_MS);
}

/**
 * Trace the operator map here, because the alternative was a laptop and the alternative broke the archive.
 *
 * `operator_wallets` is the attribution half of the product — every wallet page and the front page's "who takes the
 * curves" reads it — and it only ever grew where a person ran `npm run clusters`. Tonight that came due: the web
 * service refused the collector's record for carrying 8,598 operator wallets against 10,243 already served, so the
 * published archive stopped advancing. The guard was right. The gap existed because this code had no home in the
 * cloud, and relaxing the guard would have published less evidence to make a number go up.
 *
 * Runs on the collector's own connection, not its own — a second writer against a 10 s busy_timeout costs dropped
 * launches. Slow and bounded, because it is RPC-heavy and ingestion always outranks it.
 */
if (process.env.CLUSTERS_TRACE === "1") {
  const EVERY_MS = Number(process.env.CLUSTERS_EVERY_MINUTES ?? 45) * 60_000;
  const LIMIT = Number(process.env.CLUSTERS_LIMIT ?? 60);
  let running = false;
  const run = async () => {
    if (running) { log("[clusters] previous pass still running, skipping"); return; }
    running = true;
    /**
     * Logged on entry, not only on completion.
     *
     * Logging the result alone cannot distinguish "the timer never fired" from "it fired and is still inside an RPC
     * call" — and those need opposite fixes. An hour went into that ambiguity tonight: the operator map sat at
     * 8,598 with no line either way, and the only honest reading was that something might be hanging, might be
     * unconfigured, or might simply not have reached a log window. A start line and an end line answer it.
     */
    log(`[clusters] pass starting, ${LIMIT} seeds`);
    const t0 = Date.now();
    try {
      const { traceClusters } = await import("./clusters.ts");
      const st = await traceClusters({ limit: LIMIT, db, log: () => {} });
      log(`[clusters] traced ${st.traced}, ${st.found} funders found, ${st.wallets} wallets on file (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      log(`[clusters] trace failed after ${Math.round((Date.now() - t0) / 1000)}s: ${(e as Error).message}`);
    } finally { running = false; }
  };
  setTimeout(() => void run(), Number(process.env.CLUSTERS_FIRST_SECONDS ?? 240) * 1000);
  setInterval(() => void run(), EVERY_MS);
}

/**
 * Fill in the creation transaction for launches recorded before we kept it, in the cloud rather than by hand.
 *
 * This is a race against retention, not a one-off migration. `trades` holds about seven days, and the creator's
 * first-block row is the only local source for `create_sig`, so every launch has a window in which its citation can
 * still be recovered and after which only an archival node can return it. Run once from a laptop it recovered
 * 181,474 launches and arrived too late for 24,494. On a timer here it reaches each launch inside the window.
 *
 * Cheap and self-terminating: it writes only where `create_sig IS NULL` and a matching trade row exists, so once
 * caught up every pass does nothing. Bounded batches, because the process this runs inside must not stop ingesting.
 */
/**
 * Move old trade rows to the object store and out of the local database.
 *
 * Runs on the ingesting process's own connection, like every other sweep here, because a second writer against the
 * collector's 10 s busy_timeout costs dropped launches - and a dropped launch is the one loss this project cannot
 * repair. Bounded per pass so it always terminates, and it never deletes a row it has not first uploaded and read
 * back the size of.
 */
/** One-shot: put back rows an earlier offload took that the record is built from. Unset once it has run. */
if (process.env.TRADES_RESTORE === "1") {
  setTimeout(() => void (async () => {
    try {
      const { restoreOffloaded } = await import("./offload.ts");
      const r = await restoreOffloaded(db, { log: (s) => log(s) });
      log(`[restore] complete: ${r.restored.toLocaleString()} rows from ${r.objects} objects`);
    } catch (e) { log(`[restore] failed: ${(e as Error).message}`); }
  })(), 45_000);
}

if (process.env.TRADES_OFFLOAD === "1") {
  const EVERY_MS = Number(process.env.TRADES_OFFLOAD_EVERY_MINUTES ?? 20) * 60_000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { offloadTrades } = await import("./offload.ts");
      const r = await offloadTrades(db, { log: (s) => log(s) });
      if (r.parts) log(`[offload] pass complete: ${r.parts} objects, ${r.rows.toLocaleString()} rows, ` +
        `${(r.bytes / 1048576).toFixed(1)} MB stored, ${r.deleted.toLocaleString()} rows freed locally`);
      else if (r.skipped) log(`[offload] nothing to do: ${r.skipped}`);
    } catch (e) {
      // Loudly, and without deleting anything: the pass throws before the delete on any upload it cannot verify.
      log(`[offload] FAILED, nothing deleted: ${(e as Error).message}`);
    } finally { running = false; }
  };
  setTimeout(() => void run(), 90_000);
  setInterval(() => void run(), EVERY_MS);
}

if (process.env.BACKFILL_SIG === "1") {
  const EVERY_MS = Number(process.env.BACKFILL_SIG_EVERY_MINUTES ?? 30) * 60_000;
  const BATCH = Number(process.env.BACKFILL_SIG_BATCH ?? 5000);
  const MAX_BATCHES = Number(process.env.BACKFILL_SIG_MAX_BATCHES ?? 4);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { backfillCreateSig } = await import("./backfillsig.ts");
      const st = backfillCreateSig(db, { batch: BATCH, maxBatches: MAX_BATCHES });
      if (st.wrote) log(`[createsig] recovered ${st.wrote} creation transactions in ${st.batches} batches`);
    } catch (e) {
      log(`[createsig] backfill failed: ${(e as Error).message}`);
    } finally { running = false; }
  };
  setTimeout(() => void run(), 180_000);
  setInterval(() => void run(), EVERY_MS);
}

/**
 * Hand the record to the web service. Private network only in normal operation — Railway routes
 * `collector.railway.internal` between services without exposing anything publicly.
 */
if (process.env.RECORD_PORT) {
  void (async () => {
    const { createServer } = await import("node:http");
    const { createReadStream, statSync } = await import("node:fs");
    createServer((req, res) => {
      if (req.url === "/health") {
        let size = 0, mtime = 0;
        try { const st = statSync(RECORD_PATH); size = st.size; mtime = st.mtimeMs; } catch {}
        /**
         * The live count, which is a different claim from every other number this service publishes.
         *
         * `bytes`/`builtAt` describe the record FILE — a snapshot, correct only about itself. This describes what
         * the collector holds right now, and it is the honest source for "how many launches are on record", which
         * the site had been answering out of the published snapshot. Those are two different sentences and the site
         * was using one number for both: the download page understated the file it offered by 8,818 launches on
         * 2026-09-08, and the headline sat frozen for six hours at a time while ingestion never stopped.
         *
         * Read fresh per request rather than cached, because a cached count is a snapshot again and this endpoint
         * exists precisely to not be one. It is a COUNT(*) on an indexed table behind the private network, called
         * once every few seconds by one consumer.
         *
         * Failure returns null, never a stale or zero count. A frozen number presented as live is worse than no
         * number: the site would claim ingestion is healthy on the strength of a value that stopped moving.
         */
        let observed: number | null = null, held: number | null = null, operators: number | null = null;
        try {
          held = (db.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
          observed = (db.prepare("SELECT COUNT(*) c FROM tokens WHERE COALESCE(late_discovery,0)=0").get() as any).c as number;
          /**
           * The size of the operator map, because it decides whether the archive can advance at all.
           *
           * `serve.ts` refuses a pulled record carrying under 90% of the operator_wallets it already serves, and on
           * 2026-09-09 that froze publishing: the collector had 8,598 against 10,243 because `clusters` had only
           * ever run on a laptop. The guard was right and the number it turned on was invisible from outside — no
           * endpoint reported it, so "is the archive able to advance yet" could not be answered without a deploy.
           * A figure that gates publishing has to be observable, or the next freeze is diagnosed the same slow way.
           */
        } catch { /* null, and the consumer shows the published figure alone */ }
        /**
         * Counted separately, and its failure reported rather than swallowed.
         *
         * Folded into the try above, a throw here left `held` and `observed` set and `operators` null — which is
         * indistinguishable from "the collector is old and does not send this field", and that is exactly how it was
         * first misread. The two states have different causes and different fixes, so they are told apart: `null`
         * plus `operatorsError` is a query that failed and says why, `null` alone is a field that was never sent.
         */
        let operatorsError: string | null = null;
        try {
          operators = (db.prepare("SELECT COUNT(*) c FROM operator_wallets").get() as any).c as number;
        } catch (e) { operatorsError = (e as Error).message.slice(0, 120); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ record: RECORD_PATH, bytes: size, builtAt: mtime, building: buildingRecord, observed, held, operators, operatorsError, at: Date.now() }));
      }
      /**
       * One launch, answered by the machine that watched it.
       *
       * The public service reads a record file rebuilt every six hours, so for the first hours of a launch's life it
       * held no row and answered `UNKNOWN — Launch not observed`, then set about reconstructing the launch from
       * chain history. About a launch we had watched from its creation transaction. That is the worst failure this
       * product has: the single thing it offers that a cold scanner cannot is being there at birth, and it was
       * disclaiming exactly that during the only window when anyone is asking.
       *
       * The lag was never a property of the data. It came from welding a question about one launch to the rebuild of
       * a seventy-megabyte file — 1.6 MB of new launches shipped inside 69.6 MB of packaging, so the packaging set
       * the clock. This answers from the live database instead, in milliseconds, over the private network the web
       * service already polls for the counter.
       *
       * THE ASSESSMENT IS COMPUTED HERE, not there, and that is the point rather than an optimisation. `assess`
       * needs the trade rows behind a buyout and the run intervals proving we were watching; both live here and
       * neither is in a six-hour-old extract. Sending the row alone would have the web service judge it against
       * evidence it does not hold — missing a buyout it cannot see, and calling the launch uncovered because the
       * record's last run ended when the file was built. Same code from `provenance.ts`, run where the evidence is.
       */
      /**
       * The live wall's feed: launches since a cursor, newest last.
       *
       * Cursor is a timestamp rather than an offset, so a consumer that reconnects asks for "anything after what I
       * already showed" and cannot double-count or skip when the ring rotates under it. An empty array is a real
       * answer — a quiet few seconds — and is not the same as an error, which is why this never returns 204.
       */
      if (req.url?.startsWith("/recent")) {
        const since = Number(new URL(req.url, "http://x").searchParams.get("since") ?? 0);
        const out = recent.filter((r) => r.at > since).slice(-120);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ at: Date.now(), launches: out }));
      }
      const lm = req.url?.match(/^\/launch\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (lm) {
        try {
          const t = db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE mint = ?`).get(lm[1]) as any;
          if (!t) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ held: false })); }
          /**
           * Coverage up to now, not up to the last heartbeat — and only while ingestion proves it.
           *
           * `runs.stopped_at` is stamped with the last launch actually observed, once a minute. So the newest
           * coverage window always trails the clock by up to sixty seconds, and a launch from the last minute reads
           * as outside coverage: not observed. That is precisely the launch this endpoint exists to answer about,
           * and it would have disclaimed every one of them for their first minute of life.
           *
           * Extending the window to now is safe ONLY because of what the heartbeat means. It is not a liveness
           * timer — that version of it recorded deaf hours as covered and is the first row of the failure table in
           * HANDOFF. It is the timestamp of the last launch this process actually decoded. A fresh one is therefore
           * evidence of ingestion, not of the process merely being up, and 180s is the same threshold `npm run
           * health` uses to call ingestion advancing.
           *
           * If the heartbeat is stale we were not reliably watching, and the honest answer is the unextended
           * window: uncovered, which reads as UNKNOWN rather than as a finding.
           */
          const win = coverageWindows(db);
          const last = win[win.length - 1];
          const nowMs = Date.now();
          if (last && nowMs - last.b < 180_000) last.b = nowMs;
          const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);
          // Coverage is a statement about what this process did, and this process is the only authority on that.
          const observed = !t.late_discovery && covered(t.created_at);
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ held: true, observed, t, a: assess(db, t, covered) }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          return res.end(JSON.stringify({ held: false, error: (e as Error).message }));
        }
      }
      /**
       * The captured launch image, by content hash, over the private network.
       *
       * The bytes live on THIS service's volume because this is the process that captured them. The web service has
       * no volume, so its only alternatives were to ship the pictures inside its build context — which puts whichever
       * laptop deploys back in the publish path, and dies at ~570 MB a day — or to hot-link the creator's IPFS URI,
       * which would have the page that reports what a launch claimed at birth quietly showing whatever the operator
       * is serving today. Both are the failure this project exists to point at. So the record travels over the
       * private network and the pictures travel the same way.
       *
       * The name IS the hash, so this re-verifies before serving: a file whose bytes no longer match the sha256 it is
       * filed under is corruption, and serving it under a content address would be a false attestation rather than a
       * broken image.
       */
      const im = req.url?.match(/^\/image\/([0-9a-f]{64})$/);
      if (im) {
        const sha = im[1];
        const dir = (process.env.IMAGES_DIR ?? (config.dbPath.replace(/[^/]*$/, "") + "images")) + "/" + sha.slice(0, 2);
        const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bin: "application/octet-stream" };
        for (const ext of Object.keys(types)) {
          const path = `${dir}/${sha}.${ext}`;
          try {
            const buf = readFileSync(path);
            const actual = createHash("sha256").update(buf).digest("hex");
            if (actual !== sha) {
              log(`[image] ${path} does not match its own hash — refusing to serve it`);
              res.writeHead(500, { "content-type": "text/plain" });
              return res.end("stored image failed its own checksum");
            }
            res.writeHead(200, { "content-type": types[ext], "content-length": String(buf.length), "x-content-sha256": sha });
            return res.end(buf);
          } catch { /* try the next extension */ }
        }
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("not held");
      }
      if (req.url !== "/record.db") { res.writeHead(404); return res.end("not found"); }
      let st;
      try { st = statSync(RECORD_PATH); } catch { res.writeHead(503); return res.end("record not built yet"); }
      // A half-written database must never be served: a truncated archive reads as a real one with fewer launches.
      if (buildingRecord) { res.writeHead(503); return res.end("a rebuild is in progress; try again shortly"); }
      res.writeHead(200, { "content-type": "application/vnd.sqlite3", "content-length": String(st.size) });
      createReadStream(RECORD_PATH).pipe(res);
    }).listen(Number(process.env.RECORD_PORT), () => log(`[record] serving ${RECORD_PATH} on :${process.env.RECORD_PORT}`));
  })();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
