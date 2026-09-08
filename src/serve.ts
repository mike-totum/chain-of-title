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
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { type Assessment, assess, cleanAtBirth, coverageWindows, TOKEN_COLUMNS, MIN_POOL_SOL,
  readingCertifies, MAX_READING_AGE_MS, MAX_DEV_PCT, MIN_BUYERS, BUYOUT_SOL } from "./provenance.ts";
import { profile, verdictLine } from "./operator.ts";
import { poolReservesPooled } from "./outcomes.ts";
import { rebuild, store, curveExists } from "./backfill.ts";
import { page, tokenBody, walletBody, tokenPreview, SEARCH, when, fmt, homeBody, homeTitle,
  type Home, type Chrome, type Reading } from "./render.ts";
import { tokenRecord, walletRecord, statusRecord, unknownRecord, errorRecord,
  API_VERSION, PER_IP_PER_HOUR, GLOBAL_PER_HOUR, GLOBAL_PER_DAY, type Coverage } from "./api.ts";

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
 *
 * The per-caller and global ceilings are in `api.ts`, with the rest of the published contract, because the API page
 * quotes them. Reads are not limited at all — an unmetered read is the whole strategy.
 */
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

/**
 * Fetch the record from the machine that builds it. A Railway volume attaches to one service, so `pump.db` — and
 * therefore `servicedb` — lives on the collector; this service pulls the finished file over the private network.
 * Removing the database from the image also removes the failure that took the site down twice: an ignore rule
 * silently excluding a build product.
 */
const RECORD_URL = arg("--record-url", process.env.RECORD_URL ?? "");
const REFRESH_MS = Number(process.env.RECORD_REFRESH_HOURS ?? 6) * 3600_000;

async function pullRecord(first: boolean): Promise<void> {
  if (!RECORD_URL) return;
  const tmp = `${DB_FILE}.incoming`;
  try {
    const res = await fetch(RECORD_URL, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error(`only ${buf.length} bytes, not a real archive`);
    const { writeFileSync, renameSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, buf);
    // Verify before adopting it: a truncated or half-written database opens fine and simply reports fewer launches,
    // which is the failure this project keeps meeting. Only swap it in once it reads as a real archive.
    const { DatabaseSync } = await import("node:sqlite");
    const probe = new DatabaseSync(tmp);
    const n = (probe.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
    probe.close();
    if (n < 1000) throw new Error(`downloaded archive holds only ${n} launches`);
    /**
     * An archive must never shrink.
     *
     * The count guard above only catches an empty file. It would have accepted a real, well-formed database holding a
     * fraction of the history — which is exactly what was waiting to happen: the cloud collector was never seeded, so
     * it holds 21 hours where the archive it would have replaced holds four months. A successful pull would have cut
     * the public record from 143,102 launches to 16,731 and looked like a normal refresh in the log.
     *
     * The archive is the one asset here that cannot be rebuilt from anywhere else, and losing it silently is the
     * worst outcome this service has. Coverage only ever grows, so a smaller file is by definition a mistake
     * somewhere upstream — a half-seeded collector, a wrong path, a truncated transfer. Refusing costs a stale
     * archive; accepting costs the archive. Set RECORD_ALLOW_SHRINK=1 to override deliberately, e.g. after a prune
     * that is meant to reduce it.
     */
    const holding = (() => {
      // Read the file on disk, not `db`: the first pull runs before the connection is opened, and on a first boot
      // there may be no archive here at all — in which case anything is an improvement.
      try {
        const cur = new DatabaseSync(DB_FILE, { readOnly: true });
        const c = (cur.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
        cur.close();
        return c;
      } catch { return 0; }
    })();
    if (process.env.RECORD_ALLOW_SHRINK !== "1" && n < holding * 0.9)
      throw new Error(`downloaded archive holds ${n.toLocaleString()} launches against the ${holding.toLocaleString()} already here, ` +
        `refusing to shrink the record. If this is intended, set RECORD_ALLOW_SHRINK=1.`);
    renameSync(tmp, DB_FILE);
    console.log(`[record] pulled ${(buf.length / 1048576).toFixed(1)} MB, ${n.toLocaleString()} launches`);
    // Renaming swaps the file, but an already-open SQLite handle keeps reading the old inode — so a refresh would be
    // downloaded, verified, and then quietly ignored for as long as the process lived. Exiting hands the platform a
    // clean restart, which reopens the new file. The service is stateless; the queue holds nothing that is not in
    // the database, and a rebuild in flight is cheap to redo.
    if (!first) { console.log("[record] restarting to pick it up"); setTimeout(() => process.exit(0), 250); }
  } catch (e) {
    console.log(`[record] pull failed: ${(e as Error).message}${first ? " (starting on whatever is already here)" : ""}`);
  }
}
await pullRecord(true);
if (RECORD_URL) setInterval(() => void pullRecord(false), REFRESH_MS);

const db = openDb(DB_FILE);
const win = coverageWindows(db);
const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);
const chrome: Chrome = {
  coverageFrom: win.length ? when(win[0].a) : "unknown",
  gapMin: win.slice(1).reduce((a, w, i) => a + Math.max(0, w.a - win[i].b), 0) / 60_000,
};
/** The same coverage statement the page footer makes, in the shape the JSON records carry. */
/**
 * When the archive we are serving was actually built. The web service reads a file the collector produced and pulled
 * across, so "now" is never the right answer for how current the data is — the two 6-hour intervals in front of it
 * (RECORD_EVERY_HOURS, RECORD_REFRESH_HOURS) can put twelve hours between the chain and this process. `meta.built_at`
 * is written by servicedb; the newest row it holds is the fallback for a record built before that field existed.
 */
const recordBuiltAt = (() => {
  try {
    const m = db.prepare("SELECT v FROM meta WHERE k='built_at'").get() as any;
    if (m?.v) return Number(m.v);
  } catch {}
  try { return (db.prepare("SELECT MAX(updated_at) m FROM tokens").get() as any)?.m ?? null; } catch { return null; }
})();
console.log(`[record] built ${recordBuiltAt ? new Date(recordBuiltAt).toISOString() : "unknown"}`);
const COV: Coverage = { from: win.length ? win[0].a : null, downtimeMinutes: chrome.gapMin, builtAt: recordBuiltAt };

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

// ---------- pool refresher ----------
/**
 * Keeps `vault_sol` / `vault_at` current for the launches that could carry a certificate.
 *
 * Certification needs a pool balance read within MAX_READING_AGE_MS, and there are only two places that could come
 * from. Reading per request hands any visitor an RPC amplifier and makes the front page cost a chain round-trip per
 * row. Reading on the collector does not work either: the web service answers from a record file it pulls every few
 * hours, so a balance written there would be stale by hours before it ever arrived — a five-minute window fed by a
 * six-hour pipe is not a guarantee, it is a decoration.
 *
 * So it runs here, in the service that serves it. That is `provenance.ts`'s second invariant applied to the
 * architecture: launch facts are permanent and travel fine in a file pulled every six hours, because those rows never
 * change; pool balances are not permanent and should never have been travelling that way at all. Each kind of fact
 * gets a channel matched to how fast it moves.
 *
 * Three properties this must keep, all of them the difference between a guarantee and a decoration:
 *
 *   1. **`vault_sol` and `vault_at` move together or not at all.** A read that failed leaves both alone, so the
 *      reading ages out and the token quietly loses its certificate. Bumping the timestamp on an unchanged balance is
 *      the exact bug that caused `vault_at` to be introduced in the first place (see `db.ts`), and doing it here
 *      would reintroduce it on the freshest surface we have.
 *   2. **Newest first, and let the tail age out.** The candidate set runs to a few hundred over seven days. If the
 *      refresher cannot cover all of it, the right outcome is that older rows go uncertified — which the page already
 *      expresses as an unchecked count — not that the window widens to make the list look fuller.
 *   3. **It is a background job on our schedule.** Nothing a visitor does can make it run faster or more often, so
 *      traffic cannot be converted into RPC spend.
 */
const NO_REFRESH = process.argv.includes("--no-refresh");
/** Concurrent pool reads. Deliberately small: the rebuild worker and the per-request reads share this RPC budget. */
const REFRESH_CONCURRENCY = 3;
/** How often to look for work. Well inside the window, so a due reading is replaced rather than expiring first. */
const REFRESH_TICK_MS = 30_000;
/**
 * Refresh at half the certificate window rather than at its edge. Waiting for expiry would make every token flicker
 * between certified and uncertified once a cycle, which reads to a visitor as the site changing its mind.
 */
const REFRESH_DUE_MS = MAX_READING_AGE_MS / 2;
/** A pool we cannot read repeatedly (closed, migrated, never really there) must not crowd out ones we can. */
const REFRESH_MAX_FAILS = 3;
const REFRESH_FAIL_COOLDOWN_MS = 30 * 60_000;
/**
 * Reads per cycle. This is what makes "newest first, let the tail age out" real rather than aspirational.
 *
 * Without it a cycle works the whole due list, which during an RPC brownout means hundreds of reads that each take
 * ten to twenty seconds to fail — one cycle running for many minutes, grinding through a list ordered when it started
 * while newer launches it should be prioritising go stale behind it. Capping the cycle means the refresher always
 * finishes promptly and always re-sorts, so the newest candidates are re-read first every time and the oldest are
 * what gets dropped. Sixty per 30s tick keeps the ~150-token 24-hour set inside the certificate window with headroom.
 */
const REFRESH_MAX_PER_CYCLE = 60;

const refreshFails = new Map<string, { n: number; until: number }>();
const refresher = { cycles: 0, read: 0, failed: 0, lastCycleAt: 0, lastCycleMs: 0, due: 0 };

/**
 * The launches that could carry a certificate — the same rule the front page applies, evaluated by the same code.
 * Deriving the candidate set independently (a hand-written SQL approximation of `cleanAtBirth`, say) would let the
 * refresher and the page disagree about who matters, and the failure would be silent: tokens the page wants to
 * certify but nothing ever refreshes.
 */
function refreshCandidates(now: number): any[] {
  const since = now - HOME_DAYS * 86400_000;
  const toks = db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE graduated = 1 AND created_at >= ? AND pool IS NOT NULL`)
    .all(since) as any[];
  return toks
    .filter((t) => cleanAtBirth(t, assess(db, t, covered)))
    .sort((a, b) => b.created_at - a.created_at);   // newest first: the tail is what we are willing to lose
}

const setReading = db.prepare("UPDATE tokens SET vault_sol = ?, vault_at = ? WHERE mint = ?");

/**
 * A cycle can outlast its tick when the chain is slow to answer, and `setInterval` does not care — it would start a
 * second cycle on top of the first, then a third, multiplying exactly the RPC pressure that made them slow. The guard
 * makes a tick a no-op while one is already running.
 */
let refreshing = false;

async function refreshCycle(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try { await runRefreshCycle(); } finally { refreshing = false; }
}

async function runRefreshCycle(): Promise<void> {
  const now = Date.now();
  const started = now;
  const due = refreshCandidates(now).filter((t) => {
    const f = refreshFails.get(t.mint);
    if (f && f.n >= REFRESH_MAX_FAILS && now < f.until) return false;
    return t.vault_at == null || now - t.vault_at >= REFRESH_DUE_MS;
  });
  refresher.due = due.length;
  if (!due.length) { refresher.cycles++; refresher.lastCycleAt = started; refresher.lastCycleMs = Date.now() - started; return; }

  // Newest-first was applied by refreshCandidates; the cap is what actually spends the budget on them.
  const batch = due.slice(0, REFRESH_MAX_PER_CYCLE);
  let next = 0;
  await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, async () => {
    for (let i = next++; i < batch.length; i = next++) {
      const t = batch[i];
      const r = await poolReservesPooled(t.pool, t.mint);
      if (r) {
        // Both columns, one statement, one moment. A balance and the time it was read are a single observation.
        setReading.run(r.quoteSol, Date.now(), t.mint);
        refresher.read++;
        refreshFails.delete(t.mint);
      } else {
        refresher.failed++;
        const f = refreshFails.get(t.mint) ?? { n: 0, until: 0 };
        f.n++;
        if (f.n >= REFRESH_MAX_FAILS) f.until = Date.now() + REFRESH_FAIL_COOLDOWN_MS;
        refreshFails.set(t.mint, f);
      }
    }
  }));
  refresher.cycles++;
  refresher.lastCycleAt = started;
  refresher.lastCycleMs = Date.now() - started;
}

// ---------- rendering ----------
/**
 * `judgeable` is not decoration. A thin pool is only evidence about a token whose launch we actually hold: for a row
 * we merely happen to have — a mint named by a detector, or one that leaked in from somewhere else entirely — the
 * stored `pool` may not be that token's pool at all, and reading it produced a confident red DANGER about liquidity.
 * Wrapped SOL was served exactly this way: title "?", a DANGER telling the reader a position could not be sold. On a
 * site whose whole claim is that it says UNKNOWN rather than guess, that is the worst sentence it could emit.
 */
type TokenRead = { a: Assessment; reading: Reading | null; origin: "observed" | "rebuilt"; clean: boolean };

/**
 * Everything we are prepared to say about one launch, computed once. The HTML page and the JSON record are both built
 * from this — they must never be able to disagree about the same token, and the JSON is the copy nobody proof-reads.
 *
 * The pool is read from chain on every judgeable record rather than quoted from storage, and a read we could not make
 * costs the token its clean certificate: `clean` requires a *fresh* reading above the threshold. That is deliberately
 * fail-closed. It means a stretch of RPC trouble downgrades good tokens to "not certified" (UNKNOWN), which is a cost
 * we accept — the opposite error, certifying on a balance we could not confirm, is the one that ends the project.
 */
async function readRecord(t: any, judgeable: boolean): Promise<TokenRead> {
  const a = assess(db, t, covered);
  // `assess` already treats a complete rebuild as judgeable; the flag only decides how the record describes its source.
  const rebuilt = !!t.rebuilt_at && !!t.rebuilt_complete;
  let reading: Reading | null = judgeable && t.vault_sol != null && t.vault_at != null ? { sol: t.vault_sol, at: t.vault_at, fresh: false } : null;
  if (judgeable && t.pool) {
    const fresh = await poolReservesPooled(t.pool, t.mint);
    if (fresh) reading = { sol: fresh.quoteSol, at: Date.now(), fresh: true };
  }
  if (reading && reading.sol < MIN_POOL_SOL)
    a.flags.push({ level: "DANGER", text: `Only ${reading.sol.toFixed(1)} SOL of liquidity was in the pool ${reading.fresh ? "just now" : "when it was last read"}; a position cannot be sold near the quoted price.` });
  const clean = cleanAtBirth(t, a) && !!reading?.fresh && reading.sol >= MIN_POOL_SOL;
  return { a, reading, origin: rebuilt ? "rebuilt" : "observed", clean };
}

async function renderToken(t: any, judgeable: boolean): Promise<string> {
  const r = await readRecord(t, judgeable);
  const pv = tokenPreview(t, r.a, r.clean);
  return page(pv.title, tokenBody(t, r.a, r.reading, r.origin, r.clean, Date.now()), chrome, 1, pv.summary,
    `/t/${t.mint}.html`);
}

/**
 * What we can say about a mint right now, decided once for both surfaces.
 *
 * This ladder — do we hold it, is a rebuild already running, can we afford to start one, is it even a pump.fun launch
 * — used to live inline in the HTML route. Copying it into the API route would let the two drift, and they would
 * drift in the direction that matters: a budget refusal that the JSON reported as an ordinary empty answer is
 * indistinguishable, to an integrator, from "we looked and found nothing wrong". Each surface now only chooses how to
 * *say* the decision, never what it is.
 *
 * `htmlStatus` is the status the page has always returned for each outcome, kept as-is; the API maps the same codes to
 * more conventional ones in API_STATUS.
 */
type Decision =
  | { kind: "record"; t: any; judgeable: boolean }
  | { kind: "rebuilding"; job: Job }
  | { kind: "unknown"; code: string; why: string; htmlStatus: number };

async function decide(mint: string, ip: string): Promise<Decision> {
  const t = tokenQ.get(mint) as any;
  // Holding a *row* for a mint is not the same as holding its launch: tokens discovered late (named by a post, found
  // by a detector) have no curve history, and treating their presence as an answer meant the most useful thing we
  // could do for them — rebuild the launch from chain — was never attempted.
  const judgeable = !!t && (!!t.rebuilt_complete || (!t.late_discovery && covered(t.created_at)));
  if (judgeable) return { kind: "record", t, judgeable: true };

  // An existing job is reported without spending anything, so a poll or a reload is always free.
  const j = jobs.get(mint);
  if (j && (j.state === "queued" || j.state === "running")) return { kind: "rebuilding", job: j };
  if (j && j.state === "failed" && Date.now() - j.at < RETRY_FAILED_AFTER)
    return { kind: "unknown", code: "rebuild_failed", htmlStatus: 200,
      why: `We tried to rebuild this launch from chain history and could not: ${j.error ?? "unknown"}.` };

  /** Fall back to whatever we do hold, which is honest about knowing nothing, rather than a bare refusal. */
  if (NO_REBUILD)
    return t ? { kind: "record", t, judgeable: false }
      : { kind: "unknown", code: "no_record", htmlStatus: 200, why: "This server does not rebuild records on demand." };

  // Budgets are checked before the cheap probe, and the probe before the queue, so the cheapest refusal wins.
  if (peek("global:day", 86400_000) >= GLOBAL_PER_DAY || peek("global:hour", 3600_000) >= GLOBAL_PER_HOUR)
    return { kind: "unknown", code: "rebuild_budget_exhausted", htmlStatus: 503,
      why: "We have rebuilt as many records as we can pay for in this period. The archive itself is unaffected: only new rebuilds are paused. Try again later." };
  if (!allow(`ip:${ip}`, PER_IP_PER_HOUR, 3600_000))
    return { kind: "unknown", code: "rate_limited", htmlStatus: 429,
      why: `Rebuilding a record reads thousands of transactions from the chain, so each visitor can start ${PER_IP_PER_HOUR} an hour. Records already in the archive are always free to read.` };

  /**
   * One RPC call: a mint with no bonding curve is not a pump.fun token, and refusing here costs nothing.
   *
   * This says so even when we hold a row for the mint. Falling through to the record instead dressed a mint that is
   * nothing to do with pump.fun in the furniture of a launch record, which is how wrapped SOL came to be served under
   * a DANGER flag.
   */
  if (!(await curveExists(mint)))
    return { kind: "unknown", code: "not_a_pump_launch", htmlStatus: 200,
      why: "No pump.fun bonding curve exists for this address, so there is no launch of ours to rebuild. It may be an SPL token launched elsewhere, a wallet address, or a typo." };

  const started = enqueue(mint);
  if (started.error === "busy")
    return { kind: "unknown", code: "busy", htmlStatus: 503,
      why: "We are rebuilding as many records as we can keep up with right now, so this one has not started. Try again in a few minutes." };
  allow("global:hour", GLOBAL_PER_HOUR, 3600_000);
  allow("global:day", GLOBAL_PER_DAY, 86400_000);
  return { kind: "rebuilding", job: started };
}

/** Shown while a rebuild is queued or running. It polls, so the visitor does not have to. */
const waiting = (mint: string, j: Job) => page("Rebuilding", `
  <h1>Rebuilding this token's record</h1>
  <div class="sub mono">${mint}</div>
  <div class="prog"><i></i></div>
  <p>We have no record of this launch, so we are reading its bonding curve's entire transaction history from the chain
  and rebuilding what happened: who created it, what they took in the first block, every wallet that bought on the
  curve, and how it graduated.</p>
  <p class="sub">${j.state === "queued" ? `Queued${queue.indexOf(mint) > 0 ? `, ${queue.indexOf(mint)} ahead of it` : ""}.` : "Running."} A busy curve can take several minutes; there can be
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
  The rebuild could not be completed: <span id="errtext"></span>. That is a failure to read, not a finding.
  It says nothing about this token.</div>`, chrome, 1);

const noRecord = (mint: string, why: string) => page("No record", `
  <h1>We have no record of this launch</h1>
  <div class="sub mono">${mint}</div>
  <div class="flag UNKNOWN"><span class="tag UNKNOWN">unknown</span>${why}
  This is <b>not</b> a clean result. Once a token's float has been spread across wallets, a manufactured launch is
  indistinguishable from a real one by present-tense inspection, which is why the record has to be kept at the time,
  and why we will not guess.</div>
  ${SEARCH}`, chrome, 1);

/** True only for a readable regular file: a directory exists but cannot be sent, and a broken path is not an error. */
const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * The front page, per request.
 *
 * It used to be a file, which meant its numbers were true at build time and drifted from then on — and the build that
 * produced them could fail for a whole day, as it did. The chain does not stop, so neither should the page.
 *
 * Two things make this affordable. The counts are indexed aggregates over a 45 MB record, single-digit milliseconds.
 * And certification no longer reads a pool: a launch is certified from a stored reading that is fresh enough
 * (MAX_READING_AGE_MS), refreshed on our own schedule rather than a visitor's, so no request can ever be turned into
 * an RPC amplifier. A reading that has aged out means uncertified, never a warning.
 *
 * The cache exists only so a burst of traffic cannot multiply the work; at this TTL the page is never meaningfully
 * behind the database it reads, and it is orders of magnitude fresher than the file it replaces.
 */
const HOME_TTL_MS = Number(process.env.HOME_TTL_SECONDS ?? 15) * 1000;
const HOME_DAYS = Number(process.env.HOME_DAYS ?? 7);
let homeCache: { at: number; h: Home; html: string } | null = null;

function buildHome(now: number): Home {
  const since = now - HOME_DAYS * 86400_000;
  const toks = db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE graduated = 1 AND created_at >= ?`).all(since) as any[];
  const assessed = toks.map((t) => ({ t, a: assess(db, t, covered) }));

  const certified = assessed.filter(({ t, a }) => cleanAtBirth(t, a) && readingCertifies(t.vault_at, t.vault_sol, now));
  const uncertified = assessed.filter(({ t, a }) => cleanAtBirth(t, a) && !readingCertifies(t.vault_at, t.vault_sol, now));
  const unchecked = uncertified.length;

  /**
   * The 24-hour window ends where the archive ends, not where the clock is.
   *
   * Measured against `now`, this window slides forward while the data behind it stands still, so a
   * frozen archive does not read as stale: it reads as a collapsing market. On 2026-09-07 the
   * published record sat at one build for seven hours and this counter fell from 1,433 to 1,378
   * with nothing wrong upstream. Left long enough it reaches zero, and the headline then states
   * that no token completed a bonding curve all day, which is not stale, it is false.
   *
   * Anchoring to `built_at` makes the sentence true of the record we are actually serving. It also
   * stops the number moving for a reason unrelated to the market, which is the more insidious half:
   * a figure that drifts looks live, and a reader has no way to tell drift from news.
   */
  const windowEnd = recordBuiltAt ?? now;
  const inDay = (t: any) => t.created_at >= windowEnd - 86400_000 && t.created_at <= windowEnd;
  const day = assessed.filter(({ t }) => inDay(t));

  const proofRow = assessed
    .filter(({ t, a }) => !t.late_discovery && t.dev_pct >= 50 && a.curveBuyers === 0 && t.pool && t.vault_at != null && (t.vault_sol ?? 0) < 10)
    .sort((x, y) => (y.t.vault_at ?? 0) - (x.t.vault_at ?? 0))[0];

  const ops = db.prepare(
    `SELECT wallet, curve_sol, amm_buy, amm_sell, tokens FROM wallet_flow ORDER BY amm_sell DESC LIMIT 15`).all() as any[];
  const walletCount = (db.prepare("SELECT COUNT(*) c FROM wallet_flow").get() as any).c as number;

  return {
    now, builtAt: recordBuiltAt, windowEnd,
    graduated24h: day.length,
    clean24h: certified.filter(({ t }) => inDay(t)).length,
    danger24h: day.filter(({ a }) => a.flags.some((f) => f.level === "DANGER")).length,
    onFile: (db.prepare("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0").get() as any).c,
    windowDays: HOME_DAYS, gradWindow: toks.length, unchecked,
    unchecked24h: uncertified.filter((x) => inDay(x.t)).length,
    cleanRows: certified.sort((x, y) => y.t.created_at - x.t.created_at).slice(0, 40).map(({ t, a }) => ({
      mint: t.mint, symbol: t.symbol, devPct: t.dev_pct, buyers: a.curveBuyers ?? 0,
      fillMs: t.graduated_at && t.created_at ? t.graduated_at - t.created_at : null,
      poolSol: t.vault_sol, readAt: t.vault_at,
    })),
    wallets: walletCount,
    opRows: ops.map((w) => ({ wallet: w.wallet, taken: w.tokens, spent: w.curve_sol, sold: w.amm_sell, bought: w.amm_buy })),
    proof: proofRow ? {
      mint: proofRow.t.mint, symbol: proofRow.t.symbol, devPct: proofRow.t.dev_pct,
      gradMs: proofRow.t.graduated_at && proofRow.t.created_at ? proofRow.t.graduated_at - proofRow.t.created_at : null,
      fundedSol: 0, nowSol: proofRow.t.vault_sol, nowAt: proofRow.t.vault_at,
    } : null,
    maxDevPct: MAX_DEV_PCT, minBuyers: MIN_BUYERS, buyoutSol: BUYOUT_SOL, minPoolSol: MIN_POOL_SOL,
  };
}

function currentHome(): Home {
  const now = Date.now();
  if (homeCache && now - homeCache.at < HOME_TTL_MS) return homeCache.h;
  const h = buildHome(now);
  homeCache = { at: now, h, html: page(homeTitle(h), homeBody(h), chrome, 0, undefined, "/") };
  return h;
}
function renderHome(): string { currentHome(); return homeCache!.html; }

/**
 * `api/summary.json`, from the same pass that renders the page.
 *
 * It used to be written by the generator, and it could not be right there: a certificate needs a pool reading from
 * the last five minutes, and those readings only exist inside this process. So a build on a laptop, or in the image,
 * published clean24h 0 while the live page said 3 - two numbers on the same site disagreeing about the same thing,
 * which is the fault we spent the day removing everywhere else. Deriving it from `currentHome()` means they cannot
 * differ, because they are one computation.
 */
function summaryJson(): string {
  const h = currentHome();
  return JSON.stringify({
    generatedAt: Date.now(), asOf: h.builtAt, coverageFrom: COV.from, downtimeMinutes: Math.round(COV.downtimeMinutes),
    maxReadingAgeMs: MAX_READING_AGE_MS,
    graduated24h: h.graduated24h, clean24h: h.clean24h, uncertified24h: h.unchecked24h,
    uncertified: h.unchecked, archivedLaunches: h.onFile,
    clean: h.cleanRows.map((r) => ({
      mint: r.mint, symbol: r.symbol, creatorSupplyPct: r.devPct, curveBuyers: r.buyers,
      poolSol: r.poolSol, poolReadAt: r.readAt,
    })),
  }, null, 2);
}

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

    /**
     * ---------- the machine-readable record: /api/v1 ----------
     *
     * Free, keyless and unmetered for reads, because the whole strategy depends on being cited rather than bought:
     * a wallet or a terminal that has to sign up will use whatever is already embedded in its page instead. Only the
     * expensive path — reconstructing a launch we never watched, which costs thousands of archival RPC calls — carries
     * the same budget a human visitor gets.
     *
     * Matched before the static tree, so `/api/v1/...` is always answered by this code even if a file of that name
     * were ever written into `site/`.
     */
    if (safe.startsWith(`/api/${API_VERSION}/`) || safe === `/api/${API_VERSION}`) {
      /**
       * Every response is CORS-open. The integrations that matter most — a warning shown inside a wallet or a terminal
       * — are browser code on someone else's origin, and a missing header makes the whole API unusable to them while
       * looking perfectly fine to us. It costs nothing: the data is public domain and there is no session to steal.
       */
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      };
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      const j = (code: number, body: object, cache: "immutable" | "short" | "none" = "none", extra: Record<string, string> = {}) => {
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          ...cors,
          // A settled launch record is immutable, so it caches hard at the edge; anything still moving must not.
          "cache-control": code !== 200 ? "no-store"
            : cache === "immutable" ? "public, max-age=3600, stale-while-revalidate=86400"
            : cache === "short" ? "public, max-age=60" : "no-store",
          ...extra,
        });
        res.end(JSON.stringify(body, null, 2));
      };
      /** The HTTP status each refusal deserves. The body says the same thing either way, and carries an UNKNOWN verdict. */
      const API_STATUS: Record<string, number> = {
        not_a_pump_launch: 404, no_record: 404, rebuild_failed: 404,
        rate_limited: 429, rebuild_budget_exhausted: 503, busy: 503,
      };
      const rest = safe.slice(`/api/${API_VERSION}`.length).replace(/^\/+/, "");

      if (rest === "" || rest === "status")
        return j(200, statusRecord(COV, held, {
          docs: "/api.html",
          bulk: "/data/record.db",
          endpoints: [`/api/${API_VERSION}/token/{mint}`, `/api/${API_VERSION}/wallet/{address}`, `/api/${API_VERSION}/status`],
          rebuildsPerIpPerHour: PER_IP_PER_HOUR,
          // What the certificate actually rests on, published rather than implied: how fresh a pool reading has to be,
          // and whether the job keeping them fresh is currently keeping up.
          readingMaxAgeSeconds: MAX_READING_AGE_MS / 1000,
          liquidityRefresh: NO_REFRESH ? null : {
            cycles: refresher.cycles, read: refresher.read, failed: refresher.failed,
            dueLastCycle: refresher.due, lastCycleMs: refresher.lastCycleMs,
            lastCycleAt: refresher.lastCycleAt ? new Date(refresher.lastCycleAt).toISOString() : null,
          },
        }), "short");

      const tj = rest.match(/^token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (tj) {
        const mint = tj[1];
        const d = await decide(mint, clientIp(req));
        if (d.kind === "record") {
          const r = await readRecord(d.t, d.judgeable);
          return j(200, tokenRecord(d.t, r.a, r.reading, r.origin, r.clean, COV), d.judgeable ? "immutable" : "none");
        }
        if (d.kind === "rebuilding")
          // 202: we have accepted the work and there is no answer yet. Poll the same URL; a finished rebuild is
          // permanent, so the second call is the last one a caller ever needs to make for this mint.
          return j(202, {
            ...unknownRecord(mint, "We have no record of this launch, so we are reading its bonding curve's entire transaction history from the chain and rebuilding what happened.", COV),
            rebuild: { state: d.job.state, queued: queue.length, poll: `/api/${API_VERSION}/token/${mint}` },
          }, "none", { "retry-after": "30" });
        return j(API_STATUS[d.code] ?? 200, { ...unknownRecord(mint, d.why, COV), error: d.code },
          "none", d.code === "busy" || d.code === "rebuild_budget_exhausted" ? { "retry-after": "300" } : {});
      }

      const wj = rest.match(/^wallet\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (wj) {
        const p = profile(db, wj[1]);
        // No buyouts is not a clean bill of health for a wallet, and the record says so rather than returning an
        // empty object a caller would read as "nothing on file".
        return j(200, walletRecord(wj[1], p, verdictLine(p), COV), "short");
      }

      if (/^(token|wallet)\//.test(rest))
        return j(400, errorRecord("not_an_address",
          "A Solana address is 32 to 44 characters of base58, with no 0, O, I or l.", COV, `/api/${API_VERSION}`));

      const jj = rest.match(/^job\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      if (jj) return j(200, { ...(jobs.get(jj[1]) ?? { state: "unknown" }), apiVersion: API_VERSION });

      return j(404, errorRecord("unknown_endpoint",
        `No such endpoint. This API serves /api/${API_VERSION}/token/{mint}, /api/${API_VERSION}/wallet/{address} and /api/${API_VERSION}/status.`,
        COV, `/api/${API_VERSION}`));
    }

    /**
     * The search form's target. The box used to be an onsubmit handler with no action, so with scripting off it did
     * nothing — the site's only interactive element was decorative for anyone on a locked-down browser, a text-mode
     * client or a broken script load. A plain GET lands here and is redirected to the record.
     */
    if (safe === "/lookup") {
      const q = (url.searchParams.get("mint") ?? "").trim();
      if (MINT.test(q)) { res.writeHead(302, { location: `/t/${q}.html`, "cache-control": "no-store" }); return res.end(); }
      return send(400, page("Not an address", `<h1>That is not a Solana address</h1>
        <p class="sub">A mint address is 32 to 44 characters of base58, with no 0, O, I or l.</p>${SEARCH}`, chrome, 0));
    }

    // The front page is rendered, not served from disk. It must come before the static handler, which would
    // otherwise keep answering with whatever index.html the last build left behind.
    if (safe === "/index.html") return send(200, renderHome(), "text/html; charset=utf-8", "short");
    if (safe === "/api/summary.json") return send(200, summaryJson(), TYPES[".json"], "short");

    const file = join(DIR, safe);
    /**
     * A directory is not a file. `existsSync` is true for `site/api`, and the trailing-slash guard never fired because
     * the request that reaches here is `/api` with no slash — so readFileSync was handed a directory and threw EISDIR,
     * which the outer catch turned into a 500. Production logged a stack trace for every hit on a bare directory path.
     * A path we do not serve is a 404, not an error on our side.
     */
    if (isFile(file)) return send(200, readFileSync(file), TYPES[safe.slice(safe.lastIndexOf("."))] ?? "application/octet-stream", "short");

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
          curve in our archive. That is not a statement about the wallet: only that it does not appear here.</div>`, chrome, 1));
      const line = verdictLine(p);
      return send(200, page(`Priors: ${wm[1].slice(0, 8)}`, walletBody(wm[1], p, line), chrome, 1,
        line ?? `A wallet that has bought out ${p.buyouts.length} bonding curve${p.buyouts.length === 1 ? "" : "s"} in this archive.`,
        `/w/${wm[1]}.html`), "text/html; charset=utf-8", "short");
    }

    // a token page we have not generated: answer from the database, or rebuild it
    const m = safe.match(/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})\.html$/);
    if (m) {
      const mint = m[1];
      const d = await decide(mint, clientIp(req));
      if (d.kind === "record")
        return send(200, await renderToken(d.t, d.judgeable), "text/html; charset=utf-8", d.judgeable ? "immutable" : "none");
      if (d.kind === "rebuilding") return send(200, waiting(mint, d.job));
      return send(d.htmlStatus, noRecord(mint, esc2(d.why)));
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

/**
 * Started here rather than beside its own functions because `refreshCandidates` reads HOME_DAYS, which is declared
 * with the home-page section further down — running a cycle at that point would hit its temporal dead zone. Starting
 * after the module has finished evaluating also means the first read cannot race the server coming up.
 */
if (!NO_REFRESH) {
  // Kick off immediately so a restart does not leave the page uncertified for a whole tick, then settle into the loop.
  void refreshCycle().catch((e) => console.log(`[refresh] ${(e as Error).message}`));
  setInterval(() => void refreshCycle().catch((e) => console.log(`[refresh] ${(e as Error).message}`)), REFRESH_TICK_MS);
  setInterval(() => {
    if (!refresher.cycles) return;
    console.log(`[refresh] ${refresher.cycles} cycles, ${refresher.read} read, ${refresher.failed} failed, ${refresher.due} due last cycle (${refresher.lastCycleMs} ms)`);
  }, 10 * 60_000);
}

server.listen(PORT, () => {
  console.log(`serving ${DIR} from ${DB_FILE} (${held.toLocaleString()} launches) on http://localhost:${PORT}`);
  console.log(`unknown mints are rebuilt from chain (queue max ${MAX_QUEUE}, one at a time)`);
});
