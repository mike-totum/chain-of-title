/**
 * Outcome lookup for any pump.fun mint, including ones the monitor never saw live.
 * Primary: pump.fun frontend API (creation time, graduation, market cap).
 * Fallback: DexScreener (pair creation time, PumpSwap/Raydium pair => graduated, FDV).
 * Results are cached in the `token_outcomes` table.
 */
import type { DatabaseSync } from "node:sqlite";
import { rpc } from "./rpc-http.ts";

const RPC_HTTP = (process.env.SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const WSOL = "So11111111111111111111111111111111111111112";

/**
 * The same reading as `poolReserves`, but through the managed endpoint pool (`SOLANA_RPC_URLS`, with per-endpoint
 * back-off) instead of the single public node pinned above - which our own collector keeps saturated, so a batch of
 * reads from it returns HTTP 429 rather than balances.
 *
 * That distinction is not a performance detail. A failed read makes a token uncertifiable, so reading through a
 * rate-limited endpoint silently converts "we could not check" into "not clean" across a whole run: the first site
 * build to re-read pools lost 133 of 249 this way and reported zero clean launches in 24 h. Batch callers must use
 * this; the live collector keeps `poolReserves`, which is paced for a single token at a time.
 */
export async function poolReservesPooled(pool: string, mint: string): Promise<{ priceSol: number; quoteSol: number; baseTokens: number } | null> {
  const vault = async (m: string): Promise<number | null> => {
    try {
      const j = await rpc("getTokenAccountsByOwner", [pool, { mint: m }, { encoding: "jsonParsed" }], 15_000);
      return (j?.value ?? []).reduce((a: number, x: any) => a + Number(x.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
    } catch { return null; }
  };
  const [baseTokens, quoteSol] = await Promise.all([vault(mint), vault(WSOL)]);
  if (baseTokens === null || quoteSol === null || !(baseTokens > 0)) return null;
  return { priceSol: quoteSol / baseTokens, quoteSol, baseTokens };
}

/** Read a PumpSwap pool's vaults directly: SOL per token from actual reserves, and how much SOL sits in the pool. */
export async function poolReserves(pool: string, mint: string): Promise<{ priceSol: number; quoteSol: number; baseTokens: number } | null> {
  const get = async (m: string) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(RPC_HTTP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [pool, { mint: m }, { encoding: "jsonParsed" }] }), signal: AbortSignal.timeout(8000) });
      if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; } // public RPC rate limit: back off, retry
      const j: any = await res.json();
      if (j?.error) throw new Error(j.error.message ?? "rpc error");
      return (j?.result?.value ?? []).reduce((a: number, x: any) => a + Number(x.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0) as number;
    }
  };
  try {
    await gap(150);
    const [baseTokens, quoteSol] = await Promise.all([get(mint), get(WSOL)]);
    if (!(baseTokens > 0)) return null;
    return { priceSol: quoteSol / baseTokens, quoteSol, baseTokens };
  } catch {
    return null;
  }
}

export interface Outcome {
  mint: string;
  name: string | null;
  symbol: string | null;
  createdAt: number | null; // ms
  graduated: boolean;
  mcapUsd: number | null;
  /** market cap in SOL. Verified from the PumpSwap pool's own reserves when a pool is known; else API-reported (untrusted) */
  mcapSol: number | null;
  /** SOL actually sitting in the pool (null = unknown). Wash-printed "runners" have a huge reported mcap and ~1 SOL here. */
  poolSol: number | null;
  verified: boolean;
  source: string;
  fetchedAt: number;
}

export function ensureOutcomeTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS token_outcomes (
    mint TEXT PRIMARY KEY, name TEXT, symbol TEXT, created_at INTEGER, graduated INTEGER, mcap_usd REAL, source TEXT, fetched_at INTEGER
  )`);
  try {
    db.exec(`ALTER TABLE token_outcomes ADD COLUMN mcap_sol REAL`);
  } catch {}
  for (const col of ["pool_sol REAL", "verified INTEGER DEFAULT 0", "pool TEXT"]) {
    try {
      db.exec(`ALTER TABLE token_outcomes ADD COLUMN ${col}`);
    } catch {}
  }
}

let lastCall = 0;
async function gap(ms: number) {
  const w = lastCall + ms - Date.now();
  if (w > 0) await new Promise((r) => setTimeout(r, w));
  lastCall = Date.now();
}

async function fromPumpFun(mint: string): Promise<Outcome | null> {
  await gap(350);
  const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const j: any = await res.json();
  if (!j?.mint) return null;
  return {
    mint,
    name: j.name ?? null,
    symbol: j.symbol ?? null,
    createdAt: typeof j.created_timestamp === "number" ? j.created_timestamp : null,
    graduated: Boolean(j.complete || j.raydium_pool || j.pump_swap_pool),
    mcapUsd: typeof j.usd_market_cap === "number" ? j.usd_market_cap : null,
    mcapSol: typeof j.market_cap === "number" ? j.market_cap : null,
    poolSol: null,
    verified: false,
    source: "pump.fun",
    fetchedAt: Date.now(),
    pool: typeof j.pump_swap_pool === "string" ? j.pump_swap_pool : null,
  } as Outcome & { pool: string | null };
}

async function fromDexScreener(mint: string): Promise<Outcome | null> {
  await gap(250);
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j: any = await res.json();
  const pairs: any[] = j?.pairs ?? [];
  if (!pairs.length) return null;
  const created = pairs.map((p) => p.pairCreatedAt).filter((x) => typeof x === "number");
  const ps = pairs.find((p) => p.dexId === "pumpswap" && p?.quoteToken?.address === WSOL) ?? null; // SOL-quoted only: a USDC pair reports reserves in dollars
  // the pair's reported reserves; trusted only when they agree with the quoted price (a stale/dead pool can disagree by 5x+)
  const lb = Number(ps?.liquidity?.base), lq = Number(ps?.liquidity?.quote), px = Number(ps?.priceNative);
  const liq = lb > 0 && lq > 0 && px > 0 && px / (lq / lb) < 2 && px / (lq / lb) > 0.5 ? { base: lb, quote: lq } : null;
  return {
    mint,
    name: pairs[0]?.baseToken?.name ?? null,
    symbol: pairs[0]?.baseToken?.symbol ?? null,
    createdAt: created.length ? Math.min(...created) : null,
    graduated: pairs.some((p) => p.dexId && p.dexId !== "pumpfun"),
    mcapUsd: Math.max(...pairs.map((p) => (typeof p.fdv === "number" ? p.fdv : 0))) || null,
    mcapSol: Math.max(...pairs.map((p) => Number(p.priceNative) * 1e9 || 0)) || null,
    poolSol: null,
    verified: false,
    source: "dexscreener",
    fetchedAt: Date.now(),
    pool: ps?.pairAddress ?? null,
    liq,
  } as Outcome & { pool: string | null; liq: { base: number; quote: number } | null };
}

/** Cached lookup. `maxAgeMs` controls how stale a cached row may be (graduation status can change). */
export async function getOutcome(db: DatabaseSync, mint: string, maxAgeMs = 6 * 3600_000): Promise<Outcome | null> {
  const row = db.prepare("SELECT * FROM token_outcomes WHERE mint = ?").get(mint) as any;
  if (row && row.mcap_sol !== null && row.verified && Date.now() - row.fetched_at < maxAgeMs) {
    return { mint, name: row.name, symbol: row.symbol, createdAt: row.created_at, graduated: !!row.graduated, mcapUsd: row.mcap_usd, mcapSol: row.mcap_sol ?? null, poolSol: row.pool_sol ?? null, verified: true, source: row.source, fetchedAt: row.fetched_at };
  }
  let o: (Outcome & { pool?: string | null }) | null = null;
  try {
    o = await fromPumpFun(mint);
  } catch {}
  if (!o) {
    try {
      o = await fromDexScreener(mint);
    } catch {}
  }
  if (!o) return null;
  // API-reported prices are wash-printable: verify against the pool's reserves whenever a pool is known.
  // DexScreener reports the pool's reserves alongside the pair (one batched-friendly call, no RPC); the public RPC is
  // the fallback for pools it lacks or where its reserves disagree with its own price.
  if (!o.pool) o.pool = (db.prepare("SELECT pool FROM tokens WHERE mint = ?").get(mint) as any)?.pool ?? null;
  let liq = (o as any).liq as { base: number; quote: number } | null | undefined;
  if (o.graduated && o.source === "pump.fun" && (!o.pool || !liq)) {
    try {
      const d = (await fromDexScreener(mint)) as (Outcome & { pool?: string | null; liq?: { base: number; quote: number } | null }) | null;
      if (d?.pool && !o.pool) o.pool = d.pool;
      if (d?.liq) liq = d.liq;
    } catch {}
  }
  if (liq) {
    o.mcapSol = (liq.quote / liq.base) * 1e9;
    o.mcapUsd = null;
    o.poolSol = liq.quote;
    o.verified = true;
    o.source += "+reserves";
  } else if (o.pool) {
    const r = await poolReserves(o.pool, mint);
    if (r) {
      o.mcapSol = r.priceSol * 1e9;
      o.mcapUsd = null; // unknown SOL/USD here; SOL terms are what we use
      o.poolSol = r.quoteSol;
      o.verified = true;
      o.source += "+onchain";
    }
  }
  db.prepare(
    `INSERT OR REPLACE INTO token_outcomes (mint, name, symbol, created_at, graduated, mcap_usd, mcap_sol, pool_sol, verified, pool, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(o.mint, o.name, o.symbol, o.createdAt, o.graduated ? 1 : 0, o.mcapUsd, o.mcapSol, o.poolSol, o.verified ? 1 : 0, o.pool ?? null, o.source, o.fetchedAt);
  return o;
}
