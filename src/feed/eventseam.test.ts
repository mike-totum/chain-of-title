/**
 * That `handleLogs` decodes nothing itself, and hands the seam exactly the payloads attribution kept.
 *
 * The decode loop used to live inside `handleLogs`, which meant it could only ever be fed by a log line. Meteora's
 * Dynamic Bonding Curve emits no `Program data:` lines at all - `emit_cpi!` exclusively - so its events exist only
 * in `meta.innerInstructions` and a log-reading feed sees nothing from it. The loop is now `handleEvents`, taking
 * buffers from wherever they came from, and `handleLogs` is a thin adapter over it.
 *
 * A refactor like that is the kind that passes every existing test while quietly changing what reaches the
 * decoders, because nothing here exercised the emit path - `attribution.test.ts` proves `payloadsFrom` as a pure
 * function and the venue tests prove the decoders, and the wiring between them was covered by neither. So this
 * pins the wiring itself: the seam must be transparent, and attribution must happen BEFORE it rather than inside
 * the decoders where each venue would have to remember it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { RpcFeed, PUMP_PROGRAM } from "./rpc.ts";
import { LAUNCHLAB_PROGRAM } from "./launchlab.ts";

const data = (b: Buffer) => `Program data: ${b.toString("base64")}`;
/** A payload body long enough to survive the length guards, with a recognisable tail. */
const payload = (disc: Buffer, tag: number) => Buffer.concat([disc, Buffer.alloc(200, tag)]);
const SOME_DISC = createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8);

/** Records what the seam is handed instead of decoding it, so the assertion is about the wiring and nothing else. */
class Spy extends RpcFeed {
  seen: Buffer[][] = [];
  args: { signature: string; slot: number }[] = [];
  constructor(program: string = PUMP_PROGRAM) { super("ws://unused.invalid", program); }
  protected handleEvents(signature: string, payloads: Buffer[], slot: number): void {
    this.seen.push(payloads);
    this.args.push({ signature, slot });
  }
  feed(logs: string[]): void { (this as any).handleLogs("sig1", logs, 4242); }
}

test("handleLogs hands every attributed payload to the seam, and nothing else", () => {
  const f = new Spy();
  const ours = payload(SOME_DISC, 0x11);
  f.feed([
    `Program ${PUMP_PROGRAM} invoke [1]`,
    data(ours),
    `Program ${PUMP_PROGRAM} success`,
  ]);
  assert.equal(f.seen.length, 1, "handleLogs did not reach handleEvents - the seam is bypassed");
  assert.deepEqual(f.seen[0], [ours]);
  assert.deepEqual(f.args[0], { signature: "sig1", slot: 4242 },
    "the signature and slot must survive the seam: a trade emitted without them is unverifiable against the chain");
});

test("a foreign program's payload is dropped before the seam, not inside the decoders", () => {
  const f = new Spy();
  const ours = payload(SOME_DISC, 0x11);
  const theirs = payload(SOME_DISC, 0x22); // identical discriminator, which is the whole problem
  f.feed([
    `Program ${PUMP_PROGRAM} invoke [1]`,
    data(ours),
    `Program ${LAUNCHLAB_PROGRAM} invoke [2]`,
    data(theirs),
    `Program ${LAUNCHLAB_PROGRAM} success`,
    `Program ${PUMP_PROGRAM} success`,
  ]);
  assert.deepEqual(f.seen[0], [ours],
    "LaunchLab's payload reached pump.fun's decoder. Both events are named TradeEvent, so the discriminators are " +
    "byte-identical and only the invoke frames can tell them apart - see attribution.test.ts for what that costs.");
});

test("an unattributable payload still reaches the seam", () => {
  // The deliberate asymmetry, pinned here because it is the one that protects coverage: a log shape we failed to
  // parse must never be the reason a launch goes unrecorded. Decoding a foreign event writes a rare wrong row;
  // dropping our own loses launches permanently and silently, and would do it to all of them.
  const f = new Spy();
  const orphan = payload(SOME_DISC, 0x33);
  f.feed([data(orphan)]); // no invoke frame at all
  assert.deepEqual(f.seen[0], [orphan],
    "a payload with no enclosing frame was discarded. That is the direction that loses launches.");
});

test("the seam is reachable with payloads that never were a log line", () => {
  // The point of the split: this is how a CPI-sourced feed will drive the same decoders. If this ever needs a log
  // array to work, Meteora DBC cannot be ingested at all.
  const f = new Spy();
  const fromCpi = payload(SOME_DISC, 0x44);
  (f as any).handleEvents("sigCpi", [fromCpi], 99);
  assert.deepEqual(f.seen[0], [fromCpi]);
  assert.deepEqual(f.args[0], { signature: "sigCpi", slot: 99 });
});
