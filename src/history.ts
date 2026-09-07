/**
 * Historical winner dataset: the full bonding-curve life of tokens that became big, rebuilt from chain history.
 *
 * The live database holds ~12 organic runners in 80k launches and saw only 3 of them from launch, so no picker can
 * be learned from it. This job (1) lists candidates — pump.fun's top coins by current and all-time-high market cap,
 * a mints file, and/or our own late-graduating tokens — (2) walks each token's bonding-curve account transaction
 * history (getSignaturesForAddress: cheap, gives the activity-over-time shape for free) and (3) decodes every curve
 * transaction (getTransaction, batched) into hist_trades with wallet, side, size and the curve state after each trade.
 * A token's curve account is only used until graduation, so its history is bounded (hundreds to a few thousand txs).
 *
 *   npm run history -- --days 120 --min-ath-usd 1000000 --limit 20      # collect candidates, reconstruct 20 of them
 *   npm run history -- --mints winners.txt --limit 50                    # your own list (one mint per line)
 *   npm run history -- --db-late-grads --limit 30                        # our tokens that graduated >= 60 min after launch (losers/controls)
 *   npm run history -- --report                                          # what has been rebuilt so far
 *
 * Re-run to continue: tokens are processed oldest-first with status new -> sigs -> done; --limit bounds one run.
 * Tables: hist_tokens (one row per candidate, summary), hist_activity (per hour since creation), hist_trades.
 */
import { readFileSync } from "node:fs";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { decodeCreate, decodeTrade } from "./feed/rpc.ts";
import { bondingCurveAddress, rpc, rpcBatch, rpcStats } from "./rpc-http.ts";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const flag = (k: string) => args.includes(`--${k}`);
const DAYS = Number(opt("days", "120"));
const MIN_ATH_USD = Number(opt("min-ath-usd", "1000000"));
const LIMIT = Number(opt("limit", "20"));
const MAX_TXS = Number(opt("max-txs", "6000"));
const MAX_PAGES = Number(opt("max-pages", "60"));
const CONCURRENCY = Number(opt("concurrency", "4"));
const MINTS_FILE = opt("mints", "");
const GRAD_V_SOL = 115;
const ARCHIVAL = /helius|mainnet-beta|quiknode|quicknode|triton|rpcpool|alchemy/i;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const db = openDb(config.dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS hist_tokens (
  mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, creator TEXT, curve TEXT, created_at INTEGER, complete INTEGER,
  mcap_sol REAL, mcap_usd REAL, ath_usd REAL, ath_at INTEGER, sol_usd REAL, source TEXT, status TEXT DEFAULT 'new',
  sigs INTEGER, sigs_failed INTEGER, sigs_capped INTEGER DEFAULT 0, txs_fetched INTEGER, trades INTEGER, buyers INTEGER, dev_pct REAL,
  first_ts INTEGER, last_ts INTEGER, grad_ts INTEGER, graduated_min REAL, peak_x REAL, error TEXT, updated_at INTEGER)`);
try { db.exec(`ALTER TABLE hist_tokens ADD COLUMN dev_buy_pct REAL`); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS hist_activity (mint TEXT NOT NULL, hour INTEGER NOT NULL, txs INTEGER, failed INTEGER, trades INTEGER, buyers INTEGER, buy_sol REAL, sell_sol REAL, vsol_end REAL, PRIMARY KEY (mint, hour))`);
db.exec(`CREATE TABLE IF NOT EXISTS hist_trades (mint TEXT NOT NULL, sig TEXT NOT NULL, idx INTEGER NOT NULL, ts INTEGER, slot INTEGER, wallet TEXT, side TEXT, sol REAL, tokens REAL, vsol REAL, vtok REAL, is_dev INTEGER, PRIMARY KEY (mint, sig, idx))`);
db.exec(`CREATE INDEX IF NOT EXISTS hist_trades_mint ON hist_trades(mint, ts)`);

const upsert = db.prepare(`INSERT INTO hist_tokens (mint, name, symbol, creator, curve, created_at, complete, mcap_sol, mcap_usd, ath_usd, ath_at, sol_usd, source, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(mint) DO UPDATE SET name = COALESCE(excluded.name, name), symbol = COALESCE(excluded.symbol, symbol), creator = COALESCE(excluded.creator, creator),
    complete = COALESCE(excluded.complete, complete), mcap_sol = COALESCE(excluded.mcap_sol, mcap_sol), mcap_usd = COALESCE(excluded.mcap_usd, mcap_usd),
    ath_usd = COALESCE(excluded.ath_usd, ath_usd), ath_at = COALESCE(excluded.ath_at, ath_at), sol_usd = COALESCE(excluded.sol_usd, sol_usd), updated_at = excluded.updated_at`);

function addCandidate(mint: string, source: string, c: any = {}): void {
  let curve: string;
  try { curve = bondingCurveAddress(mint); } catch { return; }
  const mcapSol = Number(c.market_cap) > 0 ? Number(c.market_cap) : null;
  const mcapUsd = Number(c.usd_market_cap) > 0 ? Number(c.usd_market_cap) : null;
  const solUsd = mcapSol && mcapUsd ? mcapUsd / mcapSol : null;
  const ath = Number(c.ath_market_cap) > 0 && Number(c.ath_market_cap) < 5e9 ? Number(c.ath_market_cap) : null;
  upsert.run(mint, c.name ?? null, c.symbol ?? null, c.creator ?? null, curve, typeof c.created_timestamp === "number" ? c.created_timestamp : null,
    c.complete === undefined ? null : c.complete ? 1 : 0, mcapSol, mcapUsd, ath, typeof c.ath_market_cap_timestamp === "number" ? c.ath_market_cap_timestamp : null, solUsd, source, Date.now());
}

// ---- 1) candidates ----
async function collectPumpFun(): Promise<void> {
  const since = Date.now() - DAYS * 86400_000;
  let seen = 0, kept = 0;
  for (const sort of ["market_cap", "ath_market_cap"]) {
    for (let offset = 0; offset < 2000; offset += 50) {
      let coins: any[] = [];
      try {
        const res = await fetch(`https://frontend-api-v3.pump.fun/coins?offset=${offset}&limit=50&sort=${sort}&order=DESC&includeNsfw=true`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) { log(`[history] pump.fun ${sort} offset ${offset}: http ${res.status}`); await new Promise((r) => setTimeout(r, 2000)); continue; }
        coins = await res.json();
      } catch (e) { log(`[history] pump.fun ${sort} offset ${offset}: ${(e as Error).message}`); continue; }
      if (!Array.isArray(coins) || coins.length === 0) break;
      for (const c of coins) {
        seen++;
        if (typeof c?.mint !== "string" || typeof c.created_timestamp !== "number" || c.created_timestamp < since) continue;
        const ath = Number(c.ath_market_cap), usd = Number(c.usd_market_cap);
        // pump.fun's ATH field carries wash-printed nonsense (10^23) for some pools; anything above $5B is not a real ATH
        const big = (ath > 0 && ath < 5e9 ? ath : 0) >= MIN_ATH_USD || (usd > 0 && usd < 5e9 && usd >= MIN_ATH_USD);
        if (!big) continue;
        addCandidate(c.mint, `pumpfun-${sort}`, c);
        kept++;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  log(`[history] pump.fun lists: ${seen} coins seen, ${kept} candidates within ${DAYS} d with ATH or mcap >= $${MIN_ATH_USD.toLocaleString()}`);
}

function collectFile(path: string): void {
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.trim().split(/\s+/)[0];
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) { addCandidate(m, "file"); n++; }
  }
  log(`[history] ${n} mints from ${path}`);
}

function collectDbLateGrads(): void {
  const rows = db.prepare(`SELECT mint, name, symbol, creator, created_at FROM tokens WHERE graduated = 1 AND late_discovery = 0 AND graduated_at - created_at >= 60000 AND mint NOT IN (SELECT mint FROM hist_tokens) ORDER BY created_at`).all() as any[];
  for (const r of rows) addCandidate(r.mint, "db-late-grad", { name: r.name, symbol: r.symbol, creator: r.creator, created_timestamp: r.created_at, complete: true });
  log(`[history] ${rows.length} late-graduating tokens from our own database added as controls`);
}

// ---- 2) signatures ----
interface Sig { signature: string; blockTime: number | null; slot: number; err: unknown }
async function fetchSignatures(curve: string): Promise<{ sigs: Sig[]; capped: boolean }> {
  const all: Sig[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Sig[] = await rpc("getSignaturesForAddress", [curve, { limit: 1000, ...(before ? { before } : {}), commitment: "confirmed" }], 30_000);
    // publicnode is not archival: it answers [] for accounts it never indexed. An empty page is only final from an archival node.
    if (res.length === 0 && page === 0) res = await rpc("getSignaturesForAddress", [curve, { limit: 1000, commitment: "confirmed" }], 30_000, ARCHIVAL);
    all.push(...res);
    if (res.length < 1000) return { sigs: all, capped: false };
    before = res[res.length - 1].signature;
  }
  return { sigs: all, capped: true };
}

// ---- 3) transactions ----
interface Tr { sig: string; idx: number; ts: number; slot: number; wallet: string; side: "buy" | "sell"; sol: number; tokens: number; vsol: number; vtok: number }
async function fetchTrades(mint: string, sigs: Sig[]): Promise<{ trades: Tr[]; creator: string | null; name: string | null; symbol: string | null; fetched: number }> {
  const trades: Tr[] = [];
  let creator: string | null = null, name: string | null = null, symbol: string | null = null, fetched = 0, failed = 0;
  const ok = sigs.filter((s) => !s.err);
  const results: any[] = new Array(ok.length).fill(undefined);
  // public nodes allow one getTransaction per request; run a few in flight, the rpc helper spaces them per endpoint
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= ok.length) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { results[i] = await rpc("getTransaction", [ok[i].signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], 30_000); break; }
        catch (e) { if (attempt === 2) { results[i] = null; failed++; } }
      }
      if ((i + 1) % 500 === 0) log(`[history] ${mint.slice(0, 6)}: ${i + 1}/${ok.length} transactions`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  ok.forEach((s, k) => {
    const tx = results[k];
    if (!tx) return;
    fetched++;
    if (tx.meta?.err) return;
    const logs: string[] = tx.meta?.logMessages ?? [];
    let idx = 0;
    for (const l of logs) {
      if (!l.startsWith("Program data: ")) continue;
      const d = Buffer.from(l.slice(14), "base64");
      if (d.length < 8) continue;
      const t = decodeTrade(d);
      if (t) {
        if (t.mint !== mint) continue;
        trades.push({ sig: s.signature, idx: idx++, ts: (t.timestamp || tx.blockTime || 0) * 1000, slot: tx.slot ?? s.slot, wallet: t.user, side: t.isBuy ? "buy" : "sell", sol: t.solAmount, tokens: t.tokenAmount, vsol: t.vSol, vtok: t.vTokens });
        if (!creator && t.creator) creator = t.creator;
        continue;
      }
      const c = decodeCreate(d);
      if (c && c.mint === mint) { creator = c.creator ?? c.user; name = c.name; symbol = c.symbol; }
    }
  });
  if (ok.length > 0 && fetched === 0) throw new Error(`could not fetch any of ${ok.length} transactions (${failed} failed)`);
  if (failed > 0) log(`[history] ${mint.slice(0, 6)}: ${failed} of ${ok.length} transactions could not be fetched`);
  return { trades, creator, name, symbol, fetched };
}

const insTrade = db.prepare(`INSERT OR REPLACE INTO hist_trades (mint, sig, idx, ts, slot, wallet, side, sol, tokens, vsol, vtok, is_dev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const insAct = db.prepare(`INSERT OR REPLACE INTO hist_activity (mint, hour, txs, failed, trades, buyers, buy_sol, sell_sol, vsol_end) VALUES (?,?,?,?,?,?,?,?,?)`);

async function reconstruct(row: any): Promise<void> {
  const mint: string = row.mint;
  const tag = `${(row.symbol ?? mint.slice(0, 6)).trim()}`;
  // signatures (newest first from the node; we want oldest first)
  const { sigs, capped } = await fetchSignatures(row.curve);
  sigs.reverse();
  if (sigs.length === 0) { db.prepare(`UPDATE hist_tokens SET status = 'empty', sigs = 0, updated_at = ? WHERE mint = ?`).run(Date.now(), mint); log(`[history] ${tag}: no curve transactions`); return; }
  const t0 = (sigs.find((s) => s.blockTime)?.blockTime ?? 0) * 1000;
  const hoursTx = new Map<number, { txs: number; failed: number }>();
  for (const s of sigs) if (s.blockTime) { const h = Math.floor((s.blockTime * 1000 - t0) / 3600_000); const a = hoursTx.get(h) ?? { txs: 0, failed: 0 }; a.txs++; if (s.err) a.failed++; hoursTx.set(h, a); }
  const okSigs = sigs.filter((s) => !s.err);
  db.prepare(`UPDATE hist_tokens SET status = 'sigs', sigs = ?, sigs_failed = ?, sigs_capped = ?, first_ts = COALESCE(first_ts, ?), created_at = COALESCE(created_at, ?), updated_at = ? WHERE mint = ?`).run(sigs.length, sigs.length - okSigs.length, capped ? 1 : 0, t0, t0, Date.now(), mint);
  log(`[history] ${tag}: ${sigs.length} curve transactions (${sigs.length - okSigs.length} failed bot attempts)${capped ? " (capped)" : ""} over ${((sigs[sigs.length - 1].blockTime! * 1000 - t0) / 3600_000).toFixed(1)} h; decoding ${Math.min(MAX_TXS, okSigs.length)} successful ones`);
  // transactions (failed signatures carry no events and are not fetched)
  const { trades, creator, name, symbol, fetched } = await fetchTrades(mint, okSigs.slice(0, MAX_TXS));
  const dev = creator ?? row.creator ?? null;
  db.prepare("BEGIN").run();
  try {
    for (const t of trades) insTrade.run(mint, t.sig, t.idx, t.ts, t.slot, t.wallet, t.side, t.sol, t.tokens, t.vsol, t.vtok, dev && t.wallet === dev ? 1 : 0);
    // per-hour aggregates
    const hours = new Map<number, { trades: number; buyers: Set<string>; buy: number; sell: number; vsol: number }>();
    for (const t of trades) {
      const h = Math.floor((t.ts - t0) / 3600_000);
      let a = hours.get(h);
      if (!a) { a = { trades: 0, buyers: new Set(), buy: 0, sell: 0, vsol: t.vsol }; hours.set(h, a); }
      a.trades++;
      if (t.side === "buy") { a.buyers.add(t.wallet); a.buy += t.sol; } else a.sell += t.sol;
      a.vsol = t.vsol;
    }
    for (const [h, n] of hoursTx) { const a = hours.get(h); insAct.run(mint, h, n.txs, n.failed, a?.trades ?? 0, a?.buyers.size ?? 0, a?.buy ?? 0, a?.sell ?? 0, a?.vsol ?? null); }
    // summary
    const buyers = new Set(trades.filter((t) => t.side === "buy").map((t) => t.wallet)).size;
    const devBought = trades.filter((t) => dev && t.wallet === dev && t.side === "buy").reduce((s, t) => s + t.tokens, 0);
    const devSold = trades.filter((t) => dev && t.wallet === dev && t.side === "sell").reduce((s, t) => s + t.tokens, 0);
    const devFirst = trades.find((t) => dev && t.wallet === dev && t.side === "buy" && t.ts - (trades[0]?.ts ?? t0) < 60_000);
    const grad = trades.find((t) => t.vsol >= GRAD_V_SOL * 0.995);
    const launchPrice = trades.length ? trades[0].vsol / trades[0].vtok : null;
    const peakX = launchPrice ? Math.max(...trades.map((t) => t.vsol / t.vtok)) / launchPrice : null;
    // A rebuild that could not read every transaction is partial, however many it did read. 188 of 2,729 rows were
    // stored as "done" on incomplete fetches (SCI-BOT: 607 of 1,925, recording 560 trades where the full history has
    // 1,812) — an undercount that lands squarely on buyer counts and dev share. Absence of data is not a finding.
    const wanted = Math.min(MAX_TXS, okSigs.length);
    const status = trades.length === 0 ? "no-trades" : (okSigs.length > MAX_TXS || fetched < wanted) ? "partial" : "done";
    db.prepare(`UPDATE hist_tokens SET status = ?, creator = COALESCE(?, creator), name = COALESCE(name, ?), symbol = COALESCE(symbol, ?), txs_fetched = ?, trades = ?, buyers = ?, dev_pct = ?, dev_buy_pct = ?,
      first_ts = ?, last_ts = ?, grad_ts = ?, graduated_min = ?, peak_x = ?, updated_at = ? WHERE mint = ?`)
      .run(status, dev, name, symbol, fetched, trades.length, buyers, Math.max(0, devBought - devSold) / 1e7, devFirst ? devFirst.tokens / 1e7 : 0, trades[0]?.ts ?? t0, trades[trades.length - 1]?.ts ?? null,
        grad?.ts ?? null, grad ? (grad.ts - (trades[0]?.ts ?? t0)) / 60_000 : null, peakX, Date.now(), mint);
  } finally { db.prepare("COMMIT").run(); }
  const g = trades.find((t) => t.vsol >= GRAD_V_SOL * 0.995);
  const devPct = Math.max(0, trades.filter((t) => dev && t.wallet === dev && t.side === "buy").reduce((s, t) => s + t.tokens, 0) - trades.filter((t) => dev && t.wallet === dev && t.side === "sell").reduce((s, t) => s + t.tokens, 0)) / 1e7;
  log(`[history] ${tag}: ${trades.length} trades, ${buyersOf(trades)} buyers, dev ${devPct.toFixed(1)} %${g ? `, graduated at ${((g.ts - trades[0].ts) / 60_000).toFixed(0)} min` : ", not graduated on curve"}`);
}
const buyersOf = (trades: Tr[]) => new Set(trades.filter((t) => t.side === "buy").map((t) => t.wallet)).size;

function report(): void {
  const rows = db.prepare(`SELECT symbol, source, status, datetime(created_at/1000,'unixepoch') created, round(ath_usd/1e6,2) ath_musd, round(mcap_usd/1e6,2) now_musd, sigs, sigs_failed, trades, buyers, round(dev_buy_pct,1) dev_buy, round(dev_pct,1) dev_pct, round(graduated_min) grad_min, round(peak_x,1) peak_x,
      (SELECT buyers FROM hist_activity a WHERE a.mint = t.mint AND hour = 0) b_h0, (SELECT buyers FROM hist_activity a WHERE a.mint = t.mint AND hour = 1) b_h1, (SELECT buyers FROM hist_activity a WHERE a.mint = t.mint AND hour = 2) b_h2
    FROM hist_tokens t ORDER BY ath_usd DESC NULLS LAST, created_at`).all() as any[];
  const counts = db.prepare(`SELECT status, COUNT(*) n FROM hist_tokens GROUP BY status`).all() as any[];
  console.log(`hist_tokens: ${counts.map((c) => `${c.status} ${c.n}`).join(", ")}`);
  console.log(["symbol", "source", "status", "created", "ath $M", "now $M", "sigs", "failed", "trades", "buyers", "dev buy%", "dev end%", "grad min", "peak x", "buyers h0/h1/h2"].map((h, i) => h.padEnd(i === 0 ? 12 : i === 1 ? 22 : 9)).join(" "));
  for (const r of rows) console.log([r.symbol ?? "?", r.source, r.status, (r.created ?? "").slice(0, 16), r.ath_musd, r.now_musd, r.sigs, r.sigs_failed, r.trades, r.buyers, r.dev_buy, r.dev_pct, r.grad_min, r.peak_x, `${r.b_h0 ?? "-"}/${r.b_h1 ?? "-"}/${r.b_h2 ?? "-"}`].map((v, i) => String(v ?? "").padEnd(i === 0 ? 12 : i === 1 ? 22 : 9)).join(" "));
}

// ---- main ----
const pendingStmt = db.prepare(`SELECT * FROM hist_tokens WHERE status IN ('new', 'sigs') AND (error IS NULL OR updated_at < ?) ORDER BY CASE source WHEN 'db-late-grad' THEN 1 ELSE 0 END, created_at DESC LIMIT ?`);
async function runBatch(limit: number): Promise<number> {
  const todo = pendingStmt.all(Date.now() - 6 * 3600_000, limit) as any[];
  const pending = (db.prepare(`SELECT COUNT(*) n FROM hist_tokens WHERE status IN ('new', 'sigs')`).get() as any).n;
  log(`[history] ${pending} candidates pending; reconstructing ${todo.length} this run (max ${MAX_TXS} successful txs each, newest first)`);
  for (const row of todo) {
    try { await reconstruct(row); } catch (e) { db.prepare(`UPDATE hist_tokens SET error = ?, updated_at = ? WHERE mint = ?`).run((e as Error).message, Date.now(), row.mint); log(`[history] ${row.symbol ?? row.mint}: ${(e as Error).message}`); }
  }
  return todo.length;
}
if (flag("report")) { report(); process.exit(0); }
if (MINTS_FILE) collectFile(MINTS_FILE);
if (flag("db-late-grads")) collectDbLateGrads();
if (flag("daemon")) {
  // unattended: refresh the candidate list every 6 h, rebuild whatever is pending, rest when idle. launchd: com.pumpmonitor.history
  let lastCollect = 0;
  for (;;) {
    if (Date.now() - lastCollect > 6 * 3600_000) { try { await collectPumpFun(); if (flag("db-late-grads")) collectDbLateGrads(); } catch (e) { log(`[history] collect: ${(e as Error).message}`); } lastCollect = Date.now(); }
    const n = await runBatch(LIMIT);
    log(`[history] batch done; ${rpcStats()}`);
    await new Promise((r) => setTimeout(r, n === 0 ? 30 * 60_000 : 5_000));
  }
}
if ((!MINTS_FILE && !flag("db-late-grads")) || flag("pumpfun")) await collectPumpFun();
await runBatch(LIMIT);
log(`[history] done; ${rpcStats()}`);
report();
