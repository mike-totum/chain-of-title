/**
 * Retention for the research database. The archive (`npm run archive`) is the permanent asset at ~34 MB; `trades` and
 * `wallet_token_stats` are working data that grow ~1 GB/day and are only read by analyses with a 24-96 h window.
 *   npm run prune                 # dry run: report what would go
 *   npm run prune -- --apply      # delete
 *   npm run prune -- --days 14 --apply
 *   npm run prune -- --apply --vacuum   # reclaim file space (needs ~2x free disk, locks the db)
 *
 * Never touches `tokens`, `signals`, `operator_*`, `pool_map`, `hist_*`, or curve buys at or above BUYOUT_SOL —
 * those are provenance, not working data. The last of those was missing until 2026-09-08 and the sentence was false
 * for as long as it was: buyout trades were being deleted on a timer while this comment said the archive was safe.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { BUYOUT_SOL, KEEP_TRADE_EVIDENCE } from "./provenance.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
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
if (LEGAL_HOLD) {
  console.log(`LEGAL HOLD IS SET (${LEGAL_HOLD}) — nothing will be deleted. Unset LEGAL_HOLD to resume retention.`);
  process.exit(0);
}

const db = openDb(config.dbPath);
const cutoff = Date.now() - DAYS * 86400_000;
const iso = new Date(cutoff).toISOString().slice(0, 16).replace("T", " ");
const n = (x: number) => x.toLocaleString();

console.log(`retention ${DAYS} days — anything older than ${iso} UTC is working data past its window\n`);

const counts = {
  trades: (db.prepare("SELECT COUNT(*) c FROM trades WHERE ts < ?").get(cutoff) as any).c as number,
  tradesKeep: (db.prepare("SELECT COUNT(*) c FROM trades WHERE ts >= ?").get(cutoff) as any).c as number,
  wts: (db.prepare(`SELECT COUNT(*) c FROM wallet_token_stats WHERE mint IN (SELECT mint FROM tokens WHERE created_at < ?)`).get(cutoff) as any).c as number,
  snaps: (db.prepare("SELECT COUNT(*) c FROM curve_snapshots WHERE ts < ?").get(cutoff) as any).c as number,
  tweets: (db.prepare("SELECT COUNT(*) c FROM tweets WHERE fetched_at < ?").get(cutoff) as any).c as number,
};
console.log(`  trades              ${n(counts.trades).padStart(12)} to delete, ${n(counts.tradesKeep)} kept`);
console.log(`  wallet_token_stats  ${n(counts.wts).padStart(12)} to delete (tokens launched before the cutoff)`);
console.log(`  curve_snapshots     ${n(counts.snaps).padStart(12)} to delete`);
console.log(`  tweets              ${n(counts.tweets).padStart(12)} to delete`);
console.log(`\n  kept untouched: tokens, signals, operator_wallets/funders/policy, pool_map, positions, hist_*`);

if (!APPLY) { console.log(`\ndry run — nothing deleted. Re-run with --apply to execute.`); process.exit(0); }

/** delete in batches so the writer is never blocked for long while the monitor is live */
function purge(label: string, sql: string, params: unknown[]): void {
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
// See KEEP_EVIDENCE in index.ts — the same exemption, because the collector prunes itself and this prunes by hand,
// and a rule that holds in only one of them is not a rule.
purge("trades", `DELETE FROM trades WHERE rowid IN (SELECT rowid FROM trades WHERE ts < ?
  ${KEEP_TRADE_EVIDENCE} LIMIT ${BATCH})`, [cutoff]);
purge("wallet_token_stats", `DELETE FROM wallet_token_stats WHERE rowid IN (SELECT wts.rowid FROM wallet_token_stats wts JOIN tokens t ON t.mint = wts.mint WHERE t.created_at < ? LIMIT ${BATCH})`, [cutoff]);
purge("curve_snapshots", `DELETE FROM curve_snapshots WHERE rowid IN (SELECT rowid FROM curve_snapshots WHERE ts < ? LIMIT ${BATCH})`, [cutoff]);
purge("tweets", `DELETE FROM tweets WHERE rowid IN (SELECT rowid FROM tweets WHERE fetched_at < ? LIMIT ${BATCH})`, [cutoff]);
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
  console.log("\n  VACUUM — reclaiming file space (this locks the database; the monitor will block until it finishes)");
  db.exec("VACUUM");
  console.log("  done");
} else {
  console.log("\n  space is now free inside the file and will be reused; the file itself does not shrink.");
  console.log("  run with --vacuum on a stopped collector to actually shrink it.");
}
