/**
 * Which program emitted a log payload, and why the answer cannot be taken from the discriminator.
 *
 * An Anchor event discriminator is `sha256("event:<Name>")` truncated to 8 bytes. It is derived from the event's
 * NAME and nothing else, so two programs that both call an event TradeEvent produce the identical 8 bytes - and
 * the two venues this collector watches do exactly that. `logsSubscribe` delivers every line of any transaction
 * MENTIONING our program, other programs' lines included, so the decoders would read each other's events.
 *
 * The two directions are not equally bad, which is why this is fixed rather than noted. Feeding pump.fun's decoder
 * a LaunchLab TradeEvent passes its length check, takes `mint` from the pool state and `solAmount` from
 * `total_base_sell`, and produces a ~793,100 SOL buy on a pool address - over the buyout threshold, so it would be
 * written down as a launch record with a six-figure curve buyout that never happened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { payloadsFrom, decodeTrade, PUMP_PROGRAM } from "./rpc.ts";
import { LAUNCHLAB_PROGRAM } from "./launchlab.ts";

const b64 = (b: Buffer) => `Program data: ${b.toString("base64")}`;
const TRADE_NAME_DISC = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);

/** A LaunchLab TradeEvent: 147 bytes, pool_state at 8, total_base_sell at 40. */
function launchlabTrade(): Buffer {
  const d = Buffer.alloc(147);
  TRADE_NAME_DISC.copy(d, 0);
  d.fill(7, 8, 40);                              // pool_state: a valid-looking pubkey that is not a mint
  d.writeBigUInt64LE(793_100_000_000_000n, 40);  // total_base_sell, which pump.fun reads as lamports
  return d;
}

test("the collision is real, so nothing here may rest on the discriminator", () => {
  assert.deepEqual(TRADE_NAME_DISC, Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
    "LaunchLab's TRADE_DISC literal is no longer sha256(\"event:TradeEvent\"); this whole test is now about " +
    "something else and the attribution below may be guarding a collision that has moved.");
});

test("a foreign program's payload is not handed to our decoder", () => {
  const logs = [
    `Program ${PUMP_PROGRAM} invoke [1]`,
    `Program ${LAUNCHLAB_PROGRAM} invoke [2]`,
    b64(launchlabTrade()),
    `Program ${LAUNCHLAB_PROGRAM} success`,
    `Program ${PUMP_PROGRAM} success`,
  ];
  assert.equal(payloadsFrom(logs, PUMP_PROGRAM).length, 0,
    "pump.fun's reader took a LaunchLab event. Decoded as its own it is a ~793,100 SOL buy on a pool address, " +
    "which trips the buyout detector and writes a launch record for something that is not a launch.");
  assert.equal(payloadsFrom(logs, LAUNCHLAB_PROGRAM).length, 1, "LaunchLab's own event went missing");
});

/**
 * What that payload would have become. Stated as a value rather than described, because "it would decode wrongly"
 * is the sort of claim that stays plausible long after it stops being true.
 */
test("and this is what it would have been recorded as", () => {
  const t = decodeTrade(launchlabTrade());
  assert.ok(t, "the collision no longer decodes at all, so the hazard has changed shape - re-read this test");
  assert.equal(t!.solAmount, 793_100, "the fabricated figure is not what it was; check the layout has not moved");
  assert.ok(t!.solAmount >= 40, "and it clears the buyout threshold, which is what makes it get written down");
});

/**
 * The direction that must never be the reason ingestion stops.
 *
 * Dropping a foreign event writes no row. Dropping OUR events loses launches permanently and silently, and a
 * parser that does not recognise the log shape would drop all of them. So an unattributable payload is kept.
 */
test("a payload nobody can be shown to own is kept, not discarded", () => {
  const d = Buffer.alloc(140); TRADE_NAME_DISC.copy(d, 0);
  assert.equal(payloadsFrom([b64(d)], PUMP_PROGRAM).length, 1,
    "a payload with no enclosing invoke line was dropped. If the log format ever differs from what this parser " +
    "assumes, that behaviour loses every launch rather than none.");
});

test("ordinary single-venue logs are unchanged by attribution", () => {
  const a = Buffer.alloc(140); TRADE_NAME_DISC.copy(a, 0);
  const b = Buffer.alloc(160); TRADE_NAME_DISC.copy(b, 0);
  const logs = [
    `Program ${PUMP_PROGRAM} invoke [1]`,
    "Program log: Instruction: Buy",
    b64(a),
    `Program ${PUMP_PROGRAM} consumed 40000 of 400000 compute units`,
    b64(b),
    `Program ${PUMP_PROGRAM} success`,
  ];
  assert.equal(payloadsFrom(logs, PUMP_PROGRAM).length, 2,
    "the everyday case lost a payload. `consumed` and `log:` lines must not close a frame.");
});

test("a failed inner program still closes its frame", () => {
  const d = Buffer.alloc(140); TRADE_NAME_DISC.copy(d, 0);
  const logs = [
    `Program ${PUMP_PROGRAM} invoke [1]`,
    `Program ${LAUNCHLAB_PROGRAM} invoke [2]`,
    `Program ${LAUNCHLAB_PROGRAM} failed: custom program error: 0xd`,
    b64(d),
    `Program ${PUMP_PROGRAM} success`,
  ];
  assert.equal(payloadsFrom(logs, PUMP_PROGRAM).length, 1,
    "a failed inner call left its frame open, so everything after it was attributed to the wrong program");
});

/**
 * The nesting that turns a mis-parse into lost launches rather than a harmless fallback.
 *
 * A first attempt at this test could not tell whether `consumed` wrongly closed a frame: with our program
 * outermost, an early pop just empties the stack and the fallback above keeps the payload, so the bug degraded to
 * the old behaviour and nothing failed. Invert the nesting and the same bug attributes OUR payload to the program
 * around us and drops it - a silent, total ingestion loss, which is the failure this parser must never cause.
 */
test("a compute-units line does not close a frame, even when we are the inner program", () => {
  const d = Buffer.alloc(140); TRADE_NAME_DISC.copy(d, 0);
  const logs = [
    `Program ${LAUNCHLAB_PROGRAM} invoke [1]`,
    `Program ${PUMP_PROGRAM} invoke [2]`,
    "Program log: Instruction: Buy",
    `Program ${PUMP_PROGRAM} consumed 40000 of 400000 compute units`,
    b64(d),
    `Program ${PUMP_PROGRAM} success`,
    `Program ${LAUNCHLAB_PROGRAM} success`,
  ];
  assert.equal(payloadsFrom(logs, PUMP_PROGRAM).length, 1,
    "our own event was dropped: a `consumed` line closed our frame, so the payload was attributed to the program " +
    "we were called from. Losing our own launches is the one outcome worse than decoding someone else's event.");
  assert.equal(payloadsFrom(logs, LAUNCHLAB_PROGRAM).length, 0, "and it must not become LaunchLab's either");
});
