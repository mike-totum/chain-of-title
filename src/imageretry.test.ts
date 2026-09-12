/**
 * A failed picture fetch is not a verdict on the picture.
 *
 * `images.ts` used to pick rows with `image_error IS NULL`, so the first failure of any kind retired a launch's
 * image permanently. Measured on the collector, that retired 23,833 launches on a TRANSIENT error against 840 on a
 * real 404 or 410, and the four largest reasons were all a gateway answering "cooling down" - rate limiting, which
 * is a fact about how fast we asked and not about whether the pin is still there. Roughly 96% of the abandoned
 * pictures were abandoned because we asked too quickly.
 *
 * That is the exact inverse of the metadata sweep's fault fixed in de4585a, and it is the worse direction of the
 * two. That one spent its budget re-requesting documents that had already gone. This one stopped asking for
 * pictures that were still there, and a pin is retrievable once: we do not get told when it lapses, so a pin we
 * stopped asking for before it went is not delayed, it is lost.
 *
 * The tests hold the OLD predicate beside the new one rather than only asserting the new one, because the point is
 * not that the new rule works - it is what the old rule cost, and a number nobody can see again is a number nobody
 * checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { notDefinitiveSql } from "./ipfs.ts";

const HOUR = 3_600_000;
const NOW = 1_789_000_000_000;
const RETRY_BEFORE = NOW - 6 * HOUR;

/** The eligibility rule images.ts now applies, built from the same shared fragment the shipped code uses. */
const ELIGIBLE = `image_sha256 IS NULL
  AND (image_error IS NULL OR (${notDefinitiveSql("image_error")} AND COALESCE(image_at, 0) < ?))`;
/** What it replaced. Kept so the starvation can be demonstrated rather than asserted. */
const OLD_ELIGIBLE = `image_sha256 IS NULL AND image_error IS NULL`;

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tokens (mint TEXT PRIMARY KEY, image TEXT, image_sha256 TEXT, image_error TEXT, image_at INTEGER)`);
  const ins = db.prepare(`INSERT INTO tokens (mint, image, image_sha256, image_error, image_at) VALUES (?,?,?,?,?)`);
  // The four largest real reasons, one definitive failure, one success, one never tried.
  ins.run("cooling_pinata", "ipfs://a", null, "https://gateway.pinata.cloud/ipfs/ cooling down", NOW - 48 * HOUR);
  ins.run("cooling_ipfsio", "ipfs://b", null, "https://ipfs.io/ipfs/ cooling down", NOW - 48 * HOUR);
  ins.run("timeout", "ipfs://c", null, "timeout", NOW - 48 * HOUR);
  ins.run("http403", "ipfs://d", null, "http 403", NOW - 48 * HOUR);
  ins.run("gone_404", "ipfs://e", null, "http 404", NOW - 48 * HOUR);
  ins.run("gone_410", "ipfs://f", null, "http 410", NOW - 48 * HOUR);
  ins.run("recent_fail", "ipfs://g", null, "timeout", NOW - 1 * HOUR); // inside the clock, not yet due
  ins.run("never_tried", "ipfs://h", null, null, null);
  ins.run("already_held", "ipfs://i", "abc123", null, NOW - 48 * HOUR);
  return db;
}

const pick = (db: DatabaseSync, where: string, bind: unknown[]) =>
  (db.prepare(`SELECT mint FROM tokens WHERE image IS NOT NULL AND image != '' AND ${where} ORDER BY mint`)
    .all(...bind as any) as { mint: string }[]).map((r) => r.mint);

test("a gateway cooling down is retried; a 404 is not", () => {
  const got = pick(fixture(), ELIGIBLE, [RETRY_BEFORE]);
  assert.deepEqual(got, ["cooling_ipfsio", "cooling_pinata", "http403", "never_tried", "timeout"],
    `Eligible set was ${JSON.stringify(got)}.
     "cooling down", "timeout" and "http 403" are all statements about the gateway or about our request rate, and
     the pin behind them is very likely still there. A 404 or 410 is a statement about the object.`);
});

test("a picture we already hold is never re-fetched", () => {
  assert.equal(pick(fixture(), ELIGIBLE, [RETRY_BEFORE]).includes("already_held"), false);
});

test("a transient failure waits out the clock before it is asked again", () => {
  // recent_fail failed an hour ago against a six hour clock: due later, not now.
  assert.equal(pick(fixture(), ELIGIBLE, [RETRY_BEFORE]).includes("recent_fail"), false);
  const later = NOW + 24 * HOUR - 6 * HOUR;
  assert.equal(pick(fixture(), ELIGIBLE, [later]).includes("recent_fail"), true);
});

test("THE LOSS THIS FIXES: the old rule retired every transient failure permanently", () => {
  const db = fixture();
  const old = pick(db, OLD_ELIGIBLE, []);
  const now = pick(db, ELIGIBLE, [RETRY_BEFORE]);

  // The old predicate could only ever return rows that had never been tried at all.
  assert.deepEqual(old, ["never_tried"]);
  // Four recoverable pictures were invisible to it, and stayed invisible on every subsequent pass, forever.
  for (const m of ["cooling_pinata", "cooling_ipfsio", "timeout", "http403"]) {
    assert.equal(old.includes(m), false, `${m} should have been unreachable under the old rule`);
    assert.equal(now.includes(m), true, `${m} must be reachable now`);
  }
  // And the fix must not have bought that by re-requesting the genuinely dead.
  for (const m of ["gone_404", "gone_410"]) assert.equal(now.includes(m), false, `${m} is gone; do not ask again`);
});

test("images.ts asks the shared classifier rather than keeping its own copy", () => {
  const src = readFileSync("src/images.ts", "utf8");
  assert.ok(src.includes("notDefinitiveSql"),
    "images.ts must import the shared definitive-failure test from ipfs.ts, where fetchContent WRITES these strings.");
  assert.ok(!/image_sha256 IS NULL AND image_error IS NULL/.test(src),
    `images.ts still contains the old blanket predicate \`image_sha256 IS NULL AND image_error IS NULL\`.
     If a second picker grew up beside the fixed one it will silently retire recoverable pictures again.`);
});
