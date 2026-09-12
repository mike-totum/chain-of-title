/**
 * The front page's population, and why it may not be conditioned on what survived our own pruning.
 *
 * The headline is a share: launches that completed a bonding curve with no outside buyer, over launches we watched
 * and can count. On 2026-09-12 the denominator was `curve_buyers IS NOT NULL`, which excluded every launch whose
 * trade rows had been sampled at finalize or pruned by retention. That exclusion is biased in one direction and
 * hard: a launch with many buyers has many trade rows, and many rows is exactly what gets sampled, so the launches
 * dropped were disproportionately the launches WITH buyers - 28.6% of launches with 20+ creation-block buyers
 * against 6.4% of launches with none. What was left skewed toward quiet single-wallet buyouts, which are correctly
 * zeros, and the published share went from 43.4% to 77.3% with nothing changing on chain.
 *
 * A share whose denominator depends on our housekeeping is a measurement of the housekeeping. So a launch we can
 * PROVE had an outside buyer stays in the population even when its rows are gone, and `bundled_buyers` is that
 * proof: a non-creator wallet that bought on this curve in the creation block, counted live by a different code
 * path, unreachable by any pruner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/** The real predicate, lifted from the source rather than retyped, so this cannot pass while the page does else. */
function livePredicate(file: string): string {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const m = src.match(/const LIVE = "graduated_confirmed_by[\s\S]*?;/);
  assert.ok(m, `no LIVE predicate in ${file} in the shape this test reads. Point it at the real one; do not copy ` +
    `the SQL into this file, because a copy keeps passing while the published page changes.`);
  // `${cannotAttributeSql()}` is interpolated at runtime; the venue clause is tested in venues.test.ts.
  return m![0]
    .replace(/^const LIVE = "/, "").replace(/";$/, "")
    .replace(/"\s*\+\s*`/g, " ").replace(/`;?$/, "")
    .replace(/\$\{cannotAttributeSql\(\)\}/g, "0")
    .replace(/\s+/g, " ").trim();
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tokens (mint TEXT PRIMARY KEY, graduated_confirmed_by TEXT, late_discovery INTEGER,
             rebuilt_at INTEGER, venue TEXT, curve_buyers INTEGER, bundled_buyers INTEGER)`);
  const ins = db.prepare("INSERT INTO tokens VALUES (?,'pool',0,NULL,'pumpfun',?,?)");
  ins.run("real_zero", 0, 0);        // no outside buyer, and no rows are missing: the finding itself
  ins.run("counted", 14, 3);         // counted, had buyers
  ins.run("rows_gone_had_buyers", null, 5); // rows pruned, but 5 wallets bought in the creation block
  ins.run("rows_gone_unknown", null, 0);    // rows pruned and no evidence either way
  return db;
}
const inPopulation = (db: DatabaseSync, where: string) =>
  (db.prepare(`SELECT mint FROM tokens WHERE ${where} ORDER BY mint`).all() as any[]).map((r) => r.mint);

test("a launch proved to have had an outside buyer stays in the population when its rows are gone", () => {
  const db = fixture();
  const pop = inPopulation(db, livePredicate("./pages.ts"));
  assert.ok(pop.includes("rows_gone_had_buyers"),
    "a launch whose trade rows were pruned, but which recorded 5 non-creator buyers in its creation block, was " +
    "dropped from the denominator. It can never be in the numerator, so dropping it only understates the " +
    "population - and it is dropped for having been busy, which is what biases the share upward.");
  assert.deepEqual(pop, ["counted", "real_zero", "rows_gone_had_buyers"],
    "a launch with no evidence either way must stay OUT (unknown is a real answer), and everything we can place " +
    "must stay IN.");
  db.close();
});

test("the rule adds nothing to the numerator", () => {
  // The numerator is `curve_buyers = 0`. A launch admitted by the bundled_buyers clause has curve_buyers NULL or
  // above zero, never 0 - checked against production on 2026-09-12, where 0 of 2,470 published zeros had a
  // nonzero bundled_buyers. If that ever stops holding, this change would be inflating the finding rather than
  // correcting it, which is the one direction that would be worse than the bug.
  const db = fixture();
  const zeros = inPopulation(db, `${livePredicate("./pages.ts")} AND curve_buyers = 0`);
  assert.deepEqual(zeros, ["real_zero"]);
  db.close();
});

test("the front page and findings.html compute the same population", () => {
  // Two numbers for one claim is how a reader learns not to trust either. serve.ts renders the front page's
  // headline and pages.ts the prose behind it, and they have drifted before.
  assert.equal(livePredicate("./serve.ts"), livePredicate("./pages.ts"),
    "the headline and the page that explains it are now computed over different populations.");
});
