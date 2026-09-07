/**
 * Retention for the research database. The archive (`npm run archive`) is the permanent asset at ~34 MB; `trades` and
 * `wallet_token_stats` are working data that grow ~1 GB/day and are only read by analyses with a 24-96 h window.
 *   npm run prune                 # dry run: report what would go
 *   npm run prune -- --apply      # delete
 *   npm run prune -- --days 14 --apply
 *   npm run prune -- --apply --vacuum   # reclaim file space (needs ~2x free disk, locks the db)
 *
 * Never touches `tokens`, `signals`, `operator_*`, `pool_map` or `hist_*` — those are provenance, not working data.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg("--days", 7);
const APPLY = process.argv.includes("--apply");
const VACUUM = process.argv.includes("--vacuum");
const BATCH = 200_000;

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
purge("trades", `DELETE FROM trades WHERE rowid IN (SELECT rowid FROM trades WHERE ts < ? LIMIT ${BATCH})`, [cutoff]);
purge("wallet_token_stats", `DELETE FROM wallet_token_stats WHERE rowid IN (SELECT wts.rowid FROM wallet_token_stats wts JOIN tokens t ON t.mint = wts.mint WHERE t.created_at < ? LIMIT ${BATCH})`, [cutoff]);
purge("curve_snapshots", `DELETE FROM curve_snapshots WHERE rowid IN (SELECT rowid FROM curve_snapshots WHERE ts < ? LIMIT ${BATCH})`, [cutoff]);
purge("tweets", `DELETE FROM tweets WHERE rowid IN (SELECT rowid FROM tweets WHERE fetched_at < ? LIMIT ${BATCH})`, [cutoff]);

if (VACUUM) {
  console.log("\n  VACUUM — reclaiming file space (this locks the database; the monitor will block until it finishes)");
  db.exec("VACUUM");
  console.log("  done");
} else {
  console.log("\n  space is now free inside the file and will be reused; the file itself does not shrink.");
  console.log("  run with --vacuum on a stopped collector to actually shrink it.");
}
