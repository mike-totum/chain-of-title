/**
 * The swimlane draws what the archive holds, including the parts of it that are missing.
 *
 * Two of these cases cannot be reached from the published record today and are exactly the ones that will be wrong
 * when they arrive: no cluster on file yet has more than seventeen wallets that bought a curve, so the lane cap has
 * never fired in production, and a chart that silently plots a subset is this project's oldest failure shape wearing
 * a new hat. The third is the one that matters most — a token whose launch time we do not hold must not be drawn as
 * though it were bought at the moment of launch.
 */
import { test } from "node:test";
import assert from "node:assert";
import { swimlane, LANES_MAX, type LaneEvent } from "./render.ts";

const T0 = Date.UTC(2026, 8, 3, 0, 0, 0);
const ev = (over: Partial<LaneEvent> & { wallet: string; ts: number }): LaneEvent => ({
  mint: "MintOf" + over.wallet, symbol: "SYM", sol: 85, createdAt: null, danger: false, ...over,
});

test("a wait is drawn only where the launch time is on record", () => {
  const known = swimlane([
    ev({ wallet: "AAAAAA", ts: T0, createdAt: T0 - 3600_000 }),
    ev({ wallet: "BBBBBB", ts: T0 + 7200_000 }),
  ], new Map([["AAAAAA", 1], ["BBBBBB", 1]]));
  // One tail, for the one event whose launch we hold. The other gets none rather than one of length zero, which
  // would read as "bought at the moment of launch" — a finding made out of a gap in the record.
  assert.equal((known.match(/class="wt"/g) ?? []).length, 1);
  assert.equal((known.match(/class="dot/g) ?? []).length, 2);
});

test("lanes are ordered by first appearance, not by volume", () => {
  const svg = swimlane([
    ev({ wallet: "FIRSTw", ts: T0 }),
    ev({ wallet: "SECOND", ts: T0 + 1000 }),
    ev({ wallet: "SECOND", ts: T0 + 2000, mint: "MintTwo" }),
    ev({ wallet: "SECOND", ts: T0 + 3000, mint: "MintThr" }),
  ], new Map([["FIRSTw", 1], ["SECOND", 3]]));
  const labels = [...svg.matchAll(/class="lw">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ["FIRSTw", "SECOND"], "the busier wallet must not be promoted to the top lane");
});

test("past the lane cap it draws the busiest and says how many it left out", () => {
  const events: LaneEvent[] = [];
  const curves = new Map<string, number>();
  for (let i = 0; i < LANES_MAX + 5; i++) {
    const wallet = `W${String(i).padStart(5, "0")}`;
    // Later wallets are busier, so keeping the busiest also proves the cap does not simply keep the first N.
    const n = i + 1;
    for (let k = 0; k < n; k++) events.push(ev({ wallet, ts: T0 + i * 60_000 + k * 1000, mint: `M${i}_${k}` }));
    curves.set(wallet, n);
  }
  const svg = swimlane(events, curves);
  const labels = [...svg.matchAll(/class="lw">([^<]+)</g)].map((m) => m[1]);
  assert.equal(labels.length, LANES_MAX);
  assert.ok(svg.includes(`busiest ${LANES_MAX} of ${LANES_MAX + 5} wallets drawn`), "the cap must declare itself");
  assert.ok(!labels.includes("W00000"), "the quietest wallet should have been dropped");
  assert.deepEqual(labels, [...labels].sort(), "the kept lanes must stay in first-seen order");
});

test("one event is a fact, not a chart", () => {
  assert.equal(swimlane([ev({ wallet: "AAAAAA", ts: T0 })], new Map([["AAAAAA", 1]])), "");
});

test("the axis stays readable however long the span", () => {
  for (const days of [0.01, 0.5, 2, 7, 33, 400]) {
    const svg = swimlane([
      ev({ wallet: "AAAAAA", ts: T0 }),
      ev({ wallet: "BBBBBB", ts: T0 + days * 86400_000 }),
    ], new Map([["AAAAAA", 1], ["BBBBBB", 1]]));
    const ticks = (svg.match(/class="gl"/g) ?? []).length;
    assert.ok(ticks <= 13, `${days} days drew ${ticks} labelled ticks, which will overlap`);
  }
});
