/**
 * Is the collector actually collecting? Exits 0 healthy, 1 unhealthy - usable as a deploy gate or a cron check.
 *   npm run health            # human readable
 *   npm run health -- --json  # machine readable
 *
 * The product's claim is unbroken coverage, so "the process is running" is not the question. The questions are whether
 * launches are still arriving, whether the heartbeat is fresh, and whether graduated tokens are being priced.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const JSON_OUT = process.argv.includes("--json");
const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");
const now = Date.now();
const q = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p as any) as any;

// The current run is the one that started most recently, which is not the same as the one with the highest id.
// `runs.id` is AUTOINCREMENT, so it means insertion order, and any path that writes a run out of order - a seed
// merge appending the laptop's history, a repair, a restore - gives an old `started_at` the highest id. Health would
// then measure the heartbeat against a run that ended days ago and report a live collector as dead. Nothing inserts
// out of order today; ordering by id to mean "most recent in time" is wrong regardless, and it is wrong in the
// direction this project cares about, so it is fixed before something exploits it. `provenance.ts` already orders
// coverage by `started_at`; this is the one place that did not.
//
// Not MAX(stopped_at) across all runs, which would look like the same thing and is the opposite of it: a fresh run
// that has not yet stamped a heartbeat would inherit the previous run's, and a collector that is up and deaf would
// pass the one check written to catch exactly that. A NULL heartbeat on the newest run must read as unproven.
const lastRun = q("SELECT id, started_at, stopped_at FROM runs ORDER BY started_at DESC, id DESC LIMIT 1");
const heartbeatAgeS = lastRun?.stopped_at ? (now - lastRun.stopped_at) / 1000 : Infinity;
const lastLaunch = q("SELECT MAX(created_at) t FROM tokens WHERE late_discovery = 0")?.t ?? 0;
const launchAgeS = (now - lastLaunch) / 1000;
const launches1h = q("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0 AND created_at >= ?", now - 3600_000)?.c ?? 0;
const trades5m = q("SELECT COUNT(*) c FROM trades WHERE ts >= ?", now - 300_000)?.c ?? 0;
const pools = q("SELECT COUNT(*) c FROM pool_map")?.c ?? 0;
const priced1h = q("SELECT COUNT(*) c FROM tokens WHERE graduated=1 AND vault_sol IS NOT NULL AND updated_at >= ?", now - 3600_000)?.c ?? 0;

/**
 * The capture pipelines, which had no check at all until 2026-09-11.
 *
 * Every check above is about launches, and launches are the one thing here that is NOT lost when a pipeline stops:
 * the events stay on chain and an archival node rebuilds them. The material that is genuinely unrecoverable - the
 * metadata document behind a URI the creator can repoint, the launch image, a promotional message before it is
 * deleted - was collected by processes nothing watched.
 *
 * It cost exactly what that arrangement costs. The Telegram session died on 2026-09-09T14:22Z and wrote 21 gap rows
 * saying so; nothing read them and it went two days unnoticed, because a poller that is configured and ingesting
 * nothing looks precisely like a quiet week. These checks read the rows that already knew.
 *
 * A pipeline that is not configured is not a failure, and a pipeline that is configured and silent is. That is the
 * distinction the whole section turns on.
 */
const has = (table: string): boolean => {
  try { return !!q("SELECT 1 c FROM sqlite_master WHERE type='table' AND name=?", table); } catch { return false; }
};
const hasCol = (table: string, col: string): boolean => {
  try {
    return (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as any[]).some((r: any) => r.name === col);
  } catch { return false; }
};
/** Optional query: returns undefined rather than throwing when the table is not in this database. */
const opt = (table: string, sql: string, ...p: unknown[]): any => {
  if (!has(table)) return undefined;
  try { return q(sql, ...p); } catch { return undefined; }
};

const tgOn = process.env.TELEGRAM_ARCHIVE === "1";
const tgLast = opt("tg_messages", "SELECT MAX(fetched_at) t, COUNT(*) c FROM tg_messages");
const tgOpenGaps = opt("tg_gaps", "SELECT COUNT(*) c FROM tg_gaps WHERE to_at IS NULL")?.c;
const tweetLast = opt("tweets", "SELECT MAX(fetched_at) t, COUNT(*) c FROM tweets");

/**
 * Capture rate over launches old enough to have been fetched, not over all history. A historical backlog is a known
 * gap and not news; a fetcher that stopped today is. Denominator zero reports as unknown rather than as healthy.
 */
const capWindow = [now - 6 * 3600_000, now - 30 * 60_000];
const metaCap = opt("tokens",
  "SELECT COUNT(*) n, SUM(meta_json IS NOT NULL) got FROM tokens WHERE late_discovery=0 AND created_at BETWEEN ? AND ?",
  capWindow[0], capWindow[1]);
const imgCap = hasCol("tokens", "image_sha256") ? opt("tokens",
  "SELECT COUNT(*) n, SUM(image_sha256 IS NOT NULL) got FROM tokens WHERE late_discovery=0 AND created_at BETWEEN ? AND ?",
  capWindow[0], capWindow[1]) : undefined;

const rate = (r: any): number | null => (r && r.n > 0 ? Number(r.got ?? 0) / Number(r.n) : null);
const pctS = (x: number | null) => (x === null ? "n/a" : `${(100 * x).toFixed(0)}%`);

/** `ok: null` means the check could not run. Never rendered as a pass: absence of data is not a finding. */
type Check = { name: string; ok: boolean | null; detail: string };
const checks: Check[] = [
  // Since the heartbeat is stamped with the last launch that actually arrived rather than with the wall clock
  // (`index.ts`), this now measures ingestion, not liveness - a collector that is up and deaf fails it. That is the
  // whole point: the check that used to pass hardest during the failure it was meant to catch.
  { name: "coverage advancing", ok: heartbeatAgeS < 180,
    detail: heartbeatAgeS === Infinity ? "never written - collector has not completed a minute of runtime" : `last observed launch ${heartbeatAgeS.toFixed(0)}s ago (expected < 180s)` },
  { name: "launches arriving", ok: launchAgeS < 300,
    detail: `last launch ${launchAgeS.toFixed(0)}s ago, ${launches1h} in the last hour (pump.fun runs ~900-1100/h)` },
  { name: "launch rate sane", ok: launches1h >= 100,
    detail: `${launches1h}/h - below 100 means the feed is degraded, not that the market is quiet` },
  { name: "trades decoding", ok: trades5m > 0, detail: `${trades5m} trades stored in the last 5 min` },
  { name: "pool map growing", ok: pools > 0, detail: `${pools} pools known` },
  { name: "graduated tokens priced", ok: priced1h > 0, detail: `${priced1h} graduated tokens had vault balances read in the last hour` },

  // --- the unrecoverable-capture pipelines ---
  {
    name: "telegram archiving",
    ok: !tgOn ? null : (tgLast?.t ? (now - tgLast.t) < 6 * 3600_000 : false),
    detail: !tgOn ? "TELEGRAM_ARCHIVE is not set here, so nothing is expected"
      : !tgLast ? "configured, and this database has no tg_messages table at all"
      : !tgLast.t ? `configured and has NEVER stored a message (${tgLast.c} rows) - a dead session looks exactly like a quiet week`
      : `${tgLast.c} messages, last ${((now - tgLast.t) / 3600_000).toFixed(1)} h ago (expected < 6 h)`,
  },
  {
    // The check that would have caught 2026-09-09 on the day. An open gap is the poller's own record that it failed.
    name: "telegram gaps closed",
    ok: tgOpenGaps === undefined ? null : tgOpenGaps === 0,
    detail: tgOpenGaps === undefined ? "no tg_gaps table in this database"
      : tgOpenGaps === 0 ? "no open gaps" : `${tgOpenGaps} OPEN gap rows - the poller recorded its own failure and nothing read it`,
  },
  {
    name: "x archiving",
    ok: !tweetLast ? null : (tweetLast.t ? (now - tweetLast.t) < 12 * 3600_000 : false),
    detail: !tweetLast ? "no tweets table in this database"
      : !tweetLast.t ? "tweets table exists and is empty"
      : `${tweetLast.c} posts, last ${((now - tweetLast.t) / 3600_000).toFixed(1)} h ago (expected < 12 h)`,
  },
  {
    // The metadata document is the only part of a launch record that no archival node can sell back.
    name: "launch metadata captured",
    ok: rate(metaCap) === null ? null : rate(metaCap)! >= 0.5,
    detail: rate(metaCap) === null ? "no launches in the 30 min - 6 h window to judge by"
      : `${pctS(rate(metaCap))} of ${metaCap.n} launches aged 30 min to 6 h have their metadata document (expected >= 50%)`,
  },
  {
    name: "launch images captured",
    ok: rate(imgCap) === null ? null : rate(imgCap)! >= 0.5,
    detail: imgCap === undefined ? "this database has no image_sha256 column, so image evidence cannot be recorded here"
      : rate(imgCap) === null ? "no launches in the 30 min - 6 h window to judge by"
      : `${pctS(rate(imgCap))} of ${imgCap.n} launches aged 30 min to 6 h have an image hash (expected >= 50%)`,
  },
];
// A check that could not run is not a pass and not a failure. Only an explicit false is unhealthy.
const healthy = checks.every((c) => c.ok !== false);
const unknown = checks.filter((c) => c.ok === null).length;

if (JSON_OUT) {
  console.log(JSON.stringify({ healthy, unknown, checks, heartbeatAgeS, launches1h, trades5m, pools }, null, 2));
} else {
  console.log(`\ncollector: ${healthy ? "HEALTHY" : "UNHEALTHY"}${unknown ? ` (${unknown} not checkable here)` : ""}\n`);
  for (const c of checks) console.log(`  ${c.ok === null ? "----" : c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(24)} ${c.detail}`);
  if (!healthy) console.log(`\n  A failing check means coverage is being lost right now, and launch-time facts are not recoverable.`);
  console.log("");
}
process.exit(healthy ? 0 : 1);
