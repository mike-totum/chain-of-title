/**
 * The dark archive must stay dark, and "we remembered not to publish it" is not a mechanism.
 *
 * Promotion data is third-party expression: other people's copyright, other people's personal data, and mostly
 * people who were fooled by a launch rather than running it. record.db is CC0 under a DOI that cannot be withdrawn,
 * so anything that reaches it is published permanently with no way to take it back for anyone who asks.
 *
 * servicedb.ts publishes an explicit allowlist and drops everything else, which is the right shape — this asserts
 * the promotion tables are not on it, so adding them becomes a deliberate edit that fails a test rather than a
 * change nobody notices.
 */
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./servicedb.ts", import.meta.url), "utf8");

test("the published record allowlist excludes promotion data", () => {
  const m = src.match(/const RECORD_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(m, "could not find RECORD_TABLES in servicedb.ts");
  const listed = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  for (const t of ["token_promotion", "token_promotion_hit", "tweets", "mentions", "platform_snapshots"]) {
    assert.equal(listed.includes(t), false, `${t} must never be published in record.db`);
  }
  // and the allowlist is still the nine tables the schema page documents
  assert.ok(listed.includes("tokens") && listed.includes("wallet_flow"), "allowlist looks wrong");
});

test("xevidence opens the collector and never attaches the record", () => {
  const x = readFileSync(new URL("./xevidence.ts", import.meta.url), "utf8");
  // Behaviour, not vocabulary: an earlier version of this test grepped for the string "record.db" and failed on
  // the console line that tells the operator this data does not go there. What matters is which file it opens.
  assert.ok(/openDb\(config\.dbPath\)/.test(x), "xevidence must open the collector database");
  assert.equal(/openDb\(\s*["'`]/.test(x), false, "xevidence must not open a database by literal path");
  assert.equal(/ATTACH/i.test(x), false, "xevidence must not attach another database");
});
