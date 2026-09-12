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
import { VENUES } from "./venues.ts";

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
//
// AND IT IS ONE RUN PER VENUE, which is what this check had wrong from the moment a second venue existed.
//
// `LIMIT 1` over the whole table answers "is SOME subscription alive", and the question this project has to answer
// is "is EVERY subscription alive". Every venue opens its run row in the same millisecond at startup, so ordering
// by `started_at DESC, id DESC` resolves the tie on insertion order and returns whichever venue sits last in
// `VENUES` - a detail of a registry array deciding which feed gets monitored. Let pump.fun's socket die while any
// later venue stays up and health reads the later venue's fresh heartbeat and reports coverage advancing: ok. The
// primary feed dead, and the one check written to catch a collector that is up and deaf passing hardest during the
// failure it exists for. At two venues that is a coin flip. At eight it is seven times in eight.
//
// So: the newest run per venue, every declared venue checked, and the worst one decides. A venue declared in
// `VENUES` with no run row at all is a FAIL rather than a blank, because the registry entry is what publishes the
// coverage claim - `venuePhrase()` renders it the instant the entry exists - so a declared venue nobody is
// subscribed to means the site is claiming a scope the collector is not collecting. Unproven is not ok.
const allRuns = (() => {
  const sel = (cols: string) => db.prepare(`SELECT ${cols} FROM runs WHERE started_at IS NOT NULL`).all() as any[];
  // `runs.venue` arrives by migration, so a record opened without one has no such column. Older databases collapse
  // to a single venue rather than throwing, which is the truth about them: they were written by a one-venue collector.
  try { return sel("id, started_at, stopped_at, venue"); } catch { return sel("id, started_at, stopped_at"); }
})();
const newestPerVenue = new Map<string, any>();
for (const r of allRuns) {
  const v = r.venue ?? "pumpfun";
  const cur = newestPerVenue.get(v);
  if (!cur || r.started_at > cur.started_at || (r.started_at === cur.started_at && r.id > cur.id)) newestPerVenue.set(v, r);
}
// A run with no heartbeat yet reads as Infinity, not as fresh: a subscription that has opened and observed nothing
// is exactly the state a stale-heartbeat check exists to catch, and inheriting a previous run's stamp would hide it.
const runAgeS = (r: any): number => (r?.stopped_at ? (now - r.stopped_at) / 1000 : Infinity);
const venueRuns = VENUES.map((v) => ({ id: v.id, run: newestPerVenue.get(v.id) ?? null }))
  .map((x) => ({ ...x, ageS: runAgeS(x.run), everRan: !!x.run }));
const staleVenues = venueRuns.filter((x) => !(x.ageS < 180));
// The worst venue, because a summary figure that reports the healthiest feed is how this check got here.
const heartbeatAgeS = Math.max(...venueRuns.map((x) => x.ageS));
const lastRun = newestPerVenue.get("pumpfun") ?? null;
const lastLaunch = q("SELECT MAX(created_at) t FROM tokens WHERE late_discovery = 0")?.t ?? 0;
const launchAgeS = (now - lastLaunch) / 1000;
const launches1h = q("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0 AND created_at >= ?", now - 3600_000)?.c ?? 0;
// The rate floor below is calibrated to pump.fun's ~900-1100/h and nothing else, so it is measured on pump.fun
// alone. Summed across venues it becomes a threshold one busy feed can satisfy on behalf of a dead one, which is
// the same fault as the single-run heartbeat: a quiet venue cannot fail it and a dead pump.fun can be carried over
// it. Each venue's own liveness is the heartbeat's job; this one asks whether the feed we have a number for is
// degraded.
const launches1hPumpfun = q("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0 AND COALESCE(venue,'pumpfun')='pumpfun' AND created_at >= ?", now - 3600_000)?.c ?? 0;
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
  { name: "coverage advancing", ok: staleVenues.length === 0,
    detail: staleVenues.length === 0
      ? `${venueRuns.length} venue${venueRuns.length === 1 ? "" : "s"} advancing, worst ${heartbeatAgeS.toFixed(0)}s ago (expected < 180s)`
      : staleVenues.map((x) => !x.everRan
          ? `${x.id}: declared in VENUES and has never opened a run - the site claims this venue and nothing is watching it`
          : x.ageS === Infinity ? `${x.id}: run open, no launch observed yet`
          : `${x.id}: last observed launch ${x.ageS.toFixed(0)}s ago`).join("; ") },
  { name: "launches arriving", ok: launchAgeS < 300,
    detail: `last launch ${launchAgeS.toFixed(0)}s ago, ${launches1h} in the last hour (pump.fun runs ~900-1100/h)` },
  { name: "launch rate sane", ok: launches1hPumpfun >= 100,
    detail: `pump.fun ${launches1hPumpfun}/h of ${launches1h}/h across all venues - below 100 on pump.fun means that feed is degraded, not that the market is quiet` },
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
  console.log(JSON.stringify({ healthy, unknown, checks, heartbeatAgeS, launches1h, launches1hPumpfun, trades5m, pools,
    venues: venueRuns.map((x) => ({ venue: x.id, everRan: x.everRan, heartbeatAgeS: Number.isFinite(x.ageS) ? x.ageS : null })),
    staleVenues: staleVenues.map((x) => x.id) }, null, 2));
} else {
  console.log(`\ncollector: ${healthy ? "HEALTHY" : "UNHEALTHY"}${unknown ? ` (${unknown} not checkable here)` : ""}\n`);
  for (const c of checks) console.log(`  ${c.ok === null ? "----" : c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(24)} ${c.detail}`);
  if (!healthy) console.log(`\n  A failing check means coverage is being lost right now, and launch-time facts are not recoverable.`);
  console.log("");
}
process.exit(healthy ? 0 : 1);
