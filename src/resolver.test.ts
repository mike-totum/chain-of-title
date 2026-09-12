/**
 * The document resolver must never learn which venue a launch came from.
 *
 * `backfillmeta.ts` and `chainmeta.ts` are the two paths that turn a `uri` into held bytes. Both are venue-agnostic
 * today, and both are venue-agnostic for the same reason: nobody has written a venue predicate into their WHERE
 * clause. That is the most fragile way for anything to be correct. Someone adds `AND venue = 'pumpfun'` for a
 * plausible reason - backfilling one venue, rate-limiting another, a migration - and every launch on every other
 * venue silently stops being queued. It does not error. The rows simply sit with `meta_at IS NULL` forever.
 *
 * And the loss is permanent. Chain facts are re-readable from an archival node by anyone, for as long as the chain
 * exists. A launch document is served by a host the creator controls, and the hosts go away: `metadata.j7tracker.io`
 * served 30,443 of our launches and now answers 404 for every one of them. A document not fetched while the host is
 * up is not delayed, it is gone. That asymmetry is why this file exists and why the test is behavioural rather than
 * a comment asking people to be careful.
 *
 * coin-14's `metavenue.test.ts` guards the other end - that each venue's feed carries a `uri` INTO the row. This
 * guards that something then comes and collects it. A uri written by a feed and never read by a resolver produces
 * exactly the same empty archive as a uri that was never written.
 *
 * WHY IT READS THE SQL OUT OF THE SOURCE. Importing either module runs it: they open databases, read config and
 * start fetching. So the query text is lifted from the file and executed against an in-memory database holding two
 * venues' rows. That keeps the test honest in the way that matters - it fails when the SHIPPED query changes, not
 * when a copy of it in this file changes. A test that asserts against its own duplicate of the query proves only
 * that the duplicate is intact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/** Lift the `pending` query out of a module without executing the module. */
function pendingSql(file: string): string {
  const src = readFileSync(file, "utf8");
  const m = src.match(/const pending = db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(m, `${file} no longer declares \`const pending = db.prepare(\`…\`)\`.
    This test lifts the shipped query out of the source. If the declaration was renamed or restructured, update the
    matcher here - do NOT delete the test, because the thing it guards is still true.`);
  return m![1];
}

test("backfillmeta queues launches from every venue, not just pump.fun", () => {
  const sql = pendingSql("src/backfillmeta.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tokens (
    mint TEXT PRIMARY KEY, uri TEXT, meta_at INTEGER, meta_error TEXT,
    updated_at INTEGER, created_at INTEGER, venue TEXT NOT NULL DEFAULT 'pumpfun')`);
  // One launch per venue, both holding a uri nobody has resolved yet. Identical in every respect the resolver is
  // entitled to care about, different only in the column it must not consult.
  db.exec(`INSERT INTO tokens (mint, uri, created_at, venue) VALUES
    ('mint_pumpfun',   'https://example.test/a.json', 2000, 'pumpfun'),
    ('mint_launchlab', 'https://example.test/b.json', 1000, 'launchlab')`);

  const rows = db.prepare(sql).all(Date.now(), 100) as { mint: string }[];
  const got = rows.map((r) => r.mint).sort();

  assert.deepEqual(got, ["mint_launchlab", "mint_pumpfun"],
    `The resolver's pending query returned ${JSON.stringify(got)}.

     A venue is missing, which means its launches will never be queued for document capture and their documents
     will be lost permanently as their hosts go down. If you added a venue predicate deliberately, this test is the
     thing telling you what it costs - resolve one venue faster by ORDER BY, never by WHERE.`);
});

test("chainmeta queues chain-wide mints without consulting the program that made them", () => {
  const sql = pendingSql("src/chainmeta.ts");
  const db = new DatabaseSync(":memory:");
  // chain_mints has no `venue`; its equivalent is `program`, and `looks_like_launch` is a measured classifier that
  // is explicitly never used to exclude a row. Both are here so that filtering on either one fails this test.
  db.exec(`CREATE TABLE chain_mints (
    mint TEXT PRIMARY KEY, uri TEXT, meta_at INTEGER, meta_tried_at INTEGER,
    slot INTEGER, program TEXT, looks_like_launch INTEGER NOT NULL DEFAULT 1)`);
  db.exec(`INSERT INTO chain_mints (mint, uri, slot, program, looks_like_launch) VALUES
    ('mint_known',   'https://example.test/a.json', 2000, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 1),
    ('mint_unknown', 'https://example.test/b.json', 1000, 'SomeProgramWeHaveNeverSeen1111111111111111', 1),
    ('mint_notlaunch','https://example.test/c.json', 500, 'SomeProgramWeHaveNeverSeen1111111111111111', 0)`);

  const rows = db.prepare(sql).all(Date.now(), 100) as { mint: string }[];
  const got = rows.map((r) => r.mint).sort();

  assert.deepEqual(got, ["mint_known", "mint_notlaunch", "mint_unknown"],
    `The chain-wide resolver's pending query returned ${JSON.stringify(got)}.

     It must not filter on \`program\` - the whole point of the chain-wide layer is capturing launches from venues
     we cannot yet name, and those are exactly the ones whose documents nobody else is keeping. It must not filter
     on \`looks_like_launch\` either: that column is a measured classifier stored so a reader can recompute it and
     disagree, and using it to decide what to FETCH would make it self-fulfilling - a mint we declined to classify
     as a launch would never get the document that might have shown it was one.`);
});
