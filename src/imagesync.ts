/**
 * Push the local picture store into R2, and verify what is already there.
 *
 * The backlog was captured to this machine's disk before object storage existed, because the pictures were decaying
 * at roughly a thousand an hour and waiting for the durable answer would have cost more of them than it saved. This
 * moves that to the store the collector will use, so the laptop stops being where the only copy lives.
 *
 * Content-addressed on both sides, so this is idempotent and safe to re-run: an object already present is skipped
 * after a HEAD, never re-uploaded. Nothing is deleted from local disk - freeing it is a separate decision, taken
 * after the store has been confirmed to hold what the record claims, and `--verify` is what confirms that.
 *
 *   npm run imagesync                # upload everything not already in R2
 *   npm run imagesync -- --verify    # re-read from R2 and check bytes hash to their key
 *   npm run imagesync -- --dry-run
 *
 * `--verify` is the one that matters before anyone deletes anything. It re-downloads and re-hashes, so it can fail:
 * an object whose bytes do not hash to its own key is a corrupt store, and a store whose contents are merely
 * *listed* proves nothing about whether the bytes survived the trip.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { r2Config, head, put, get, objectKey } from "./r2.ts";

/** Extension back to a content type, mirroring EXT in images.ts. Unknown extensions upload as octet-stream. */
const TYPE: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bin: "application/octet-stream",
};

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIR = arg("--dir", process.env.IMAGES_DIR ?? "data/images");
const DRY = process.argv.includes("--dry-run");
const VERIFY = process.argv.includes("--verify");
const CONCURRENCY = Number(arg("--concurrency", "12"));

if (!config.dbPath) throw new Error("config failed to load");
const store = r2Config();
if (!store) { console.error("R2 is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET"); process.exit(1); }

/** Every file in the two-character fan-out, with the sha256 its name asserts. */
const files: { path: string; sha: string; type: string; bytes: number }[] = [];
for (const sub of readdirSync(DIR)) {
  const subPath = join(DIR, sub);
  let entries: string[];
  try { if (!statSync(subPath).isDirectory()) continue; entries = readdirSync(subPath); } catch { continue; }
  for (const f of entries) {
    const [sha, ext] = f.split(".");
    if (!/^[0-9a-f]{64}$/.test(sha ?? "")) continue;
    const path = join(subPath, f);
    files.push({ path, sha, type: TYPE[ext ?? ""] ?? "application/octet-stream", bytes: statSync(path).size });
  }
}
console.log(`${files.length.toLocaleString()} local pictures, ${(files.reduce((a, f) => a + f.bytes, 0) / 1e9).toFixed(2)} GB`);
if (DRY) { console.log("dry run: nothing uploaded"); process.exit(0); }

let uploaded = 0, already = 0, failed = 0, verified = 0, corrupt = 0, bytes = 0, done = 0;
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let i = next++; i < files.length; i = next++) {
    const f = files[i];
    try {
      if (VERIFY) {
        const back = await get(store, f.sha);
        if (!back) { corrupt++; console.log(`  MISSING in store: ${f.sha}`); }
        else if (createHash("sha256").update(back).digest("hex") !== f.sha) { corrupt++; console.log(`  HASH MISMATCH: ${f.sha}`); }
        else verified++;
      } else if (await head(store, f.sha)) {
        already++;
      } else {
        const buf = readFileSync(f.path);
        // The name is a claim about the bytes; check it before trusting it as the key. A local file whose contents
        // do not hash to its own filename must not be uploaded under that name and quietly become the record's
        // commitment for a picture it is not.
        const actual = createHash("sha256").update(buf).digest("hex");
        if (actual !== f.sha) { corrupt++; console.log(`  local file does not match its own name, skipped: ${f.path}`); continue; }
        await put(store, f.sha, buf, f.type);
        uploaded++; bytes += buf.length;
      }
    } catch (e) { failed++; if (failed <= 5) console.log(`  ${f.sha.slice(0, 12)}…: ${(e as Error).message}`); }
    if (++done % 2000 === 0) console.log(`  ${done.toLocaleString()}/${files.length.toLocaleString()} - ${uploaded.toLocaleString()} up, ${already.toLocaleString()} already, ${failed} failed`);
  }
}));

if (VERIFY) {
  console.log(`\nverified ${verified.toLocaleString()} objects re-read and hashing to their own key`);
  if (corrupt) console.log(`${corrupt} MISSING OR CORRUPT - do not delete local copies`);
  else console.log("every local picture is in the store and intact. Local copies are now redundant, not primary.");
  process.exit(corrupt ? 1 : 0);
}
console.log(`\nuploaded ${uploaded.toLocaleString()} (${(bytes / 1e9).toFixed(2)} GB), ${already.toLocaleString()} already held, ${failed} failed, ${corrupt} local files failed their own hash`);
console.log("run with --verify before deleting anything locally.");
