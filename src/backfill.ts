/**
 * On-demand provenance for a token we never watched.
 *
 *   npm run backfill -- <mint> [--force]
 *
 * The archive only covers launches since the collector started, so every older mint answered UNKNOWN - fine as a
 * discipline, useless as a product. A pump.fun token's bonding curve is a single account whose entire transaction
 * history is bounded (hundreds to a few thousand signatures) and, on an archival endpoint, fully readable. So the
 * launch record can be rebuilt: creator, what the creator took in the first block, every distinct outside buyer on
 * the curve, how long the curve took to fill, whether one wallet took it whole, whether the creator sold.
 *
 * **This is not the same thing as having watched.** Two differences are recorded rather than glossed:
 *   - Completeness is checked and stored. If signature paging hits its cap, or transactions could not be fetched, the
 *     rebuild is partial (`rebuilt_complete = 0`) and certifies nothing. A truncated history looks exactly like a
 *     quiet launch, which is the failure mode this whole project keeps running into.
 *   - Off-chain launch metadata is genuinely gone. The name, image and socials live behind an IPFS `uri` that the
 *     operator can repoint or unpin, so what a token *claimed to be* at launch is only known if we saw it then.
 *
 * Reconstructed trades go to `hist_trades`, not `trades`, so live observation and rebuilt history stay physically
 * separate and a reader can always tell which produced an answer.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { decodeCreate, decodeTrade, PUMP_PROGRAM } from "./feed/rpc.ts";
import { bondingCurveAddress, rpc } from "./rpc-http.ts";
import { BUYOUT_SOL } from "./provenance.ts";

const GRAD_V_SOL = 115;
const MAX_PAGES = 40;          // 40k signatures; beyond this a curve is not a normal launch
const CONCURRENCY = 8;
const ARCHIVAL = /helius|mainnet-beta|quiknode|quicknode|triton|rpcpool|alchemy/i;

/**
 * Does a bonding curve for this mint exist at all? One RPC call, so a request for a mint that is not a pump.fun token
 * (a typo, an SPL token, a wallet address) is refused before anything is queued.
 *
 * The test is account ownership, not transaction history. The curve address is a PDA derived from the mint, so it can
 * be computed for *any* address, and `getSignaturesForAddress` answers for an address that has merely appeared in some
 * transaction - it returned a signature for USDC's derived curve, sending a non-pump.fun token down the expensive
 * rebuild path the guard exists to prevent. An account owned by the pump.fun program is the actual question.
 */
export async function curveExists(mint: string): Promise<boolean> {
  try {
    const res = await rpc("getAccountInfo", [bondingCurveAddress(mint), { encoding: "base64", commitment: "confirmed" }], 15_000);
    return res?.value?.owner === PUMP_PROGRAM;
  } catch { return false; }
}

export interface Rebuilt {
  mint: string;
  complete: boolean;
  reason: string | null;        // why it is incomplete, when it is
  creator: string | null;
  name: string | null;
  symbol: string | null;
  createdAt: number | null;
  devPct: number;               // share of supply the creator took in the creation transaction
  devSold: boolean;
  curveBuyers: number;          // distinct non-creator wallets that bought on the curve
  graduatedAt: number | null;
  biggestBuy: { wallet: string; sol: number; ts: number } | null;
  trades: number;
  sigs: number;
  sigsFailed: number;
}

interface Sig { signature: string; err: unknown; slot: number; blockTime?: number }

/**
 * Page the curve account's whole signature history. `capped` means we stopped early and the record is partial.
 * `maxSigs` bounds the work for a caller that did not choose it - a request from the open internet must not be able
 * to commission an unbounded number of RPC calls.
 */
async function signatures(curve: string, maxSigs = Infinity): Promise<{ sigs: Sig[]; capped: boolean }> {
  const all: Sig[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Sig[] = await rpc("getSignaturesForAddress", [curve, { limit: 1000, ...(before ? { before } : {}), commitment: "confirmed" }], 30_000);
    // A non-archival node answers [] for an account it never indexed, which is indistinguishable from "no history".
    // Only an archival endpoint's empty first page is final.
    if (res.length === 0 && page === 0) res = await rpc("getSignaturesForAddress", [curve, { limit: 1000, commitment: "confirmed" }], 30_000, ARCHIVAL);
    all.push(...res);
    if (res.length < 1000) return { sigs: all, capped: false };
    if (all.length >= maxSigs) return { sigs: all, capped: true };
    before = res[res.length - 1].signature;
  }
  return { sigs: all, capped: true };
}

export async function rebuild(mint: string, opts: { maxSigs?: number } = {}): Promise<Rebuilt> {
  const curve = bondingCurveAddress(mint);
  const { sigs, capped } = await signatures(curve, opts.maxSigs);
  const ok = sigs.filter((s) => !s.err);
  const failedSigs = sigs.length - ok.length;

  const results: any[] = new Array(ok.length).fill(undefined);
  let unfetched = 0, cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= ok.length) return;
      for (let attempt = 0; ; attempt++) {
        try {
          // The endpoint pool includes non-archival nodes, which answer `null` for anything older than their
          // retention rather than erroring. Retries are pinned to archival endpoints so a null means "not on chain",
          // not "asked the wrong node" - without this, 741 of 1,925 transactions came back empty.
          const tx = await rpc("getTransaction", [ok[i].signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], 30_000, attempt === 0 ? undefined : ARCHIVAL);
          // A node that does not hold the transaction answers `result: null` - no error is thrown. Counting that as a
          // successful fetch made a rebuild missing 1,300 of 1,925 transactions report itself complete, and silently
          // dropped the creator's own opening buy. An empty answer is a failure to read, not a reading of nothing.
          if (tx === null || tx === undefined) { if (attempt === 3) { results[i] = null; unfetched++; break; } continue; }
          results[i] = tx;
          break;
        } catch {
          if (attempt === 3) { results[i] = null; unfetched++; break; }
        }
      }
    }
  }));

  // Collect every trade first: the creator's identity is carried on the trade events themselves, so nothing can be
  // classified as the creator's or an outsider's until the whole set has been read. (The CreateEvent is not reliably
  // present in the curve account's own history, which is why requiring it rejected valid rebuilds.)
  type T = { ts: number; wallet: string; buy: boolean; sol: number; tokens: number; vsol: number };
  const trades: T[] = [];
  let creator: string | null = null, name: string | null = null, symbol: string | null = null;

  for (let k = 0; k < ok.length; k++) {
    const tx = results[k];
    if (!tx || tx.meta?.err) continue;
    for (const l of (tx.meta?.logMessages ?? []) as string[]) {
      if (!l.startsWith("Program data: ")) continue;
      const d = Buffer.from(l.slice(14), "base64");
      if (d.length < 8) continue;
      const c = decodeCreate(d);
      if (c && c.mint === mint) { creator = c.creator ?? c.user ?? creator; name = c.name ?? name; symbol = c.symbol ?? symbol; continue; }
      const t = decodeTrade(d);
      if (!t || t.mint !== mint) continue;
      if (!creator && t.creator) creator = t.creator;
      trades.push({
        ts: (t.timestamp || tx.blockTime || ok[k].blockTime || 0) * 1000,
        wallet: t.user, buy: t.isBuy, sol: t.solAmount, tokens: t.tokenAmount, vsol: t.vSol,
      });
    }
  }
  trades.sort((a, b) => a.ts - b.ts);

  // The curve's first trade is the creation transaction's own buy, so it dates the launch.
  const createdAt = trades.length ? trades[0].ts : null;
  const dev = creator;
  // "Creator took X% of supply in the first block" - their buy at creation, matching what the live collector records,
  // not their net holdings later. 1% of the 1B supply is 1e7 tokens.
  const devFirst = trades.find((t) => dev && t.wallet === dev && t.buy && t.ts - (trades[0]?.ts ?? 0) < 60_000);
  const devPct = devFirst ? devFirst.tokens / 1e7 : 0;
  const devSold = trades.some((t) => dev && t.wallet === dev && !t.buy);
  const buyers = new Set(trades.filter((t) => t.buy && t.wallet !== dev).map((t) => t.wallet));
  const grad = trades.find((t) => t.vsol >= GRAD_V_SOL * 0.995);
  const graduatedAt = grad ? grad.ts : null;
  let biggest: Rebuilt["biggestBuy"] = null;
  for (const t of trades) if (t.buy && t.wallet !== dev && (!biggest || t.sol > biggest.sol)) biggest = { wallet: t.wallet, sol: t.sol, ts: t.ts };
  const tradeCount = trades.length;

  // A rebuild is only usable if we could read every transaction. A partial history understates buyers, dev share and
  // buyouts alike - always in the direction that makes a manufactured launch look ordinary.
  let reason: string | null = null;
  if (capped) reason = `this curve has more than ${sigs.length.toLocaleString()} transactions - more than we rebuild on demand`;
  else if (unfetched > 0) reason = `${unfetched} of ${ok.length} transactions could not be fetched`;
  else if (!trades.length) reason = "no pump.fun curve trades found for this mint";
  else if (!creator) reason = "the creator wallet could not be identified from any trade event";

  return {
    mint, complete: reason === null, reason, creator, name, symbol, createdAt,
    devPct, devSold,
    curveBuyers: buyers.size, graduatedAt, biggestBuy: biggest,
    trades: tradeCount, sigs: sigs.length, sigsFailed: failedSigs,
  };
}

/** Persist a rebuild: token row plus its curve trades in `hist_trades`, never in the live `trades` table. */
export function store(db: any, r: Rebuilt): void {
  db.prepare(`INSERT INTO tokens (mint, name, symbol, creator, created_at, late_discovery, dev_pct, dev_sold,
      unique_buyers, graduated, graduated_at, rebuilt_at, rebuilt_complete, updated_at)
    VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?,?)
    ON CONFLICT(mint) DO UPDATE SET
      -- Precedence. A launch we watched live is the better record and a rebuild only fills its gaps, so COALESCE
      -- keeps observed values. But a row whose data came from an *earlier rebuild* (rebuilt_at is set) must be
      -- replaceable, or a first attempt that was wrong is preserved forever: the first run here recorded the wrong
      -- creator and 0.0% creator supply, and re-running with the fix could not correct it.
      name = COALESCE(tokens.name, excluded.name), symbol = COALESCE(tokens.symbol, excluded.symbol),
      creator = CASE WHEN excluded.rebuilt_complete = 1 AND tokens.rebuilt_at IS NOT NULL THEN excluded.creator ELSE COALESCE(tokens.creator, excluded.creator) END,
      created_at = CASE WHEN excluded.rebuilt_complete = 1 AND tokens.rebuilt_at IS NOT NULL THEN excluded.created_at ELSE COALESCE(tokens.created_at, excluded.created_at) END,
      dev_pct = CASE WHEN excluded.rebuilt_complete = 1 AND tokens.rebuilt_at IS NOT NULL THEN excluded.dev_pct ELSE COALESCE(tokens.dev_pct, excluded.dev_pct) END,
      dev_sold = CASE WHEN excluded.rebuilt_complete = 1 AND tokens.rebuilt_at IS NOT NULL THEN excluded.dev_sold ELSE MAX(COALESCE(tokens.dev_sold,0), COALESCE(excluded.dev_sold,0)) END,
      unique_buyers = CASE WHEN excluded.rebuilt_complete = 1 AND tokens.rebuilt_at IS NOT NULL THEN excluded.unique_buyers ELSE MAX(COALESCE(tokens.unique_buyers,0), COALESCE(excluded.unique_buyers,0)) END,
      graduated = MAX(COALESCE(tokens.graduated,0), COALESCE(excluded.graduated,0)),
      graduated_at = CASE WHEN excluded.rebuilt_complete = 1 AND tokens.rebuilt_at IS NOT NULL THEN excluded.graduated_at ELSE COALESCE(tokens.graduated_at, excluded.graduated_at) END,
      rebuilt_at = excluded.rebuilt_at, rebuilt_complete = excluded.rebuilt_complete,
      updated_at = excluded.updated_at`)
    .run(r.mint, r.name, r.symbol, r.creator, r.createdAt, r.devPct, r.devSold ? 1 : 0,
      r.curveBuyers, r.graduatedAt !== null ? 1 : 0, r.graduatedAt, Date.now(), r.complete ? 1 : 0, Date.now());

  // Only a buy large enough to *be* a buyout belongs in the buyout table. Writing the largest buy unconditionally
  // invented a curve-buyout record for every rebuilt token, including one whose biggest buy rounded to 0 SOL, and
  // those rows feed the wallet profiles on the operator pages.
  if (r.biggestBuy && r.biggestBuy.sol >= BUYOUT_SOL) {
    db.prepare(`INSERT OR REPLACE INTO hist_trades (mint, sig, idx, ts, slot, wallet, side, sol, tokens, vsol, vtok, is_dev)
      VALUES (?, ?, 0, ?, 0, ?, 'buy', ?, 0, 0, 0, 0)`)
      .run(r.mint, `rebuild:${r.mint}:${r.biggestBuy.wallet}`, r.biggestBuy.ts, r.biggestBuy.wallet, r.biggestBuy.sol);
  }
}

// ---------- CLI ----------
if (import.meta.filename === process.argv[1]) {
  const mint = process.argv[2];
  if (!mint || mint.startsWith("--")) { console.error("usage: npm run backfill -- <mint>"); process.exit(1); }
  const db = openDb(config.dbPath);
  const existing = db.prepare("SELECT rebuilt_at, rebuilt_complete FROM tokens WHERE mint = ?").get(mint) as any;
  if (existing?.rebuilt_at && existing.rebuilt_complete && !process.argv.includes("--force")) {
    console.log("already rebuilt (provenance is immutable; pass --force to redo)");
    process.exit(0);
  }
  const t0 = Date.now();
  const r = await rebuild(mint);
  store(db, r);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${r.symbol ?? "?"}  ${mint}`);
  console.log(`  rebuilt from ${r.sigs} signatures (${r.sigsFailed} failed on chain), ${r.trades} curve trades, in ${secs}s`);
  if (!r.complete) { console.log(`  [UNKNOWN] incomplete: ${r.reason}. This cannot certify anything.`); process.exit(0); }
  console.log(`  created         ${r.createdAt ? new Date(r.createdAt).toISOString() : "?"}`);
  console.log(`  creator         ${r.creator ?? "?"}`);
  console.log(`  creator took    ${r.devPct.toFixed(1)}% of supply in the first block`);
  console.log(`  outside buyers  ${r.curveBuyers} distinct wallets on the curve`);
  console.log(`  graduated       ${r.graduatedAt ? `${((r.graduatedAt - (r.createdAt ?? r.graduatedAt)) / 60000).toFixed(1)} min after launch` : "no"}`);
  console.log(`  creator sold    ${r.devSold ? "yes" : "no"}`);
  if (r.biggestBuy) console.log(`  largest buy     ${r.biggestBuy.sol.toFixed(1)} SOL by ${r.biggestBuy.wallet}`);
  console.log(`\n  Rebuilt from chain history, not watched live. Off-chain launch metadata (name, image, socials) is`);
  console.log(`  whatever the URI resolves to today, which the operator can change.\n`);
}
