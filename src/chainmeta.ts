/**
 * Fetch and keep the metadata document for every launch on the chain, not just pump.fun's.
 *
 *   npm run chainmeta                 one pass over launches with a uri and no document yet
 *   npm run chainmeta -- --daemon     keep up
 *
 * WHY THIS IS THE URGENT HALF. Everything else this archive records is on chain and stays there: an archival node
 * will rebuild a creator's supply share next year for whoever pays. The metadata document is the exception. It sits
 * behind a URI the creator controls, and when it is repointed or unpinned the launch's own account of itself is
 * gone for everyone, permanently. `metadata.j7tracker.io` hosted the documents for 30,443 launches and now answers
 * 404 for every single one. So this is the only pipeline here whose cost of not running compounds.
 *
 * Until now it ran against `tokens` only - the pump.fun collector's table - through `backfillmeta.ts`. `chainmints`
 * records launches from every venue on Solana and had no document capture at all, which made the chain-wide layer
 * comprehensive about the recoverable half and blind to the unrecoverable one. Exactly backwards.
 *
 * DELIBERATELY NOT A NEW FETCHER. `fetchMetaResult` and the IPFS gateway rotation in `ipfs.ts` already solve the
 * hard part - ipfs.io answers 429 to us on every request, so the declared host is the one host that will not serve
 * the document, and rotating is asking a different volunteer for the same content-addressed bytes. Reimplementing
 * that here would mean two fetchers ageing apart, and the older one carries measurements this one would lack.
 *
 * THE BYTES ARE STORED, AND THE HASH IS OF THE BYTES. `meta_sha256` is computed from what actually arrived, never
 * copied from anywhere, so a document can never be filed under a name it does not match. A document that arrives
 * and does not parse is HELD, not discarded: `meta_at` says we have the bytes and `meta_error` says they did not
 * parse, and collapsing those two into one field is how a capture becomes indistinguishable from a failure.
 */
import { createHash } from "node:crypto";
import { openDb } from "./db.ts";
import { fetchMetaResult, type MetaResult } from "./tracker.ts";

const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const BATCH = Number(arg("batch", "60"));
const CONCURRENCY = Number(arg("concurrency", "8"));
const DAEMON = process.argv.includes("--daemon");
/** A document that failed once may be a gateway having a bad minute. A day later is a different question. */
const RETRY_AFTER_MS = Number(arg("retry-hours", "24")) * 3600_000;

const DB = process.env.CHAINMINTS_DB
  ?? (process.env.DB_PATH ? process.env.DB_PATH.replace(/[^/]+$/, "chainmints.db") : "data/chainmints.db");
const db = openDb(DB, { migrate: false });

/**
 * Columns added here rather than in `chainmints.ts` so the scanner keeps writing if this has never run, and so a
 * database built by an older scanner widens on first use instead of failing. Absent is not empty: a NULL `meta_at`
 * means we have not held the bytes, which is different from holding bytes that did not parse.
 */
for (const ddl of [
  "ALTER TABLE chain_mints ADD COLUMN meta_json TEXT",
  "ALTER TABLE chain_mints ADD COLUMN meta_bytes INTEGER",
  "ALTER TABLE chain_mints ADD COLUMN meta_sha256 TEXT",
  "ALTER TABLE chain_mints ADD COLUMN meta_at INTEGER",
  "ALTER TABLE chain_mints ADD COLUMN meta_error TEXT",
  "ALTER TABLE chain_mints ADD COLUMN meta_tried_at INTEGER",
]) { try { db.exec(ddl); } catch { /* already widened */ } }
db.exec("CREATE INDEX IF NOT EXISTS chain_mints_meta_todo ON chain_mints(meta_at, uri)");

/**
 * Newest first, on purpose and against the usual instinct to clear the backlog. A document published an hour ago is
 * far more likely to still be served than one from last week, and every hour a fetch is deferred is a chance the
 * host deletes it. The backlog is the part already most likely lost; the front of the queue is the part still
 * savable.
 */
const pending = db.prepare(`SELECT mint, uri FROM chain_mints
  WHERE meta_at IS NULL AND uri IS NOT NULL AND length(uri) > 0
    AND (meta_tried_at IS NULL OR meta_tried_at < ?)
  ORDER BY slot DESC LIMIT ?`);

const held = db.prepare(`UPDATE chain_mints SET
  meta_json = ?, meta_bytes = ?, meta_sha256 = ?, meta_at = ?, meta_error = ?, meta_tried_at = ?
  WHERE mint = ?`);
const missed = db.prepare("UPDATE chain_mints SET meta_error = ?, meta_tried_at = ? WHERE mint = ?");

async function pass(): Promise<{ got: number; failed: number; bytes: number }> {
  const rows = pending.all(Date.now() - RETRY_AFTER_MS, BATCH) as unknown as { mint: string; uri: string }[];
  if (!rows.length) return { got: 0, failed: 0, bytes: 0 };

  // Fetched with no transaction open. This database has a writer beside it and its obligation is not to block one.
  const results: { mint: string; r: MetaResult }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let i = next++; i < rows.length; i = next++) {
      let out: MetaResult;
      try { out = await fetchMetaResult(rows[i].uri); }
      catch (e) { out = { meta: null, via: "none", error: `threw: ${(e as Error).message}` }; }
      results.push({ mint: rows[i].mint, r: out });
    }
  }));

  const now = Date.now();
  let got = 0, failed = 0, bytes = 0;
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    for (const { mint, r } of results) {
      if (r.meta?.raw) {
        // Hashed from the bytes that arrived, never from a column. Nothing is filed under a name it does not match.
        const sha = createHash("sha256").update(Buffer.from(r.meta.raw)).digest("hex");
        held.run(r.meta.raw, r.meta.bytes ?? Buffer.byteLength(r.meta.raw), sha, now, r.error ?? null, now, mint);
        got++; bytes += r.meta.bytes ?? 0;
      } else {
        // The cause, not the word "unreachable": a gateway refusing us and a pin that is gone are different facts,
        // and only one of them is worth retrying. meta_at stays NULL because we hold nothing.
        missed.run(r.error ?? "unreachable", now, mint);
        failed++;
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { got, failed, bytes };
}

(async () => {
  console.log(`[chainmeta] ${DB}${DAEMON ? ", daemon" : ""}`);
  do {
    const t0 = Date.now();
    const { got, failed, bytes } = await pass();
    const s = db.prepare(`SELECT
        SUM(uri IS NOT NULL) with_uri, SUM(meta_at IS NOT NULL) held,
        SUM(uri IS NOT NULL AND meta_at IS NULL) todo
      FROM chain_mints WHERE looks_like_launch = 1`).get() as any;
    if (got || failed) {
      console.log(`[chainmeta] +${got} documents (${(bytes / 1024).toFixed(0)} KB), ${failed} unreachable, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s; of launches: ${Number(s.with_uri ?? 0).toLocaleString()} have a uri, ` +
        `${Number(s.held ?? 0).toLocaleString()} documents held, ${Number(s.todo ?? 0).toLocaleString()} still to fetch`);
    } else if (DAEMON) {
      // Nothing to do is worth saying once a cycle: a fetcher that is up and idle looks exactly like one that is up
      // and broken, which is the failure this project has now found five times.
      console.log(`[chainmeta] nothing pending (${Number(s.held ?? 0).toLocaleString()} held, ` +
        `${Number(s.todo ?? 0).toLocaleString()} awaiting retry)`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  } while (DAEMON);
})();
