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

  // 1. no reading at all — we never looked, or the call failed and deliberately wrote nothing
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
  // than null. That must read as "we do not know", exactly like a missing reading — never as a finding.
  assert.equal(graduationDisproved({ curve_checked_at: 1789000000000, curve_complete: undefined }), false);
  assert.equal(graduationDisproved({ curve_checked_at: undefined, curve_complete: undefined }), false);
});
