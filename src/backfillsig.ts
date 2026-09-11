/**
 * Recover the creation transaction for launches recorded before `create_sig` existed.
 *
 * `tokens.create_sig` is written live from the create event as of 2026-09-09. Every launch before that carries the
 * claim - "the creator took 79.31% of supply in the first block" - with no transaction a reader can check it
 * against. This fills them in from the rows we still hold.
 *
 * The source is the dev's own first-block trade in `trades`: `is_dev = 1 AND age_ms = 0`, which is the creator's
 * initial buy, decoded from the same transaction the create event was decoded from. Its signature therefore IS the
 * creation transaction's signature, not a nearby one - that is the whole reason this backfill is sound, and it is
 * why nothing looser is accepted here. A `is_dev` trade at age_ms > 0 is a later purchase by the creator and proves
 * nothing about the first block; taking it would attach a citation that does not support the claim beside it.
 *
 * **This is a race against retention, so it belongs in the collector rather than in a person's terminal.** `trades`
 * holds roughly seven days at present volume, so a launch's creation signature survives locally only until its trade
 * rows are pruned. Run once by hand on the laptop it recovered 181,474 of 206,019 launches and missed 24,494 whose
 * rows had already gone. In the collector (`BACKFILL_SIG=1`) it runs on a timer and reaches each launch while the
 * evidence is still there, which is the difference between a backfill and a permanent hole.
 *
 *   npm run backfillsig -- --dry-run
 *   npm run backfillsig
 *
 * Idempotent and never overwrites: only rows where `create_sig IS NULL` are touched.
 */
import type { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

export interface SigBackfillStats { wrote: number; batches: number }

/**
 * Fill `create_sig`/`create_slot` from the creator's first-block trade, in bounded batches.
 *
 * `updated_at` moves with the write. `servicedb` copies incrementally on that column, so a row filled without
 * touching it stays in the collector and never reaches the published record - which happened twice on 2026-09-09,
 * once losing 940 confirmations and once losing 180,951 signatures. The paired-backfill list in servicedb.ts is the
 * belt to this brace; neither is sufficient alone, because a crashed build can leave the watermark ahead of writes
 * that already happened.
 *
 * One short transaction per batch, because the collector is normally ingesting against this same file and its only
 * real obligation is not to drop a launch.
 */
export function backfillCreateSig(db: DatabaseSync, opts: { batch?: number; maxBatches?: number } = {}): SigBackfillStats {
  const batch = opts.batch ?? 20_000;
  const maxBatches = opts.maxBatches ?? Infinity;
  let wrote = 0, batches = 0;
  for (; batches < maxBatches;) {
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
          LIMIT ?)`).run(Date.now(), batch);
      n = Number(r.changes);
      db.prepare("COMMIT").run();
    } catch (e) {
      try { db.prepare("ROLLBACK").run(); } catch {}
      throw e;
    }
    if (n === 0) break;
    wrote += n; batches++;
  }
  return { wrote, batches };
}

// ---------- CLI ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const DRY = process.argv.includes("--dry-run");
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const db = openDb(config.dbPath);
  const count = (sql: string): number => (db.prepare(sql).get() as any).c as number;

  const total = count("SELECT COUNT(*) c FROM tokens");
  const missing = count("SELECT COUNT(*) c FROM tokens WHERE create_sig IS NULL");
  const recoverable = count(`SELECT COUNT(*) c FROM tokens t WHERE t.create_sig IS NULL AND EXISTS (
    SELECT 1 FROM trades tr WHERE tr.mint = t.mint AND tr.is_dev = 1 AND tr.age_ms = 0 AND tr.sig IS NOT NULL)`);
  const gradMissing = count(`SELECT COUNT(*) c FROM tokens WHERE create_sig IS NULL AND graduated_confirmed_by IS NOT NULL`);

  console.log(`${total.toLocaleString()} launches, ${missing.toLocaleString()} without a creation transaction`);
  console.log(`  recoverable from trade rows we still hold : ${recoverable.toLocaleString()}`);
  console.log(`  already pruned, archival RPC only         : ${(missing - recoverable).toLocaleString()}`);
  console.log(`confirmed graduations missing one: ${gradMissing.toLocaleString()}\n`);
  if (DRY) { console.log("dry run: nothing written"); process.exit(0); }

  const st = backfillCreateSig(db, { batch: Number(arg("--batch", "20000")) });
  const after = count("SELECT COUNT(*) c FROM tokens WHERE create_sig IS NOT NULL");
  console.log(`wrote ${st.wrote.toLocaleString()} in ${st.batches} batches`);
  console.log(`launches now citing a creation transaction: ${after.toLocaleString()} of ${total.toLocaleString()}`);
  const stillMissing = count("SELECT COUNT(*) c FROM tokens WHERE create_sig IS NULL AND graduated_confirmed_by IS NOT NULL");
  if (stillMissing) console.log(`\n${stillMissing.toLocaleString()} confirmed graduations remain without one. Their trade rows are gone;\nonly an archival node can return them, and no further local run will help.`);
}
