/**
 * Build the portable provenance archive - the product asset, separated from the research database.
 *   npm run archive -- [--out data/archive.db] [--verify]
 *
 * The research DB is ~5.3 GB, almost all of it `trades` and `wallet_token_stats`, which the product never reads.
 * What the product needs is what each token WAS at birth, and that is ~50 MB for 121k launches (~10 MB/day). Splitting
 * them means the public service never touches the heavy database, the archive is trivially hostable and backed up, and
 * research queries cannot take the site down.
 *
 * Coverage is written alongside the data. Launch-time facts are unrecoverable, so a token that launched while the
 * collector was down must be reported as unobserved rather than answered confidently.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "data/archive.db");
const GAP_TOLERANCE_MS = 180_000; // runs whose heartbeats are within 3 min are one continuous stretch

const src = openDb(config.dbPath);
src.exec("PRAGMA query_only = 1");
mkdirSync(dirname(OUT), { recursive: true });
const out = new DatabaseSync(OUT);
out.exec(`
  PRAGMA journal_mode = WAL;
  DROP TABLE IF EXISTS launches;
  DROP TABLE IF EXISTS coverage;
  DROP TABLE IF EXISTS operators;
  DROP TABLE IF EXISTS operator_policy;
  DROP TABLE IF EXISTS pools;
  CREATE TABLE launches (
    mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, creator TEXT,
    created_at INTEGER,            -- ms, creation as we observed it
    observed INTEGER,              -- 1 = we watched it launch; 0 = discovered later, provenance unknown
    dev_pct REAL,                  -- share of supply the creator took in the first block
    dev_sold INTEGER,
    curve_buyers INTEGER,          -- distinct outside buyers on the bonding curve
    buyers_30s INTEGER,
    bundled_buyers INTEGER,        -- first buys landing in the creation block
    graduated INTEGER, graduated_at INTEGER,
    buy_vol_sol REAL, sell_vol_sol REAL,
    pool TEXT
  );
  CREATE INDEX launches_created ON launches(created_at);
  CREATE INDEX launches_creator ON launches(creator);
  -- when the collector was actually running. Anything outside these windows was not observed.
  CREATE TABLE coverage (start_at INTEGER, end_at INTEGER);
  -- wallet farms traced from curve buyouts to their funder
  CREATE TABLE operators (wallet TEXT PRIMARY KEY, cluster TEXT, role TEXT, source_mint TEXT);
  CREATE TABLE operator_policy (cluster TEXT PRIMARY KEY, policy TEXT, hold_plays INTEGER, dist_plays INTEGER, plays INTEGER, note TEXT);
  CREATE TABLE pools (pool TEXT PRIMARY KEY, mint TEXT);
  CREATE INDEX pools_mint ON pools(mint);
`);

// ---------- coverage: merge run heartbeats into continuous windows ----------
const runs = src.prepare(`SELECT started_at, stopped_at FROM runs WHERE started_at IS NOT NULL ORDER BY started_at`).all() as { started_at: number; stopped_at: number | null }[];
const windows: { start_at: number; end_at: number }[] = [];
for (const r of runs) {
  // a run with no heartbeat ever recorded covers only the instant it started; do not claim more
  const end = r.stopped_at ?? r.started_at;
  const last = windows[windows.length - 1];
  if (last && r.started_at - last.end_at <= GAP_TOLERANCE_MS) last.end_at = Math.max(last.end_at, end);
  else windows.push({ start_at: r.started_at, end_at: end });
}
const insCov = out.prepare("INSERT INTO coverage (start_at, end_at) VALUES (?,?)");
for (const w of windows) insCov.run(w.start_at, w.end_at);

const covered = (ts: number) => windows.some((w) => ts >= w.start_at && ts <= w.end_at);

// ---------- launches ----------
const rows = src.prepare(`SELECT mint, symbol, name, creator, created_at, late_discovery, dev_pct, dev_sold,
  unique_buyers, snap30_buyers, bundled_buyers, graduated, graduated_at, buy_vol_sol, sell_vol_sol, pool
  FROM tokens`).all() as any[];
const ins = out.prepare(`INSERT OR REPLACE INTO launches (mint, symbol, name, creator, created_at, observed, dev_pct,
  dev_sold, curve_buyers, buyers_30s, bundled_buyers, graduated, graduated_at, buy_vol_sol, sell_vol_sol, pool)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
out.exec("BEGIN");
let observed = 0;
for (const r of rows) {
  // observed = we saw it launch AND the collector was demonstrably running at that moment
  const obs = !r.late_discovery && covered(r) ? 1 : 0;
  if (obs) observed++;
  ins.run(r.mint, r.symbol, r.name, r.creator, r.created_at, obs,
    obs ? r.dev_pct : null, obs ? r.dev_sold : null, obs ? r.unique_buyers : null,
    obs ? r.snap30_buyers : null, obs ? r.bundled_buyers : null,
    r.graduated, r.graduated_at, obs ? r.buy_vol_sol : null, obs ? r.sell_vol_sol : null, r.pool);
}
out.exec("COMMIT");

// ---------- operator map and pools ----------
const copy = (sql: string, insSql: string, map: (r: any) => unknown[]) => {
  const st = out.prepare(insSql);
  out.exec("BEGIN");
  let n = 0;
  for (const r of src.prepare(sql).all() as any[]) { st.run(...map(r) as any); n++; }
  out.exec("COMMIT");
  return n;
};
const nOps = copy("SELECT wallet, cluster, role, source_mint FROM operator_wallets WHERE cluster IS NOT NULL",
  "INSERT OR REPLACE INTO operators (wallet, cluster, role, source_mint) VALUES (?,?,?,?)", (r) => [r.wallet, r.cluster, r.role, r.source_mint]);
const nPol = copy("SELECT cluster, policy, hold_plays, dist_plays, plays, note FROM operator_policy",
  "INSERT OR REPLACE INTO operator_policy (cluster, policy, hold_plays, dist_plays, plays, note) VALUES (?,?,?,?,?,?)",
  (r) => [r.cluster, r.policy, r.hold_plays, r.dist_plays, r.plays, r.note]);
const nPools = copy("SELECT pool, mint FROM pool_map", "INSERT OR REPLACE INTO pools (pool, mint) VALUES (?,?)", (r) => [r.pool, r.mint]);

out.exec("VACUUM");
const size = statSync(OUT).size / 1048576;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const totalCovered = windows.reduce((a, w) => a + (w.end_at - w.start_at), 0);
const span = windows.length ? windows[windows.length - 1].end_at - windows[0].start_at : 0;

console.log(`\nwrote ${OUT} - ${size.toFixed(1)} MB`);
console.log(`  launches            ${rows.length.toLocaleString()} (${observed.toLocaleString()} observed at launch, ${(rows.length - observed).toLocaleString()} provenance unknown)`);
console.log(`  operator wallets    ${nOps.toLocaleString()} in ${nPol} scored clusters`);
console.log(`  pools               ${nPools.toLocaleString()}`);
console.log(`\nCOVERAGE - ${windows.length} continuous window(s), ${(100 * totalCovered / Math.max(span, 1)).toFixed(2)}% of the span`);
for (const w of windows) console.log(`  ${iso(w.start_at)} → ${iso(w.end_at)}  (${((w.end_at - w.start_at) / 3600_000).toFixed(1)} h)`);
const gaps = windows.slice(1).map((w, i) => ({ from: windows[i].end_at, to: w.start_at })).filter((g) => g.to - g.from > GAP_TOLERANCE_MS);
if (gaps.length) {
  console.log(`\nGAPS - launches in these windows have no provenance and must not be answered confidently`);
  for (const g of gaps) console.log(`  ${iso(g.from)} → ${iso(g.to)}  (${((g.to - g.from) / 60_000).toFixed(0)} min)`);
} else console.log("\nno gaps recorded");
