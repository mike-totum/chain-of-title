/**
 * That adopting a new record re-derives EVERYTHING bound to the old connection.
 *
 * `reloadRecord` swaps the record file in place: it opens the new one, reassigns `db`, re-derives the values read
 * from the file, re-prepares the statements bound to the old connection, and closes the old handle 30 seconds later
 * so requests already in flight finish against the file they started on. The design is right. Its failure mode is
 * that it works from a LIST, and a list can be incomplete.
 *
 * On 2026-09-12 it was. `covered = coverageFor(db)` was declared `const` at module scope and never rebuilt, so the
 * closure held the boot connection for the life of the process. That was harmless for as long as its per-venue
 * cache was warm - a warm cache never touches the connection. Then a second venue's launches reached the served
 * record for the first time, the cache missed, the closure queried a handle that had been closed since the first
 * adoption, and every front-page render returned 500 with `database is not open`.
 *
 * Nothing could have caught that by reading `reloadRecord`, because the function is correct about everything it
 * mentions. The only check that works is over what it does NOT mention, which is what this test is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./serve.ts", import.meta.url), "utf8");

/**
 * Whether an initializer actually USES the connection, rather than merely containing the letters.
 *
 * String literals are blanked first, because `arg("--db", ...)` is a flag name. And `db` is only counted where it
 * stands alone as a value: not after a dot or a backslash, which is what excludes `config.dbPath` and the regex
 * `/\/record\.db$/` in HEALTH_URL. Both were false positives on the first attempt, and a guard that cries wolf
 * gets an exemption list, and an exemption list is where the next real one hides.
 */
const withoutStrings = (s: string) =>
  s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, "``");
const usesConnection = (init: string) => /(?<![.\\\w])db\b/.test(withoutStrings(init));

function reloadBody(): string {
  const i = SRC.indexOf("function reloadRecord()");
  assert.ok(i > 0, "reloadRecord is gone from serve.ts; this test is checking nothing");
  // To the end of the function: its final `catch` block, then the closing brace at column 0.
  const j = SRC.indexOf("\n}", SRC.indexOf("catch (e)", i));
  assert.ok(j > i, "could not find the end of reloadRecord");
  return SRC.slice(i, j);
}

/** Module-scope `const`/`let` whose initializer actually uses the connection. */
function dbDerivedBindings(): { name: string; init: string }[] {
  const out: { name: string; init: string }[] = [];
  const re = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]*)/gm;
  for (const m of SRC.matchAll(re)) {
    const name = m[1], init = m[2];
    if (name === "db") continue;
    if (!usesConnection(init)) continue;
    out.push({ name, init: init.trim() });
  }
  return out;
}

test("every module-level value derived from the record connection is rebuilt on adoption", () => {
  const body = reloadBody();
  const missing = dbDerivedBindings().filter(({ name }) => !new RegExp(`\\b${name}\\s*=[^=]`).test(body));
  assert.deepEqual(missing.map((m) => m.name), [],
    "these are built from the record connection at module scope and reloadRecord never reassigns them, so after " +
    "the first record adoption they hold a handle that is closed 30 seconds later:\n" +
    missing.map((m) => `  ${m.name} = ${m.init}`).join("\n") +
    "\nA prepared statement or a closure over the old connection answers correctly until the moment it touches " +
    "the connection again - which for a lazily-cached closure can be weeks later and triggered by data, not code. " +
    "Rebuild it inside reloadRecord, next to `covered`.");
});

test("the coverage closure specifically is rebuilt, and before anything reads coverage", () => {
  // Called out on its own because it is the one that fell over, and because ORDER matters here: `buildFacts` and
  // the chrome figures are computed from coverage inside the same function, so a rebuild placed after them would
  // typecheck, pass the test above, and still serve one adoption's worth of pages from the old windows.
  const body = reloadBody();
  const rebuilt = body.indexOf("covered = coverageFor(db)");
  assert.ok(rebuilt > 0, "reloadRecord no longer rebuilds `covered`. That is the 2026-09-12 front-page outage.");
  const facts = body.indexOf("buildFacts(");
  if (facts > 0) assert.ok(rebuilt < facts,
    "`covered` is rebuilt AFTER buildFacts uses it, so the prose figures are computed from the previous record's " +
    "coverage windows under the new record's build time.");
  assert.match(SRC, /let covered = coverageFor\(db\)/,
    "`covered` must be `let`: it is rebuilt on every adoption, and `const` is what made it hold the boot handle.");
});
