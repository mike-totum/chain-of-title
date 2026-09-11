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

type Check = { name: string; ok: boolean; detail: string };
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
];
const healthy = checks.every((c) => c.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({ healthy, checks, heartbeatAgeS, launches1h, trades5m, pools }, null, 2));
} else {
  console.log(`\ncollector: ${healthy ? "HEALTHY" : "UNHEALTHY"}\n`);
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(24)} ${c.detail}`);
  if (!healthy) console.log(`\n  A failing check means coverage is being lost right now, and launch-time facts are not recoverable.`);
  console.log("");
}
process.exit(healthy ? 0 : 1);
