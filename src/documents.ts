/**
 * Publish the launch metadata documents themselves, not just their hashes.
 *
 * WHY THIS EXISTS. `record.db` carries `meta_sha256` for every launch whose document we hold, and nothing else about
 * it. A reader can therefore VERIFY a document they already have and cannot OBTAIN one they do not - which, for the
 * one artefact in this archive that cannot be rebuilt from chain at any price, is the difference between being the
 * copy and merely attesting to it. As of 2026-09-10 that is about 126,000 documents, several thousand of which exist
 * in no other copy on earth: `metadata.j7tracker.io` hosted 30,443 launches and now answers 404 for every one.
 *
 * `servicedb.ts` states the reason they were withheld and asks for it to be decided deliberately rather than by an
 * ALTER. The reason was arithmetic - "about a kilobyte a launch", "~24 MB a day", against the property that one
 * person can mirror the whole archive. Measured now that the collector actually holds a corpus, rather than
 * estimated when it held none:
 *
 *   126,245 documents held, of which 91,917 are distinct   27% are duplicates of another launch's
 *   301 bytes mean, 3,066 bytes largest                    not a kilobyte
 *   ~40 MB as NDJSON, ~14 MB gzipped                       the whole corpus, not a day of it
 *   ~2.1 MB/day gzipped at the current launch rate         ~770 MB/year
 *
 * So the concern was real and the number was 3.3x too high. It is answered here by keeping this OUT of `record.db`
 * entirely - that file's size and mirrorability are untouched - and shipping the documents as a separate, optional
 * bundle that a reader takes only if they want the bytes.
 *
 * DEDUPLICATED BY CONTENT, which is not only a size decision. 249 launches sharing one document is a factory, and
 * the `launches` count on each row is that evidence stated plainly rather than left implicit in 249 copies.
 *
 * EVERY DOCUMENT IS FILED UNDER THE HASH OF ITS OWN BYTES, computed here rather than read from a column, so nothing
 * can be published under a name it does not match. Where the record's precomputed `meta_sha256` disagreed with the
 * bytes, that is counted in the manifest - a fact about our bookkeeping, visible rather than silently reconciled.
 *
 * REPRODUCIBLE. Rows are sorted by hash, so the same corpus produces the same bytes and two mirrors can compare.
 * The manifest's `sha256` is of the UNCOMPRESSED NDJSON, because gzip framing carries metadata that need not be
 * stable for the content to be identical.
 *
 *   npm run documents                      → data/documents.ndjson.gz + data/documents.json
 *   npm run documents -- --out /data/documents.ndjson.gz
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { writeFileSync, renameSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "data/documents.ndjson.gz");
const MANIFEST = OUT.replace(/\.ndjson\.gz$/, ".json");

/** Read-only: this runs beside a collector whose only real obligation is not to drop a launch. */
const db = new DatabaseSync(config.dbPath, { readOnly: true });

/**
 * Grouped by the hash OF THE BYTES, computed here, not by the stored `meta_sha256`.
 *
 * That column is written by the record build and not by capture, so on the collector it is populated for some rows
 * and not others - 85,472 of 106,170 when this was written. Grouping on it, or requiring it non-null, would have
 * silently dropped 20,698 documents from the bundle: a fifth of the corpus, absent with no error and no count,
 * including documents whose source host has already deleted them. The bytes are the primary; the hash is a function
 * of them and is derived, never depended on.
 *
 * Where the stored hash exists and disagrees with the bytes, that is recorded rather than resolved silently.
 */
const raw = db.prepare(`
  SELECT meta_json AS doc, meta_sha256 AS stored, created_at
    FROM tokens
   WHERE meta_json IS NOT NULL AND meta_json != ''`).all() as unknown as
  { doc: string; stored: string | null; created_at: number }[];

type Group = { sha: string; doc: string; launches: number; first_seen: number; last_seen: number };
const groups = new Map<string, Group>();
let storedHashDisagreed = 0;
for (const r of raw) {
  const sha = createHash("sha256").update(Buffer.from(r.doc)).digest("hex");
  if (r.stored && r.stored !== sha) storedHashDisagreed++;
  const g = groups.get(sha);
  if (g) {
    g.launches++;
    if (r.created_at < g.first_seen) g.first_seen = r.created_at;
    if (r.created_at > g.last_seen) g.last_seen = r.created_at;
  } else groups.set(sha, { sha, doc: r.doc, launches: 1, first_seen: r.created_at, last_seen: r.created_at });
}
/** Sorted by hash so the same corpus produces the same bytes and two mirrors can compare. */
const rows = [...groups.values()].sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));

/**
 * Launches whose document we RECORD holding, against documents we can actually hand over. The two differ: rows
 * captured before `meta_json` existed, and documents larger than the cap, are marked held with no bytes kept. Saying
 * so is the point - a manifest that reported only the second number would overstate what the bundle answers for.
 */
const heldLaunches = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE meta_at IS NOT NULL`).get() as any).c as number;
const withBytes = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE meta_json IS NOT NULL AND meta_json != ''`).get() as any).c as number;

const lines: string[] = [];
let covered = 0;
for (const r of rows) {
  covered += r.launches;
  lines.push(JSON.stringify({
    sha256: r.sha,
    bytes: Buffer.byteLength(r.doc),
    /** How many launches declared this exact document. Greater than one is reuse, and reuse is evidence. */
    launches: r.launches,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    /** The document as served, verbatim. A string, not a parsed object: the bytes are what the hash commits to. */
    doc: r.doc,
  }));
}

const ndjson = Buffer.from(lines.join("\n") + (lines.length ? "\n" : ""));
const sha256 = createHash("sha256").update(ndjson).digest("hex");
const gz = gzipSync(ndjson, { level: 9 });

writeFileSync(`${OUT}.tmp`, gz);
renameSync(`${OUT}.tmp`, OUT);

const manifest = {
  builtAt: Date.now(),
  documents: lines.length,
  /** Launches answered by those documents - larger than `documents`, because launches reuse each other's. */
  launchesCovered: covered,
  /** Launches recorded as holding a document, whether or not its bytes are in this bundle. */
  launchesWithDocumentRecorded: heldLaunches,
  launchesWithBytesHeld: withBytes,
  /**
   * Rows whose stored meta_sha256 disagreed with their own bytes. The bundle files every document under the hash of
   * what it actually contains, so nothing here is published under a name it does not match; this counts how often
   * the record's precomputed column was wrong about a document, which is a fact about our bookkeeping worth seeing.
   */
  storedHashDisagreed,
  ndjsonBytes: ndjson.length,
  gzipBytes: gz.length,
  /** Of the uncompressed NDJSON. Two mirrors comparing this are comparing content, not gzip framing. */
  sha256,
  license: "CC0-1.0",
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

console.log(`${lines.length.toLocaleString()} distinct documents covering ${covered.toLocaleString()} launches`);
console.log(`  ${(ndjson.length / 1e6).toFixed(1)} MB NDJSON → ${(gz.length / 1e6).toFixed(1)} MB gzipped (${(ndjson.length / gz.length).toFixed(1)}x)`);
console.log(`  sha256 ${sha256}`);
if (storedHashDisagreed) console.log(`  ${storedHashDisagreed} rows had a stored meta_sha256 that disagreed with their own bytes`);
if (heldLaunches > withBytes)
  console.log(`  note: ${(heldLaunches - withBytes).toLocaleString()} launches are recorded as holding a document whose bytes we did not keep`);
console.log(`wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB) and ${MANIFEST}`);
