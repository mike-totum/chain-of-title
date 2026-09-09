/**
 * Fetch and keep the launch image, before the pin is dropped.
 *
 *   npm run images -- [--limit 500] [--all] [--concurrency 6]
 *
 * The collector records the image *URL* a launch declared. That preserves the option to hold the picture and nothing
 * more: the URL points at IPFS through a gateway, and the moment the operator unpins it, or the gateway stops serving
 * it, the only evidence of what a token presented itself as is gone. Every other fact this project publishes can be
 * rebuilt from chain by anyone with archival RPC. This one cannot be rebuilt at any price, and it decays while nobody
 * is looking.
 *
 * So this is deliberately a separate job rather than something the collector does inline. The collector's one
 * obligation is unbroken coverage, and a run of slow IPFS gateways must never be able to stall the thing that watches
 * launches. It is resumable, idempotent, and safe to kill at any point.
 *
 * **Bytes do not go in `record.db`.** The published record is 334 bytes per launch, which is what makes it a file
 * anyone can mirror and a DOI deposit that stays small enough to be replicated. Images average a few hundred KB, so
 * carrying them would inflate the archive by four orders of magnitude and destroy the property that makes it useful.
 * The record carries the **sha256** instead: that is enough to prove any copy of an image is the one we saw, and it
 * lets the pictures travel as their own artifact for whoever wants them.
 *
 * Default scope is launches that completed their bonding curve. Those are the ones anyone looks up, and it bounds the
 * job to roughly 1,400 a day rather than 24,000. `--all` widens it; the storage arithmetic is yours to accept.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { r2Config, head, put } from "./r2.ts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { fetchContent } from "./ipfs.ts";

/** Bigger than this is not a token icon, and we are not a CDN. Skipped and recorded as skipped, never retried blindly. */
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif",
};

export type CaptureStats = { attempted: number; kept: number; skipped: number; failed: number; bytes: number; reused: number };

/**
 * Capture the pending launch images into `dir`, recording the sha256 on each row.
 *
 * Takes an open database rather than opening its own, because the collector now calls this in-process on a timer.
 * That is a change from the original design note above, and the reason is the one this whole file is about: as a
 * separate laptop job it stopped the moment the lid closed, and this is the only thing the project collects that
 * cannot be rebuilt from chain afterwards. A second PROCESS writing the collector's database is what must not
 * happen — a multi-second write transaction against a 10 s busy_timeout costs dropped launches — but sharing the
 * collector's own handle has no contention to lose: the writes below are single-row UPDATEs, serialised with
 * ingestion by the same connection, and everything slow here is awaited network I/O that blocks nothing.
 *
 * Still bounded on purpose: `limit` rows per call and `concurrency` in flight, so a run of dead gateways costs a
 * bounded number of open sockets and never a stalled collector.
 */
export async function captureImages(
  db: DatabaseSync,
  opts: { dir: string; limit: number; concurrency: number; all?: boolean; log?: (s: string) => void } =
    { dir: "data/images", limit: 500, concurrency: 6 },
): Promise<CaptureStats> {
  const log = opts.log ?? ((s: string) => console.log(s));
  for (const c of ["image_sha256 TEXT", "image_bytes INTEGER", "image_at INTEGER", "image_error TEXT"])
    try { db.exec(`ALTER TABLE tokens ADD COLUMN ${c}`); } catch {}

  /**
   * A gateway URL is a way of reaching the bytes, not the bytes. Normalising to a gateway we can actually reach
   * matters less than recording what we tried, so the URL is used as declared and any failure is written down rather
   * than retried forever: `image_error` is how a permanently dead pin stops costing a request on every run.
   */
  const pending = db.prepare(`
    SELECT mint, image FROM tokens
     WHERE image IS NOT NULL AND image != ''
       AND image_sha256 IS NULL AND image_error IS NULL
       ${opts.all ? "" : "AND graduated = 1"}
     ORDER BY created_at DESC LIMIT ?`).all(opts.limit) as { mint: string; image: string }[];

  const st: CaptureStats = { attempted: pending.length, kept: 0, skipped: 0, failed: 0, bytes: 0, reused: 0 };
  if (pending.length === 0) return st;
  // Resolved once. A half-configured store must not look enabled, so r2Config returns null unless all four are set.
  const store = r2Config();

  const done = db.prepare("UPDATE tokens SET image_sha256=?, image_bytes=?, image_at=? WHERE mint=?");
  const failed = db.prepare("UPDATE tokens SET image_error=?, image_at=? WHERE mint=?");

  const one = async (mint: string, url: string): Promise<void> => {
    try {
      // Through the gateway rotation, not the declared host: every launch declares ipfs.io and ipfs.io refuses us.
      // The CID is the address; the hostname is only a way of reaching it, so the same bytes come from whoever answers.
      const { res, error } = await fetchContent(url, TIMEOUT_MS);
      if (!res) { failed.run(error ?? "unreachable", Date.now(), mint); st.failed++; return; }
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) { failed.run(`too large: ${len}`, Date.now(), mint); st.skipped++; return; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) { failed.run("empty body", Date.now(), mint); st.failed++; return; }
      if (buf.length > MAX_BYTES) { failed.run(`too large: ${buf.length}`, Date.now(), mint); st.skipped++; return; }

      const sha = createHash("sha256").update(buf).digest("hex");
      const ext = EXT[type] ?? "bin";
      /**
       * Where the bytes go, and why the record does not care.
       *
       * With R2 configured the picture store is object storage and the collector volume stays flat — which is the
       * only way "keep every launch's picture" and "never fill the disk" are both true at ~1 GB/day against 20 GB.
       * Without it, local disk, unchanged. Either way the row records the same sha256, so the published record is
       * identical and a reader verifying a picture never learns, or needs to learn, where we happened to put it.
       *
       * Content-addressed in both, so the 47% of launches reusing another launch's image cost one HEAD and no
       * transfer. A store that already holds the bytes is the dedup check; there is no second index to drift.
       */
      if (store) {
        if (await head(store, sha).catch(() => false)) st.reused++;
        else await put(store, sha, buf, type || "application/octet-stream");
      } else {
        const sub = join(opts.dir, sha.slice(0, 2));
        const path = join(sub, `${sha}.${ext}`);
        if (existsSync(path)) st.reused++;
        else { mkdirSync(sub, { recursive: true }); writeFileSync(path, buf); }
      }
      done.run(sha, buf.length, Date.now(), mint);
      st.kept++; st.bytes += buf.length;
    } catch (e: any) {
      // Recorded, not swallowed. A row with image_error and no sha is "we tried and could not", which is a different
      // statement from "no image", and neither is "the launch had none".
      failed.run(String(e?.name === "TimeoutError" ? "timeout" : e?.message ?? e).slice(0, 120), Date.now(), mint);
      st.failed++;
    }
  };

  mkdirSync(opts.dir, { recursive: true });
  log(`fetching ${pending.length} launch image${pending.length === 1 ? "" : "s"}${opts.all ? " (all launches)" : " (graduated only)"}` +
    ` → ${store ? `r2://${store.bucket}` : opts.dir}…`);
  let cursor = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= pending.length) return;
      await one(pending[i].mint, pending[i].image);
    }
  }));
  return st;
}

// ---------- CLI ----------
// Only when run directly. Importing this module must not start fetching, now that the collector imports it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const DIR = arg("--dir", "data/images");
  const db = openDb(config.dbPath);
  const st = await captureImages(db, {
    dir: DIR,
    limit: Number(arg("--limit", "500")),
    concurrency: Number(arg("--concurrency", "6")),
    all: process.argv.includes("--all"),
  });
  if (st.attempted === 0) {
    console.log("nothing to fetch: every candidate launch already has its image or a recorded failure");
    process.exit(0);
  }
  const held = (db.prepare("SELECT COUNT(*) c FROM tokens WHERE image_sha256 IS NOT NULL").get() as any).c;
  const distinct = (db.prepare("SELECT COUNT(DISTINCT image_sha256) c FROM tokens WHERE image_sha256 IS NOT NULL").get() as any).c;
  console.log(`  kept ${st.kept}  (${(st.bytes / 1048576).toFixed(1)} MB this run, ${st.reused} already on disk)`);
  console.log(`  skipped ${st.skipped}, failed ${st.failed}`);
  console.log(`  archive now holds images for ${held.toLocaleString()} launches, ${distinct.toLocaleString()} distinct pictures`);
  console.log(`\nThe record database carries the sha256, never the bytes. Files live in ${DIR}/<first two hex>/<sha256>.<ext>.`);
}
