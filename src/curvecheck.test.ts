/**
 * The four states of the on-chain curve reading, pinned.
 *
 * `curve_checked_at` and `curve_complete` encode four different things and the pair is what tells them apart. The
 * predicate that decides which of them counts as a disconfirmation was written `!t.curve_complete`, and `!null` is
 * true in JavaScript, so "we read it and the account had already gone" was silently counted the same as "we read it
 * and the curve had not completed". 191 launches were excluded from every graduation count on the site because an
 * RPC read of ours came back empty.
 *
 * This is the cheapest possible guard against it coming back, and it is worth having because the bug is invisible:
 * both spellings behave identically on the two states that occur most often.
 */
import { test } from "node:test";
import assert from "node:assert";
import { graduationDisproved } from "./provenance.ts";

test("only an explicit incomplete reading disproves a graduation", () => {
  const at = 1789000000000;

  // 1. no reading at all - we never looked, or the call failed and deliberately wrote nothing
  assert.equal(graduationDisproved({ curve_checked_at: null, curve_complete: null }), false,
    "a launch we never read must not be treated as disproved");
  assert.equal(graduationDisproved({}), false, "a row missing the columns entirely is not a finding");

  // 2. read, and the account was gone. We looked and learned nothing: neither confirmed nor disproved.
  assert.equal(graduationDisproved({ curve_checked_at: at, curve_complete: null }), false,
    "an unreadable account is our failure, never a finding about the token");

  // 3. read, and the curve had not completed. The only disconfirmation.
  assert.equal(graduationDisproved({ curve_checked_at: at, curve_complete: 0 }), true);

  // 4. read, and the curve had completed
  assert.equal(graduationDisproved({ curve_checked_at: at, curve_complete: 1 }), false);
});

test("undefined is not a disconfirmation either", () => {
  // optionalColumns() omits these columns on a database that lacks them, so every consumer sees undefined rather
  // than null. That must read as "we do not know", exactly like a missing reading - never as a finding.
  assert.equal(graduationDisproved({ curve_checked_at: 1789000000000, curve_complete: undefined }), false);
  assert.equal(graduationDisproved({ curve_checked_at: undefined, curve_complete: undefined }), false);
});

/**
 * And the same thing again at the two surfaces a reader actually meets.
 *
 * The test above existed, passed, and did not help. `graduationDisproved` was corrected in one place while two
 * callers kept their own longhand copy of the old predicate - the token page in `assess`, and `launch.graduated` in
 * api/v1 - so the archive went on publishing an account-gone reading as a disproof on exactly the surfaces the
 * correction had promised were fixed. Pinning a helper does nothing about a caller that never calls it.
 *
 * So this asserts the behaviour at the boundary rather than the predicate. A source-level grep is the cheaper guard
 * and the weaker one: it catches the spelling and not the mistake.
 */
import { readFileSync } from "node:fs";

/**
 * Correction prose is allowed to quote the broken predicate, and has to be.
 *
 * `disproved-fix-did-not-travel` states the exact spelling that was wrong, because a correction that will not say
 * what the fault was is not a correction. The corrections table is append-only by design, so this string can never
 * be reworded out of it later - which means the guard has to know about it rather than the text having to bend.
 * Anything else matching the pattern is the bug returning.
 */
const QUOTED_IN_CORRECTIONS = "curve_checked_at != null && !curve_complete";

test("no caller open-codes the disproof predicate instead of calling the helper", () => {
  // The literal that was wrong in both copies. Any reappearance is the same bug returning, whatever file it is in.
  const longhand = /curve_checked_at\s*!=\s*null\s*&&\s*!\s*t?\.?curve_complete\b/;
  for (const f of ["provenance.ts", "api.ts", "serve.ts", "render.ts", "pages.ts", "servicedb.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    // Comments are allowed to quote the broken spelling; code is not. Strip block comments before testing.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      .split(QUOTED_IN_CORRECTIONS).join("");
    assert.ok(!longhand.test(code),
      `${f} spells the disproof predicate out longhand. Call graduationDisproved(t): !null is true, so this form ` +
      `reports an unreadable curve account as a disproved graduation.`);
  }
});

test("an account-gone reading is not published as a failed graduation", async () => {
  const { assess } = await import("./provenance.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const at = 1789000000000;
  // assess reads trades to find a curve buyout. Empty tables are the point: this test is about the curve reading.
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE trades (mint TEXT, wallet TEXT, side TEXT, sol REAL, ts INTEGER, market TEXT, sig TEXT);
           CREATE TABLE hist_trades (mint TEXT, wallet TEXT, side TEXT, sol REAL, ts INTEGER, sig TEXT)`);
  const covered = () => true;
  const base = {
    mint: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", creator: "Cr", created_at: at - 600_000,
    dev_pct: 4, curve_buyers: 90, graduated: 1, graduated_at: at - 300_000, dev_sold: 0,
    snap30_buyers: 40, bundled_buyers: 0, late_discovery: 0,
  };
  const say = (t: any) => JSON.stringify(assess(db as any, t, covered));

  // Read, account gone. We looked and learned nothing, so nothing may be asserted about the curve either way.
  const gone = say({ ...base, curve_checked_at: at, curve_complete: null });
  assert.ok(!/we do not state that this curve graduated/i.test(gone),
    "an unreadable curve account is our failed RPC read, and must not be published as a finding about the token");

  // Read, and genuinely incomplete. This one SHOULD say so, or the fix has gone too far the other way.
  const disproved = say({ ...base, curve_checked_at: at, curve_complete: 0 });
  assert.notEqual(disproved, gone,
    "a disproved graduation and an unreadable account must not produce the same output - that is the original bug");
});
