/**
 * Recover the creation transaction for launches recorded before `create_sig` existed.
 *
 * `tokens.create_sig` is written live from the create event as of 2026-09-09. Every launch before that carries the
 * claim — "the creator took 79.31% of supply in the first block" — with no transaction a reader can check it
 * against. This fills them in from the rows we still hold.
 *
 * The source is the dev's own first-block trade in `trades`: `is_dev = 1 AND age_ms = 0`, which is the creator's
 * initial buy, decoded from the same transaction the create event was decoded from. Its signature therefore IS the
 * creation transaction's signature, not a nearby one — that is the whole reason this backfill is sound, and it is
 * why nothing looser is accepted here. A `is_dev` trade at age_ms > 0 is a later purchase by the creator and proves
 * nothing about the first block; taking it would attach a citation that does not support the claim beside it.
 *
 * **This is a race, and it is being lost.** `trades` is under retention — about seven days at present volume — so a
 * launch's creation signature survives locally only until its trade rows are pruned. Measured when this was written:
 * 181,231 of 205,697 launches still recoverable, but only 5,498 of 7,026 confirmed graduations, the other 1,528
 * already gone. Roughly 25,000 launches age out per day. Run this now rather than well; what it misses is
 * recoverable only from an archival node, at a cost.
 *
 *   npm run backfillsig -- --dry-run
 *   npm run backfillsig
 *
 * It is idempotent and never overwrites: only rows where `create_sig IS NULL` are touched.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const DRY = process.argv.includes("--dry-run");
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BATCH = Number(arg("--batch", "20000"));

const db = openDb(config.dbPath);

const count = (sql: string): number => (db.prepare(sql).get() as any).c as number;

const total = count("SELECT COUNT(*) c FROM tokens");
const missing = count("SELECT COUNT(*) c FROM tokens WHERE create_sig IS NULL");
const recoverable = count(`SELECT COUNT(*) c FROM tokens t WHERE t.create_sig IS NULL AND EXISTS (
  SELECT 1 FROM trades tr WHERE tr.mint = t.mint AND tr.is_dev = 1 AND tr.age_ms = 0 AND tr.sig IS NOT NULL)`);
const gradMissing = count(`SELECT COUNT(*) c FROM tokens WHERE create_sig IS NULL AND graduated_confirmed_by IS NOT NULL`);
const gradRecoverable = count(`SELECT COUNT(*) c FROM tokens t WHERE t.create_sig IS NULL
  AND t.graduated_confirmed_by IS NOT NULL AND EXISTS (
  SELECT 1 FROM trades tr WHERE tr.mint = t.mint AND tr.is_dev = 1 AND tr.age_ms = 0 AND tr.sig IS NOT NULL)`);

console.log(`${total.toLocaleString()} launches, ${missing.toLocaleString()} without a creation transaction`);
console.log(`  recoverable from trade rows we still hold : ${recoverable.toLocaleString()}`);
console.log(`  already pruned, archival RPC only         : ${(missing - recoverable).toLocaleString()}`);
console.log(`confirmed graduations missing one: ${gradMissing.toLocaleString()}, of which ${gradRecoverable.toLocaleString()} recoverable\n`);

if (DRY) {
  console.log("dry run: nothing written");
  process.exit(0);
}

/**
 * Written in batches inside short transactions rather than as one statement over 180,000 rows.
 *
 * The collector is normally running against this file and a single multi-minute write transaction would hold the
 * write lock across it, which costs dropped launches — the one loss here that cannot be repaired. `updated_at` moves
 * with the write so `servicedb`'s incremental copy carries the row into the published record; omitting that is how
 * 940 confirmations sat in the collector and never reached the public archive earlier today.
 */
let done = 0, wrote = 0;
for (;;) {
  const t0 = Date.now();
  db.prepare("BEGIN IMMEDIATE").run();
  let n = 0;
  try {
    const r = db.prepare(`UPDATE tokens SET
        create_sig = (SELECT tr.sig FROM trades tr WHERE tr.mint = tokens.mint AND tr.is_dev = 1 AND tr.age_ms = 0 AND tr.sig IS NOT NULL LIMIT 1),
        create_slot = COALESCE(create_slot, (SELECT tr.slot FROM trades tr WHERE tr.mint = tokens.mint AND tr.is_dev = 1 AND tr.age_ms = 0 AND tr.sig IS NOT NULL LIMIT 1)),
        updated_at = ?
      WHERE mint IN (
        SELECT t.mint FROM tokens t WHERE t.create_sig IS NULL AND EXISTS (
          SELECT 1 FROM trades tr WHERE tr.mint = t.mint AND tr.is_dev = 1 AND tr.age_ms = 0 AND tr.sig IS NOT NULL)
        LIMIT ?)`).run(Date.now(), BATCH);
    n = Number(r.changes);
    db.prepare("COMMIT").run();
  } catch (e) {
    try { db.prepare("ROLLBACK").run(); } catch {}
    throw e;
  }
  if (n === 0) break;
  wrote += n; done++;
  console.log(`  batch ${done}: ${n.toLocaleString()} rows in ${Date.now() - t0} ms (${wrote.toLocaleString()} total)`);
}

const after = count("SELECT COUNT(*) c FROM tokens WHERE create_sig IS NOT NULL");
const afterGrad = count("SELECT COUNT(*) c FROM tokens WHERE create_sig IS NOT NULL AND graduated_confirmed_by IS NOT NULL");
console.log(`\nwrote ${wrote.toLocaleString()}`);
console.log(`launches now citing a creation transaction: ${after.toLocaleString()} of ${total.toLocaleString()}`);
console.log(`confirmed graduations citing one:           ${afterGrad.toLocaleString()}`);
const stillMissing = count("SELECT COUNT(*) c FROM tokens WHERE create_sig IS NULL AND graduated_confirmed_by IS NOT NULL");
if (stillMissing) console.log(`\n${stillMissing.toLocaleString()} confirmed graduations remain without one. Their trade rows are gone;\nonly an archival node can return them, and no further local run will help.`);
