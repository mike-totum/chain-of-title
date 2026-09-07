/**
 * 24-hour bonding-curve polling for every launch, independent of the websocket tracker.
 *
 * The live monitor follows a token's trades for WATCH_MINUTES and drops it when it goes quiet, so the
 * hour-1-to-hour-6 phase where slow organic runners separate from the rest was not recorded (Squads
 * graduated at 5.5 h and 1806x with no curve data after minute 30). This job reads each token's
 * bonding-curve account directly (getMultipleAccounts, 100 per call) on an adaptive cadence:
 * 3 min while the reserves keep changing, 15 min after two quiet reads, 60 min after six, 2 min when
 * the curve holds >= 10 SOL. Polling stops at graduation, at 24 h, or when the account disappears.
 * A graduation seen here is also written to `tokens` so the report and snapshots pick the token up.
 *
 *   npm run curvepoll          # long-running; installed as launchd com.pumpmonitor.curvepoll
 *
 * Rows: curve_snapshots(mint, ts, vsol, vtok, rsol, complete); state in curve_poll.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { bondingCurveAddress, configureEndpoints, decodeCurveAccount, rpc, rpcStats } from "./rpc-http.ts";

const db = openDb(config.dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS curve_snapshots (mint TEXT NOT NULL, ts INTEGER NOT NULL, vsol REAL, vtok REAL, rsol REAL, complete INTEGER, PRIMARY KEY (mint, ts))`);
db.exec(`CREATE INDEX IF NOT EXISTS curve_snap_ts ON curve_snapshots(ts)`);
db.exec(`CREATE TABLE IF NOT EXISTS curve_poll (mint TEXT PRIMARY KEY, curve TEXT, created_at INTEGER, next_at INTEGER, last_vsol REAL, last_rsol REAL, unchanged INTEGER DEFAULT 0, polls INTEGER DEFAULT 0, done INTEGER DEFAULT 0, done_reason TEXT)`);
db.exec(`CREATE INDEX IF NOT EXISTS curve_poll_due ON curve_poll(done, next_at)`);

const HOURS = Number(process.env.CURVE_POLL_HOURS || 24);
// ~1,000 account reads an hour: the official endpoint carries this fine; metered keys (Helius) are fallback only
const pollUrls = (process.env.CURVEPOLL_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (pollUrls.length) configureEndpoints(pollUrls);
const FIRST_POLL_MS = 5 * 60_000;
const CYCLE_MS = 20_000;
const MAX_PER_CYCLE = 3000;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const enrollStmt = db.prepare(`INSERT OR IGNORE INTO curve_poll (mint, curve, created_at, next_at) VALUES (?,?,?,?)`);
const newTokens = db.prepare(`SELECT t.mint, t.created_at FROM tokens t LEFT JOIN curve_poll p ON p.mint = t.mint WHERE p.mint IS NULL AND t.late_discovery = 0 AND t.created_at >= ? ORDER BY t.created_at DESC LIMIT 5000`);
const due = db.prepare(`SELECT mint, curve, created_at, last_vsol, last_rsol, unchanged, polls FROM curve_poll WHERE done = 0 AND next_at <= ? ORDER BY next_at LIMIT ?`);
const insSnap = db.prepare(`INSERT OR REPLACE INTO curve_snapshots (mint, ts, vsol, vtok, rsol, complete) VALUES (?,?,?,?,?,?)`);
const upd = db.prepare(`UPDATE curve_poll SET next_at = ?, last_vsol = ?, last_rsol = ?, unchanged = ?, polls = polls + 1, done = ?, done_reason = ? WHERE mint = ?`);
const markGrad = db.prepare(`UPDATE tokens SET graduated = 1, graduated_at = COALESCE(graduated_at, ?) WHERE mint = ? AND COALESCE(graduated, 0) = 0`);

interface Row { mint: string; curve: string; created_at: number; last_vsol: number | null; last_rsol: number | null; unchanged: number; polls: number }

function enroll(now: number): number {
  const rows = newTokens.all(now - HOURS * 3600_000) as unknown as { mint: string; created_at: number }[];
  let n = 0;
  const tx = db.prepare("BEGIN"); tx.run();
  try {
    for (const r of rows) {
      let curve: string;
      try { curve = bondingCurveAddress(r.mint); } catch { continue; }
      enrollStmt.run(r.mint, curve, r.created_at, Math.max(now, r.created_at + FIRST_POLL_MS));
      n++;
    }
  } finally { db.prepare("COMMIT").run(); }
  return n;
}

function nextInterval(r: Row, changed: boolean, rsol: number): { ms: number; unchanged: number } {
  const unchanged = changed ? 0 : r.unchanged + 1;
  if (rsol >= 10) return { ms: 2 * 60_000, unchanged };
  if (unchanged < 2) return { ms: 3 * 60_000, unchanged };
  if (unchanged < 6) return { ms: 15 * 60_000, unchanged };
  return { ms: 60 * 60_000, unchanged };
}

/** 100 accounts per call where the node allows it (official endpoint); otherwise 10 per call (publicnode). undefined = that read failed. */
async function readAccounts(keys: string[]): Promise<any[] | null> {
  try { const r = await rpc("getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]); if (Array.isArray(r?.value)) return r.value; } catch {}
  const out: any[] = new Array(keys.length).fill(undefined);
  let any = false;
  for (let i = 0; i < keys.length; i += 10) {
    try { const r = await rpc("getMultipleAccounts", [keys.slice(i, i + 10), { encoding: "base64", commitment: "confirmed" }]); if (Array.isArray(r?.value)) { r.value.forEach((v: any, k: number) => (out[i + k] = v)); any = true; } } catch {}
  }
  return any ? out : null;
}

let stats = { polls: 0, changed: 0, graduated: 0, expired: 0, closed: 0, failedBatches: 0 };
async function cycle(): Promise<void> {
  const now = Date.now();
  const enrolled = enroll(now);
  const rows = due.all(now, MAX_PER_CYCLE) as unknown as Row[];
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const result = await readAccounts(batch.map((r) => r.curve));
    if (!result) { stats.failedBatches++; for (const r of batch) upd.run(now + 60_000, r.last_vsol, r.last_rsol, r.unchanged, 0, null, r.mint); continue; }
    const ts = Date.now();
    db.prepare("BEGIN").run();
    try {
      batch.forEach((r, k) => {
        const acct = result[k];
        const age = ts - r.created_at;
        if (acct === undefined) { upd.run(ts + 60_000, r.last_vsol, r.last_rsol, r.unchanged, 0, null, r.mint); return; } // read failed; retry soon
        if (!acct?.data?.[0]) { upd.run(ts, r.last_vsol, r.last_rsol, r.unchanged, 1, "closed", r.mint); stats.closed++; return; }
        const c = decodeCurveAccount(acct.data[0]);
        if (!c) { upd.run(ts + 15 * 60_000, r.last_vsol, r.last_rsol, r.unchanged, 0, null, r.mint); return; }
        insSnap.run(r.mint, ts, c.vSol, c.vTokens, c.realSol, c.complete ? 1 : 0);
        stats.polls++;
        const changed = r.last_vsol === null || Math.abs(c.vSol - r.last_vsol) > 1e-6 || Math.abs(c.realSol - (r.last_rsol ?? 0)) > 1e-6;
        if (changed) stats.changed++;
        if (c.complete) { markGrad.run(ts, r.mint); upd.run(ts, c.vSol, c.realSol, 0, 1, "graduated", r.mint); stats.graduated++; return; }
        if (age > HOURS * 3600_000) { upd.run(ts, c.vSol, c.realSol, 0, 1, "expired", r.mint); stats.expired++; return; }
        const nx = nextInterval(r, changed, c.realSol);
        upd.run(ts + nx.ms, c.vSol, c.realSol, nx.unchanged, 0, null, r.mint);
      });
    } finally { db.prepare("COMMIT").run(); }
  }
  if (enrolled || rows.length) lastActivity = { enrolled, polled: rows.length };
}

let lastActivity = { enrolled: 0, polled: 0 };
let lastStatus = 0;
log(`[curvepoll] start: ${HOURS} h horizon, endpoints ${rpcStats()}`);
for (;;) {
  const t0 = Date.now();
  try { await cycle(); } catch (e) { log(`[curvepoll] cycle error: ${(e as Error).message}`); }
  if (Date.now() - lastStatus > 5 * 60_000) {
    lastStatus = Date.now();
    const q = db.prepare(`SELECT SUM(done = 0) active, SUM(done = 0 AND next_at <= ?) overdue, COUNT(*) total FROM curve_poll`).get(Date.now()) as any;
    log(`[curvepoll] active ${q.active} overdue ${q.overdue} total ${q.total} | last cycle enrolled ${lastActivity.enrolled} polled ${lastActivity.polled} | reads ${stats.polls} changed ${stats.changed} grad ${stats.graduated} expired ${stats.expired} closed ${stats.closed} failed-batches ${stats.failedBatches} | ${rpcStats()}`);
  }
  const wait = CYCLE_MS - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
