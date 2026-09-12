/**
 * The curve reading, which is the whole of what the second venue's stream can say.
 *
 * These paths cannot be tested by watching production: a LaunchLab graduation is rare enough that eight minutes of
 * live ingestion produced none, and graduation is the single fact this venue is here to contribute. So the event is
 * synthesised and the state transition checked - what moves, and just as importantly what does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Tracker } from "./tracker.ts";
import type { CreateEvent } from "./feed/pumpportal.ts";
import type { CurveUpdate } from "./feed/rpc.ts";

const MINT = "ALvT2usBGUC8C21dDiXpwAGVwA3x1GBKtut3VFWQcX8x";
const POOL = "7L2sWFH3rjHCBbjye28oHXDW1H9Vkt2WNeMJcW4B1hUK";
const WSOL = "So11111111111111111111111111111111111111112";

const tracker = () => new Tracker({ watchMinutes: 60, deadAfterSeconds: 3600, watchMaxMinutes: 60 });

const create = (over: Partial<CreateEvent> = {}): CreateEvent => ({
  venue: "launchlab", signature: "sig", mint: MINT, traderPublicKey: "Cr34t0r", txType: "create",
  initialBuy: 50_000_000, solAmount: 1, bondingCurveKey: POOL,
  vTokensInBondingCurve: 1_073_000_000, vSolInBondingCurve: 30, marketCapSol: 0,
  name: "n", symbol: "S", uri: "u", pool: POOL, quoteMint: WSOL, solQuoted: true, ...over,
});

const reading = (over: Partial<CurveUpdate> = {}): CurveUpdate => ({
  venue: "launchlab", mint: MINT, curveAccount: POOL, signature: "sig2", slot: 2,
  vTokens: 900_000_000, vSol: 60, realTokens: 173_000_000, quoteReserve: 30, quoteMint: WSOL,
  complete: false, ...over,
});

/**
 * The denominator of dev_pct. pump.fun mints 1e9 for every launch and the tracker divided by that constant; a venue
 * that mints something else would have had its creator's share reported against another venue's supply, in the
 * field the data dictionary calls the most load-bearing in the file.
 */
test("dev_pct is the creator's share of THIS launch's supply", () => {
  const t = tracker().onCreate(create({ initialBuy: 50_000_000, totalSupply: 500_000_000 }), 1000);
  assert.equal(Number(t.devPct.toFixed(4)), 10, "50M of a 500M supply is 10%, not the 5% pump.fun's constant gives");
  const d = tracker().onCreate(create({ initialBuy: 50_000_000 }), 1000);
  assert.equal(Number(d.devPct.toFixed(4)), 5, "with no supply stated, pump.fun's 1e9 is the right fallback");
});

test("a curve reading moves the curve and the price, and counts nobody", () => {
  const tk = tracker();
  tk.onCreate(create(), 1000);
  const t = tk.onCurve(reading(), 2000)!;
  assert.ok(t, "the reading found no token to update");
  assert.equal(t.curve.vSol, 60);
  assert.equal(t.curve.vTokens, 900_000_000);
  assert.equal(t.lastPrice, 60 / 900_000_000);
  assert.equal(t.lastTradeAt, 2000, "a curve that moved is a token that is alive; the dead timer reads this");
  // The whole point of the split. Nothing here witnessed a wallet.
  assert.equal(t.buyers.size, 0, "a curve reading must never add a buyer: it names nobody");
  assert.equal(t.sellers.size, 0);
  assert.equal(t.buys, 0, "trade counts published beside a null buyer count invite the inference the venue cannot support");
  assert.equal(t.sells, 0);
  assert.equal(t.buyVolSol, 0);
  assert.equal(t.devSold, false);
});

/**
 * Graduation from the venue's own status field. This is confirmation, not the ~115 vSOL inference that
 * `graduated_confirmed_by` exists to mark as unconfirmed - so it must arrive with that column set, or `assess`
 * refuses to state that the curve completed and every finding downstream of completion is withheld.
 */
test("a completed curve is recorded as confirmed, with no buyer count invented for it", () => {
  const tk = tracker();
  tk.onCreate(create(), 1000);
  const t = tk.onCurve(reading({ complete: true, vSol: 115, vTokens: 280_000_000 }), 5000)!;
  assert.equal(t.graduated, true);
  assert.equal(t.graduatedAt, 5000);
  assert.equal(t.graduatedConfirmedBy, "curve_complete",
    "without this the graduation reads as an unconfirmed threshold inference and nothing may be said about it");
  assert.equal(t.buyersAtGrad, null,
    "buyersAtGrad must be null, not 0: t.buyers is empty because this venue names nobody, and 0 there would be " +
    "published as 'it graduated with no buyers' - a measurement of an empty set");
});

/**
 * pump.fun's graduation threshold is a fact about pump.fun's curve parameters, and 115 of some other token is not
 * 115 SOL. Completion here comes from the program's own status byte or it does not come at all.
 */
test("a curve past pump.fun's threshold does not graduate on another venue without its own say-so", () => {
  const tk = tracker();
  tk.onCreate(create(), 1000);
  const t = tk.onCurve(reading({ complete: false, vSol: 400, vTokens: 100_000_000 }), 5000)!;
  assert.equal(t.graduated, false,
    "400 vSOL is far past pump.fun's 115, and this venue's pool still says Fund. isGraduated() must not be applied here.");
  assert.equal(t.graduatedConfirmedBy, undefined);
});

/**
 * A pool quoted in something other than wrapped SOL has no SOL price, and 0 is not the answer. About four in five
 * of this venue's launches are in this state, so it is the common case rather than an edge.
 */
test("a curve with no SOL quote leaves every SOL figure alone rather than zeroing it", () => {
  const tk = tracker();
  const c = tk.onCreate(create({ solQuoted: false, quoteMint: "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump", vSolInBondingCurve: 0 }), 1000);
  assert.equal(c.solQuoted, false);
  assert.equal(c.launchPrice, 0, "the collector records 0 here; servicedb publishes NULL for it, see the record build");
  const t = tk.onCurve(reading({ vSol: null, quoteReserve: 4_000_000 }), 2000)!;
  assert.equal(t.curve.vSol, 0, "vSol must not be filled from a quantity of some other token");
  assert.equal(t.peakPrice, 0, "a peak price in SOL cannot be set by a pool that has no SOL in it");
  assert.equal(t.lastTradeAt, 2000, "the curve still moved, so the token is still alive");
});

/** A reading for a token nobody is watching is not an error and must not create one. */
test("a reading for an untracked mint is ignored", () => {
  assert.equal(tracker().onCurve(reading(), 2000), null);
});
