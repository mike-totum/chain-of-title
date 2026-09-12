/**
 * The Raydium LaunchLab decoders, pinned against bytes the chain actually produced.
 *
 * A fixture and not a mock. Every byte below came from pool 7L2sWFH3rjHCBbjye28oHXDW1H9Vkt2WNeMJcW4B1hUK on
 * 2026-09-11, and the values asserted against it were confirmed independently: the base mint matches what that
 * pool's own PoolCreateEvent reported, decoded from a separate transaction.
 *
 * The offsets are the whole risk here. `base_mint` sits at 205, which is 64 bytes further in than a reader who
 * skipped the nested 40-byte VestingSchedule would look, and reading it 64 bytes early returns a perfectly
 * well-formed pubkey belonging to something else. A wrong-but-plausible address is the failure mode this archive
 * exists to catch in other people's data, so it gets a fixture rather than a careful read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePool, decodeCurve, decodeTrade, isSolQuoted, quoteMintOf, WSOL, ACCOUNTS } from "./launchlab.ts";

/** Pool 7L2sWFH3… ("Snapcat", SNAP), read from mainnet 2026-09-11. */
const POOL_B64 =
  "9+3j9dfD3kYJBAAAAAAAAPoABgYBAIDGpH6NAwAAeMX7UdECAOCXDj7pzwMAZRRmIAAAAABPXws/eAIAAAELFQAAAAAAaznLWwAAAAC5ExEAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATi2Hz3YuI6AI4Wg5uPQTvvOcOPEr4trV" +
  "yob4rmZuUDUv76UoyW8/kSO/XTQhGtcPshtjskAzEmFgU9mvfUhN3IrTpwrpmtosWGv+ZBQevg1Giu3nB0Ejn4vyLTmq7xSNBn9ys8G6eb1WVz" +
  "sHzEgsWU9IFj4lqa4mCNEtJe/O7CUXS6SZVjbxvx4Qae8gfpQODTVHaPwu9H7ywIkVaACWgV1nRITOGDlpMf31x6ETR6ILG+3pFn/x4TRd/GI3" +
  "EE35DHHBizbjdg6nquwWDF7fZDmiYP2vSctZ5/IIk1RCGwwDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAA";

test("the pool account decodes to the mint its own create event reported", () => {
  const p = decodePool(POOL_B64);
  assert.ok(p, "the pool did not decode at all");
  assert.equal(p.baseMint, "ALvT2usBGUC8C21dDiXpwAGVwA3x1GBKtut3VFWQcX8x",
    "base_mint is at offset 205, after the 40-byte VestingSchedule. A near-miss here returns a valid-looking " +
    "pubkey for the wrong account, which is why this is pinned to bytes rather than reasoned about.");
  assert.equal(p.baseDecimals, 6);
  assert.equal(p.quoteDecimals, 6);
  assert.equal(p.creator.length >= 32, true);
  assert.equal(p.status, 0, "status 0 is Fund: still on the curve");
});

/**
 * The denominator of dev_pct, read rather than assumed.
 *
 * `tracker.onCreate` divided the creator's tokens by `curve.ts`'s TOTAL_SUPPLY - 1,000,000,000, which is a fact
 * about pump.fun, not about launches. LaunchLab sets supply per pool. Every pool sampled so far does mint 1e9,
 * which is exactly why this is pinned: a constant that happens to be right is indistinguishable from one that is
 * right until the day it is not, and the field it would be wrong in is the one the data dictionary calls the most
 * load-bearing in the file.
 *
 * `supply` sits at 21 and `total_base_sell` at 29, both before the reserves and well before the VestingSchedule
 * that moves everything after 101.
 */
test("the pool states its own supply, and it is not read from a pump.fun constant", () => {
  const p = decodePool(POOL_B64)!;
  assert.equal(p.supply, 1_000_000_000, "supply is at offset 21, scaled by the pool's own base decimals");
  assert.equal(p.totalBaseSell, 793_100_000, "total_base_sell is at offset 29: what the curve sells before it completes");
  assert.ok(p.totalBaseSell < p.supply, "the curve cannot sell more than exists; one of these offsets is wrong");
});

test("a pool not quoted in wrapped SOL is refused rather than priced in SOL", () => {
  const p = decodePool(POOL_B64)!;
  assert.equal(p.solQuoted, false, "this fixture is quote-mint SNAPcES…, deliberately not WSOL");
  assert.notEqual(p.quoteMint, WSOL);
  // The point of the whole exercise: CurveState.vSol is SOL by name and by every consumer's assumption.
  assert.equal(decodeCurve(POOL_B64), null,
    "a non-SOL pool must not be expressed as a CurveState: filling vSol with a quantity of some other token is " +
    "how a 40 SOL buyout rule fires on 40 of something else");
});

test("a truncated or foreign account decodes to null, never to zeros", () => {
  assert.equal(decodePool(Buffer.from(POOL_B64, "base64").subarray(0, 200).toString("base64")), null);
  assert.equal(decodePool(Buffer.alloc(0).toString("base64")), null);
  assert.equal(decodePool("not base64 at all!!"), null);
});

test("a trade on a non-SOL pool is declined, and the reason is distinguishable", () => {
  // A well-formed TradeEvent payload; what varies is the quote mint in the instruction accounts.
  const d = Buffer.alloc(147);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(d, 0);
  const keys = new Array(15).fill("11111111111111111111111111111111");
  keys[ACCOUNTS.swap.mint] = "ALvT2usBGUC8C21dDiXpwAGVwA3x1GBKtut3VFWQcX8x";
  keys[ACCOUNTS.swap.user] = "DsGJkPzFEQZuwy7JjZzPcJEyEfdC6StV7rarXG4ftRSA";

  keys[ACCOUNTS.swap.quoteMint] = "SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz";
  assert.equal(isSolQuoted({ keys }, "swap"), false);
  assert.equal(decodeTrade(d, { keys }), null, "a non-SOL-quoted trade must not report a solAmount");
  assert.equal(quoteMintOf({ keys }, "swap"), "SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz",
    "the caller must still be able to learn WHY it was declined, or 'not a trade' and 'not priceable' collapse");

  keys[ACCOUNTS.swap.quoteMint] = WSOL;
  assert.ok(decodeTrade(d, { keys }), "the same payload on a WSOL pool must decode");
});

test("a trade with no accounts supplied is declined, not guessed", () => {
  const d = Buffer.alloc(147);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(d, 0);
  assert.equal(decodeTrade(d), null,
    "the mint and trader live in the instruction accounts; without them there is no record to write");
});
