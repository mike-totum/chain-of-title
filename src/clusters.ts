/**
 * Operator clusters: who graduates the winners, who funded them, and every other wallet the same funder seeded.
 *
 * Found 2026-09-04: the wallets that bought out the Kshama and Squads curves were born in 20-wallet batches funded by one
 * address each, and 32 of 32 sampled siblings of the Kshama funder traded the same four tokens on PumpSwap. The habit is the
 * funder → wallet farm → dormant-curve buyout → multi-wallet AMM accumulation. This tool builds the wallet list the live
 * `cluster-follow` strategy watches.
 *
 * Seeds: the wallet whose buy graduated each reconstructed winner (hist_trades), any live curve buy >= 40 SOL, and the
 * hand-traced wallets in data/operator-clusters.json. Each seed is traced to its funder (payer of its first incoming SOL),
 * each funder's outgoing transfers are sampled to enumerate its farm.
 *
 *   npm run clusters                 # trace up to --limit 120 new seeds, enumerate their funders, print the scorecard
 *   npm run clusters -- --report     # scorecard only
 *
 * Tables: operator_funders(funder, ...), operator_wallets(wallet, funder, cluster, role, ...). role: buyout | seeded | known.
 */
import { existsSync, readFileSync } from "node:fs";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { rpc, rpcStats } from "./rpc-http.ts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const LIMIT = Number(opt("limit", "120"));
const MAX_PAGES = 25; // 25k signatures: older/busier wallets are left untraced (not worth the calls)
const SAMPLE = Number(opt("sample", "60"));
const ARCHIVAL = /helius|mainnet-beta|quiknode|quicknode|triton|rpcpool|alchemy/i;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The database handle, injectable.
 *
 * This module used to open its own connection at import. Inside the collector that would be a SECOND writer against
 * the file the collector is ingesting into - the precise thing HANDOFF names as costing dropped launches, and the
 * reason this tool stayed on a laptop for a week. `traceClusters` takes the caller's handle instead, so in the
 * collector the tracing and the ingestion serialise on one connection, and the CLI still opens its own.
 */
let db = openDb(config.dbPath);
export function useDb(handle: typeof db): void { db = handle; }
db.exec(`CREATE TABLE IF NOT EXISTS operator_funders (funder TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, txs INTEGER, wallets INTEGER, seeds INTEGER, sampled_at INTEGER, note TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS operator_wallets (wallet TEXT PRIMARY KEY, funder TEXT, cluster TEXT, role TEXT, seeded_at INTEGER, source_mint TEXT, traced INTEGER DEFAULT 0, added_at INTEGER)`);
db.exec(`CREATE INDEX IF NOT EXISTS operator_wallets_funder ON operator_wallets(funder)`);
db.exec(`CREATE TABLE IF NOT EXISTS operator_policy (cluster TEXT PRIMARY KEY, policy TEXT, hold_plays INTEGER, dist_plays INTEGER, plays INTEGER, manual INTEGER DEFAULT 0, note TEXT, updated_at INTEGER)`);
/**
 * The two hand-set rows are GONE, 2026-09-12, and this is why they must not come back.
 *
 * They wrote a characterisation of two identifiable groups into every database this ever ran against - "dumps
 * into followers: Squads sold 283 SOL in 30 min, onoda drained in hours" and "holds through the flat window;
 * Kshama 660x, Simba 46x". Both were written for trading, by hand, from a sample of one or two launches each.
 * From there they travelled: into the collector, into `record.db` through servicedb, onto the public site as
 * "Cluster behaviour", into the api/v1 wallet response as `operatorPolicy`, and into the DOI deposit - which the
 * pledge says cannot be renamed, withdrawn or made private.
 *
 * A register records what was observed and never what it concluded about a party. `policy` is a grade, the notes
 * name third-party launches in prose, and the hypothesis they were written to serve was tested and rejected. The
 * generated rows below (`5 hold / 9 distribute of 15 plays`) are counts of what wallets did and are kept in the
 * collector's own database, which is a research instrument; what changed is that none of it is published any
 * more. See the `cluster-policy-published` correction.
 */
for (const col of ["parent TEXT", "hops INTEGER DEFAULT 0"]) { try { db.exec(`ALTER TABLE operator_funders ADD COLUMN ${col}`); } catch {} }
/** a funder with almost no history is a pass-through wallet; its own funder is the real source. Follow up to this many hops. */
const MAX_HOPS = Number(opt("hops", "3"));
const PASSTHROUGH_TXS = 50;
function rootOf(funder: string): string {
  const seen = new Set<string>();
  let f = funder;
  for (;;) {
    seen.add(f);
    const r = db.prepare(`SELECT parent FROM operator_funders WHERE funder = ?`).get(f) as any;
    if (!r?.parent || seen.has(r.parent)) return f;
    f = r.parent;
  }
}
const insWallet = db.prepare(`INSERT INTO operator_wallets (wallet, funder, cluster, role, seeded_at, source_mint, traced, added_at) VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(wallet) DO UPDATE SET funder = COALESCE(operator_wallets.funder, excluded.funder), cluster = COALESCE(operator_wallets.cluster, excluded.cluster),
  role = CASE WHEN operator_wallets.role = 'seeded' AND excluded.role != 'seeded' THEN excluded.role ELSE operator_wallets.role END, seeded_at = COALESCE(operator_wallets.seeded_at, excluded.seeded_at),
  source_mint = COALESCE(operator_wallets.source_mint, excluded.source_mint), traced = MAX(operator_wallets.traced, excluded.traced)`);
/**
 * Whether the reconstruction tables exist in this database.
 *
 * `hist_tokens` and `hist_trades` are written by `history.ts`, which has only ever run on a laptop. Three queries
 * here read them, and in the collector every one throws `no such table` - so wiring this module into the collector
 * made it fail on entry, on every pass, while the operator map it exists to grow sat unchanged and the published
 * archive stayed frozen behind a guard that map decides.
 *
 * Degrading rather than creating the tables: an empty `hist_tokens` would be a schema this file does not own and a
 * claim that we hold reconstructions we do not. What the tables contribute is seeds and an ordering preference -
 * useful, not required - so without them the pass does less and says nothing false.
 */
const hasHistory = (): boolean => {
  try {
    /**
     * BOTH tables, not either. The first version used `name IN (...) LIMIT 1`, which is true when only one exists -
     * and that is exactly the collector's state: `seed.ts` creates `hist_trades` in the seed database and never
     * `hist_tokens`, so the seeded collector has one of the two. The guard passed and the query on the missing table
     * threw anyway, so the fix changed nothing and looked like a deploy that had not rolled out.
     */
    const n = (db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('hist_tokens','hist_trades')")
      .get() as any).c as number;
    return n === 2;
  } catch { return false; }
};

const clusterName = (funder: string) => funder.slice(0, 6);

// ---- seeds ----
function collectSeeds(): number {
  let n = 0;
  // hand-traced clusters (data/operator-clusters.json)
  if (existsSync("data/operator-clusters.json")) {
    const j = JSON.parse(readFileSync("data/operator-clusters.json", "utf8"));
    for (const c of Object.values<any>(j.clusters ?? {})) {
      db.prepare(`INSERT OR IGNORE INTO operator_funders (funder, note) VALUES (?, 'hand-traced 2026-09-04')`).run(c.funder);
      for (const w of c.known_buyers ?? []) { insWallet.run(w, c.funder, clusterName(c.funder), "buyout", null, null, 1, Date.now()); n++; }
      for (const w of c.wallets ?? []) { insWallet.run(w, c.funder, clusterName(c.funder), "seeded", null, null, 1, Date.now()); n++; }
    }
  }
  // the wallet whose buy completed each reconstructed winner's curve - only where reconstructions exist
  if (hasHistory()) {
  const grads = db.prepare(`SELECT h.mint, (SELECT wallet FROM hist_trades t WHERE t.mint = h.mint AND t.side = 'buy' AND t.vsol >= 114.4 ORDER BY t.ts LIMIT 1) w
    FROM hist_tokens h WHERE h.status IN ('done', 'partial')`).all() as any[];
  for (const g of grads) if (g.w) { insWallet.run(g.w, null, null, "buyout", null, g.mint, 0, Date.now()); n++; }
  }
  // live curve buys >= 40 SOL (the buyout size) by anyone
  const live = db.prepare(`SELECT DISTINCT wallet, mint FROM trades WHERE market = 'curve' AND side = 'buy' AND sol >= 40`).all() as any[];
  for (const l of live) { insWallet.run(l.wallet, null, null, "buyout", null, l.mint, 0, Date.now()); n++; }
  return n;
}

// ---- tracing ----
interface Sig { signature: string; blockTime: number | null; err: unknown }
async function oldestSignatures(addr: string, maxPages: number): Promise<{ sigs: Sig[]; capped: boolean; total: number }> {
  let before: string | undefined, last: Sig[] = [], total = 0;
  for (let p = 0; p < maxPages; p++) {
    const r: Sig[] = await rpc("getSignaturesForAddress", [addr, { limit: 1000, ...(before ? { before } : {}) }], 30_000, ARCHIVAL);
    total += r.length;
    if (r.length) last = r;
    if (r.length < 1000) return { sigs: last, capped: false, total };
    before = r[r.length - 1].signature;
  }
  return { sigs: last, capped: true, total };
}
async function tx(sig: string): Promise<any> { return rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 30_000, ARCHIVAL); }
function deltas(t: any): [string, number][] {
  const keys: string[] = t.transaction.message.accountKeys.map((k: any) => k.pubkey);
  return keys.map((k, i) => [k, (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9] as [string, number]);
}

/**
 * Trading terminals, bridges and exchanges fund thousands of unrelated retail wallets, and to this tracer that is
 * indistinguishable from a wallet farm - same shape, one payer seeding many wallets that then trade the same tokens.
 * Enumerating one would fill operator_wallets with ordinary users and hand cluster-follow a permanent false signal.
 * Found 2026-09-06 when the first blind-detected buyout (PONST, 85 SOL on a curve dormant 9.5 h) traced to
 * "AxiomRXZAq1..." - a vanity address spelling the name of a Solana trading terminal. Operators do not grind a vanity
 * funder address with a product name; platforms do. Prefix match is deliberately loose: these addresses advertise.
 */
const PLATFORM_FUNDERS = new Set<string>([
  "AxiomRXZAq1Jgjj9pHmNqVP7Lhu67wLXZJZbaK87TTSk",
]);
const PLATFORM_PREFIXES = ["Axiom", "BullX", "Photon", "Trojan", "GMGN", "Bloom", "Nova", "Pepeboost", "Maestro", "Banana"];
export function isPlatformFunder(addr: string): boolean {
  if (PLATFORM_FUNDERS.has(addr)) return true;
  return PLATFORM_PREFIXES.some((p) => addr.toLowerCase().startsWith(p.toLowerCase()));
}

/** funder = payer of the wallet's first successful transaction in which the wallet received SOL */
async function traceFunder(wallet: string): Promise<{ funder: string | null; seededAt: number | null; total: number; capped: boolean }> {
  const { sigs, capped, total } = await oldestSignatures(wallet, MAX_PAGES);
  if (capped) return { funder: null, seededAt: null, total, capped };
  const ok = sigs.filter((s) => !s.err).reverse().slice(0, 3);
  for (const s of ok) {
    const t = await tx(s.signature);
    if (!t) continue;
    const d = deltas(t);
    const mine = d.find(([k]) => k === wallet)?.[1] ?? 0;
    const payer = t.transaction.message.accountKeys[0]?.pubkey;
    if (mine > 0 && payer && payer !== wallet) {
      if (isPlatformFunder(payer)) { console.log(`  funder ${payer.slice(0, 12)} looks like a trading platform, not a farm - not seeded`); return { funder: null, seededAt: null, total, capped }; }
      return { funder: payer, seededAt: (t.blockTime ?? 0) * 1000, total, capped };
    }
  }
  return { funder: null, seededAt: null, total, capped };
}

/** sample a funder's transactions and collect every wallet it sent SOL to */
async function enumerateFunder(funder: string): Promise<{ wallets: Map<string, number>; txs: number; first: number | null; last: number | null }> {
  const all: Sig[] = [];
  let before: string | undefined;
  for (let p = 0; p < 3; p++) {
    const r: Sig[] = await rpc("getSignaturesForAddress", [funder, { limit: 1000, ...(before ? { before } : {}) }], 30_000, ARCHIVAL);
    all.push(...r);
    if (r.length < 1000) break;
    before = r[r.length - 1].signature;
  }
  const ok = all.filter((s) => !s.err);
  const step = Math.max(1, Math.floor(ok.length / SAMPLE));
  const sample = ok.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const wallets = new Map<string, number>();
  for (const s of sample) {
    let t: any = null;
    try { t = await tx(s.signature); } catch {}
    if (!t) continue;
    for (const [k, d] of deltas(t)) if (k !== funder && d >= 0.005) wallets.set(k, (wallets.get(k) ?? 0) + d);
    await sleep(50);
  }
  return { wallets, txs: all.length, first: ok.length ? (ok[ok.length - 1].blockTime ?? 0) * 1000 : null, last: ok.length ? (ok[0].blockTime ?? 0) * 1000 : null };
}

// ---- scorecard ----
/** one pass over the cluster wallets' trades (indexed by wallet), reused by both tables below */
function buildClusterTrades(): void {
  db.exec(`DROP TABLE IF EXISTS temp.ct`);
  db.exec(`CREATE TEMP TABLE ct AS
    SELECT w.cluster, w.funder, tr.mint, tr.wallet, tr.side, tr.sol, tr.price, tr.ts, tr.market
    FROM operator_wallets w JOIN trades tr ON tr.wallet = w.wallet WHERE w.cluster IS NOT NULL`);
  db.exec(`CREATE INDEX temp.ct_cm ON ct(cluster, mint, ts)`);
}
function report(): void {
  buildClusterTrades();
  const rows = db.prepare(`
    WITH wal AS (SELECT cluster, COUNT(*) wallets, SUM(role = 'buyout') buyouts, COUNT(DISTINCT funder) funders FROM operator_wallets WHERE cluster IS NOT NULL GROUP BY cluster),
    hist AS (SELECT x.cluster, COUNT(DISTINCT x.source_mint) hist_wins, COUNT(DISTINCT CASE WHEN h.buyers >= 30 THEN x.source_mint END) organic
             FROM operator_wallets x JOIN hist_tokens h ON h.mint = x.source_mint WHERE x.cluster IS NOT NULL GROUP BY x.cluster),
    live AS (SELECT c.cluster, COUNT(DISTINCT c.mint) live_tokens, ROUND(SUM(CASE WHEN c.side = 'buy' THEN c.sol ELSE -c.sol END), 1) live_net_sol,
             COUNT(DISTINCT CASE WHEN o.verified AND o.mcap_sol >= 822 AND o.pool_sol >= 40 THEN c.mint END) live_big
             FROM ct c LEFT JOIN token_outcomes o ON o.mint = c.mint GROUP BY c.cluster),
    ftx AS (SELECT w.cluster, MAX(f.txs) funder_txs FROM operator_wallets w JOIN operator_funders f ON f.funder = w.funder WHERE w.cluster IS NOT NULL GROUP BY w.cluster)
    SELECT wal.*, COALESCE(hist.hist_wins, 0) hist_wins, COALESCE(hist.organic, 0) organic, COALESCE(live.live_tokens, 0) live_tokens, live.live_big, live.live_net_sol, ftx.funder_txs
    FROM wal LEFT JOIN hist ON hist.cluster = wal.cluster LEFT JOIN live ON live.cluster = wal.cluster LEFT JOIN ftx ON ftx.cluster = wal.cluster
    ORDER BY hist_wins DESC, live_big DESC, wallets DESC`).all() as any[];
  const totals = db.prepare(`SELECT COUNT(*) n, SUM(role = 'buyout') buyouts, SUM(traced) traced, SUM(funder IS NOT NULL) with_funder, COUNT(DISTINCT cluster) clusters FROM operator_wallets`).get() as any;
  const funders = db.prepare(`SELECT COUNT(*) n, SUM(parent IS NOT NULL) hopped FROM operator_funders`).get() as any;
  console.log(`\noperator_wallets: ${totals.n} (${totals.buyouts} buyout wallets, ${totals.traced} traced, ${totals.with_funder} with a funder) in ${totals.clusters} clusters; funders: ${funders.n} (${funders.hopped} pass-throughs resolved to a parent)`);
  console.log(["cluster", "wallets", "buyouts", "funders", "hist wins", "organic", "live tokens", "live big", "live net SOL", "funder txs"].map((h) => h.padEnd(13)).join(""));
  for (const r of rows.slice(0, 40)) console.log([r.cluster, r.wallets, r.buyouts, r.funders, r.hist_wins, r.organic, r.live_tokens, r.live_big, r.live_net_sol, r.funder_txs].map((v) => String(v ?? "").padEnd(13)).join(""));
  console.log("\nhist wins = reconstructed $1M+ tokens graduated by the cluster's wallets; organic = of those, >= 30 curve buyers; live big = tokens in our data the cluster traded that verify as real runners now (includes pool-capital washes: read with dev share and curve buyers); funder txs capped at 3000");
  behaviour();
}

/**
 * Hold or distribute? For every play where >= 3 wallets of one cluster traded a token on the AMM: what the farm bought and sold
 * in the first hour after its first AMM trade and afterwards, how many outside buyers came, and where the price went. A farm that
 * holds through the flat window and sells at the top is one to eat with; a farm that sells into the first hour is selling to followers.
 */
interface PlayRow { cluster: string; symbol: string; buy_h1: number; sell_h1: number; buy_later: number; sell_later: number; grad_h: number }
function verdictOf(r: PlayRow): string {
  const net1 = r.buy_h1 - r.sell_h1, netL = r.buy_later - r.sell_later;
  return r.sell_h1 > r.buy_h1 ? "DISTRIBUTE" : net1 > 0 && netL < -0.5 * (net1 + r.buy_later) ? "hold→sell" : net1 > 0 ? "HOLD" : "flat";
}
/**
 * Per-cluster policy from the behaviour table (30 days): follow = net buyer in its first hour on at least two plays and 60 % of them;
 * avoid = distributed on two or more plays and at least two thirds of them; watch = not enough evidence (entered on paper, tagged).
 * Manual rows (manual = 1) are never overwritten. cluster-follow enters for follow and watch, never for avoid.
 */
function computePolicies(): void {
  const plays = behaviourRows(30) as PlayRow[];
  const by = new Map<string, { hold: number; dist: number; n: number }>();
  for (const r of plays) {
    if (r.grad_h !== null && r.grad_h < 0.05) continue; // instant graduations are factory launches, not plays on a dormant curve
    const v = verdictOf(r);
    const a = by.get(r.cluster) ?? { hold: 0, dist: 0, n: 0 };
    a.n++;
    if (v === "HOLD" || v === "hold→sell") a.hold++;
    else if (v === "DISTRIBUTE") a.dist++;
    by.set(r.cluster, a);
  }
  const up = db.prepare(`INSERT INTO operator_policy (cluster, policy, hold_plays, dist_plays, plays, manual, note, updated_at) VALUES (?,?,?,?,?,0,?,?)
    ON CONFLICT(cluster) DO UPDATE SET hold_plays = excluded.hold_plays, dist_plays = excluded.dist_plays, plays = excluded.plays, updated_at = excluded.updated_at,
    policy = CASE WHEN operator_policy.manual = 1 THEN operator_policy.policy ELSE excluded.policy END, note = CASE WHEN operator_policy.manual = 1 THEN operator_policy.note ELSE excluded.note END`);
  for (const [cluster, a] of by) {
    // "watch" must mean *no evidence*, not "evidence of distributing that just missed a threshold". The old rule
    // (avoid only at dist >= 2 and dist/n >= 0.67) let through nine clusters that distributed on 100 % of their one
    // observed play, and DoAsxP, which distributed on 6 of 9 and missed the cut by a third of a percent - cluster-follow
    // duly bought alongside it. Any net distributor is now avoided whatever the sample: entering one is feeding them.
    const policy = a.hold >= 2 && a.hold / a.n >= 0.6 ? "follow" : a.dist > a.hold ? "avoid" : "watch";
    up.run(cluster, policy, a.hold, a.dist, a.n, `${a.hold} hold / ${a.dist} distribute of ${a.n} plays (30 d)`, Date.now());
  }
}
function policyTable(): void {
  const rows = db.prepare(`SELECT cluster, policy, hold_plays, dist_plays, plays, manual, note FROM operator_policy ORDER BY CASE policy WHEN 'follow' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, plays DESC`).all() as any[];
  console.log(`\nCLUSTER POLICY (what cluster-follow is allowed to do): ${rows.filter((r) => r.policy === "follow").length} follow, ${rows.filter((r) => r.policy === "watch").length} watch, ${rows.filter((r) => r.policy === "avoid").length} avoid`);
  console.log(["cluster", "policy", "hold", "distribute", "plays", "set by", "note"].map((h) => h.padEnd(12)).join(""));
  for (const r of rows.slice(0, 30)) console.log([r.cluster, r.policy, r.hold_plays, r.dist_plays, r.plays, r.manual ? "hand" : "table", r.note].map((v) => String(v ?? "").padEnd(12)).join(""));
}
const BEHAVIOUR_SQL = `
    WITH plays AS (SELECT cluster, mint, COUNT(DISTINCT wallet) wallets, MIN(ts) first_ts FROM ct WHERE market = 'amm' AND ts >= ? GROUP BY cluster, mint HAVING wallets >= 3),
    agg AS (SELECT p.cluster, p.mint, p.wallets, p.first_ts,
      SUM(CASE WHEN c.side = 'buy' AND c.ts < p.first_ts + 3600000 THEN c.sol ELSE 0 END) buy_h1,
      SUM(CASE WHEN c.side = 'sell' AND c.ts < p.first_ts + 3600000 THEN c.sol ELSE 0 END) sell_h1,
      SUM(CASE WHEN c.side = 'buy' AND c.ts >= p.first_ts + 3600000 THEN c.sol ELSE 0 END) buy_later,
      SUM(CASE WHEN c.side = 'sell' AND c.ts >= p.first_ts + 3600000 THEN c.sol ELSE 0 END) sell_later,
      MIN(CASE WHEN c.ts = p.first_ts THEN c.price END) p_first
      FROM plays p JOIN ct c ON c.cluster = p.cluster AND c.mint = p.mint AND c.market = 'amm' GROUP BY p.cluster, p.mint),
    px AS (SELECT mint, MAX(price) p_peak, COUNT(DISTINCT CASE WHEN side = 'buy' THEN wallet END) buyers FROM trades WHERE market = 'amm' AND mint IN (SELECT mint FROM plays) GROUP BY mint),
    lastpx AS (SELECT mint, price p_last FROM trades WHERE market = 'amm' AND mint IN (SELECT mint FROM plays) AND id IN (SELECT MAX(id) FROM trades WHERE market = 'amm' AND mint IN (SELECT mint FROM plays) GROUP BY mint))
    SELECT a.cluster, t.symbol, a.wallets, ROUND((COALESCE(t.graduated_at, a.first_ts) - t.created_at) / 3600000.0, 1) grad_h,
      ROUND(a.buy_h1, 1) buy_h1, ROUND(a.sell_h1, 1) sell_h1, ROUND(a.buy_later, 1) buy_later, ROUND(a.sell_later, 1) sell_later,
      (SELECT COUNT(DISTINCT x.wallet) FROM trades x WHERE x.mint = a.mint AND x.market = 'amm' AND x.side = 'buy' AND x.wallet NOT IN (SELECT wallet FROM operator_wallets)) outside_buyers, ROUND(lastpx.p_last / NULLIF(a.p_first, 0), 2) px_last, ROUND(px.p_peak / NULLIF(a.p_first, 0), 2) px_peak,
      (SELECT ROUND(o.mcap_sol) FROM token_outcomes o WHERE o.mint = a.mint AND o.verified) mcap_now
    FROM agg a JOIN tokens t ON t.mint = a.mint LEFT JOIN px ON px.mint = a.mint LEFT JOIN lastpx ON lastpx.mint = a.mint
    ORDER BY a.first_ts DESC LIMIT 400`;
function behaviourRows(days: number): any[] {
  const since = Date.now() - days * 86400_000;
  return db.prepare(BEHAVIOUR_SQL).all(since) as any[];
}
function behaviour(): void {
  const since = Date.now() - 7 * 86400_000;
  const rows = (behaviourRows(7) as any[]).slice(0, 40);
  console.log("\nFARM BEHAVIOUR PER PLAY (last 7 days, >= 3 cluster wallets on the AMM): hold or distribute?");
  console.log(["cluster", "token", "wallets", "grad h", "buy h1", "sell h1", "buy later", "sell later", "verdict", "outside", "px last", "px peak", "mcap now"].map((h) => h.padEnd(11)).join(""));
  for (const r of rows) {
    const verdict = verdictOf(r);
    console.log([r.cluster, (r.symbol ?? "?").trim().slice(0, 10), r.wallets, r.grad_h, r.buy_h1, r.sell_h1, r.buy_later, r.sell_later, verdict, r.outside_buyers, r.px_last, r.px_peak, r.mcap_now].map((v) => String(v ?? "").padEnd(11)).join(""));
  }
  policyTable();
  console.log("h1 = first hour after the cluster's first AMM trade on the token; DISTRIBUTE = the farm sold more than it bought in that hour (selling to followers); HOLD = net buyer in h1; hold→sell = accumulated, then sold most of it later; px = last / peak AMM price vs the cluster's first-trade price; outside = distinct AMM buyers not in the cluster");
}

/**
 * One tracing pass, callable rather than only runnable.
 *
 * This file was a script whose whole body executed on import, so the only way to grow the operator map was for a
 * person to run it on a laptop - and that is exactly what happened. The published record froze tonight because the
 * web service refused the collector's record for carrying 8,598 operator wallets against the 10,243 already served:
 * the guard doing its job about a gap that existed only because this code had no home in the cloud.
 *
 * The map is the attribution half of the product. Every wallet page, and the front page's "who takes the curves",
 * reads it. A record that carries fewer of them really is carrying less evidence, so the right fix was never to
 * relax the guard; it was to let the machine that ingests also trace.
 *
 * RPC-heavy and bounded: `limit` seeds and `limit` funders per pass. In the collector it runs on a slow timer, in
 * the same process and therefore on the same connection, because a second writer against a 10 s busy_timeout costs
 * dropped launches - the one loss here that cannot be repaired.
 */
export async function traceClusters(opts: { limit?: number; db?: typeof db; log?: (...a: unknown[]) => void } = {}): Promise<{ traced: number; found: number; wallets: number }> {
  const LIMIT = opts.limit ?? 120;
  const log = opts.log ?? console.log;
  if (opts.db) useDb(opts.db);
  const seeds = collectSeeds();
  log(`[clusters] ${seeds} seed rows collected`);
  // trace seeds: organic-looking winners first, then the rest
  /**
   * Organic-looking winners first when we can tell, otherwise newest first. The ordering is a preference about which
   * seeds are worth the RPC calls, not a correctness condition, so a database without reconstructions still traces -
   * it just cannot prioritise, which is a far smaller loss than tracing nothing at all.
   */
  const todo = (hasHistory()
    ? db.prepare(`SELECT w.wallet, w.source_mint, h.buyers, h.graduated_min FROM operator_wallets w LEFT JOIN hist_tokens h ON h.mint = w.source_mint
        WHERE w.traced = 0 ORDER BY (COALESCE(h.buyers, 0) >= 30 OR COALESCE(h.graduated_min, 0) >= 1) DESC, h.ath_usd DESC LIMIT ?`)
    : db.prepare(`SELECT w.wallet, w.source_mint, NULL buyers, NULL graduated_min FROM operator_wallets w
        WHERE w.traced = 0 ORDER BY w.added_at DESC LIMIT ?`)).all(LIMIT) as any[];
  log(`[clusters] tracing ${todo.length} seed wallets to their funders`);
  let traced = 0, found = 0;
  for (const s of todo) {
    try {
      const r = await traceFunder(s.wallet);
      db.prepare(`UPDATE operator_wallets SET traced = 1, funder = COALESCE(funder, ?), cluster = COALESCE(cluster, ?), seeded_at = COALESCE(seeded_at, ?) WHERE wallet = ?`).run(r.funder, r.funder ? clusterName(r.funder) : null, r.seededAt, s.wallet);
      if (r.funder) { db.prepare(`INSERT OR IGNORE INTO operator_funders (funder) VALUES (?)`).run(r.funder); found++; }
      traced++;
      if (traced % 20 === 0) log(`[clusters] ${traced}/${todo.length} traced, ${found} funders`);
    } catch (e) { log(`[clusters] ${s.wallet.slice(0, 8)}: ${(e as Error).message}`); }
  }
  // enumerate funders not yet sampled (or sampled > 24 h ago)
  const funders = db.prepare(`SELECT funder FROM operator_funders WHERE sampled_at IS NULL OR sampled_at < ? ORDER BY (SELECT COUNT(*) FROM operator_wallets w WHERE w.funder = operator_funders.funder AND w.role = 'buyout') DESC LIMIT ?`).all(Date.now() - 86400_000, LIMIT) as any[];
  log(`[clusters] enumerating ${funders.length} funders (${SAMPLE} sampled transactions each)`);
  for (const f of funders) {
    try {
      const r = await enumerateFunder(f.funder);
      db.prepare("BEGIN").run();
      try {
        for (const [w] of r.wallets) insWallet.run(w, f.funder, clusterName(f.funder), "seeded", null, null, 0, Date.now());
        db.prepare(`UPDATE operator_funders SET first_seen = ?, last_seen = ?, txs = ?, wallets = (SELECT COUNT(*) FROM operator_wallets w WHERE w.funder = ?), seeds = (SELECT COUNT(*) FROM operator_wallets w WHERE w.funder = ? AND w.role = 'buyout'), sampled_at = ? WHERE funder = ?`)
          .run(r.first, r.last, r.txs, f.funder, f.funder, Date.now(), f.funder);
      } finally { db.prepare("COMMIT").run(); }
      log(`[clusters] ${clusterName(f.funder)}: ${r.wallets.size} recipients in ${SAMPLE} of ${r.txs}${r.txs >= 3000 ? "+" : ""} txs`);
    } catch (e) { log(`[clusters] funder ${clusterName(f.funder)}: ${(e as Error).message}`); }
  }
  // pass-through funders: trace them one hop up (repeat runs climb further); wallets are then named after the root
  const thin = db.prepare(`SELECT funder, hops FROM operator_funders WHERE parent IS NULL AND txs IS NOT NULL AND txs <= ? AND COALESCE(hops, 0) < ? LIMIT ?`).all(PASSTHROUGH_TXS, MAX_HOPS, LIMIT) as any[];
  log(`[clusters] ${thin.length} pass-through funders (<= ${PASSTHROUGH_TXS} txs): tracing their own funders`);
  for (const f of thin) {
    try {
      const r = await traceFunder(f.funder);
      if (!r.funder) { db.prepare(`UPDATE operator_funders SET hops = ? WHERE funder = ?`).run(MAX_HOPS, f.funder); continue; }
      db.prepare(`INSERT OR IGNORE INTO operator_funders (funder, note, hops) VALUES (?, ?, ?)`).run(r.funder, `parent of ${clusterName(f.funder)}`, (f.hops ?? 0) + 1);
      db.prepare(`UPDATE operator_funders SET parent = ?, hops = ? WHERE funder = ?`).run(r.funder, (f.hops ?? 0) + 1, f.funder);
      log(`[clusters] ${clusterName(f.funder)} <- ${clusterName(r.funder)}`);
    } catch (e) { log(`[clusters] parent of ${clusterName(f.funder)}: ${(e as Error).message}`); }
  }
  // rename every wallet after its root funder so the live strategy and the report see one cluster per operation
  for (const w of db.prepare(`SELECT wallet, funder FROM operator_wallets WHERE funder IS NOT NULL`).all() as any[]) db.prepare(`UPDATE operator_wallets SET cluster = ? WHERE wallet = ?`).run(clusterName(rootOf(w.funder)), w.wallet);
  /**
   * The derived analysis, and it is allowed to fail.
   *
   * `buildClusterTrades` and `computePolicies` read `token_outcomes` and the reconstruction tables - laptop-only,
   * like `hist_tokens`. They summarise what the clusters DID; the tracing loop above is what discovers the wallets,
   * and that is the part the published archive depends on, because the record's operator map is what the shrink
   * guard measures.
   *
   * So a missing analysis table costs a scorecard, not the map. Wrapping these was the difference between a pass
   * that grows the archive and one that throws on its last line and writes nothing - which is what happened, every
   * pass, for the first hour this ran in the cloud.
   */
  try {
    buildClusterTrades();
    computePolicies();
  } catch (e) {
    log(`[clusters] wallets traced; cluster analysis skipped (${(e as Error).message})`);
  }
  log(`[clusters] done; ${rpcStats()}`);

  const wallets = (db.prepare("SELECT COUNT(*) c FROM operator_wallets").get() as any).c as number;
  return { traced, found, wallets };
}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (args.includes("--report")) { buildClusterTrades(); computePolicies(); report(); process.exit(0); }
  await traceClusters({ limit: LIMIT });
  report();
}
