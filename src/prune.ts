/**
 * Retention for the research database. The archive (`npm run archive`) is the permanent asset at ~34 MB; `trades` and
 * `wallet_token_stats` are working data that grow ~1 GB/day and are only read by analyses with a 24-96 h window.
 *   npm run prune                 # dry run: report what would go
 *   npm run prune -- --apply      # delete
 *   npm run prune -- --days 14 --apply
 *   npm run prune -- --apply --vacuum   # reclaim file space (needs ~2x free disk, locks the db)
 *
 * Never touches `tokens`, `signals`, `operator_*`, `pool_map`, `hist_*`, or curve buys at or above BUYOUT_SOL -
 * those are provenance, not working data. The last of those was missing until 2026-09-08 and the sentence was false
 * for as long as it was: buyout trades were being deleted on a timer while this comment said the archive was safe.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { BUYOUT_SOL, KEEP_TRADE_EVIDENCE, keepTweetEvidence } from "./provenance.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
/**
 * Which database to prune. Defaults to the configured one, and exists because without it this tool could only ever
 * be pointed at production - so the only way to test a retention rule was to run it on the real archive and hope.
 * A destructive tool that cannot be rehearsed is one whose guards are verified by reasoning alone, which is how
 * every check found broken today got shipped.
 */
const DB_ARG = (() => { const i = process.argv.indexOf("--db"); return i > 0 ? process.argv[i + 1] : ""; })();
const DAYS = arg("--days", 7);
const APPLY = process.argv.includes("--apply");
const VACUUM = process.argv.includes("--vacuum");
const BATCH = 200_000;

/**
 * A legal hold suspends every deletion in this file, and in the collector's own pruner.
 *
 * Retention timers and evidence are in direct conflict the moment a dispute is foreseeable. Routine deletion under a
 * documented policy is defensible; deletion that continues after a claim is anticipated is spoliation, and it is
 * judged on whether a reasonable person should have foreseen the claim, not on whether anyone remembered to stop the
 * cron job. The 3-day trades prune destroys ~6 million rows a day, so the window between "we should have stopped"
 * and "we stopped" is measured in hours.
 *
 * One environment variable, honoured by both pruners, that fails closed: set LEGAL_HOLD to anything and nothing is
 * deleted anywhere until it is unset. Deliberately not a config file or a database flag - it has to be settable in
 * seconds by someone who has just been told to preserve, without a deploy.
 */
const LEGAL_HOLD = (process.env.LEGAL_HOLD ?? "").trim();

const db = openDb(DB_ARG || config.dbPath);

/**
 * Record the hold, and remember what it protected.
 *
 * An env var alone is hard to testify about later: it says nothing about when the hold began or who set it. A row
 * does. `protect_before` is the harder half - the retention cutoff at the moment the hold started. Without it,
 * unsetting the hold lets the next prune sweep the entire held period in a single pass, so the moment of release
 * becomes the moment the evidence disappears, which is the opposite of what a hold is for.
 */
export function noteHold(db2: any, note: string, retainDays: number): void {
  const open = db2.prepare("SELECT id FROM legal_holds WHERE released_at IS NULL ORDER BY id DESC LIMIT 1").get();
  if (open) { db2.prepare("UPDATE legal_holds SET last_seen_at = ? WHERE id = ?").run(Date.now(), (open as any).id); return; }
  db2.prepare("INSERT INTO legal_holds (note, set_at, last_seen_at, protect_before) VALUES (?,?,?,?)")
    .run(note, Date.now(), Date.now(), Date.now() - retainDays * 86400_000);
}

/** Rows older than the earliest hold ever recorded are never deleted again, released or not. */
export function protectFloor(db2: any): number {
  try {
    const r = db2.prepare("SELECT MIN(protect_before) m FROM legal_holds").get() as any;
    return Number(r?.m ?? 0) || 0;
  } catch { return 0; }
}

if (LEGAL_HOLD) {
  noteHold(db, LEGAL_HOLD, DAYS);
  console.log(`LEGAL HOLD IS SET (${LEGAL_HOLD}) - nothing will be deleted, and the hold is recorded in legal_holds.`);
  console.log(`Unset LEGAL_HOLD to resume retention. Data protected during a hold stays protected after release.`);
  process.exit(0);
}
const FLOOR = protectFloor(db);
if (FLOOR) console.log(`  a previous legal hold protects everything before ${new Date(FLOOR).toISOString().slice(0, 10)}; it will not be deleted.`);
if (DB_ARG) console.log(`  (pruning ${DB_ARG}, not the configured database)`);
/**
 * Does this database have that table? Neither pruner may assume one into existence.
 *
 * `curve_snapshots` is created by curvepoll.ts, which has only ever run on the laptop - so on the cloud collector
 * the table does not exist, this script died on its first COUNT, and the collector's own pruner threw partway
 * through its loop and skipped everything after it. A retention job that half-runs is worse than one that fails,
 * because it looks like it ran.
 */
const hasTable = (t: string): boolean => {
  try { return !!(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t) as any)?.c; }
  catch { return false; }
};
const cutoff = Date.now() - DAYS * 86400_000;
const iso = new Date(cutoff).toISOString().slice(0, 16).replace("T", " ");
const n = (x: number) => x.toLocaleString();

console.log(`retention ${DAYS} days - anything older than ${iso} UTC is working data past its window\n`);

/** -1 means the table is not in this database, which prints as "absent" rather than as a zero that looks like work done. */
const countOf = (table: string, sql: string): number => {
  if (!hasTable(table)) return -1;
  try { return (db.prepare(sql).get(cutoff) as any).c as number; } catch { return -1; }
};
const counts = {
  trades: countOf("trades", "SELECT COUNT(*) c FROM trades WHERE ts < ?"),
  tradesKeep: countOf("trades", "SELECT COUNT(*) c FROM trades WHERE ts >= ?"),
  wts: countOf("wallet_token_stats", `SELECT COUNT(*) c FROM wallet_token_stats WHERE mint IN (SELECT mint FROM tokens WHERE created_at < ?)`),
  snaps: countOf("curve_snapshots", "SELECT COUNT(*) c FROM curve_snapshots WHERE ts < ?"),
  tweets: countOf("tweets", "SELECT COUNT(*) c FROM tweets WHERE fetched_at < ?"),
};
const show = (v: number) => (v < 0 ? "absent".padStart(12) : n(v).padStart(12));
console.log(`  trades              ${show(counts.trades)} to delete, ${counts.tradesKeep < 0 ? "absent" : n(counts.tradesKeep)} kept`);
console.log(`  wallet_token_stats  ${show(counts.wts)} to delete (tokens launched before the cutoff)`);
console.log(`  curve_snapshots     ${show(counts.snaps)} to delete`);
console.log(Number(process.env.TWEETS_RETAIN_DAYS ?? 0) > 0
  ? `  tweets              ${show(counts.tweets)} to delete (TWEETS_RETAIN_DAYS=${process.env.TWEETS_RETAIN_DAYS})`
  : `  tweets              ${show(counts.tweets)} older than the cutoff, RETAINED - set TWEETS_RETAIN_DAYS to delete them`);
console.log(`\n  kept untouched: tokens, signals, operator_wallets/funders/policy, pool_map, positions, hist_*`);

if (!APPLY) { console.log(`\ndry run - nothing deleted. Re-run with --apply to execute.`); process.exit(0); }

/** delete in batches so the writer is never blocked for long while the monitor is live */
function purge(label: string, sql: string, params: unknown[]): void {
  if (!hasTable(label)) { console.log(`  ${label}: absent from this database, skipped`); return; }
  let total = 0;
  for (;;) {
    const r = db.prepare(sql).run(...params as any) as any;
    const c = Number(r.changes ?? 0);
    total += c;
    if (c < BATCH) break;
    process.stdout.write(`\r  ${label}: ${n(total)} deleted`);
  }
  console.log(`\r  ${label}: ${n(total)} deleted        `);
}
console.log("");
// Buyout-sized curve buys are evidence, not working data: `findBuyout` reads them and `servicedb` copies them into
// the published record. Deleting them leaves every count intact while destroying the proof of who took each curve.
// See KEEP_EVIDENCE in index.ts - the same exemption, because the collector prunes itself and this prunes by hand,
// and a rule that holds in only one of them is not a rule.
purge("trades", `DELETE FROM trades WHERE rowid IN (SELECT rowid FROM trades WHERE ts < ? AND ts >= ${FLOOR}
  ${KEEP_TRADE_EVIDENCE} LIMIT ${BATCH})`, [cutoff]);
purge("wallet_token_stats", `DELETE FROM wallet_token_stats WHERE rowid IN (SELECT wts.rowid FROM wallet_token_stats wts JOIN tokens t ON t.mint = wts.mint WHERE t.created_at < ? LIMIT ${BATCH})`, [cutoff]);
purge("curve_snapshots", `DELETE FROM curve_snapshots WHERE rowid IN (SELECT rowid FROM curve_snapshots WHERE ts < ? LIMIT ${BATCH})`, [cutoff]);
/**
 * Tweets are kept unless TWEETS_RETAIN_DAYS says otherwise - the same footing as tg_messages, and for the same
 * reason. The 88,133 posts already here are the only sample of broad pump.fun X chatter this project holds, they
 * cannot be re-collected now the account has no credits, and deleting them to tidy up is a one-way door.
 */
const TWEET_DAYS = Number(process.env.TWEETS_RETAIN_DAYS ?? 0);
if (TWEET_DAYS > 0) {
  const KEEP_TWEETS = keepTweetEvidence(db);
  if (KEEP_TWEETS) console.log("  tweets cited by token_promotion_hit are evidence and will be kept");
  purge("tweets", `DELETE FROM tweets WHERE rowid IN (SELECT rowid FROM tweets WHERE fetched_at < ${Date.now() - TWEET_DAYS * 86400_000} ${KEEP_TWEETS} LIMIT ${BATCH})`, []);
} else {
  console.log("  tweets: retained (TWEETS_RETAIN_DAYS unset) - the only X sample this project holds");
}
/**
 * Telegram messages are NOT pruned on the working-data timer, and that is deliberate: they are the archive, not
 * working data, and the retention period for personal data is a legal decision rather than an operational one.
 *
 * TELEGRAM_RETAIN_DAYS exists so that decision can be enforced once someone qualified has made it. Unset means keep,
 * which is the archival default and the assumption that should be challenged rather than inherited. See TELEGRAM.md.
 */
const TG_DAYS = Number(process.env.TELEGRAM_RETAIN_DAYS ?? 0);
if (TG_DAYS > 0) {
  const tgCutoff = Date.now() - TG_DAYS * 86400_000;
  console.log(`\n  TELEGRAM_RETAIN_DAYS=${TG_DAYS}: deleting channel messages posted before ${new Date(tgCutoff).toISOString().slice(0, 10)}`);
  purge("tg_messages", `DELETE FROM tg_messages WHERE rowid IN (SELECT rowid FROM tg_messages WHERE posted_at < ? LIMIT ${BATCH})`, [tgCutoff]);
} else {
  console.log("\n  tg_messages: retained (TELEGRAM_RETAIN_DAYS unset). Retention is a legal decision; see TELEGRAM.md.");
}

if (VACUUM) {
  console.log("\n  VACUUM - reclaiming file space (this locks the database; the monitor will block until it finishes)");
  db.exec("VACUUM");
  console.log("  done");
} else {
  console.log("\n  space is now free inside the file and will be reused; the file itself does not shrink.");
  console.log("  run with --vacuum on a stopped collector to actually shrink it.");
}
