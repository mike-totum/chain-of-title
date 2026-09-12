/**
 * That the metadata sweep stops re-asking for documents the host has told us are gone.
 *
 * WHAT THIS IS ABOUT. `sweepMissingMeta` picks rows from both ends of the backlog, and the oldest end orders by
 * `created_at ASC`. Measured 2026-09-12 against the published record: 49,232 launches have a URI and no document,
 * 23,940 of them sort before 2026-09-08, and **20,075 of those are `metadata.j7tracker.io`** - a host that deletes
 * a launch's metadata about 48-72 hours after launch and then answers 404 forever. Random sample, 25 per day: 0 of
 * 75 survived at 3-5 days old, 7 of 25 at 2 days, 50 of 50 at 0-1 days.
 *
 * Because a 404 and a timeout were both just "an error" on one six-hour clock, every cycle re-requested those
 * 20,075 dead documents BEFORE reaching 2026-09-08, which holds 23,614 missing documents that a 300-row sample
 * says are ~91% still served. The arm of this project with a real deadline was spending its budget on the part
 * that had already expired.
 *
 * WHY THE TEST RUNS THE REAL SQL. `index.ts` cannot be imported - it is the collector and importing it starts one.
 * A test that re-typed the predicate here would be a copy that keeps passing while the sweep is changed, which is
 * the failure this repo keeps producing. So the SQL fragment lives in `ipfs.ts` beside the code that WRITES these
 * error strings, both files use it, and this runs it against a real database with rows built to sit either side of
 * every boundary. Each half is watched failing separately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { isDefinitiveError, notDefinitiveSql } from "./ipfs.ts";

const HOUR = 3600_000;
const SIX_HOURS = 6 * HOUR;
const SEVEN_DAYS = 168 * HOUR;

/** The sweep's own picker, with the two clocks the collector passes it. */
const pickSql = (order: "ASC" | "DESC") => `SELECT mint FROM tokens
  WHERE meta_at IS NULL AND uri IS NOT NULL AND uri != ''
    AND (meta_error IS NULL
         OR (updated_at < ? AND ${notDefinitiveSql("meta_error")})
         OR updated_at < ?)
  ORDER BY created_at ${order} LIMIT ?`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "metaretry-"));
  const db = openDb(join(dir, "c.db"));
  const now = Date.now();
  const add = (mint: string, err: string | null, agoMs: number, createdAgo: number) =>
    db.prepare("INSERT INTO tokens (mint, uri, created_at, meta_error, updated_at, venue) VALUES (?,?,?,?,?,'pumpfun')")
      .run(mint, `https://example.test/${mint}.json`, now - createdAgo, err, now - agoMs);
  return { dir, db, now, add, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const pick = (f: ReturnType<typeof fixture>, order: "ASC" | "DESC" = "ASC", n = 50) =>
  (f.db.prepare(pickSql(order)).all(f.now - SIX_HOURS, f.now - SEVEN_DAYS, n) as { mint: string }[]).map((r) => r.mint);

test("a host's 404 is not retried on the six-hour clock; our own timeout still is", () => {
  const f = fixture();
  try {
    f.add("dead404", "http 404", 7 * HOUR, 5 * 24 * HOUR);
    f.add("deadGw", "https://ipfs.filebase.io/ipfs/ http 404", 7 * HOUR, 5 * 24 * HOUR);
    f.add("gone410", "http 410", 7 * HOUR, 5 * 24 * HOUR);
    f.add("notHttp", "not a fetchable uri", 7 * HOUR, 5 * 24 * HOUR);
    f.add("timeout", "https://ipfs.filebase.io/ipfs/ timeout", 7 * HOUR, 5 * 24 * HOUR);
    f.add("refused", "https://gateway.pinata.cloud/ipfs/ 429", 7 * HOUR, 5 * 24 * HOUR);
    f.add("cooling", "https://4everland.io/ipfs/ cooling down", 7 * HOUR, 5 * 24 * HOUR);
    f.add("neverTried", null, 0, 5 * 24 * HOUR);

    const got = pick(f).sort();
    assert.deepEqual(got, ["cooling", "neverTried", "refused", "timeout"],
      "a definitive 404/410 must not come back at six hours, and a refusal or timeout must");
  } finally { f.close(); }
});

test("a definitive failure DOES come back after seven days - never is a decision that becomes permanent", () => {
  const f = fixture();
  try {
    f.add("recent404", "http 404", 2 * 24 * HOUR, 9 * 24 * HOUR);
    f.add("old404", "http 404", 8 * 24 * HOUR, 9 * 24 * HOUR);
    const got = pick(f).sort();
    assert.deepEqual(got, ["old404"],
      "a pin can be restored and a host can change its mind; the long clock is what keeps that reachable");
  } finally { f.close(); }
});

test("THE STARVATION THIS FIXES: dead rows sorting first no longer crowd out recoverable ones", () => {
  const f = fixture();
  try {
    /**
     * The shape of the real backlog in miniature, and the reason this is about ORDERING rather than waste.
     * The dead rows are OLDER, so `created_at ASC` reaches them first; with one clock they filled the batch every
     * cycle and the recoverable day behind them was never asked for at all.
     */
    for (let i = 0; i < 40; i++) f.add(`j7-${i}`, "http 404", 7 * HOUR, 10 * 24 * HOUR);
    for (let i = 0; i < 10; i++) f.add(`sep8-${i}`, "https://ipfs.io/ipfs/ 429", 7 * HOUR, 4 * 24 * HOUR);

    const batch = pick(f, "ASC", 20);
    assert.equal(batch.length, 10, "only the recoverable rows should remain eligible");
    assert.ok(batch.every((m) => m.startsWith("sep8-")),
      `the dead host still filled the batch: ${batch.slice(0, 5).join(", ")}`);

    /**
     * And watch the old behaviour fail, in the same database, so the claim is demonstrated rather than asserted:
     * with a single clock the same batch is entirely the documents that cannot come back.
     */
    const oneClock = f.db.prepare(`SELECT mint FROM tokens
      WHERE meta_at IS NULL AND uri IS NOT NULL AND uri != ''
        AND (meta_error IS NULL OR updated_at < ?)
      ORDER BY created_at ASC LIMIT 20`).all(f.now - SIX_HOURS) as { mint: string }[];
    assert.ok(oneClock.every((r) => r.mint.startsWith("j7-")),
      "the old predicate is supposed to fail here - if it does not, this test is not measuring what it claims");
  } finally { f.close(); }
});

test("isDefinitiveError agrees with the SQL, on the strings fetchContent actually writes", () => {
  for (const e of ["http 404", "http 410", "https://ipfs.filebase.io/ipfs/ http 404", "not a fetchable uri"])
    assert.equal(isDefinitiveError(e), true, `${e} should be definitive`);
  for (const e of ["https://ipfs.io/ipfs/ 429", "timeout", "https://4everland.io/ipfs/ cooling down",
                   "read failed: socket hang up", "http 403", "http 500", "unreachable", null])
    assert.equal(isDefinitiveError(e as any), false, `${e} should be transient`);
  /**
   * `http 4040` must not read as a 404. The word-boundary is the whole reason this is a regex and not an
   * `includes`, and a substring match here would retire a live document on a status code that does not exist.
   */
  assert.equal(isDefinitiveError("http 4040"), false);
});

test("the collector uses the shared fragment rather than its own copy of the predicate", () => {
  /**
   * `index.ts` cannot be imported, so this reads it. The thing that would silently undo all of the above is
   * somebody re-typing the LIKE clauses inline; then `ipfs.ts` could change and the sweep would not.
   */
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /notDefinitiveSql\(/, "the sweep must build its predicate from ipfs.ts");
  assert.ok(!/meta_error NOT LIKE/.test(src),
    "index.ts has its own copy of the definitive-error test; it will drift from the strings ipfs.ts writes");
  assert.match(src, /META_DEFINITIVE_RETRY_MS/, "the second clock must still be passed to the picker");
});
