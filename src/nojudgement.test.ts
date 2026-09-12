/**
 * That this project's own grade of a party cannot reach the public record, the pages, or the API.
 *
 * WHAT HAPPENED. `operator_policy` held a trading-era judgement of each wallet cluster - one of follow, watch or
 * avoid - plus two notes hand-written from a sample of one or two launches each: "dumps into followers: Squads
 * sold 283 SOL in 30 min, onoda drained in hours" and "holds through the flat window; Kshama 660x, Simba 46x".
 * They were seeded into every database by `clusters.ts`, carried into `record.db` by `servicedb`, rendered on
 * every wallet and cluster page as "Cluster behaviour", served by api/v1 as `operatorPolicy`, and deposited under
 * the DOI. 55 rows: 34 avoid, 17 watch, 4 follow.
 *
 * The cluster page says, directly beneath where the grade was printed, that a shared funder is a lead and not a
 * finding and that trading terminals fund their users exactly as a wallet farm does. So the page contradicted
 * itself, and the half that was our opinion was the half stated without qualification.
 *
 * WHY THESE ARE SOURCE-READING TESTS. The fault is a line somebody writes, not a value in a database - there is
 * no row to assert against once the table is gone. The same shape as `metavenue.test.ts`: what must not happen is
 * a plausible-looking re-addition, and the thing that catches that is a test that reads the code.
 *
 * WHAT IS DELIBERATELY STILL PUBLISHED: `operator_wallets` and `operator_funders`. Who funded a wallet is a chain
 * fact anyone can re-derive, and the funder note is where a cluster identified as a trading terminal rather than a
 * farm is recorded - withholding that would be worse than publishing it. The line is not "nothing about clusters",
 * it is "nothing that is our conclusion about a party".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
/** Strip block and line comments, so the prohibitions below cannot be tripped by the notes explaining them. */
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the published record does not carry operator_policy, and drops it if it already did", () => {
  const s = code("./servicedb.ts");
  assert.ok(/DROP TABLE IF EXISTS rec\.operator_policy/.test(s),
    "the record build must DROP it: an incremental build does not remove a table it merely stops writing, so the " +
    "55 rows already in the deployed record would sit there while nothing refreshed them");
  assert.ok(!/CREATE TABLE IF NOT EXISTS rec\.operator_policy/.test(s), "the record recreates operator_policy");
  assert.ok(!/\["operator_policy"/.test(s), "the record build copies operator_policy again");
});

test("no page renders a cluster grade", () => {
  const s = code("./render.ts");
  assert.ok(!/Cluster behaviour/.test(s),
    "the heading that printed follow / watch / avoid against a named address is back");
  assert.ok(!/p\.policy/.test(s), "a template reads a policy field again");
  /**
   * The qualifying sentence must survive. Removing the grade and then losing the caveat would leave the cluster
   * pages asserting a group with nothing saying what a shared funder does and does not establish.
   */
  assert.match(src("./render.ts"), /a lead, not a finding/,
    "the cluster pages must keep saying that a shared funder is a lead and not a finding");
  assert.match(src("./render.ts"), /Trading terminals fund their users/,
    "and must keep naming the trading-terminal confound, which is why the grade was unsafe in the first place");
});

test("the public API does not serve a grade", () => {
  const s = code("./api.ts");
  assert.ok(!/operatorPolicy/.test(s), "api/v1 serves this project's opinion of a cluster again");
  // The observation stays: which wallets share a funder is checkable on chain.
  assert.match(s, /operatorCluster/, "the cluster label itself should still be served; it is an observation");
});

test("nothing seeds a hand-written characterisation of a named group", () => {
  const s = code("./clusters.ts");
  for (const phrase of ["dumps into followers", "holds through the flat window", "Kshama 660x", "onoda drained"]) {
    assert.ok(!s.includes(phrase),
      `clusters.ts writes "${phrase}" into every database it runs against. It reached the public record, the ` +
      `site, api/v1 and the DOI deposit from here.`);
  }
  assert.ok(!/INSERT OR IGNORE INTO operator_policy[^;]*'(follow|avoid|watch)'/.test(s),
    "a hand-set cluster grade is seeded again");
});

test("the correction stays on the record, naming what was withdrawn", () => {
  /**
   * A correction is not a changelog entry: the record carries the corrections table so a mirror is
   * self-describing, and someone holding a copy taken before 2026-09-12 has the grade in it. Deleting the
   * published thing without the row would leave that reader with no way to learn it was withdrawn.
   */
  const s = src("./servicedb.ts");
  assert.match(s, /"cluster-policy-published"/, "the correction row is gone");
  assert.match(s, /mirrored under a DOI/, "the correction must say that copies taken before this date carry it");
});
