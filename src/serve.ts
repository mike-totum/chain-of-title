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
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { DatabaseSync } from "node:sqlite";
import { type Assessment, assess, cleanAtBirth, coverageWindows, TOKEN_COLUMNS, optionalColumns, graduationDisproved, MIN_POOL_SOL,
  readingCertifies, readingIsFresh, MAX_READING_AGE_MS, MAX_DEV_PCT, MIN_BUYERS, BUYOUT_SOL } from "./provenance.ts";
import { profile, verdictLine, walletVerdict, clusterProfile, clusterTable } from "./operator.ts";
import { poolReservesPooled } from "./outcomes.ts";
import { rebuild, store, curveExists } from "./backfill.ts";
import { page, tokenBody, walletBody, tokenPreview, SEARCH, when, fmt, homeBody, homeTitle, verdict, CANONICAL_HOST,
  siblingsBody, relaunchStrip, wallBody, clusterBody, walletsBody, operatorsBody, cleanBody,
  reportBody, reportsIndexBody,
  type Priors, type SiblingRow, type SiblingStats, type StripMark,
  type Home, type Chrome, type Reading } from "./render.ts";
import { loadReports, reportDate } from "./reports.ts";
import { r2Config, getWithType as r2Get } from "./r2.ts";
import { tokenRecord, walletRecord, statusRecord, unknownRecord, errorRecord,
  API_VERSION, PER_IP_PER_HOUR, GLOBAL_PER_HOUR, GLOBAL_PER_DAY, type Coverage } from "./api.ts";
import { startWatchdog, startHeartbeat, fmtAge } from "./watchdog.ts";
import { telegramSend } from "./signals/telegram-notify.ts";

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

/**
 * The collector's live launch count, which is a different claim from the published one and needs saying separately.
 *
 * Everything else this service reports comes out of `record.db`: a snapshot, exact about itself and as old as the
 * last build. That is the right source for "how many launches are in the file you are downloading" and the wrong one
 * for "how many launches are on record", which the site had been answering from it — so the headline sat frozen for
 * six hours at a stretch while the collector never stopped ingesting, and understated the archive by thousands by
 * the end of each cycle.
 *
 * Derived from RECORD_URL rather than configured separately, so there is one address for the collector and no way to
 * point them at different services. Null whenever the collector cannot be reached or has not answered recently: a
 * live number that has quietly stopped moving is worse than none, because the page would then assert ingestion is
 * healthy on the strength of a value that died.
 */
/**
 * Settable on its own, and that is the point rather than a convenience.
 *
 * Deriving it from RECORD_URL alone would mean the live counter could not be switched on without also arming
 * `pullRecord`, which adopts whatever record the collector is serving. That pull is the step being deliberately held
 * back until the collector's build has been observed producing something sane — it is the path that can replace a
 * 165,025-launch published archive — and a display feature must not be the thing that arms it. Set
 * COLLECTOR_HEALTH_URL for the counter; set RECORD_URL when, separately, the pull is meant to be live.
 */
const HEALTH_URL = process.env.COLLECTOR_HEALTH_URL || (RECORD_URL ? RECORD_URL.replace(/\/record\.db$/, "/health") : "");
const LIVE_MAX_AGE_MS = 60_000;
/**
 * Ask the collector about one launch this file does not hold. Same host as the counter, so there is one address for
 * the collector and no way to point them at different services.
 */
const LAUNCH_URL = HEALTH_URL ? HEALTH_URL.replace(/\/health$/, "/launch/") : "";
/**
 * Why the last live lookup did not answer. Reported on /api/v1/live rather than logged, for the same reason the
 * counter's `unavailable` is: a feature that silently declines to work looks identical to one that was never built,
 * and the difference is only visible from inside a container nobody can open.
 */
let lastLaunchLookup = "no lookup attempted yet";
let live: { observed: number; held: number; operators?: number | null; operatorsError?: string | null; at: number } | null = null;
/**
 * Why the last poll produced nothing. The page renders the same either way — no counter — but "the collector is
 * unreachable" and "the collector answered and could not count" are different faults with different fixes, and a
 * single blank number collapses them into one. Reported on /api/v1/live rather than logged, so it can be read from
 * outside the container without a shell.
 */
let liveErr: string | null = "not polled yet";

async function pollLive(): Promise<void> {
  if (!HEALTH_URL) return;
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const h = (await res.json()) as any;
    // A collector that answers without a count is not a collector that has zero launches: it is one whose own
    // COUNT(*) threw, which is a fault on its side and must not be rendered as a number.
    if (typeof h.observed === "number" && typeof h.held === "number") {
      /**
       * Carry the fields through rather than picking two of them.
       *
       * This picked `observed` and `held` and dropped everything else, so `operators` — added to /health precisely
       * to make the publish guard observable — arrived and was discarded, and /api/v1/live reported null. Two
       * deploys were spent diagnosing the producer for a fault in the consumer, which is this evening's shape
       * exactly: the thing that looked broken was the thing being read, not the thing being sent.
       */
      live = { observed: h.observed, held: h.held, operators: h.operators ?? null,
        operatorsError: h.operatorsError ?? null, at: Date.now() };
      liveErr = null;
    } else liveErr = "collector reachable but reported no counts";
  } catch (e) {
    // Leave the previous value; freshness is judged by `at` below, not by whether this particular poll worked.
    liveErr = `collector unreachable: ${(e as Error).message}`;
  }
}
/** Null once the last successful poll is older than the tolerance, so a dead collector shows no live number at all. */
const liveNow = () => (live && Date.now() - live.at <= LIVE_MAX_AGE_MS ? live : null);
if (HEALTH_URL) { void pollLive(); setInterval(() => void pollLive(), 15_000); }

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
    /**
     * Every dimension of the record, not just the row count of one table.
     *
     * A guard that reads `tokens` alone calls it growth whenever the launch count rises, and on 2026-09-08 that was
     * about to be wrong in the way that matters: the collector's first working build held 169,100 launches against
     * production's 165,025 — but 580 buyout trades against 2,099, and zero `hist_trades` against 1,072. Adopting it
     * would have grown the headline number while destroying three quarters of the evidence of who took the curves,
     * and this guard would have called it an improvement.
     *
     * `trades` and `hist_trades` are what `findBuyout` reads: the wallet pages, the operator attribution, the half
     * of this product a contract scanner cannot reproduce. They are the record, not working data, which is also why
     * retention no longer deletes them.
     *
     * The right count is not the right archive. A number rising is not a pipeline working.
     */
    const dims = ["tokens", "trades", "hist_trades", "operator_wallets", "pool_map"] as const;
    const incoming: Record<string, number> = {};
    for (const t of dims) {
      try { incoming[t] = (probe.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c as number; }
      catch { incoming[t] = 0; }   // a table the incoming file does not have holds nothing, which is what it means
    }
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
    /**
     * The same 90% rule on every other dimension, checked against what is already being served. Separate from the
     * launch check above so the error names the dimension that actually regressed — "fewer launches" and "the same
     * launches with the buyout evidence gone" are different faults and want different fixes.
     */
    if (process.env.RECORD_ALLOW_SHRINK !== "1") {
      const held: Record<string, number> = {};
      try {
        const cur = new DatabaseSync(DB_FILE, { readOnly: true });
        for (const t of dims) {
          try { held[t] = (cur.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c as number; } catch { held[t] = 0; }
        }
        cur.close();
      } catch { /* nothing served yet: anything is an improvement, and the launch guard above still applies */ }
      for (const t of dims) {
        if (t === "tokens") continue;                       // already checked, with its own message
        if ((held[t] ?? 0) > 0 && incoming[t] < held[t] * 0.9)
          throw new Error(`downloaded archive holds ${incoming[t].toLocaleString()} rows of ${t} against the ` +
            `${held[t].toLocaleString()} already here. The launch count may be higher, but this record carries less ` +
            `evidence than the one it would replace — refusing. Set RECORD_ALLOW_SHRINK=1 to override deliberately.`);
      }
    }
    renameSync(tmp, DB_FILE);
    console.log(`[record] pulled ${(buf.length / 1048576).toFixed(1)} MB, ${n.toLocaleString()} launches`);
    // Renaming swaps the file, but an already-open SQLite handle keeps reading the old inode — so a refresh would be
    // downloaded, verified, and then quietly ignored for as long as the process lived. Exiting hands the platform a
    // clean restart, which reopens the new file. The service is stateless; the queue holds nothing that is not in
    // the database, and a rebuild in flight is cheap to redo.
    // Adopt in place. This used to exit so the platform would restart us onto the new inode, which loops forever on
    // a service with no volume — see reloadRecord.
    reloadRecord();
  } catch (e) {
    console.log(`[record] pull failed: ${(e as Error).message}${first ? " (starting on whatever is already here)" : ""}`);
  }
}
/**
 * NOTHING NETWORK-BOUND RUNS BEFORE THIS PROCESS LISTENS.
 *
 * The boot pull used to be awaited here, and it took the site down on 2026-09-09. This service sleeps when idle, so
 * a wake starts a fresh container — which then blocked on downloading a 79 MB record from the collector before
 * binding a port, and the platform's wake timed out. Every request got a 502 while the process was busy fetching the
 * data it wanted to serve. The site had been up for hours; it broke the first time it was allowed to go idle.
 *
 * A service must be able to answer with what it already has. The image ships a record, that record is never empty
 * (the guard below refuses to start otherwise), and being a few hours behind is a state this codebase already
 * describes honestly on every page. Being unreachable is not.
 *
 * So the pull moves to a timer after `listen`, and the first one is gated on the collector actually holding
 * something newer — otherwise a service that wakes often would download 79 MB and restart itself on every wake.
 */
async function collectorHasNewer(): Promise<boolean> {
  if (!HEALTH_URL) return true;   // no way to ask: fall through to the pull, which has its own guards
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const h = await res.json() as any;
    const theirs = Number(h?.builtAt ?? 0);
    if (!Number.isFinite(theirs) || theirs <= 0) return false;
    const ours = await (async () => {
      try {
        const { DatabaseSync: DS } = await import("node:sqlite");
        const cur = new DS(DB_FILE, { readOnly: true });
        const m = cur.prepare("SELECT v FROM meta WHERE k='built_at'").get() as any;
        cur.close();
        return Number(m?.v ?? 0) || 0;
      } catch { return 0; }
    })();
    /**
     * Size decides, and the clock only breaks ties.
     *
     * This compared build times alone, and on 2026-09-10 that stranded the public archive 29,205 launches behind:
     * every deploy bakes whatever `data/record.db` was on the laptop into the image, that copy happened to carry a
     * later `built_at` than the collector's current build, and so the service sat serving 202,938 launches while
     * the collector held 232,143 and declined to pull, correctly by the rule it was given. A build time says when
     * a file was made. It says nothing about which file is more of the archive, and that is the actual question.
     * The pull still has to clear the shrink guards afterwards, which is what protects against the reverse error.
     */
    const theirLaunches = Number(h?.observed ?? h?.launches ?? 0);
    if (Number.isFinite(theirLaunches) && theirLaunches > observed * 1.001) {
      console.log(`[record] collector holds ${theirLaunches.toLocaleString()} launches against the ${observed.toLocaleString()} being served; pulling`);
      return true;
    }
    if (theirs <= ours) { console.log(`[record] collector's build is not newer than ours (${new Date(ours).toISOString()}) and holds no more launches (${theirLaunches.toLocaleString()} vs ${observed.toLocaleString()}); skipping the pull`); return false; }
    return true;
  } catch { return false; }
}
/**
 * Whether this process has finished its first attempt at pulling a record, and when it started.
 *
 * Every deploy ships the `data/record.db` that was on disk when the image was built, and the service boots serving
 * it - by design, so a collector that cannot be reached does not take the site down. The consequence is that for
 * the first half-minute of every deploy the process is knowingly serving an old file, and the freshness watchdog
 * was judging it there: on 2026-09-10 it alarmed at "a record built 10h 30m ago" and the pull landed seconds
 * later with one built eight minutes ago. An alarm that fires on every deploy is worse than no alarm, because it
 * teaches the person reading it that this check does not mean anything.
 */
const bootAt = Date.now();
let firstPullSettled = !RECORD_URL;
/** How long the boot pull gets before the watchdog starts judging the record anyway. */
const BOOT_PULL_GRACE_MS = 5 * 60_000;

if (RECORD_URL) {
  setTimeout(() => void (async () => {
    try { if (await collectorHasNewer()) await pullRecord(false); }
    finally {
      // Settled means attempted, not succeeded. A pull that fails must let the watchdog resume judging, or a
      // collector that is permanently unreachable would silence the check it exists to trip.
      firstPullSettled = true;
    }
  })(), 20_000);
  setInterval(() => void pullRecord(false), REFRESH_MS);
}

/**
 * Fetch a record before serving, when there is nothing worth serving yet.
 *
 * The record used to be baked into the image from whatever was on a laptop at build time, which meant a personal
 * machine sat in the publish path of a public archive: on 2026-09-10 that copy carried a later build timestamp
 * than the collector's, the service preferred it, and the archive sat 29,419 launches behind. With the record on
 * a volume instead, the first boot has nothing at all, and a web service that starts anyway would answer "we hold
 * no record" about every token on Solana — authoritative and wrong, which this project ranks below being down.
 *
 * Deliberately not `pullRecord`: that ends in `reloadRecord`, which reassigns `db`, and `db` is initialised on the
 * next line. Calling it here would read a binding in its temporal dead zone. This only puts bytes on disk, and the
 * ordinary guards below then decide whether those bytes are fit to serve.
 */
async function fetchFirstRecord(): Promise<void> {
  if (!RECORD_URL) return;
  const holds = (() => {
    try {
      const cur = new DatabaseSync(DB_FILE, { readOnly: true });
      const n = (cur.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
      cur.close();
      return n;
    } catch { return 0; }
  })();
  if (holds >= 1000) return;
  const { writeFileSync, mkdirSync, renameSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  for (let attempt = 1; attempt <= 20; attempt++) {
    console.log(`[record] nothing to serve yet (${holds} launches on disk); fetching from the collector, attempt ${attempt}`);
    try {
      const res = await fetch(RECORD_URL, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) throw new Error(`only ${buf.length} bytes`);
      mkdirSync(dirname(DB_FILE), { recursive: true });
      writeFileSync(`${DB_FILE}.incoming`, buf);
      const probe = new DatabaseSync(`${DB_FILE}.incoming`, { readOnly: true });
      const n = (probe.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
      probe.close();
      if (n < 1000) throw new Error(`it holds only ${n} launches`);
      renameSync(`${DB_FILE}.incoming`, DB_FILE);
      console.log(`[record] fetched ${(buf.length / 1048576).toFixed(1)} MB, ${n.toLocaleString()} launches, before opening the port`);
      return;
    } catch (e) {
      console.log(`[record] first fetch failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  // Twenty attempts over five minutes. Exit rather than serve an empty archive; the platform restarts us and the
  // collector may be back by then.
  console.error("[record] could not fetch a record to serve. Exiting rather than answering with an empty archive.");
  process.exit(1);
}
await fetchFirstRecord();

/**
 * The published record, opened WITHOUT migrating it. This service serves the file to the public and must not be the
 * reason its bytes differ from what servicedb built — see openDb. Readings still write here; only schema changes and
 * journal_mode are withheld.
 */
let db = openDb(DB_FILE, { migrate: false });

/**
 * The guard runs FIRST, before anything else touches a table.
 *
 * It used to sit fifty lines below `coverageWindows(db)`, which was harmless only while `openDb` created the tables
 * it needed: a missing record produced empty tables and the guard caught it with a clear message. Opening without
 * migrating removes that floor — there is no `runs` table either — so a missing or truncated file threw inside
 * `coverageWindows` and the refusal below could never be reached. The message the guard exists to print was
 * replaced by a stack trace, on the one path where the service must fail comprehensibly.
 */
const count = (sql: string): number => {
  try { return (db.prepare(sql).get() as any).c as number; } catch { return 0; }
};
let held = count("SELECT COUNT(*) c FROM tokens");
let observed = count("SELECT COUNT(*) c FROM tokens WHERE COALESCE(late_discovery,0)=0");
if (held < 1000) {
  console.error(`refusing to start: ${DB_FILE} holds ${held} launches, which cannot be a real archive.`);
  console.error(`build one with \`npm run servicedb\` and make sure it is present at that path.`);
  process.exit(1);
}

let win = coverageWindows(db);
const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);
let chrome: Chrome = {
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
const readBuiltAt = () => {
  try {
    const m = db.prepare("SELECT v FROM meta WHERE k='built_at'").get() as any;
    if (m?.v) return Number(m.v);
  } catch {}
  try { return (db.prepare("SELECT MAX(updated_at) m FROM tokens").get() as any)?.m ?? null; } catch { return null; }
};
let recordBuiltAt = readBuiltAt();
console.log(`[record] built ${recordBuiltAt ? new Date(recordBuiltAt).toISOString() : "unknown"}`);
let COV: Coverage = { from: win.length ? win[0].a : null, downtimeMinutes: chrome.gapMin, builtAt: recordBuiltAt };

/**
 * Adopt a freshly pulled record WITHOUT restarting.
 *
 * The pull used to rename the file and exit, on the reasoning that an open SQLite handle keeps reading the old inode
 * so only a restart can pick up the new one. That is true, and on 2026-09-09 it took the site down for hours: this
 * service has no volume, so the restart returns a container built from the image, the 80 MB that was just pulled is
 * gone, the record is old again, and it pulls and restarts forever. Every request 502s because the process never
 * lives long enough to answer one. The freshness gate did not help — the collector is newer than the image on every
 * single fresh container, by construction.
 *
 * Reopening in place is the fix that needs no volume and keeps the service stateless: swap the handle, re-derive
 * everything read from the file, re-prepare the statements bound to the old connection. The old handle is closed on
 * a delay rather than immediately, so a request already mid-flight finishes against the file it started on.
 */
function reloadRecord(): void {
  const previous = db;
  try {
    db = openDb(DB_FILE, { migrate: false });
    const n = count("SELECT COUNT(*) c FROM tokens");
    // The same floor the boot guard applies. A record that cannot be a real archive is not adopted, and the process
    // keeps serving what it already had rather than exiting into the loop this function exists to end.
    if (n < 1000) { db = previous; console.log(`[record] refusing to adopt a record holding ${n} launches`); return; }
    held = n;
    observed = count("SELECT COUNT(*) c FROM tokens WHERE COALESCE(late_discovery,0)=0");
    win = coverageWindows(db);
    chrome = {
      coverageFrom: win.length ? when(win[0].a) : "unknown",
      gapMin: win.slice(1).reduce((a, w, i) => a + Math.max(0, w.a - win[i].b), 0) / 60_000,
    };
    recordBuiltAt = readBuiltAt();
    COV = { from: win.length ? win[0].a : null, downtimeMinutes: chrome.gapMin, builtAt: recordBuiltAt };
    tokenQ = db.prepare(`SELECT ${TOKEN_COLUMNS}${optionalColumns(db)} FROM tokens WHERE mint = ?`);
    setReading = db.prepare("UPDATE tokens SET vault_sol = ?, vault_at = ? WHERE mint = ?");
    console.log(`[record] adopted in place: ${held.toLocaleString()} launches, built ${recordBuiltAt ? new Date(recordBuiltAt).toISOString() : "unknown"}`);
    setTimeout(() => { try { previous.close(); } catch { /* a request may still hold it; the process will outlive this */ } }, 30_000);
  } catch (e) {
    db = previous;
    console.log(`[record] could not adopt the new record, still serving the previous one: ${(e as Error).message}`);
  }
}

/**
 * Refuse to serve an empty archive. `openDb` creates its tables when the file is missing, so a database that failed to
 * ship produces a service that answers "we have no record of this launch" for every token on Solana — confidently,
 * with a clean 200, and indistinguishable from the truth. Being down is recoverable; being authoritatively wrong about
 * every token is not. This is exactly what a missing `data/record.db` did on the first deploy.
 */
/**
 * Two counts, because they answer different questions and publishing either one as "launches" was wrong.
 *
 * `observed` is every launch watched from its creation transaction: the population the product's claims are actually
 * about. `held` is every row in the file, which additionally counts launches a detector restored after the fact and
 * the handful rebuilt from chain history. Those rows are real records and belong in the file, but their first-block
 * counters are not complete observations, so they must not be added to a number that means "we saw this happen".
 *
 * The front page has always shown `observed` and the API reported `held`, both labelled launches, and they differed by
 * 2,736. Nobody was wrong about the data and the site still contradicted itself, which is the failure this project
 * exists to point at in other people.
 */
/**
 * Counted inside a try, because the record is now opened without migrating it (see openDb) and a missing or truncated
 * file therefore has no `tokens` table at all rather than an empty one. That must reach the guard below as "holds
 * nothing", which is what it is, instead of an unhandled exception in a stack trace nobody reads.
 */

/**
 * Is the archive the public is being given still advancing?
 *
 * This is `scripts/freshness.sh`, moved off the laptop and into the service, because the laptop version could not run
 * during the failure it was written for: a closed lid stops the publish timer AND the hourly probe that would have
 * noticed, so the site froze and the alarm slept beside it.
 *
 * `recordBuiltAt` is fixed for the life of this process — adopting a pulled record renames the file and exits so the
 * platform restarts us onto the new inode — so this age is exactly "how long since a record was successfully
 * published", whatever the cause. A collector that stopped building, a pull that stopped passing its guards, a
 * laptop that stopped deploying: all of them surface here as one number that stops moving, which is the only
 * question the public actually cares about.
 *
 * One failure alarms, with no consecutive-failure grace: nothing here crosses a network, so a failure is a fact
 * about a timestamp, not a blip that might clear on its own.
 */
const STALE_AFTER_MS = Number(process.env.STALE_AFTER_HOURS ?? 8) * 3600_000;
const alertsArmed = !!(config.telegramBotToken && config.telegramChatId);
if (!alertsArmed)
  console.log(`[watch] WARNING: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set on this service. The staleness ` +
    `watch will run and log, and will not be able to tell anyone. That is the state this watch exists to end.`);
startWatchdog({
  name: "the published archive has stopped advancing",
  everyMs: 15 * 60_000,
  failuresBeforeAlarm: 1,
  repeatMs: 6 * 3600_000,
  send: (text) => telegramSend(config.telegramBotToken, config.telegramChatId, text),
  probe: async () => {
    // Still inside the boot window, with the first pull not yet attempted: the age being measured belongs to the
    // file the image was built with, not to the archive. Bounded, so an unreachable collector still trips this.
    if (!firstPullSettled && Date.now() - bootAt < BOOT_PULL_GRACE_MS)
      return { ok: true, detail: `still completing the first record pull of this process` };
    if (!recordBuiltAt) return { ok: false, detail: `the record being served carries no built_at, so its age cannot be stated` };
    const age = Date.now() - recordBuiltAt;
    // Not a pedantic guard: a builder with a wrong clock produces a record that is permanently "fresh" and would silence this
    // check permanently. Fail on it rather than treating negative age as very recent.
    if (age < 0) return { ok: false, detail: `the record claims to have been built ${fmtAge(-age)} in the future — check the clock on the builder` };
    return age < STALE_AFTER_MS
      ? { ok: true, detail: `${observed.toLocaleString()} launches, built ${fmtAge(age)} ago (limit ${fmtAge(STALE_AFTER_MS)})` }
      : { ok: false, detail: `${CANONICAL_HOST || "the site"} is serving a record built ${fmtAge(age)} ago (limit ` +
          `${fmtAge(STALE_AFTER_MS)}) — ${observed.toLocaleString()} launches. The site is up and every route answers; ` +
          `the counts are simply old. The collector's build or the record pull has stopped.` };
  },
});
/** The absence of this ping is the only alarm that survives the whole platform going down. See watchdog.ts. */
startHeartbeat(process.env.HEARTBEAT_URL ?? "", 5 * 60_000, "web");

let tokenQ = db.prepare(`SELECT ${TOKEN_COLUMNS}${optionalColumns(db)} FROM tokens WHERE mint = ?`);

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
  const toks = db.prepare(`SELECT ${TOKEN_COLUMNS}${optionalColumns(db)} FROM tokens WHERE graduated = 1 AND created_at >= ? AND pool IS NOT NULL`)
    .all(since) as any[];
  return toks
    .filter((t) => cleanAtBirth(t, assess(db, t, covered)))
    .sort((a, b) => b.created_at - a.created_at);   // newest first: the tail is what we are willing to lose
}

let setReading = db.prepare("UPDATE tokens SET vault_sol = ?, vault_at = ? WHERE mint = ?");

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
/**
 * `clean` is a claim about the launch. `liquid` is a claim about right now. They were one boolean and should never
 * have been — see the note on `readRecord`.
 */
type TokenRead = { a: Assessment; reading: Reading | null; origin: "observed" | "rebuilt"; clean: boolean; liquid: boolean };

/**
 * Everything we are prepared to say about one launch, computed once. The HTML page and the JSON record are both built
 * from this — they must never be able to disagree about the same token, and the JSON is the copy nobody proof-reads.
 *
 * The pool is read from chain on every judgeable record rather than quoted from storage, and a read we could not make
 * is never reported as a balance. That is deliberately fail-closed, and the opposite error — quoting a balance we
 * could not confirm — is the one that ends the project.
 *
 * **`clean` and `liquid` are two claims and this function returns them separately.** They used to be one boolean:
 * a launch was "clean" only if its birth record was spotless *and* a pool reading under five minutes old showed at
 * least MIN_POOL_SOL. That conflated the one thing this archive can say that nobody else can with the one thing
 * every scanner on Solana already says.
 *
 * Clean-at-birth is a fact about the first blocks. It is permanent, it is unrecoverable once the float is spread,
 * and it is the reason this project exists. Present liquidity decays by the minute, is readable by anyone with an
 * RPC key, and on public RPC we currently fail about a third of the reads. Gating the first on the second meant a
 * stretch of RPC trouble silently deleted findings the archive holds forever: over the last seven days 423 launches
 * passed every birth test and the front page published 10 of them.
 *
 * So the birth claim now stands on the birth record alone, and liquidity is reported beside it with the age of the
 * reading, or reported as unread. Nothing is certified on a balance we could not confirm — that rule is unchanged.
 * What changed is that failing to read a pool no longer retracts a statement about the past.
 */
async function readRecord(t: any, judgeable: boolean, precomputed?: any): Promise<TokenRead> {
  /**
   * `precomputed` is an assessment the collector made about its own data. It is used as given rather than recomputed
   * here, because recomputing it is not possible: the trade rows behind a buyout and the run intervals proving we
   * were watching live on the collector, and this service reads a file built hours ago. Judging the row here would
   * miss a buyout it cannot see and call a launch uncovered because the record's last run ended when the file was
   * built. Same `assess` from `provenance.ts` either way; only the database under it differs.
   */
  const a = precomputed ?? assess(db, t, covered);
  // `assess` already treats a complete rebuild as judgeable; the flag only decides how the record describes its source.
  const rebuilt = !!t.rebuilt_at && !!t.rebuilt_complete;
  let reading: Reading | null = judgeable && t.vault_sol != null && t.vault_at != null ? { sol: t.vault_sol, at: t.vault_at, fresh: false } : null;
  if (judgeable && t.pool) {
    const fresh = await poolReservesPooled(t.pool, t.mint);
    if (fresh) reading = { sol: fresh.quoteSol, at: Date.now(), fresh: true };
  }
  /**
   * The birth claim is settled BEFORE the pool reading is allowed to add anything, and the order is the whole point.
   *
   * `cleanAtBirth` refuses any launch carrying a DANGER flag, and this function pushes a DANGER flag when the pool is
   * thin. Computing `clean` after the push therefore let a balance read seconds ago decide what the record says about
   * the first block — which is the conflation this split exists to end, and it produced a live disagreement: the
   * front page listed a launch as clean while the launch's own page said "carries a danger flag", because only one of
   * the two paths had read a pool. Settle the past first; then say what the present looks like.
   */
  const clean = cleanAtBirth(t, a);
  if (reading && reading.sol < MIN_POOL_SOL)
    a.flags.push({ level: "DANGER", kind: "liquidity", code: "thin_pool_now", text: `Only ${reading.sol.toFixed(1)} SOL of liquidity was in the pool ${reading.fresh ? "just now" : "when it was last read"}.` });
  const liquid = !!reading?.fresh && reading.sol >= MIN_POOL_SOL;
  return { a, reading, origin: rebuilt ? "rebuilt" : "observed", clean, liquid };
}

/**
 * What else this launch is a copy of. Two index lookups, single-digit milliseconds on the served record.
 *
 * `tokens_image` is partial (`WHERE image_sha256 IS NOT NULL`) and `tokens_creator` covers the other, so neither of
 * these scans. They are computed per request rather than stored because they change as the archive grows: the
 * answer to "how many other launches used this picture" is different tomorrow, and a stored count would quietly age.
 */
function priorsFor(t: any): Priors {
  let sameImage: number | null = null;
  if (t.image_sha256) {
    sameImage = ((db.prepare(`SELECT COUNT(*) c FROM tokens WHERE image_sha256 = ? AND mint != ?`)
      .get(t.image_sha256, t.mint)) as any).c as number;
  }
  const byCreator = !t.creator ? 0 : ((db.prepare(`SELECT COUNT(*) c FROM tokens WHERE creator = ? AND mint != ?`)
    .get(t.creator, t.mint)) as any).c as number;
  /**
   * "Carrying a danger flag" is counted with SQL that mirrors the loudest criteria rather than by running `assess`
   * over what can be thousands of rows on a request. It is deliberately a floor: the real flag set is broader, so
   * this understates and never overstates, which is the correct direction for a number sitting beside a creator's
   * address. The linked page runs the real criteria per launch.
   */
  const creatorFlagged = !t.creator || byCreator === 0 ? 0 : ((db.prepare(
    `SELECT COUNT(*) c FROM tokens WHERE creator = ? AND mint != ?
       AND (dev_pct >= 50 OR (graduated_confirmed_by IS NOT NULL AND curve_buyers = 0))`)
    .get(t.creator, t.mint)) as any).c as number;
  return { sameImage, imageSha: t.image_sha256 ?? null, byCreator, creatorFlagged };
}

async function renderToken(t: any, judgeable: boolean, precomputed?: any): Promise<string> {
  const r = await readRecord(t, judgeable, precomputed);
  const pv = tokenPreview(t, r.a, r.clean);
  return page(pv.title, tokenBody(t, r.a, r.reading, r.origin, r.clean, Date.now(), priorsFor(t)), chrome, 1, pv.summary,
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
  | { kind: "record"; t: any; judgeable: boolean; precomputed?: any }
  | { kind: "rebuilding"; job: Job }
  | { kind: "unknown"; code: string; why: string; htmlStatus: number };

async function decide(mint: string, ip: string): Promise<Decision> {
  const t = tokenQ.get(mint) as any;
  // Holding a *row* for a mint is not the same as holding its launch: tokens discovered late (named by a post, found
  // by a detector) have no curve history, and treating their presence as an answer meant the most useful thing we
  // could do for them — rebuild the launch from chain — was never attempted.
  const judgeable = !!t && (!!t.rebuilt_complete || (!t.late_discovery && covered(t.created_at)));
  if (judgeable) return { kind: "record", t, judgeable: true };

  /**
   * Before reconstructing a launch from chain, ask the machine that watched it.
   *
   * The record file is rebuilt every six hours, so a launch from the last few hours is simply not in it — and the
   * service answered "we have no record of this launch" and started reading its entire bonding-curve history back
   * off the chain. About a launch the collector observed live, from the creation transaction, and still holds.
   *
   * That is this product disclaiming the one thing it has. A cold scanner can read the chain too; being there at
   * birth is the whole claim, and it was being denied during the only window when anybody asks — the first hours,
   * when the token is new and the question is live.
   *
   * A rebuild is also strictly worse evidence. `rebuilt_complete` exists precisely to mark reconstruction as a
   * weaker class than observation, it costs thousands of RPC reads, and it is rate limited to a handful per visitor
   * per hour. Spending that to recover something we already have was not a trade-off anyone chose; it fell out of
   * a lookup inheriting a bulk file's cadence.
   *
   * Short timeout, failure falls through to exactly what happened before: the collector being unreachable must
   * never be worse than not having asked.
   */
  if (LAUNCH_URL && !t) {
    try {
      const r = await fetch(LAUNCH_URL + mint, { signal: AbortSignal.timeout(2500) });
      if (!r.ok) lastLaunchLookup = `http ${r.status}`;
      else {
        const live = (await r.json()) as any;
        if (live?.held && live.observed && live.t && live.a) {
          lastLaunchLookup = "ok";
          return { kind: "record", t: live.t, judgeable: true, precomputed: live.a };
        }
        // Held but not observed, or not held at all: both are real answers and both are worth telling apart from
        // a network failure, because they mean different things about the collector.
        lastLaunchLookup = live?.held ? `held but not observed (late_discovery or outside coverage)` : "collector does not hold it";
      }
    } catch (e) {
      lastLaunchLookup = `unreachable: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`;
    }
  } else if (!LAUNCH_URL) lastLaunchLookup = "COLLECTOR_HEALTH_URL not set, so no live lookup is configured";

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
/**
 * Where the captured launch pictures live. On the collector this is its volume; on the web service it is whatever
 * the image carries, which is why a picture we do not hold returns 404 rather than pretending. See IMAGES.md.
 */
const IMAGE_DIR = process.env.IMAGE_DIR ?? "data/images";
/** Resolved once at boot. Null unless all four R2 variables are set, so a half-configured store never looks enabled. */
const imageStore = r2Config();
/**
 * How long a rendered front page is reused. Was 15 seconds, which cost more than it bought: a miss assesses every
 * graduation in the window - 0.6 s on a laptop, longer on the container - and node has one thread, so for that
 * whole time the site answers nothing at all. At 15 seconds the service spent a measurable share of its life
 * unable to serve anyone, to keep a page fresher than its own contents. Nothing on it is younger than this: the
 * launch counts are as old as the archive, hours behind, and the page says so beside them; the liquidity readings
 * come from a refresher on its own cycle; and the only genuinely live figure, the launch counter, is fetched by
 * the browser from /api/v1/live, which is never cached.
 */
const HOME_TTL_MS = Number(process.env.HOME_TTL_SECONDS ?? 60) * 1000;
/** A stall worth a log line. Below this a reader feels a slow page; above it, requests in flight are timing out. */
const LOOP_STALL_MS = Number(process.env.LOOP_STALL_MS ?? 2000);
const HOME_DAYS = Number(process.env.HOME_DAYS ?? 7);
/**
 * How many clean launches the built Home carries, and how many of them the API publishes.
 *
 * CLEAN_MAX bounds /clean.html so one quiet week cannot render a page nobody can load; over the seven-day window
 * this holds every row we have (351 at the time of writing). API_CLEAN_ROWS is the published contract and is
 * deliberately a separate number: it was 40 before these two were distinguished and it stays 40.
 */
/**
 * Published reports, read once at boot.
 *
 * They are committed files in the image, not rows in the record, so they cannot change while the process runs and
 * re-reading them per request would be a filesystem hit for a constant. A newly published report reaches the site
 * the way any other source change does: on the next deploy.
 */
const REPORTS = loadReports();
console.log(`[reports] ${REPORTS.length} published${REPORTS.length ? `, latest ${REPORTS[0].published} ${REPORTS[0].slug}` : ""}`);

const CLEAN_MAX = 400;
const API_CLEAN_ROWS = 40;
/**
 * The bounds on the wallet and operator lists, applied where they are built rather than where they are shown.
 * Both pages state their own bound, because a list that shows the first 250 of 2,401 without saying so tells a
 * reader they have seen the register.
 */
const WALLETS_MAX = 250;
const OPERATORS_MAX = 200;
let homeCache: { at: number; h: Home; html: string } | null = null;

/**
 * The cumulative finding. Two counts over the whole table, not the window.
 *
 * Cached for the life of the process rather than recomputed each rebuild: it moves by single digits an hour against
 * totals in the thousands, and the front page already pays three seconds for the window pass. The exclusions are
 * the same ones findings.html states — a token a detector restored after launch carries a zero because nobody was
 * watching it, not because nobody bought, and counting those would overstate this by nearly half.
 */
let everCache: { watched: number; noBuyer: number } | null = null;
function everFinding(): { watched: number; noBuyer: number } {
  if (everCache) return everCache;
  const LIVE = "graduated_confirmed_by IS NOT NULL AND COALESCE(late_discovery,0) = 0 AND rebuilt_at IS NULL";
  const c = (w: string) => (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE ${w}`).get() as any).c as number;
  try { everCache = { watched: c(LIVE), noBuyer: c(`${LIVE} AND curve_buyers = 0`) }; }
  catch { everCache = { watched: 0, noBuyer: 0 }; }
  return everCache;
}

function buildHome(now: number): Home {
  const since = now - HOME_DAYS * 86400_000;
  // Same rule as the record pages: a graduation we have disproved is not counted as one. This is the population
  // behind the front page's headline figure, which was inflated by 3,195 rows across the archive.
  const toks = (db.prepare(`SELECT ${TOKEN_COLUMNS}${optionalColumns(db)} FROM tokens WHERE graduated = 1 AND created_at >= ?`).all(since) as any[])
    .filter((t) => !graduationDisproved(t));
  const assessed = toks.map((t) => ({ t, a: assess(db, t, covered) }));

  /**
   * Two populations, and the front page now leads with the first rather than the second.
   *
   * `birthClean` is every launch whose record shows no sign of manufacture. That is the archive's own finding and it
   * does not expire. `certified` is the subset we have also just read a healthy pool for, which is a different and
   * much more perishable claim. Publishing only the intersection meant the headline number tracked our RPC luck: it
   * said "5 launched clean" out of 1,656 while the record held 423 clean launches for the week, and a reader has no
   * way to tell a strict bar from a broken one.
   */
  const birthClean = assessed.filter(({ t, a }) => cleanAtBirth(t, a));
  const certified = birthClean.filter(({ t }) => readingCertifies(t.vault_at, t.vault_sol, now));
  const uncertified = birthClean.filter(({ t }) => !readingCertifies(t.vault_at, t.vault_sol, now));
  const unchecked = uncertified.length;
  // Of those, the ones we simply have no recent reading for — as distinct from the ones we read and found thin.
  // The page says different things about each, so it cannot count them together.
  const unread = birthClean.filter(({ t }) => !readingIsFresh(t.vault_at, now)).length;

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

  /**
   * The full lists, not the front page's preview of them.
   *
   * These were LIMIT 15 and limit 10 because fifteen and ten were what the front page printed. /wallets.html and
   * /operators.html then had to re-query for the rest, which is two statements that have to agree about one table
   * — the shape this codebase keeps finding bugs in. Built once and sliced by each consumer instead, for the same
   * reason summary.json is derived from this object: a preview cannot say something different from the list it
   * links to if they are the same array. 250 rows instead of 15 costs nothing next to the assessment pass above,
   * and clusterTable was measured at 6 ms.
   */
  const ops = db.prepare(
    `SELECT wallet, curve_sol, amm_buy, amm_sell, tokens FROM wallet_flow ORDER BY amm_sell DESC LIMIT ?`)
    .all(WALLETS_MAX) as any[];
  const walletCount = (db.prepare("SELECT COUNT(*) c FROM wallet_flow").get() as any).c as number;

  return {
    now, builtAt: recordBuiltAt, windowEnd,
    graduated24h: day.length,
    cleanBirth24h: birthClean.filter(({ t }) => inDay(t)).length,
    clean24h: certified.filter(({ t }) => inDay(t)).length,
    danger24h: day.filter(({ a }) => a.flags.some((f) => f.level === "DANGER")).length,
    onFile: (db.prepare("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0").get() as any).c,
    everWatched: everFinding().watched, everNoBuyer: everFinding().noBuyer,
    windowDays: HOME_DAYS, gradWindow: toks.length, cleanBirthWindow: birthClean.length, unchecked, unread,
    unchecked24h: uncertified.filter((x) => inDay(x.t)).length,
    /**
     * Every clean launch, liquid or not, newest first — with the liquidity reading carried as nullable rather than
     * used as a filter. A row whose pool we have not read recently belongs on this list with its liquidity column
     * saying so; leaving it off published our RPC coverage as if it were a finding about the token.
     *
     * This was capped at 40 because 40 was what the front page printed. It is now the list itself, sliced by each
     * consumer: the front page takes the newest handful, /clean.html renders all of it, and the API keeps taking
     * exactly the 40 it has always published (see summaryJson). Widening it costs nothing — `birthClean` is
     * already fully computed above and this only maps more of it — and it means the page and the page it links to
     * cannot disagree, which is the same reason summary.json is derived from this object rather than rebuilt.
     */
    cleanRows: birthClean.sort((x, y) => y.t.created_at - x.t.created_at).slice(0, CLEAN_MAX).map(({ t, a }) => ({
      mint: t.mint, symbol: t.symbol, devPct: t.dev_pct, buyers: a.curveBuyers ?? 0,
      fillMs: t.graduated_at && t.created_at ? t.graduated_at - t.created_at : null,
      // Quote any reading recent enough to quote, thin or not, and say separately whether it clears the threshold.
      // Nulling a thin-but-fresh balance would report "we read it and it is nearly empty" as "we have not read it".
      poolSol: readingIsFresh(t.vault_at, now) ? t.vault_sol : null,
      readAt: readingIsFresh(t.vault_at, now) ? t.vault_at : null,
      liquid: readingCertifies(t.vault_at, t.vault_sol, now),
    })),
    wallets: walletCount,
    opRows: ops.map((w) => ({ wallet: w.wallet, taken: w.tokens, spent: w.curve_sol, sold: w.amm_sell, bought: w.amm_buy })),
    /**
     * The groups behind those wallets. A cluster column on the table above would have been the obvious move and was
     * wrong: only three of the fifteen busiest wallets carry a traced funder, so the column would have been twelve
     * dashes, and a dash there reads as "this one acts alone" when it means "we have not traced it". The clusters
     * we did trace get their own list, where every row is something we know.
     */
    /**
     * What we found in the window, itemised and counted by code rather than by parsing the sentence each flag
     * renders - the sentences have been rewritten four times in a day and a regex over them would have broken
     * every time. Ordered by how often it happens, which is the order a reader wants.
     */
    findings: (() => {
      const label: Record<string, string> = {
        creator_kept_supply: "the creator kept the supply",
        creator_bought_own_curve: "the creator bought its own curve",
        creator_completed_curve: "the creator's own buy completed it",
        filled_in_seconds: "the curve filled in seconds",
        few_outside_buyers: "almost no one outside bought",
        buyer_distributes: "the buyer sold and did not buy back",
      };
      const n = new Map<string, number>();
      for (const { a } of day)
        // Counted once per launch per kind: a launch with two flags of the same code is one launch, not two.
        for (const code of new Set(a.flags.filter((f) => f.level === "DANGER" && f.code && f.code !== "thin_pool_now").map((f) => f.code!)))
          n.set(code, (n.get(code) ?? 0) + 1);
      return [...n.entries()].filter(([c]) => label[c]).sort((x, y) => y[1] - x[1])
        .map(([c, v]) => ({ label: label[c], n: v }));
    })(),
    clusterRows: clusterTable(db, OPERATORS_MAX),
    latestReport: REPORTS.length ? {
      slug: REPORTS[0].slug, title: REPORTS[0].title, published: REPORTS[0].published,
      publishedLong: reportDate(REPORTS[0].published), summary: REPORTS[0].summary,
    } : null,
    /**
     * Three records to open, newest first, for a visitor with nothing to paste. Taken from the same assessed set
     * the counters above are built from, so the page cannot offer a record it would describe differently. The
     * proof token is skipped because the "why a scanner cannot tell you this" passage further down the page walks
     * through that one launch in detail; offering it here as well would spend the opening on a record the reader
     * is about to be shown anyway.
     */
    startHere: day
      /**
       * Chosen on the danger flag, which is a permanent finding about the launch record, and not on recency alone.
       * Recency alone offered three launches all reading "Not certified" - which is a statement about whether we
       * have a fresh pool balance, not about the token - so the one door into the archive taught a first-time
       * visitor that the tool has nothing to say. These are three of the flagged count in the headline above, so
       * they are representative of the majority rather than picked for effect.
       */
      .filter(({ t, a }) => t.mint !== proofRow?.t.mint && t.graduated_at &&
        a.flags.some((f) => f.level === "DANGER"))
      .sort((x, y) => (y.t.graduated_at ?? 0) - (x.t.graduated_at ?? 0))
      .slice(0, 3)
      .map(({ t, a }) => {
        const v = verdict(t, a, false);
        return { mint: t.mint, symbol: t.symbol, label: v.label, level: v.level, at: t.graduated_at as number };
      }),
    /**
      * `fundedSol` used to be here, hardcoded to 0, and the front page printed "pool funded to 0 SOL of real
      * liquidity" as step 2 of an argument whose whole point is that the pool looked funded before it was drained.
      * It rendered as liquidity going up. We store one pool balance per token (`vault_sol`, with the time it was
      * read) and no history, so there is no figure behind that claim and the claim is gone rather than guessed.
      *
      * The verdict comes from the same function the token's own record page calls, so the sample on the front page
      * cannot state something its record does not.
      */
    proof: proofRow ? {
      mint: proofRow.t.mint, symbol: proofRow.t.symbol, devPct: proofRow.t.dev_pct,
      gradMs: proofRow.t.graduated_at && proofRow.t.created_at ? proofRow.t.graduated_at - proofRow.t.created_at : null,
      nowSol: proofRow.t.vault_sol, nowAt: proofRow.t.vault_at,
      verdict: verdict(proofRow.t, proofRow.a, false),
    } : null,
    maxDevPct: MAX_DEV_PCT, minBuyers: MIN_BUYERS, buyoutSol: BUYOUT_SOL, minPoolSol: MIN_POOL_SOL,
    maxReadingAgeMs: MAX_READING_AGE_MS,
  };
}

/**
 * Serve what we have and refresh behind the request, rather than making one visitor pay for the rebuild.
 *
 * Measured against production on 2026-09-10: a warm front page answers in 0.10-0.14 s and the first request after
 * the 60 s cache lapses takes 3.2 s. On a site with sparse traffic that is not an edge case — it is most visitors,
 * because most arrivals follow a gap longer than the TTL. Every one of them was paying for the whole assessment
 * pass while the page they were waiting for already existed in memory, one field away, only slightly out of date.
 *
 * Staleness costs nothing here and the arithmetic says so plainly: the record itself is up to six hours old by
 * design (build interval plus pull interval), and every page states the age of what it is showing. A front page a
 * couple of minutes behind that is not a different kind of claim, it is the same claim rounded.
 *
 * This does not make the rebuild cheaper, and node has one thread, so the 3 s still blocks the loop when it runs —
 * it just no longer blocks it in front of somebody. The deeper fix is that `assess()` recomputes launch facts that
 * cannot change: for a graduated token everything except the liquidity reading is settled forever, so the pass is
 * re-deriving thousands of immutable answers every minute. Memoising by mint is the real win and belongs with
 * whoever owns the clean/liquidity split, not in a latency patch.
 *
 * STALE_LIMIT caps it. If a rebuild is failing, serving an ever-older page silently is exactly the frozen-archive
 * failure this project already has a probe for, so past ten intervals we go back to building synchronously and the
 * visitor waits rather than being lied to quickly.
 */
const HOME_STALE_LIMIT_MS = HOME_TTL_MS * 10;
let homeRebuilding = false;

function rebuildHome(now: number): Home {
  const t0 = performance.now();
  const h = buildHome(now);
  const html = page(homeTitle(h), homeBody(h), chrome, 0, undefined, "/");
  const ms = performance.now() - t0;
  if (ms > 1000) console.log(`[home] rebuilt in ${Math.round(ms)} ms, blocking everything else for that long`);
  homeCache = { at: now, h, html };
  return h;
}

function currentHome(): Home {
  const now = Date.now();
  if (homeCache) {
    const age = now - homeCache.at;
    if (age < HOME_TTL_MS) return homeCache.h;
    if (age < HOME_STALE_LIMIT_MS) {
      // Hand back the page we already have, then refresh. setImmediate so the response is flushed first.
      if (!homeRebuilding) {
        homeRebuilding = true;
        /**
         * A timer, not setImmediate, and the delay is the whole point.
         *
         * The first version used setImmediate and measured 1.3 ms locally and 2.9 s in production — the fix
         * appeared to work and did nothing. The front page is ~49 KB, which goes out over TLS across several event
         * loop turns; setImmediate fires in the check phase of the very next turn, so the rebuild seized the only
         * thread while the response was still being written and the client waited for it anyway. Over loopback
         * with no TLS the whole body flushes in one turn, which is exactly why the local test passed.
         *
         * Two seconds is far longer than any flush needs and costs nothing: the page being handed out is already
         * stale by definition, and two more seconds of it is not a different claim.
         */
        setTimeout(() => {
          try { rebuildHome(Date.now()); }
          catch (e) { console.log(`[home] background rebuild failed: ${(e as Error).message}`); }
          finally { homeRebuilding = false; }
        }, 2000).unref();
      }
      return homeCache.h;
    }
  }
  /**
   * The front page is assessed, not read: a cache miss walks every graduation in the window. It is the largest
   * synchronous unit of work this process does on a request, and node runs it on the only thread there is, so
   * everything else - other pages, the API, the deploy gate - waits behind it. That is timed rather than assumed
   * because on 2026-09-10 a smoke check timed out with zero bytes after thirty seconds, and nothing in the logs
   * could say what the process had been doing. A build slow enough to be felt says so.
   */
  return rebuildHome(now);
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
    graduated24h: h.graduated24h,
    /**
     * Two counts, because they answer two questions and used to be one number answering neither cleanly.
     * `cleanAtBirth24h` is how many launches in the window show no sign of manufacture — a permanent finding about
     * the first blocks. `clean24h` is the subset we have also just read a healthy pool for, which decays. A consumer
     * wanting the archive's own judgement wants the first; the second tracks our RPC coverage as much as the market.
     */
    cleanAtBirth24h: h.cleanBirth24h, clean24h: h.clean24h, uncertified24h: h.unchecked24h,
    uncertified: h.unchecked, archivedLaunches: h.onFile,
    /**
     * Forty, explicitly, and not `h.cleanRows.length`.
     *
     * That field used to be capped at 40 by the builder and this list inherited the cap by accident. The cap moved
     * to the consumers when /clean.html needed the whole list, so without this slice the published contract would
     * have silently widened from 40 rows to several hundred on the same deploy that changed a page layout. A
     * consumer's response size is not ours to change as a side effect.
     */
    clean: h.cleanRows.slice(0, API_CLEAN_ROWS).map((r) => ({
      mint: r.mint, symbol: r.symbol, creatorSupplyPct: r.devPct, curveBuyers: r.buyers,
      // null = no reading fresh enough to quote. Not zero liquidity, and not a finding about the token.
      poolSol: r.poolSol, poolReadAt: r.readAt, liquidityVerified: r.liquid,
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
    /**
     * One address for the front page, and it is `/`.
     *
     * `/index.html` used to be a second, equal address for the same document — reachable, indexable, and the one
     * every link in the masthead and footer actually pointed at. A 301 collapses them, so a crawler sees one page
     * and a reader never has a filename in the address bar. Permanent rather than temporary because this will not
     * be changing back, and query strings are carried through so nothing with a `?ref=` loses it on the way.
     */
    if (path === "/index.html") {
      res.writeHead(301, { location: `/${url.search}`, "cache-control": "public, max-age=3600" });
      return res.end();
    }
    if (path === "/") path = "/index.html";
    // never let a path escape the served directory
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");

    // job status, for the waiting page's poll
    /**
     * The two "seen before" views: every launch that used one picture, and every launch by one creator.
     *
     * Bounded at SIBLINGS_MAX rows because a creator with 1,994 launches would otherwise render a page nobody can
     * read and this service would build it on every request. Oldest first, so the sequence reads from the start —
     * the cadence is the finding, and a burst of launches minutes apart is invisible if the newest are shown.
     */
    /**
     * The live wall, and the feed behind it.
     *
     * `/api/live/recent` proxies the collector's in-memory ring over the private network. Proxied rather than
     * exposed directly because the collector has no public address and should not get one: it is the ingesting
     * process, and the only thing that must never be starved of attention is ingestion. The web service is already
     * the public face and already polls the collector for the counter.
     *
     * `no-store`, and a short upstream timeout. A cached live feed is a contradiction, and a slow collector must
     * degrade to "nothing new" on the page rather than hold a request open.
     */
    if (safe === "/api/live/recent") {
      if (!HEALTH_URL) return send(200, JSON.stringify({ at: Date.now(), launches: [], unavailable: "no collector configured" }), TYPES[".json"], "none");
      const since = Number(url.searchParams.get("since") ?? 0);
      try {
        const r = await fetch(HEALTH_URL.replace(/\/health$/, `/recent?since=${since}`), { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return send(200, JSON.stringify({ at: Date.now(), launches: [], unavailable: `collector http ${r.status}` }), TYPES[".json"], "none");
        return send(200, await r.text(), TYPES[".json"], "none");
      } catch (e) {
        // A feed that cannot reach the collector says so. It never returns an empty list as though the chain were
        // quiet, which would be a false statement about the market rather than about us.
        return send(200, JSON.stringify({ at: Date.now(), launches: [], unavailable: `collector unreachable: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}` }), TYPES[".json"], "none");
      }
    }
    if (safe === "/live.html") {
      return send(200, page("Launches, as they happen", wallBody(), chrome, 0,
        "Every pump.fun launch the moment its creation transaction is decoded, with the creator's share of supply.",
        "/live.html"), "text/html; charset=utf-8", "none");
    }

    /**
     * The three lists the front page previews, in full.
     *
     * All three render from `currentHome()` rather than from queries of their own, so the rows on the front page
     * and the rows here are literally the same arrays: a preview cannot say something a reader finds contradicted
     * when they open it. That is the same reasoning that derives summary.json from this object instead of
     * rebuilding it, and it is why the builder above now selects the whole list rather than the top handful.
     *
     * Cached "short" like the front page, for the same reason: these are its figures.
     */
    /**
     * Reports, rendered here rather than served from the static tree.
     *
     * They were files in `site/`, written by whoever last ran `npm run site` on a laptop and uploaded with the
     * image. That was survivable while the report was also computed there; it stopped being survivable the moment
     * the front page began advertising the latest report from a manifest in the image, because the two could then
     * disagree: publish a manifest, deploy without rebuilding the static tree, and the front page links to a
     * report whose page is not in the image. A 404 from our own front page, on the one artifact meant to be cited.
     *
     * Rendering from the same manifests the front page reads makes that impossible to express, and it takes the
     * laptop out of one more publish path. These are matched before the static handler, so the older files in
     * `site/reports*` are shadowed rather than served.
     */
    if (safe === "/reports.html") {
      return send(200, page("Reports", reportsIndexBody(REPORTS), chrome, 0,
        "Dated reports computed from the launch record, each with the queries to reproduce it.",
        "/reports.html"), "text/html; charset=utf-8", "short");
    }
    const rep = safe.match(/^\/reports\/([a-z0-9-]{1,64})\.html$/);
    if (rep) {
      const r = REPORTS.find((x) => x.slug === rep[1]);
      const body = r ? reportBody(r) : "";
      // A slug we hold no manifest for, or hold a manifest but no template for, is a 404 and says which. Never a
      // page with a title and an empty table: a report that asserts nothing still looks like a report.
      if (!r || !body) return send(404, page("No such report", `<h1 class="headline">No such report</h1>
        <p class="lede">We publish no report under that name. <a href="../reports.html">Everything we have
        published</a> is listed here.</p>`, chrome, 1, undefined, safe), "text/html; charset=utf-8", "none");
      return send(200, page(r.title, body, chrome, 1, r.summary, safe), "text/html; charset=utf-8", "short");
    }

    if (safe === "/wallets.html") {
      const h = currentHome();
      return send(200, page("Who takes the curves",
        walletsBody(h.opRows, h.wallets, h.opRows.length, h.buyoutSol), chrome, 0,
        "Every wallet on file that has taken a whole bonding curve in one transaction, what it spent, and what it did with the tokens afterwards.",
        "/wallets.html"), "text/html; charset=utf-8", "short");
    }
    if (safe === "/operators.html") {
      const h = currentHome();
      return send(200, page("Operator groups",
        operatorsBody(h.clusterRows, h.now, h.clusterRows.length, h.clusterRows.length >= OPERATORS_MAX),
        chrome, 0,
        "Every group of curve-buying wallets we have traced to a common funder, ordered by curves taken.",
        "/operators.html"), "text/html; charset=utf-8", "short");
    }
    if (safe === "/clean.html") {
      const h = currentHome();
      return send(200, page(`Checked, no markers found, last ${h.windowDays === 1 ? "24 hours" : `${h.windowDays} days`}`,
        cleanBody(h), chrome, 0,
        "Every launch in the window whose record carries none of the patterns we look for, with the liquidity reading and its age.",
        "/clean.html"), "text/html; charset=utf-8", "short");
    }

    const SIBLINGS_MAX = 300;
    const imgSibs = safe.match(/^\/i\/([0-9a-f]{64})\.html$/);
    const creatorSibs = safe.match(/^\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})\.html$/);
    if (imgSibs || creatorSibs) {
      const kind: "image" | "creator" = imgSibs ? "image" : "creator";
      const key = (imgSibs ?? creatorSibs)![1];
      const where = kind === "image" ? "image_sha256 = ?" : "creator = ?";
      /**
       * Aggregates over the whole set in one pass. The page lists at most SIBLINGS_MAX rows, and every figure beside
       * the heading must describe all of them or the two disagree — see the note in siblingsBody.
       */
      const agg = db.prepare(`SELECT COUNT(*) c,
          SUM(CASE WHEN dev_pct >= 50 OR (graduated_confirmed_by IS NOT NULL AND curve_buyers = 0) THEN 1 ELSE 0 END) flagged,
          SUM(COALESCE(graduated,0)) grad, MIN(created_at) a, MAX(created_at) b
        FROM tokens WHERE ${where}`).get(key) as any;
      const total = (agg?.c ?? 0) as number;
      if (!total) return send(404, page("Not held", `<h1 class="headline">Nothing on file</h1>
        <p class="lede">We hold no launch for that ${kind === "image" ? "picture" : "creator"}. That is a statement
        about our records and not about the ${kind === "image" ? "image" : "wallet"}.</p>${SEARCH}`, chrome, 1,
        undefined, safe));
      const rows = (db.prepare(`SELECT mint, symbol, name, created_at, dev_pct, curve_buyers, graduated,
          graduated_confirmed_by FROM tokens WHERE ${where} ORDER BY created_at ASC LIMIT ?`)
        .all(key, SIBLINGS_MAX) as any[]).map((x): SiblingRow => ({
          mint: x.mint, symbol: x.symbol, name: x.name, createdAt: x.created_at,
          devPct: x.dev_pct ?? null, curveBuyers: x.curve_buyers ?? null,
          graduated: !!x.graduated,
          // Same floor the count on the token page uses, and for the same reason: understate, never overstate.
          danger: (x.dev_pct ?? 0) >= 50 || (x.graduated_confirmed_by != null && x.curve_buyers === 0),
        }));
      const stats = { total, flagged: Number(agg?.flagged ?? 0), grad: Number(agg?.grad ?? 0),
        span: agg?.a != null && agg?.b != null ? Number(agg.b) - Number(agg.a) : 0 };
      /**
       * The strip plots the WHOLE set, not the page of rows below it — three columns per launch, so a wallet with
       * 1,994 of them is a cheap query and a few hundred kilobytes of SVG. Capped at STRIP_MAX because past a few
       * thousand marks the comb is solid and more marks add bytes without adding information; when the cap bites the
       * strip says so rather than quietly plotting a subset.
       */
      const STRIP_MAX = 3000;
      const markRows = db.prepare(`SELECT mint, symbol, created_at, dev_pct, curve_buyers, graduated_confirmed_by
        FROM tokens WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(key, STRIP_MAX) as any[];
      const marks: StripMark[] = markRows.map((x) => ({
        t: x.created_at, mint: x.mint, symbol: x.symbol,
        danger: (x.dev_pct ?? 0) >= 50 || (x.graduated_confirmed_by != null && x.curve_buyers === 0),
      })).sort((p1, p2) => p1.t - p2.t);
      const strip = relaunchStrip(marks, total);
      const title = kind === "image" ? `${fmt(total)} launches used this picture` : `${fmt(total)} launches by this wallet`;
      return send(200, page(title, siblingsBody(kind, key, rows, stats, Date.now(), SIBLINGS_MAX, strip), chrome, 1,
        kind === "image"
          ? `Every launch in the archive that used this exact image, matched by sha256, oldest first.`
          : `Every launch in the archive from this creator wallet, oldest first.`, safe), "text/html; charset=utf-8", "short");
    }

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

      if (rest === "live") {
        /**
         * What the collector holds right now, for the counter on the page. Deliberately its own endpoint rather than
         * a field on /status: /status describes the published file and is cacheable, this cannot be cached at all,
         * and merging them would make one of the two wrong. `null` means the collector is unreachable or stale —
         * the page then shows the published figure alone rather than a number that has stopped moving.
         */
        const l = liveNow();
        return j(200, {
          observed: l?.observed ?? null, held: l?.held ?? null, at: l?.at ?? null,
          // The operator map the collector holds, against what this service serves. The pull is refused when the
          // first drops below 90% of the second, so these two numbers are the whole answer to "can the archive
          // advance", and until now neither was reported anywhere.
          operators: l?.operators ?? null, operatorsError: (l as any)?.operatorsError ?? null,
          operatorsServed: (() => { try { return (db.prepare("SELECT COUNT(*) c FROM operator_wallets").get() as any).c; } catch { return null; } })(),
          published: observed, generatedAt: Date.now(), liveLookup: lastLaunchLookup,
          // Null when the counter is working. Says which fault when it is not, including the case where a poll
          // succeeded long ago and has since gone stale — a value that was real and is no longer current.
          unavailable: l ? null : (liveErr ?? (live ? `last successful poll ${Math.round((Date.now() - live.at) / 1000)}s ago, past the ${LIVE_MAX_AGE_MS / 1000}s tolerance` : "no successful poll yet")),
        });
      }

      if (rest === "" || rest === "status")
        return j(200, statusRecord(COV, observed, {
          // The collector's live count, which is a claim about the archive rather than about this file. Null when the
          // collector cannot be reached; never falls back to the published number, which would make it meaningless.
          recorded: liveNow()?.observed ?? null,
          // Every row in the file, including launches restored after creation and those rebuilt from chain history.
          // `launches` above counts only those observed from the creation transaction, which is what the pages report.
          records: held,
          docs: "/api.html",
          bulk: "/data/record.db",
          // The launch documents themselves, deliberately outside record.db so that file stays mirrorable.
          documents: "/data/documents.ndjson.gz",
          documentsManifest: "/data/documents.json",
          document: `/d/{mint}`,
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
          const r = await readRecord(d.t, d.judgeable, d.precomputed);
          // A live answer must never be cached as immutable: it describes a launch still moving, and the next
          // question about it deserves the collector's current view rather than this second's.
          return j(200, tokenRecord(d.t, r.a, r.reading, r.origin, r.clean, COV),
            d.precomputed ? "short" : d.judgeable ? "immutable" : "none");
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
    /**
      * The picture a launch published at birth, served from the bytes we captured and addressed by their sha256.
      *
      * Never a redirect to the original URI. The URI belongs to the creator and can be repointed or unpinned, so
      * proxying it live would render whatever they serve today under a heading that says what the launch claimed
      * at birth — the precise substitution this site exists to report. Content-addressed, so the response is
      * immutable by construction and cacheable forever: the hash IS the verification.
      */
    /**
     * The metadata document a launch published at birth — the bytes, not our reading of them.
     *
     * record.db commits to `meta_sha256` and carries no document, so a reader could verify bytes they already held
     * and could not obtain any. For the one artefact in this archive that cannot be rebuilt from chain at any price
     * that is the difference between being the copy and attesting to one, and it is not hypothetical:
     * metadata.j7tracker.io hosted 30,443 of these launches and now answers 404 for every one of them, so for
     * thousands of launches the bytes behind this route are the only ones left anywhere.
     *
     * By mint, because that is what a reader arrives holding and what the record is indexed by. The sha256 goes back
     * in a header, so the answer is still checkable against the record's commitment.
     */
    const doc = /^\/d\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(safe);
    if (doc) {
      const mint = doc[1];
      /**
       * The record is the attestation and is checked first, exactly as for pictures. Serving a document for a launch
       * the archive does not attest holding one for would be serving evidence nobody can verify against the archive.
       */
      const att = db.prepare("SELECT meta_at, meta_sha256 FROM tokens WHERE mint = ?").get(mint) as any;
      if (!att) return send(404, "no such launch on record", "text/plain; charset=utf-8", "none");
      if (!att.meta_at) return send(404, "no document on record for this launch", "text/plain; charset=utf-8", "none");
      if (!HEALTH_URL) return send(503, "no collector configured to serve documents from", "text/plain; charset=utf-8", "none");
      try {
        const r = await fetch(HEALTH_URL.replace(/\/health$/, `/doc/${mint}`), { signal: AbortSignal.timeout(15_000) });
        if (r.status === 404) return send(404, await r.text(), "text/plain; charset=utf-8", "none");
        if (!r.ok) return send(502, "document store unavailable", "text/plain; charset=utf-8", "none");
        const buf = Buffer.from(await r.arrayBuffer());
        const sha = createHash("sha256").update(buf).digest("hex");
        /**
         * Refuse rather than serve bytes that do not match what the record committed to. A document that has drifted
         * from its published hash is the one thing this route must never hand over quietly — the reader's whole
         * reason for asking us rather than the creator's URI is that ours is the attested copy.
         */
        if (att.meta_sha256 && att.meta_sha256 !== sha)
          return send(500, "stored document does not match the hash on record", "text/plain; charset=utf-8", "none");
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(buf.length),
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-sha256": sha,
          "x-fetched-at": r.headers.get("x-fetched-at") ?? "",
          // Operator-supplied bytes. Never let them execute or be framed, whatever the content type claims.
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": "*",
        });
        return res.end(buf);
      } catch { return send(502, "document store unreachable", "text/plain; charset=utf-8", "none"); }
    }

    const img = /^\/i\/([0-9a-f]{64})$/.exec(safe);
    if (img) {
      const sha = img[1];
      /**
       * The record is the attestation, and it is checked BEFORE anything is read or fetched.
       *
       * This check was believed to be here and was not. The other session merged two /i/ routes on the
       * understanding that mine already refused a hash the record did not carry; mine only ever checked the local
       * filesystem, and the 404 that cost an hour of misdiagnosis came from a missing file rather than from a
       * refusal. Writing it now so the belief and the behaviour agree.
       *
       * It matters beyond tidiness. The page says "this is the picture the launch published", and the only thing
       * that makes that claim checkable by a reader is the commitment published beside it in record.db. Serving
       * bytes for a hash the archive never attested is serving evidence nobody can verify against the archive —
       * the exact property the whole commitment scheme exists to provide. Prepared inline rather than hoisted,
       * because `db` is swapped in place by reloadRecord and a hoisted statement would outlive its connection.
       */
      if (!db.prepare("SELECT 1 FROM tokens WHERE image_sha256 = ? LIMIT 1").get(sha))
        return send(404, "no record attests this picture", "text/plain; charset=utf-8", "none");
      const dir = join(IMAGE_DIR, sha.slice(0, 2));
      const hit = (() => {
        for (const ext of ["webp", "png", "jpg", "gif", "svg", "avif", "bin"]) {
          const p = join(dir, `${sha}.${ext}`);
          if (isFile(p)) return { p, ext };
        }
        return null;
      })();
      /**
       * Locally if we have it, otherwise from the collector over the private network.
       *
       * The bytes live on the COLLECTOR's volume, because that is the process that captured them, and this service
       * has no volume. Reading only from the local directory meant serving whatever pictures happened to be in the
       * build context of whichever machine deployed — the laptop back in the publish path, and ~570 MB a day of
       * images inside a container image. The local branch stays because it is right in development and on any deploy
       * that does carry files; the fallback is what makes production honest.
       */
      const headers = (type: string, len: number) => ({
        "content-type": type,
        "content-length": String(len),
        "cache-control": "public, max-age=31536000, immutable",
        // Operator-supplied bytes. Never let them execute or be framed, whatever the content type claims.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
      });
      const TYPES_BY_EXT: Record<string, string> = { webp: "image/webp", png: "image/png", jpg: "image/jpeg",
        gif: "image/gif", svg: "image/svg+xml", avif: "image/avif" };
      if (hit) {
        const buf = readFileSync(hit.p);
        res.writeHead(200, headers(TYPES_BY_EXT[hit.ext] ?? "application/octet-stream", buf.length));
        return res.end(buf);
      }
      /**
       * The object store, when there is one, before the collector.
       *
       * Once pictures go to R2 the collector's volume stops accumulating them, so asking the collector for a picture
       * it captured last week would 404 — a real answer about our records, and the wrong one. The store is where the
       * bytes actually are; the collector fallback stays for the transition and for any deploy without a store.
       *
       * Content-addressed, so this cannot serve the wrong picture: the key IS the hash the record commits to. A
       * corrupt or substituted object would have to collide with sha256 to be served under that name.
       */
      if (imageStore) {
        try {
          const obj = await r2Get(imageStore, sha);
          if (obj) {
            res.writeHead(200, headers(obj.contentType, obj.body.length));
            return res.end(obj.body);
          }
          // Absent from the store is "we never captured it" — fall through to the collector, which may still hold
          // it from before the store existed, and only then to 404.
        } catch { return send(502, "image store unreachable", "text/plain; charset=utf-8", "none"); }
      }
      if (HEALTH_URL) {
        try {
          const r = await fetch(HEALTH_URL.replace(/\/health$/, `/image/${sha}`), { signal: AbortSignal.timeout(15_000) });
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            res.writeHead(200, headers(r.headers.get("content-type") ?? "application/octet-stream", buf.length));
            return res.end(buf);
          }
          // 404 from the store is "we never captured it", which is a different answer from "the store is down" and
          // must not be cached as though it were settled.
          if (r.status !== 404) return send(502, "image store unavailable", "text/plain; charset=utf-8", "none");
        } catch { return send(502, "image store unreachable", "text/plain; charset=utf-8", "none"); }
      }
      // A picture we do not hold is a 404 and nothing else. Never a placeholder that could be mistaken for evidence.
      return send(404, "not held", "text/plain; charset=utf-8", "none");
    }

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
    /**
     * The document bundle, streamed from the collector rather than held here.
     *
     * record.db is pulled, verified and adopted by this service because every page depends on it. This is different:
     * it is an optional download that no page reads, ~13 MB gzipped, and giving it its own pull-verify-adopt cycle
     * would be a second copy of the most delicate machinery in the project for a file nothing here queries. So it is
     * proxied. If the collector is down this 502s, which is the honest answer — the alternative is serving a stale
     * bundle under a name that promises the current corpus.
     */
    if (safe === "/data/documents.ndjson.gz" || safe === "/data/documents.json") {
      if (!HEALTH_URL) return send(503, "no collector configured to serve documents from", "text/plain; charset=utf-8", "none");
      const which = safe.endsWith(".json") ? "/documents.json" : "/documents.ndjson.gz";
      try {
        const r = await fetch(HEALTH_URL.replace(/\/health$/, which), { signal: AbortSignal.timeout(120_000) });
        if (!r.ok) return send(r.status === 503 ? 503 : 502, await r.text(), "text/plain; charset=utf-8", "none");
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(200, {
          "content-type": which.endsWith(".json") ? "application/json" : "application/gzip",
          "content-length": String(buf.length),
          "content-disposition": `attachment; filename="chain-of-title-${which.slice(1)}"`,
          "cache-control": "public, max-age=3600",
          "access-control-allow-origin": "*",
        });
        return res.end(buf);
      } catch { return send(502, "the document bundle is not available from the collector", "text/plain; charset=utf-8", "none"); }
    }

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
    /**
     * An operator cluster. Cluster names are the first six characters of the funder's address, which is what
     * `operator_wallets.cluster` holds, so the pattern is base58 and short rather than a full address.
     */
    const cm = safe.match(/^\/o\/([1-9A-HJ-NP-Za-km-z]{4,12})\.html$/);
    if (cm) {
      const c = clusterProfile(db, cm[1]);
      if (!c.wallets.length)
        return send(404, page("No cluster", `<h1 class="headline">No cluster on file</h1>
          <p class="lede">We hold no wallets funded from that address. That is a statement about our records and
          not about anyone.</p>${SEARCH}`, chrome, 1, undefined, safe));
      // The signature belongs to the (wallet, mint) purchase, and the render layer takes it as a lookup rather than
      // a field so that the chart's own input stays the shape the chart needs.
      const sigs = new Map(c.events.map((e) => [`${e.wallet} ${e.mint}`, e.sig]));
      return send(200, page(`Operator cluster ${cm[1]}`, clusterBody({ ...c, sigs }), chrome, 1,
        c.curves
          ? `${c.wallets.length} wallets funded from one address, which together bought ${c.curves} bonding curves outright.`
          : `${c.wallets.length} wallets funded from one address.`,
        `/o/${cm[1]}.html`), "text/html; charset=utf-8", "short");
    }

    const wm = safe.match(/^\/w\/([1-9A-HJ-NP-Za-km-z]{32,44})\.html$/);
    if (wm) {
      const p = profile(db, wm[1]);
      if (!p.buyouts.length)
        return send(200, page("No record", `<h1>No curve buyouts on record</h1><div class="sub mono">${wm[1]}</div>
          <div class="flag UNKNOWN"><span class="tag UNKNOWN">unknown</span>This wallet has not bought out a bonding
          curve in our archive. That is not a statement about the wallet: only that it does not appear here.</div>`, chrome, 1));
      const line = verdictLine(p);
      return send(200, page(`Wallet ${wm[1].slice(0, 8)}`, walletBody(wm[1], p, walletVerdict(p)), chrome, 1,
        line ?? `A wallet that has bought out ${p.buyouts.length} bonding curve${p.buyouts.length === 1 ? "" : "s"} in this archive.`,
        `/w/${wm[1]}.html`), "text/html; charset=utf-8", "short");
    }

    // a token page we have not generated: answer from the database, or rebuild it
    const m = safe.match(/^\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})\.html$/);
    if (m) {
      const mint = m[1];
      const d = await decide(mint, clientIp(req));
      if (d.kind === "record")
        // Same rule as the API: a live answer describes a launch still moving and must not be cached as immutable.
        return send(200, await renderToken(d.t, d.judgeable, d.precomputed), "text/html; charset=utf-8",
          d.precomputed ? "short" : d.judgeable ? "immutable" : "none");
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

/**
 * How long the single thread was unavailable, and when.
 *
 * Every stall this service can suffer looks identical from outside - a request that connects and then receives
 * nothing - and looks like nothing at all from inside, because the process is up, healthy and busy. This is the
 * one measurement that distinguishes "the site is down" from "the site was thinking": `monitorEventLoopDelay`
 * records how long the loop went unserviced, so a stall names itself in the log instead of being reconstructed
 * afterwards from a failed check and a guess. It samples in C++ and costs nothing measurable.
 *
 * Only stalls a visitor could notice are reported. A page that takes two seconds is slow; a page that takes
 * thirty has already failed for everyone who was waiting.
 */
{
  const { monitorEventLoopDelay } = await import("node:perf_hooks");
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  setInterval(() => {
    const worst = loop.max / 1e6;
    loop.reset();
    if (worst >= LOOP_STALL_MS) console.log(`[loop] blocked for ${Math.round(worst)} ms at some point in the last minute — every request in flight waited that long`);
  }, 60_000).unref();
}

server.listen(PORT, () => {
  console.log(`serving ${DIR} from ${DB_FILE} (${held.toLocaleString()} launches) on http://localhost:${PORT}`);
  console.log(`unknown mints are rebuilt from chain (queue max ${MAX_QUEUE}, one at a time)`);
});
