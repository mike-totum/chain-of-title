/**
 * Fetch and keep the launch metadata document for every launch that has a URI and no document.
 *
 * This is the most valuable thing left uncaptured and the only one on a deadline that is not ours. The document is
 * what a launch *claimed to be* - its name, its description, its socials, and the URI of its picture. It lives
 * off-chain behind a URI the creator controls, so unlike everything else in this archive it cannot be rebuilt from
 * chain history by anyone, at any price, once the creator repoints it or the pin lapses. An archival node returns
 * the transaction that created "GTA 6 Coin"; nothing returns the sentence claiming Rockstar had announced it.
 *
 * **Why there is a backlog at all.** Live capture only began working on 2026-09-08 - 98.8% of that day's launches
 * carry a document and 0.0% of 09-02 through 09-07 do. The recovery sweep in `index.ts` cannot reach them: it is
 * windowed to launches created in the last three days, so 116,739 of the 158,052 missing documents are already
 * outside it and get further outside it every hour. That window is right for a sweep running beside ingestion and
 * wrong as the only path, which is what it had become.
 *
 * Cost is not the constraint here and it is worth saying plainly, because the assumption that it was is what kept
 * this narrow: the documents average 306 bytes. Every launch this archive has ever seen is 63 MB in total, and a
 * day's worth is about 7 MB. The picture is the expensive artefact; the claim is nearly free and we were keeping
 * neither.
 *
 *   npm run backfillmeta -- --dry-run
 *   npm run backfillmeta -- --limit 5000 --concurrency 8
 *
 * Resumable and idempotent: it only ever selects rows with no document, and a fetch that fails is recorded so the
 * next pass does not spend the same seconds on the same dead pin. `meta_error` describes OUR fetch, not the launch,
 * which is why it is not published in the record - the same rule `image_error` already follows.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { fetchMetaResult, type MetaResult } from "./tracker.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes("--dry-run");
const LIMIT = Number(arg("--limit", "200000"));
const CONCURRENCY = Number(arg("--concurrency", "8"));
const BATCH = Number(arg("--batch", "500"));
/** Retry a failed fetch after this long: an IPFS gateway that timed out is not the same as a pin that is gone. */
const RETRY_AFTER_MS = Number(arg("--retry-hours", "12")) * 3600_000;

const db = openDb(config.dbPath);
try { db.exec("ALTER TABLE tokens ADD COLUMN meta_error TEXT"); } catch {}

const q = (sql: string) => (db.prepare(sql).get() as any).c as number;
const total = q("SELECT COUNT(*) c FROM tokens");
const missing = q("SELECT COUNT(*) c FROM tokens WHERE meta_at IS NULL AND uri IS NOT NULL AND length(uri) > 0");
console.log(`${total.toLocaleString()} launches; ${missing.toLocaleString()} have a URI and no document held`);
console.log(`  at ~306 bytes each, holding all of them costs about ${(missing * 306 / 1e6).toFixed(0)} MB\n`);
if (DRY) { console.log("dry run: nothing fetched, nothing written"); process.exit(0); }

/**
 * Newest first. A launch someone might look up today is worth more than one from last week, and - the reason that
 * matters here rather than being a preference - a recent pin is likelier to still be answering, so the same minute
 * of fetching recovers more documents at the new end than the old. The old end is where the loss is permanent, but
 * it is permanent whether we reach it in an hour or a day, and much of it is already gone.
 */
const pending = db.prepare(`SELECT mint, uri FROM tokens
  WHERE meta_at IS NULL AND uri IS NOT NULL AND length(uri) > 0
    AND (meta_error IS NULL OR updated_at < ?)
  ORDER BY created_at DESC LIMIT ?`);

const ok = db.prepare(`UPDATE tokens SET
  image = COALESCE(image, ?), description = COALESCE(description, ?),
  twitter = COALESCE(twitter, ?), telegram = COALESCE(telegram, ?), website = COALESCE(website, ?),
  meta_json = COALESCE(meta_json, ?), meta_bytes = COALESCE(meta_bytes, ?),
  -- A document served but unparseable is held, not lost: meta_at says we have the bytes, meta_error says they did
  -- not parse. Writing NULL here unconditionally would file it as a clean capture and lose that distinction.
  meta_at = COALESCE(meta_at, ?), meta_error = ?,
  -- servicedb copies incrementally on updated_at, and a document written without moving it would sit in the
  -- collector and never reach the published record. That has now happened twice today. See servicedb.ts.
  updated_at = ?
  WHERE mint = ?`);
const bad = db.prepare(`UPDATE tokens SET meta_error = ?, updated_at = ? WHERE mint = ?`);

let got = 0, failed = 0, seen = 0, bytes = 0;
const started = Date.now();

for (;;) {
  const rows = pending.all(Date.now() - RETRY_AFTER_MS, Math.min(BATCH, LIMIT - seen)) as unknown as
    { mint: string; uri: string }[];
  if (!rows.length || seen >= LIMIT) break;

  // Fetch the whole batch with no lock held, then write it in one short transaction. The collector is normally
  // running against this file and its only real obligation is not to drop a launch.
  const results: { mint: string; r: MetaResult }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const r = rows[i];
      let out: MetaResult;
      try { out = await fetchMetaResult(r.uri); }
      catch (e) { out = { meta: null, via: "none", error: `threw: ${(e as Error).message}` }; }
      results.push({ mint: r.mint, r: out });
    }
  }));

  const now = Date.now();
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    for (const { mint, r } of results) {
      const meta = r.meta;
      if (meta) {
        ok.run(meta.image ?? null, meta.description ?? null, meta.twitter ?? null, meta.telegram ?? null,
          meta.website ?? null, meta.raw ?? null, meta.bytes ?? null, now, r.error ?? null, now, mint);
        got++; bytes += meta.bytes ?? 0;
      } else {
        /**
         * The cause, not the word "unreachable". `fetchContent` distinguishes a gateway refusing us from a pin that
         * is gone, and the whole point of a retry pass is to know which of those it is looking at - 121,832 rows
         * were written with one word between them and the permanent loss could not be sized.
         */
        bad.run(r.error ?? "unreachable", now, mint);
        failed++;
      }
    }
    db.prepare("COMMIT").run();
  } catch (e) {
    try { db.prepare("ROLLBACK").run(); } catch {}
    throw e;
  }
  seen += rows.length;
  const rate = seen / Math.max(1, (Date.now() - started) / 1000);
  console.log(`  ${seen.toLocaleString()} tried - ${got.toLocaleString()} kept (${(bytes / 1e6).toFixed(1)} MB), ` +
    `${failed.toLocaleString()} unreachable, ${rate.toFixed(0)}/s`);
}

const held = q("SELECT COUNT(*) c FROM tokens WHERE meta_at IS NOT NULL");
console.log(`\nkept ${got.toLocaleString()} documents (${(bytes / 1e6).toFixed(1)} MB), ${failed.toLocaleString()} unreachable`);
console.log(`archive now holds the launch claim for ${held.toLocaleString()} of ${total.toLocaleString()} launches`);
if (failed) console.log(`\nUnreachable is not "no document": it is a gateway that did not answer or a pin that is gone.\nThey are marked and retried after ${RETRY_AFTER_MS / 3600_000} h; what is truly unpinned will not come back.`);
