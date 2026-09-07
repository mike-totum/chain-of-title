/**
 * Hourly on-chain snapshots of every graduated token's PumpSwap pool (market cap in SOL and SOL in the pool),
 * so slow strategies (hold for hours or days) can be backtested on real reserves rather than indexer prices.
 *
 *   npm run snapshots            # one sweep; installed as an hourly launchd job (com.pumpmonitor.snapshots)
 *
 * Universe: tokens that graduated (or were discovered post-graduation) in the last 72 h. Pools missing from
 * pump.fun are looked up on DexScreener in batches of 30. Pools that were already dead (< 5 SOL) more than
 * 6 h after graduation are not re-read. Rows go to outcome_snapshots(mint, ts, mcap_sol, pool_sol).
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { ensureOutcomeTable, poolReserves } from "./outcomes.ts";

const db = openDb(config.dbPath);
ensureOutcomeTable(db);
db.exec(`CREATE TABLE IF NOT EXISTS outcome_snapshots (mint TEXT NOT NULL, ts INTEGER NOT NULL, mcap_sol REAL, pool_sol REAL, PRIMARY KEY (mint, ts))`);
db.exec(`CREATE INDEX IF NOT EXISTS snap_ts ON outcome_snapshots(ts)`);
const WSOL = "So11111111111111111111111111111111111111112";
const now = Date.now();
const since = now - 72 * 3600_000;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface Row { mint: string; symbol: string; graduated_at: number | null; created_at: number; pool: string | null; last_pool_sol: number | null; last_ts: number | null }
const rows = db
  .prepare(
    `SELECT t.mint, t.symbol, t.graduated_at, t.created_at, COALESCE(t.pool, o.pool) pool,
            (SELECT pool_sol FROM outcome_snapshots s WHERE s.mint = t.mint ORDER BY ts DESC LIMIT 1) last_pool_sol,
            (SELECT ts FROM outcome_snapshots s WHERE s.mint = t.mint ORDER BY ts DESC LIMIT 1) last_ts
     FROM tokens t LEFT JOIN token_outcomes o ON o.mint = t.mint
     WHERE t.graduated = 1 AND COALESCE(t.graduated_at, t.created_at) >= ?`,
  )
  .all(since) as unknown as Row[];

const ins = db.prepare(`INSERT OR REPLACE INTO outcome_snapshots (mint, ts, mcap_sol, pool_sol) VALUES (?,?,?,?)`);
let read = 0, dead = 0, failed = 0, skippedFresh = 0, found = 0, viaRpc = 0;
const want = rows.filter((r) => {
  const ageH = (now - (r.graduated_at ?? r.created_at)) / 3600_000;
  if (r.last_pool_sol !== null && r.last_pool_sol < 5 && ageH > 6) { dead++; return false; }
  if (r.last_ts !== null && now - r.last_ts < 40 * 60_000) { skippedFresh++; return false; }
  return true;
});
const missing = rows.filter((r) => !r.pool).length;
// 1) DexScreener, 30 mints per call: pool address + reserves (trusted when they agree with the quoted price)
const needRpc: Row[] = [];
for (let i = 0; i < want.length; i += 30) {
  const batch = want.slice(i, i + 30);
  const got = new Set<string>();
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.map((r) => r.mint).join(",")}`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j: any = await res.json();
      for (const p of j?.pairs ?? []) {
        if (p?.dexId !== "pumpswap" || typeof p?.pairAddress !== "string") continue;
        if (p?.quoteToken?.address !== WSOL) continue; // USDC-quoted pairs report reserves in dollars, not SOL
        const r = batch.find((x) => x.mint === p?.baseToken?.address);
        if (!r || got.has(r.mint)) continue;
        if (!r.pool) { r.pool = p.pairAddress; found++; db.prepare(`UPDATE tokens SET pool = ? WHERE mint = ? AND pool IS NULL`).run(r.pool, r.mint); }
        const lb = Number(p?.liquidity?.base), lq = Number(p?.liquidity?.quote), px = Number(p?.priceNative);
        const agree = px > 0 && px / (lq / lb) < 2 && px / (lq / lb) > 0.5;
        // reserves that agree with the quoted price are the snapshot; a pool DexScreener itself shows as drained (< 5 SOL) is
        // recorded as dead without an RPC read; only a live pool with self-contradicting numbers goes to the RPC fallback
        if (lb > 0 && lq > 0 && (agree || lq < 5)) { ins.run(r.mint, now, (lq / lb) * 1e9, lq); read++; got.add(r.mint); }
      }
    } else await new Promise((r) => setTimeout(r, 2000));
  } catch {}
  for (const r of batch) if (!got.has(r.mint) && r.pool) needRpc.push(r);
  await new Promise((r) => setTimeout(r, 300));
}
// 2) RPC fallback for pools DexScreener lacks or disagrees with itself on; bounded so the hourly cadence holds
const deadline = now + 40 * 60_000;
for (const r of needRpc) {
  if (Date.now() > deadline) { failed += 1; continue; }
  const res = await poolReserves(r.pool!, r.mint);
  if (!res) { failed++; continue; }
  ins.run(r.mint, now, res.priceSol * 1e9, res.quoteSol);
  read++; viaRpc++;
}
const total = (db.prepare(`SELECT COUNT(*) n FROM outcome_snapshots`).get() as any).n;
log(`[snapshots] ${rows.length} graduated tokens in 72h, ${missing} lacked a pool (${found} found on DexScreener); read ${read} (${viaRpc} via RPC), dead-skipped ${dead}, fresh-skipped ${skippedFresh}, failed ${failed}; ${total} rows total`);
