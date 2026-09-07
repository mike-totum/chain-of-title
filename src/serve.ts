/**
 * The live service. Serves the generated site, and answers for tokens the archive has never seen.
 *
 *   npm run serve -- [--port 8899] [--dir site]
 *
 * The static site can only answer the launches it was generated from, so every other mint hit a 404 — the single
 * worst page on the site, because a stranger's first action is to paste an address we probably do not hold. Here that
 * request instead queues a chain rebuild (`backfill.ts`), tells the visitor what is happening and how long it takes,
 * and writes the finished page into the static tree so the answer is permanent and the next request never touches
 * this code path.
 *
 * Rebuilds are queued, never synchronous: a busy curve took 324 s to reconstruct, which is a background job, not a
 * request. One worker runs at a time because the RPC endpoint, not the CPU, is the constraint.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { assess, cleanAtBirth, coverageWindows, TOKEN_COLUMNS, MIN_POOL_SOL } from "./provenance.ts";
import { profile, verdictLine } from "./operator.ts";
import { poolReservesPooled } from "./outcomes.ts";
import { rebuild, store, curveExists } from "./backfill.ts";
import { page, tokenBody, walletBody, tokenPreview, SEARCH, when, fmt, type Chrome, type Reading } from "./render.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg("--port", process.env.PORT ?? "8899"));
const DIR = arg("--dir", "site");
/** The record database (`npm run servicedb`). Defaults to the collector's own file for local use. */
const DB_FILE = arg("--db", config.dbPath);
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NO_REBUILD = process.argv.includes("--no-rebuild");
const MAX_QUEUE = 40;                 // beyond this we say we are busy rather than promising something we won't do
const RETRY_FAILED_AFTER = 3600_000;  // a failed rebuild may be retried after an hour, not on every reload

/**
 * Limits. Every rebuild spends someone else's money — archival RPC calls, thousands of them for a busy curve — and
 * the request comes from the open internet. Without a bound, one visitor can occupy the single worker indefinitely
 * and exhaust the RPC quota that the collector also depends on. Refusing is safe; the visitor is told plainly why and
 * when to come back. These are deliberately generous for a human and useless for a script.
 */
const PER_IP_PER_HOUR = 5;
const GLOBAL_PER_HOUR = 60;
const GLOBAL_PER_DAY = 400;
/** Signature cap for a rebuild nobody asked us to pay for. The CLI has no cap. */
const MAX_SIGS_ON_DEMAND = 8_000;
const JOB_TTL = 6 * 3600_000;
const MAX_JOBS = 5_000;

/** Sliding-window counters. Cheap, and pruned as they are read so nothing accumulates. */
const hits = new Map<string, number[]>();
function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { hits.set(key, arr); return false; }
  arr.push(now);
  hits.set(key, arr);
  return true;
}
function peek(key: string, windowMs: number): number {
  const now = Date.now();
  return (hits.get(key) ?? []).filter((t) => now - t < windowMs).length;
}

/**
 * The client address. Behind Cloudflare or Railway the socket address is the proxy, so the forwarded header is what
 * identifies a visitor — but it is caller-supplied and trivially spoofed if we are ever exposed directly. Set
 * TRUST_PROXY=1 only when something in front is known to overwrite it.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
function clientIp(req: any): string {
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf) return cf;
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

const db = openDb(DB_FILE);
const win = coverageWindows(db);
const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);
const chrome: Chrome = {
  coverageFrom: win.length ? when(win[0].a) : "unknown",
  gapMin: win.slice(1).reduce((a, w, i) => a + Math.max(0, w.a - win[i].b), 0) / 60_000,
};

/**
 * Refuse to serve an empty archive. `openDb` creates its tables when the file is missing, so a database that failed to
 * ship produces a service that answers "we have no record of this launch" for every token on Solana — confidently,
 * with a clean 200, and indistinguishable from the truth. Being down is recoverable; being authoritatively wrong about
 * every token is not. This is exactly what a missing `data/record.db` did on the first deploy.
 */
const held = (db.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
if (held < 1000) {
  console.error(`refusing to start: ${DB_FILE} holds ${held} launches, which cannot be a real archive.`);
  console.error(`build one with \`npm run servicedb\` and make sure it is present at that path.`);
  process.exit(1);
}

const tokenQ = db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE mint = ?`);

// ---------- job queue ----------
type Job = { mint: string; state: "queued" | "running" | "done" | "failed"; at: number; error?: string };
const jobs = new Map<string, Job>();
const queue: string[] = [];
let working = false;

/** Forget finished jobs so the map cannot grow without bound; a job's result lives in the database, not here. */
function evictJobs(): void {
  const now = Date.now();
  for (const [m, j] of jobs) if (j.state !== "queued" && j.state !== "running" && now - j.at > JOB_TTL) jobs.delete(m);
  if (jobs.size > MAX_JOBS) {
    const done = [...jobs].filter(([, j]) => j.state === "done" || j.state === "failed").sort((a, b) => a[1].at - b[1].at);
    for (const [m] of done.slice(0, jobs.size - MAX_JOBS)) jobs.delete(m);
  }
}

function enqueue(mint: string): Job {
  const existing = jobs.get(mint);
  if (existing && !(existing.state === "failed" && Date.now() - existing.at > RETRY_FAILED_AFTER)) return existing;
  if (queue.length >= MAX_QUEUE) return { mint, state: "failed", at: Date.now(), error: "busy" };
  evictJobs();
  const j: Job = { mint, state: "queued", at: Date.now() };
  jobs.set(mint, j);
  queue.push(mint);
  void work();
  return j;
}

async function work(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const mint = queue.shift();
      if (!mint) return;
      const j = jobs.get(mint)!;
      j.state = "running"; j.at = Date.now();
      try {
        const r = await rebuild(mint, { maxSigs: MAX_SIGS_ON_DEMAND });
        store(db, r);
        // An incomplete rebuild is stored (so the incompleteness is on the record) but is not a success: the page will
        // say UNKNOWN, and a later retry may do better if the endpoints are healthier.
        j.state = r.complete ? "done" : "failed";
        j.error = r.reason ?? undefined;
        console.log(`[rebuild] ${mint} ${r.complete ? "complete" : `incomplete: ${r.reason}`} (${r.trades} trades, ${r.curveBuyers} buyers)`);
      } catch (e) {
        j.state = "failed"; j.error = (e as Error).message;
        console.log(`[rebuild] ${mint} failed: ${j.error}`);
      }
      j.at = Date.now();
    }
  } finally { working = false; }
}

// ---------- rendering ----------
async function renderToken(t: any): Promise<string> {
  const a = assess(db, t, covered);
  // `assess` already treats a complete rebuild as judgeable; the flag only decides how the page describes its source.
  const rebuilt = !!t.rebuilt_at && !!t.rebuilt_complete;
  let reading: Reading | null = t.vault_sol != null && t.vault_at != null ? { sol: t.vault_sol, at: t.vault_at, fresh: false } : null;
  if (t.pool) {
    const fresh = await poolReservesPooled(t.pool, t.mint);
    if (fresh) reading = { sol: fresh.quoteSol, at: Date.now(), fresh: true };
  }
  if (reading && reading.sol < MIN_POOL_SOL)
    a.flags.push({ level: "DANGER", text: `Only ${reading.sol.toFixed(1)} SOL of liquidity was in the pool ${reading.fresh ? "just now" : "when it was last read"}; a position cannot be sold near the quoted price.` });
  const clean = cleanAtBirth(t, a) && !!reading?.fresh && reading.sol >= MIN_POOL_SOL;
  const pv = tokenPreview(t, a, clean);
  return page(pv.title, tokenBody(t, a, reading, rebuilt ? "rebuilt" : "observed", clean, Date.now()), chrome, 1, pv.summary);
}

/** Shown while a rebuild is queued or running. It polls, so the visitor does not have to. */
const waiting = (mint: string, j: Job) => page("Rebuilding", `
  <h1>Rebuilding this token's record</h1>
  <div class="sub mono">${mint}</div>
  <div class="prog"><i></i></div>
  <p>We have no record of this launch, so we are reading its bonding curve's entire transaction history from the chain
  and rebuilding what happened: who created it, what they took in the first block, every wallet that bought on the
  curve, and how it graduated.</p>
  <p class="sub">${j.state === "queued" ? `Queued${queue.indexOf(mint) > 0 ? `, ${queue.indexOf(mint)} ahead of it` : ""}.` : "Running."} A busy curve can take several minutes — there can be
  thousands of transactions. This page checks every few seconds and will show the record when it is ready. Once built,
  it is permanent: a launch record never changes.</p>
  <script>
  setTimeout(function(){
    fetch('/api/job/${mint}').then(function(r){return r.json()}).then(function(j){
      if(j.state==='done') location.reload();
      else if(j.state==='failed') document.getElementById('err').style.display='block', document.getElementById('errtext').textContent=j.error||'unknown';
      else location.reload();
    }).catch(function(){location.reload()});
  }, 5000);
  </script>
  <div class="flag DANGER" id="err" style="display:none"><span class="tag DANGER">failed</span>
  The rebuild could not be completed: <span id="errtext"></span>. That is a failure to read, not a finding —
  it says nothing about this token.</div>`, chrome, 1);

const noRecord = (mint: string, why: string) => page("No record", `
  <h1>We have no record of this launch</h1>
  <div class="sub mono">${mint}</div>
  <div class="flag UNKNOWN"><span class="tag UNKNOWN">unknown</span>${why}
  This is <b>not</b> a clean result. Once a token's float has been spread across wallets, a manufactured launch is
  indistinguishable from a real one by present-tense inspection — which is why the record has to be kept at the time,
  and why we will not guess.</div>
  ${SEARCH}`, chrome, 1);

// ---------- server ----------
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const server = createServer(async (req, res) => {
  /**
   * Caching is the CDN's job, not the disk's. A launch record is immutable once complete, so it can be cached hard and
   * revalidated in the background; a page that is still UNKNOWN or waiting on a rebuild must not be, or a visitor is
   * pinned to an answer we are in the middle of improving. Pre-rendering these to files does not scale — ~24,000
   * launches a day is millions of pages a year — and an edge cache does the same job without a filesystem.
   */
  const send = (code: number, body: string | Buffer, type = "text/html; charset=utf-8", cache = "none") => {
    const cc = code !== 200 ? "no-store"
      : cache === "immutable" ? "public, max-age=3600, stale-while-revalidate=86400"
      : cache === "short" ? "public, max-age=60"
      : "no-store";
    res.writeHead(code, { "content-type": type, "cache-control": cc });
    res.end(body);
  };
  try {
    const url = new URL(req.url ?? "/", "http://x");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    // never let a path escape the served directory
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");

    // job status, for the waiting page's poll
    const jobMatch = safe.match(/^\/api\/job\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    if (jobMatch) {
      const j = jobs.get(jobMatch[1]);
      return send(200, JSON.stringify(j ?? { state: "unknown" }), TYPES[".json"]);
    }

    const file = join(DIR, safe);
    if (existsSync(file) && !file.endsWith("/")) return send(200, readFileSync(file), TYPES[safe.slice(safe.lastIndexOf("."))] ?? "application/octet-stream", "short");

    // The archive itself. Served from the image rather than copied into the static tree, and cached hard because it
    // is rebuilt on deploy — a public good nobody has to ask for.
    if (safe === "/data/record.db") {
      try {
        const buf = readFileSync(DB_FILE);
        res.writeHead(200, {
          "content-type": "application/vnd.sqlite3",
          "content-disposition": 'attachment; filename="chain-of-title-record.db"',
          "cache-control": "public, max-age=3600",
        });
        return res.end(buf);
      } catch { return send(404, "the record database is not available on this server"); }
    }

    // a wallet's record, rendered from its trades across the whole archive
    const wm = safe.match(/^\/w\/([1-9A-HJ-NP-Za-km-z]{32,44})\.html$/);
    if (wm) {
      const p = profile(db, wm[1]);
      if (!p.buyouts.length)
        return send(200, page("No record", `<h1>No curve buyouts on record</h1><div class="sub mono">${wm[1]}</div>
          <div class="flag UNKNOWN"><span class="tag UNKNOWN">unknown</span>This wallet has not bought out a bonding
          curve in our archive. That is not a statement about the wallet — only that it does not appear here.</div>`, chrome, 1));
      const line = verdictLine(p);
      return send(200, page(`Priors — ${wm[1].slice(0, 8)}`, walletBody(wm[1], p, line), chrome, 1,
        line ?? `A wallet that has bought out ${p.buyouts.length} bonding curve${p.buyouts.length === 1 ? "" : "s"} in this archive.`),
        "text/html; charset=utf-8", "short");
    }

    // a token page we have not generated: answer from the database, or rebuild it
    const m = safe.match(/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})\.html$/);
    if (m) {
      const mint = m[1];
      const t = tokenQ.get(mint) as any;
      // Only a record we can actually judge short-circuits the rebuild. Holding a *row* for a mint is not the same as
      // holding its launch: tokens discovered late (named by a post, found by a detector) have no curve history, and
      // treating their presence as an answer meant the most useful thing we could do for them — rebuild the launch
      // from chain — was never attempted.
      const judgeable = !!t && (!!t.rebuilt_complete || (!t.late_discovery && covered(t.created_at)));
      if (judgeable) return send(200, await renderToken(t), "text/html; charset=utf-8", "immutable");
      /** Fall back to whatever we do hold, which is honest about knowing nothing, rather than a bare refusal. */
      const existing = async (why: string) => t ? send(200, await renderToken(t)) : send(200, noRecord(mint, why));
      const j = jobs.get(mint);
      // an existing job is reported without spending anything, so a poll or a reload is always free
      if (j && (j.state === "queued" || j.state === "running")) return send(200, waiting(mint, j));
      if (j && j.state === "failed" && Date.now() - j.at < RETRY_FAILED_AFTER)
        return send(200, noRecord(mint, `We tried to rebuild this launch from chain history and could not: ${esc2(j.error ?? "unknown")}.`));

      if (NO_REBUILD) return existing("This server does not rebuild records on demand.");
      // Budgets are checked before the cheap probe, and the probe before the queue, so the cheapest refusal wins.
      if (peek("global:day", 86400_000) >= GLOBAL_PER_DAY || peek("global:hour", 3600_000) >= GLOBAL_PER_HOUR)
        return send(503, noRecord(mint, "We have rebuilt as many records as we can pay for in this period. The archive itself is unaffected — only new rebuilds are paused. Try again later."));
      const ip = clientIp(req);
      if (!allow(`ip:${ip}`, PER_IP_PER_HOUR, 3600_000))
        return send(429, noRecord(mint, `Rebuilding a record reads thousands of transactions from the chain, so each visitor can start ${PER_IP_PER_HOUR} an hour. Records already in the archive are always free to read.`));

      // One RPC call: a mint with no bonding curve is not a pump.fun token, and refusing here costs nothing.
      if (!(await curveExists(mint)))
        return existing("No pump.fun bonding curve exists for this address, so there is no launch of ours to rebuild. It may be an SPL token launched elsewhere, a wallet address, or a typo.");

      const started = enqueue(mint);
      if (started.error === "busy")
        return send(503, noRecord(mint, "We are rebuilding as many records as we can keep up with right now, so this one has not started. Try again in a few minutes."));
      allow("global:hour", GLOBAL_PER_HOUR, 3600_000);
      allow("global:day", GLOBAL_PER_DAY, 86400_000);
      return send(200, waiting(mint, started));
    }

    // anything else
    const custom = join(DIR, "404.html");
    return send(404, existsSync(custom) ? readFileSync(custom) : "not found");
  } catch (e) {
    console.error(e);
    return send(500, "error");
  }
});

const esc2 = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

server.listen(PORT, () => {
  console.log(`serving ${DIR} from ${DB_FILE} (${held.toLocaleString()} launches) on http://localhost:${PORT}`);
  console.log(`unknown mints are rebuilt from chain (queue max ${MAX_QUEUE}, one at a time)`);
});
