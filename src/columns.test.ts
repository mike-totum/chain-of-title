/**
 * `TOKEN_COLUMNS` must be satisfiable by both databases, because both are queried with it.
 *
 * It is one string in `provenance.ts` used against two different schemas: the collector's `pump.db`, which the
 * collector queries to answer `/launch/<mint>`, and the published `record.db`, which the web service serves. A
 * column list shared by two schemas is a claim that both satisfy it, and nothing checked the claim.
 *
 * On 2026-09-09 it did not hold. `meta_sha256` was added to the list and to the record — where `servicedb` computes
 * it — but never to the collector, so every query built from TOKEN_COLUMNS threw `no such column` there. The visible
 * effect was an HTTP 500 from `/launch/<mint>`, which is the endpoint that answers about a token launched moments
 * ago; the web service fell back to reconstructing the launch from chain history and told visitors `UNKNOWN — Launch
 * not observed` about launches the collector had watched from their creation transaction. The endpoint's own comment
 * calls that "the worst failure this product has". It was reintroduced by one column in a list.
 *
 * This test builds both schemas the way the code builds them — `openDb` for the collector, `servicedb`'s CREATE for
 * the record — and asserts every name in TOKEN_COLUMNS exists in each. It fails on the addition rather than months
 * later on a route nobody exercises, and it is fast because it needs no data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { TOKEN_COLUMNS } from "./provenance.ts";

/** The bare column names TOKEN_COLUMNS asks for, with SQL comments and whitespace stripped. */
function requestedColumns(): string[] {
  return TOKEN_COLUMNS
    .replace(/--[^\n]*/g, "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

const columnsOf = (db: DatabaseSync, table: string): Set<string> =>
  new Set((db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as any[]).map((r) => r.name));

test("the collector's schema satisfies TOKEN_COLUMNS", () => {
  const dir = mkdtempSync(join(tmpdir(), "cot-cols-"));
  try {
    const db = openDb(join(dir, "pump.db"));
    const have = columnsOf(db, "tokens");
    const missing = requestedColumns().filter((c) => !have.has(c));
    assert.deepEqual(missing, [],
      `TOKEN_COLUMNS names ${missing.length} column(s) the collector does not have: ${missing.join(", ")}.\n` +
      `Every query built from TOKEN_COLUMNS throws "no such column" against the collector database — including\n` +
      `/launch/<mint>, which is how the site answers about a launch it watched minutes ago. Add the column in\n` +
      `db.ts with a paired backfill, or take it out of TOKEN_COLUMNS.`);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the published record's schema satisfies TOKEN_COLUMNS", () => {
  /**
   * Read from `servicedb.ts` rather than from a built file: the test must fail when someone edits the CREATE and
   * forgets the column list, which is exactly the change that broke the collector side. A built record would only
   * prove that the last build happened to be consistent.
   */
  const src = readFileSync(new URL("./servicedb.ts", import.meta.url), "utf8");
  const m = src.match(/CREATE TABLE IF NOT EXISTS rec\.tokens \(([\s\S]*?)\n\s*\);/);
  assert.ok(m, "could not find the rec.tokens CREATE in servicedb.ts");
  const declared = new Set(
    m[1].replace(/--[^\n]*/g, "").split(",")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((n) => /^[a-z_][a-z0-9_]*$/i.test(n)));
  /**
   * Columns appended after the CREATE. Two forms, and both must be read or the test reports a gap that is not there:
   * a literal `ALTER TABLE rec.tokens ADD COLUMN x`, and a loop over a list of `"name TYPE"` strings interpolated
   * into the same statement — which is how the launch-claim columns are added, including the one that started this.
   */
  for (const a of src.matchAll(/ALTER TABLE rec\.tokens ADD COLUMN (\w+)/g)) declared.add(a[1]);
  for (const loop of src.matchAll(/for \(const c of \[([\s\S]*?)\]\)\s*\n?\s*try \{ db\.exec\(`ALTER TABLE rec\.tokens ADD COLUMN \$\{c\}`\)/g))
    for (const q of loop[1].matchAll(/"(\w+)[^"]*"/g)) declared.add(q[1]);

  const missing = requestedColumns().filter((c) => !declared.has(c));
  assert.deepEqual(missing, [],
    `TOKEN_COLUMNS names ${missing.length} column(s) the published record does not declare: ${missing.join(", ")}.`);
});
