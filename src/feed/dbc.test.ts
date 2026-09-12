/**
 * The Meteora Dynamic Bonding Curve decoders, pinned against bytes the chain actually produced.
 *
 * Fixtures, not mocks. Every buffer below is base64 of real mainnet bytes, and each one names the transaction or
 * account it came from so anyone can re-fetch it and check:
 *
 *   creation   5wrQoQ4yj2iipMkcbUTqoBUVBQhJtqgduspNQsW3dnx8bYNrQMLz2LgZGh92HUL1uCqaL7dT439R2CvQL2KQAHJK
 *              slot 446328221, 2026-09-12T03:33:35Z - "Anthropig" (ANTHROPIG), a Token-2022 launch.
 *   swap       s18YrtAxdzupHRGPh79L3DHStaAhhy1aWMpZ4XVu3bdXMU1S8LJEQJWe3z2KBU3FijDBPmBi2vAKqavHDHeTCmf
 *              slot 446328462, 2026-09-12T03:34:52Z - a sale on the same pool, 241 slots after it was created.
 *   accounts   pool 5AY2Ac5ubEaPeTwAjU3SxajNpKoTM8MEMwJGUD7WYZo4 and its config
 *              CaDBnXEGdbJ9bKBN8U4AbbvJ7BMY6KMrBTXDyShaonjd, read at slot 446333139.
 *
 * The whole launch is one specimen, deliberately: the creation event, a swap on it, and its two accounts, so the
 * assertions cross-check each other rather than each standing alone. The base mint the creation event names is the
 * base mint the pool account holds at offset 136 and the base mint the swap instruction listed at account 7. The
 * `migration_threshold` the swap event reported is the `migration_quote_threshold` in the config account. And by
 * the time the accounts were read the curve had finished, at a quote reserve equal to that threshold to the
 * lamport - four independent readings of one number.
 *
 * THE ONE THAT MATTERS MOST is "one swap produces one trade". DBC emits `EvtSwap` and `EvtSwap2` for every single
 * swap, and both fixtures below came out of the same transaction. A decoder that recognised both would double
 * every trade on this venue - volume, buyer counts, fees - and both readings would be individually correct, so
 * nothing downstream could contradict it. That test drives the real pair and proves exactly one trade comes out,
 * and separately proves the discarded event is not carrying anything the kept one lacks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { base58Decode } from "../rpc-http.ts";
import {
  DBC_PROGRAM, EVENT_CPI_TAG, CREATE_DISC, TRADE_DISC, SUPERSEDED_TRADE_DISC, CURVE_COMPLETE_DISC,
  ACCOUNTS, WSOL, eventPayload, isCreateEvent, isTradeEvent, isSupersededTradeEvent, isCurveCompleteEvent,
  poolOf, configOf, createParts, initializeArgs, tradeParts, tradesIn, decodePool, decodeConfig, poolCurve,
  curveState, quoteMintOf, isSolQuoted, traderOf,
} from "./dbc.ts";

const POOL = "5AY2Ac5ubEaPeTwAjU3SxajNpKoTM8MEMwJGUD7WYZo4";
const CONFIG = "CaDBnXEGdbJ9bKBN8U4AbbvJ7BMY6KMrBTXDyShaonjd";
const MINT = "7qNoXXPbgkqyiNGrY7sQughsZgpDB57MHdHjzoNnSDUH";
const CREATOR = "5VNR5ZtFqTzQRbGHzHej5AG97PHPcVQ79TdBrjcwXwFr";
const TRADER = "6jFuBv3We29D8cwiNuLHazVrmRJC73qR3iPjK1X83D6f";

/**
 * `EvtInitializePool`, as the FULL inner-instruction data: 8-byte event-CPI tag plus the 145-byte payload.
 * Kept tagged rather than pre-stripped so the test drives `eventPayload` on bytes that still carry the tag - the
 * boundary between the CPI channel and a log channel is the thing most likely to be got wrong by hand.
 */
const CREATE_IX =
  "5EWlLlHLmh3kMvZVy0KGJT3gDK17KF1TN6+myd5gCjEWhbzcca6NyfhLNO88d+3Xq/KAZ64aa+2dwifzPLdZ+su0lPevApiaqt+MFjsj" +
  "pHxCszl786zOc4IvLYw1BSUqiiym0TFwxM/HqFsyshNy5WWKpvYv8ccGGAF3KGwOGItxYWcG4wSOHJBLKqPBdFO2AZ1tmhoAAAAA";

/**
 * The creation INSTRUCTION's own data - `initialize_virtual_pool_with_token2022` plus its one argument. Not an
 * event: the name, symbol and uri exist nowhere in `EvtInitializePool`, which is why this fixture is here at all.
 */
const INITIALIZE_IX_DATA =
  "qXYzTpFu3JsJAAAAQW50aHJvcGlnCQAAAEFOVEhST1BJR1AAAABodHRwczovL2lwZnMuaW8vaXBmcy9iYWZrcmVpZXdoN29ieHk2M20zbWwz" +
  "bWQydmdweDVydWx3bnU0NDZvdDZtaXRyd2ptb2g0cmRkMzdkbQ==";

/** `EvtSwap` - the event we deliberately ignore. Tagged inner-instruction data, 170 bytes. */
const SWAP_IX =
  "5EWlLlHLmh0bPBXViqq7kz3gDK17KF1TN6+myd5gCjEWhbzcca6NyfhLNO88d+3Xq/KAZ64aa+2dwifzPLdZ+su0lPevApiaqt+MFjsj" +
  "pHwAAEr798MTAAAAqsxYAgAAAABK+/fDEwAAAPcSdQIAAAAAU0cyRjVupQUAAAAAAAAAAOVCAQAAAAAAuVAAAAAAAAAAAAAAAAAAAEr7" +
  "98MTAAAAXMikagAAAAA=";

/** `EvtSwap2` - the authoritative one, from the SAME transaction as SWAP_IX. Tagged, 195 bytes. */
const SWAP2_IX =
  "5EWlLlHLmh29QjOoJlB1mT3gDK17KF1TN6+myd5gCjEWhbzcca6NyfhLNO88d+3Xq/KAZ64aa+2dwifzPLdZ+su0lPevApiaqt+MFjsj" +
  "pHwAAEr798MTAAAAqsxYAgAAAAAASvv3wxMAAABK+/fDEwAAAAAAAAAAAAAA9xJ1AgAAAABTRzJGNW6lBQAAAAAAAAAA5UIBAAAAAAC5" +
  "UAAAAAAAAAAAAAAAAAAAIixNZAIAAACAvauMAgAAAFzIpGoAAAAA";

/** `VirtualPool` 5AY2Ac5u…, 424 bytes, read at slot 446333139 - by then a finished, migrated curve. */
const POOL_B64 =
  "1eAF0WJFd1wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAq/KAZ64aa+2d" +
  "wifzPLdZ+su0lPevApiaqt+MFjsjpHxCszl786zOc4IvLYw1BSUqiiym0TFwxM/HqFsyshNy5WWKpvYv8ccGGAF3KGwOGItxYWcG4wSOHJBL" +
  "KqPBdFO2xLm9gAmpS4Uw96Sf0em4NSESIaPBMGFxGbfYsNL70s4i+kXSG4tzOvfPQTrpFBV5SuNCWNTlQx4GSRNAIKduyGCOURrwcwMAgL2r" +
  "jAIAAABgMBXpDwAAAJOkjQEAAAAAAAAAAAAAAAAAAAAAAAAAAMqxedvzbbkFAAAAAAAAAACdbZoaAAAAAAEBAAADAQAAYDAV6Q8AAACTpI0B" +
  "AAAAAOrEVKQ/AAAA85U2BgAAAACayKRqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAABQAAAAAAAAAx/euMgoAAADgKk4BAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAA==";

/** `PoolConfig` CaDBnXEG…, 1048 bytes, read at slot 446333139. The only account that names the quote asset. */
const CONFIG_B64 =
  "GmwOe3TmgSsGm4hX/quBhPtof2NGGMA12sQ53BrrO1WYoPAAAAAAAf5fsF6ZuTmEPAyuBd58jRUkfjRRTKsAAhuRvCzwRV49/l+wXpm5OYQ8" +
  "DK4F3nyNFSR+NFFMqwACG5G8LPBFXj2gJSYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCwAAECcBAAEAAACAUQEAAAAAAAAAAAAAAAAAAAAAAAEBAAYAAQAAAABZ" +
  "BgEAAQAAAAAAAAAAAEi3fIqOGQAAgL2rjAIAAABV8rv96hMAAD34lVn0bbkFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAgMakfo0DAACAxqR+jQMAAQAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjnfYLqRh2BAAAAAAA" +
  "AAAAPfiVWfRtuQUAAAAAAAAAAN5i0IkCpMcEY2kLwQQCAACbV2lOqRpchLHE/v8AAAAAiZbN4LONNWeLGQAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

const buf = (b64: string) => Buffer.from(b64, "base64");
const payloadOf = (b64: string) => {
  const p = eventPayload(buf(b64));
  assert.ok(p, "the event-CPI tag did not match, so nothing below is testing what it says it is");
  return p;
};

/**
 * The discriminators are derivable, and this is the check that they were derived correctly rather than plausibly.
 *
 * The byte arrays on the right are what the program's own IDL account publishes (v0.1.10, read from
 * B8daPXJqt9sv94r1s9GM13sNH6CSak6UtYHV2yyDGbtf, which the program owns). The left side is `sha256("event:<Name>")`
 * computed in dbc.ts. A mismatch would mean a decoder that silently matches nothing, which from outside looks
 * exactly like a venue that has gone quiet - the failure venues.ts clause 6 is about.
 */
test("every discriminator this decoder computes equals the one the program's IDL publishes", () => {
  assert.deepEqual([...CREATE_DISC], [228, 50, 246, 85, 203, 66, 134, 37], "EvtInitializePool");
  assert.deepEqual([...TRADE_DISC], [189, 66, 51, 168, 38, 80, 117, 153], "EvtSwap2");
  assert.deepEqual([...SUPERSEDED_TRADE_DISC], [27, 60, 21, 213, 138, 170, 187, 147], "EvtSwap");
  assert.deepEqual([...CURVE_COMPLETE_DISC], [229, 231, 86, 84, 156, 134, 75, 24], "EvtCurveComplete");
  assert.equal(DBC_PROGRAM, "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    "the IDL account's own `address` field, and MeteoraAg's Anchor.toml [programs.mainnet]");
});

/**
 * The event-CPI tag, and the byte-order flip inside its derivation.
 *
 * Anchor's constant is the sha256 digest read as a big-endian u64 and then written little-endian, so the bytes on
 * the wire are the digest REVERSED. Computing it without the reverse produces a tag that never matches, and the
 * whole venue silently ingests nothing. Pinned against the real inner instruction, not against the derivation.
 */
test("the event-CPI tag is derived with its byte flip, and real bytes start with it", () => {
  assert.equal(EVENT_CPI_TAG.toString("hex"), "e445a52e51cb9a1d");
  for (const [name, b64] of [["create", CREATE_IX], ["EvtSwap", SWAP_IX], ["EvtSwap2", SWAP2_IX]] as const) {
    const raw = buf(b64);
    assert.equal(raw.subarray(0, 8).toString("hex"), "e445a52e51cb9a1d", `${name} did not carry the tag`);
    const payload = eventPayload(raw)!;
    assert.equal(payload.length, raw.length - 8, `${name}: exactly the 8-byte tag comes off, nothing more`);
    // The post-tag buffer is what a log channel would have carried, so the event discriminator is now at 0.
    assert.equal(payload.subarray(0, 8).length, 8);
  }
});

test("an instruction that is not an Anchor event yields no payload", () => {
  // The creation instruction itself. It lands in the same place a caller looks for events and must not decode.
  assert.equal(eventPayload(buf(INITIALIZE_IX_DATA)), null,
    "initialize_virtual_pool_with_token2022 is an instruction, not an event; accepting it would decode its " +
    "arguments as a pubkey");
  assert.equal(eventPayload(Buffer.alloc(0)), null);
  assert.equal(eventPayload(Buffer.alloc(12)), null, "too short to hold a tag and a discriminator");
});

test("the creation event names the mint and the creator", () => {
  const d = payloadOf(CREATE_IX);
  assert.equal(isCreateEvent(d), true);
  assert.equal(isTradeEvent(d), false);
  const c = createParts(d);
  assert.ok(c);
  assert.equal(c.pool, POOL);
  assert.equal(c.config, CONFIG);
  assert.equal(c.creator, CREATOR, "creator is at 72, after pool and config");
  assert.equal(c.baseMint, MINT,
    "base_mint is at 104. A near-miss returns a well-formed pubkey belonging to the config or the creator, which " +
    "is why this is pinned to bytes rather than reasoned about");
  assert.equal(c.poolType, 1, "1 is Token-2022; this launch used initialize_virtual_pool_with_token2022");
});

/**
 * `activation_point` is not a time, whatever its name says.
 *
 * The field is a u64 called `activation_point` and the obvious reading is a unix timestamp. It is 446,328,221 -
 * which is the SLOT the creation transaction landed in, because this pool's config says `activation_type: 0`
 * (slot). Read as seconds that is 1984. Pinned because a decoder that "helpfully" multiplied it by 1000 would
 * date every DBC launch to the Reagan administration and nothing downstream would notice a consistent wrong date.
 */
test("activation_point is the creation slot, not a timestamp", () => {
  const c = createParts(payloadOf(CREATE_IX))!;
  assert.equal(c.activationPoint, 446_328_221n, "the slot this transaction landed in");
  assert.equal(decodeConfig(CONFIG_B64)!.activationType, 0, "0 means the point above is a slot");
  assert.ok(c.activationPoint < 1_600_000_000n,
    "if this were seconds it would be 1984; the guard is here so a later 'fix' to treat it as time fails loudly");
});

/**
 * The token's name comes from the instruction, because the event does not have one.
 *
 * pump.fun and LaunchLab both put name/symbol/uri in their creation event. DBC does not - `EvtInitializePool` has
 * six fields and none of them is a string. A decoder that read only events would record every DBC launch nameless
 * and the record would look complete.
 */
test("name, symbol and uri come from the creation instruction's arguments", () => {
  const a = initializeArgs(buf(INITIALIZE_IX_DATA));
  assert.ok(a, "the initialize discriminator did not match");
  assert.equal(a.name, "Anthropig");
  assert.equal(a.symbol, "ANTHROPIG");
  assert.equal(a.uri, "https://ipfs.io/ipfs/bafkreiewh7obxy63m3ml3md2vgpx5rulwnu446ot6mitrwjmoh4rdd37dm");
  // And it must not accept an event payload, or a pool pubkey would be read as a string length.
  assert.equal(initializeArgs(payloadOf(CREATE_IX)), null);
  assert.equal(initializeArgs(buf(INITIALIZE_IX_DATA).subarray(0, 20)), null,
    "a string length running past the buffer means the layout moved: refuse, never truncate a token's own name");
});

test("the trade event decodes, and the direction is resolved against the ledger", () => {
  const d = payloadOf(SWAP2_IX);
  const t = tradeParts(d);
  assert.ok(t);
  assert.equal(t.pool, POOL);
  assert.equal(t.config, CONFIG);
  assert.equal(t.isBuy, false,
    "trade_direction 0 is BaseToQuote. In this transaction the signer's base balance fell by 84,892,187,466 and " +
    "the quote vault fell by 41,226,999: a sale. Reading it as a buy reports every exit as a purchase");
  assert.equal(t.swapMode, 0);
  assert.equal(t.hasReferral, false);
  assert.equal(t.includedFeeInputRaw, 84_892_187_466n);
  assert.equal(t.excludedFeeInputRaw, 84_892_187_466n, "equal here because this config takes its fee on the output");
  assert.equal(t.amountLeftRaw, 0n, "a complete fill; non-zero would mean the swap ran into the end of the curve");
  assert.equal(t.outputRaw, 41_226_999n);
  // Resolved from the direction, which is the one place in this layout a plausible wrong number can appear.
  assert.equal(t.baseRaw, 84_892_187_466n, "a sale's input is base");
  assert.equal(t.quoteRaw, 41_226_999n, "a sale's output is quote");
  assert.equal(t.tradingFeeRaw, 82_661n);
  assert.equal(t.protocolFeeRaw, 20_665n);
  assert.equal(t.referralFeeRaw, 0n);
  assert.equal(t.timestamp, 1_789_184_092n, "current_timestamp; this one really is a unix time");
  assert.equal(t.nextSqrtPrice, 406_852_516_436_920_147n,
    "DBC's price is this squared, in Q64. It is not a ratio of the reserves - see note C in dbc.ts");
});

/**
 * RAW INTEGERS, and the assertion is that nobody scaled anything.
 *
 * The base decimals are in the config (6 here) and the quote decimals are in the quote mint (9 for wrapped SOL, 6
 * for the USDC pools that are 9.1% of configs). Neither is in the event. A decoder that divided by 1e9 "because a
 * curve is SOL" produced a 1000x error on LaunchLab and a fake 986x paper trade before that.
 */
test("the trade event reports raw integers and scales nothing", () => {
  const t = tradeParts(payloadOf(SWAP2_IX))!;
  for (const [name, v] of Object.entries(t)) {
    if (typeof v === "bigint") assert.equal(Number.isInteger(Number(v)), true, `${name} must be a raw integer`);
  }
  assert.equal(typeof t.quoteRaw, "bigint", "a scaled amount would be a float; bigint is the guard");
  assert.notEqual(Number(t.quoteRaw), 41_226_999 / 1e9);
});

/**
 * ONE SWAP, ONE TRADE. This is the test the whole file is for.
 *
 * Both fixtures came out of transaction s18YrtAxdzup… - one `EvtSwap`, one `EvtSwap2`, one swap. Feed the decoder
 * both and exactly one trade must come out. Recognising both would double every DBC trade in the archive.
 */
test("a real EvtSwap/EvtSwap2 pair from one transaction yields exactly one trade", () => {
  const legacy = payloadOf(SWAP_IX);
  const authoritative = payloadOf(SWAP2_IX);

  // The predicates split them, and the split is exclusive in both directions.
  assert.equal(isTradeEvent(authoritative), true);
  assert.equal(isTradeEvent(legacy), false, "EvtSwap must not be read as a trade");
  assert.equal(isSupersededTradeEvent(legacy), true);
  assert.equal(isSupersededTradeEvent(authoritative), false);
  assert.equal(tradeParts(legacy), null, "and it must not decode either, whichever order a caller tries");

  const { trades, unpairedLegacy } = tradesIn([legacy, authoritative]);
  assert.equal(trades.length, 1, "two events, one swap, one trade");
  assert.equal(unpairedLegacy.length, 0, "the EvtSwap was paired, so it is a known duplicate and not an alarm");
  assert.equal(trades[0].outputRaw, 41_226_999n);

  // Order must not matter: a transaction's inner instructions are not guaranteed to arrive in emission order.
  assert.equal(tradesIn([authoritative, legacy]).trades.length, 1);
  // And two genuinely different swaps must still be two trades - the dedup is per event, not per pool.
  assert.equal(tradesIn([authoritative, authoritative]).trades.length, 2,
    "this deliberately does NOT dedup by pool: two swaps on one pool in one transaction are two trades");
});

/**
 * And the discarded event is not carrying anything the kept one lacks.
 *
 * "Ignore EvtSwap" is only safe if EvtSwap2 is a superset for this swap. Decoded here at EvtSwap's own offsets -
 * spelled out rather than imported, because the point is to read the discarded bytes independently - and every
 * field the two share agrees. What EvtSwap2 adds is the pair that makes it authoritative: the quote reserve and
 * the migration threshold, which EvtSwap does not carry at all.
 */
test("the ignored EvtSwap agrees with EvtSwap2 on every field they share, and lacks the curve", () => {
  const legacy = payloadOf(SWAP_IX);
  const t = tradeParts(payloadOf(SWAP2_IX))!;
  assert.equal(legacy.length, 162, "EvtSwap: 8 disc + 154 borsh");
  assert.equal(base58ish(legacy.subarray(8, 40)), t.pool);
  assert.equal(base58ish(legacy.subarray(40, 72)), t.config);
  assert.equal(legacy[72], 0, "same trade_direction");
  assert.equal(legacy.readBigUInt64LE(90), t.includedFeeInputRaw, "actual_input_amount");
  assert.equal(legacy.readBigUInt64LE(98), t.outputRaw, "output_amount");
  assert.equal(legacy.readBigUInt64LE(122), t.tradingFeeRaw);
  assert.equal(legacy.readBigUInt64LE(130), t.protocolFeeRaw);
  assert.equal(legacy.readBigUInt64LE(138), t.referralFeeRaw);
  assert.equal(legacy.readBigUInt64LE(154), t.timestamp);
  // What is only in EvtSwap2, and why it wins: the curve's position and where it graduates.
  assert.equal(t.quoteReserveRaw, 10_272_713_762n, "quote raised after this swap - EvtSwap has no reserve field");
  assert.equal(t.migrationThresholdRaw, 10_950_000_000n, "and where this curve completes");
  assert.equal(t.migrationThresholdRaw, decodeConfig(CONFIG_B64)!.migrationQuoteThresholdRaw,
    "the event's threshold equals the config account's own migration_quote_threshold, read independently");
});

/** base58 of a 32-byte slice, written out here so this test does not lean on the module it is checking. */
function base58ish(b: Buffer): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + b.toString("hex"));
  let out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b) { if (x !== 0) break; out = "1" + out; }
  return out;
}

/**
 * An `EvtSwap` with no `EvtSwap2` beside it is reported, not dropped.
 *
 * The pairing was measured on today's `swap2` traffic and cannot speak for the retired `swap` instruction or for
 * the next program version. A plain filter would drop such a trade and the archive would be quietly short by
 * exactly the trades that stopped being duplicated. This is the difference between a gap and an alarm.
 */
test("an unpaired EvtSwap is surfaced rather than silently discarded", () => {
  const { trades, unpairedLegacy } = tradesIn([payloadOf(SWAP_IX)]);
  assert.equal(trades.length, 0, "we still refuse to decode it: its fields cannot answer what the archive asks");
  assert.deepEqual(unpairedLegacy, [POOL], "but the caller is told, by pool, so this can never be invisible");
});

test("the pool account decodes to the mint its own creation event reported", () => {
  const p = decodePool(POOL_B64);
  assert.ok(p, "the pool did not decode at all");
  assert.equal(p.baseMint, MINT,
    "base_mint is at 136, past the 64-byte VolatilityTracker and the 16-byte alignment gap before sqrt_price. " +
    "This is the same address EvtInitializePool named and the same the swap instruction listed at account 7");
  assert.equal(p.config, CONFIG);
  assert.equal(p.creator, CREATOR);
  assert.equal(p.baseVault, "EEwBM2TiwT2YE2YbCTGgr4LknwDqtBxPC4QnLVKHQ6Hb", "swap instruction account 5");
  assert.equal(p.quoteVault, "3MYCqw9avtv6SsUcKVcUQ7UVyxLG2XQFvdgywqiiYSKh", "swap instruction account 6");
  assert.equal(p.poolType, 1, "agrees with the creation event, from a different source");
  assert.equal(p.activationPoint, 446_328_221n, "the same slot the creation event carried");
  assert.equal(p.hasSwap, true);
});

/**
 * The curve finished, and the program says so itself.
 *
 * `finish_curve_timestamp` is the venue's own statement. pump.fun's ~115 vSOL rule is a guess that
 * `graduated_confirmed_by` exists to flag; this is not a guess. And the number it finished at is the threshold to
 * the lamport, which is the cross-check that both offsets are right.
 */
test("completion is read from the program's own field, not inferred from a threshold", () => {
  const p = decodePool(POOL_B64)!;
  assert.equal(p.finishCurveTimestamp, 1_789_184_154n, "2026-09-12T03:35:54Z, 99 seconds after the launch");
  assert.equal(p.complete, true);
  assert.equal(p.isMigrated, true, "and it had already been moved to an AMM by the time these bytes were read");
  assert.equal(p.quoteReserveRaw, decodeConfig(CONFIG_B64)!.migrationQuoteThresholdRaw,
    "the curve stopped at exactly its threshold: 10.95 SOL. Two offsets in two accounts agreeing on one number");
});

test("the config account names the quote asset, which the pool account does not", () => {
  const c = decodeConfig(CONFIG_B64);
  assert.ok(c);
  assert.equal(c.quoteMint, WSOL);
  assert.equal(c.solQuoted, true);
  assert.equal(c.tokenDecimal, 6, "read, never assumed: the swap's token balances were 6-decimal");
  assert.equal(c.tokenType, 1, "Token-2022, agreeing with the pool's pool_type from a different account");
  assert.equal(c.collectFeeMode, 1, "1 means the fee is taken in the output token, so a fee has no fixed unit");
  assert.equal(c.migrationQuoteThresholdRaw, 10_950_000_000n);
  assert.equal(c.preMigrationTokenSupplyRaw, 1_000_000_000_000_000n,
    "1e9 tokens at 6 decimals - read from this launch's config, not from curve.ts's pump.fun constant. The " +
    "denominator of dev_pct, which the data dictionary calls the most load-bearing number in the file");
  assert.ok(c.migrationBaseThresholdRaw < c.swapBaseAmountRaw,
    "the curve cannot leave more for the AMM than it was willing to sell; one of these offsets is wrong");
});

test("a curve reading needs both accounts, and refuses a config that is not this pool's", () => {
  const good = poolCurve(POOL_B64, CONFIG_B64, CONFIG);
  assert.ok(good);
  assert.equal(good.baseMint, MINT);
  assert.equal(good.quoteMint, WSOL);
  assert.equal(good.solQuoted, true);
  assert.equal(good.totalSupply, 1_000_000_000, "supply scaled by the config's own token_decimal");
  assert.equal(good.complete, true);
  assert.equal(good.progress, 1, "quote raised / threshold: this curve finished exactly at its threshold");
  // Unitless on purpose: progress is a ratio, so it is right whether the pool is priced in SOL or USDC.
  assert.equal(poolCurve(POOL_B64, CONFIG_B64, "11111111111111111111111111111111"), null,
    "a PoolConfig does not contain its own address, so a caller that knows which it fetched must be able to say " +
    "so - pairing a pool with the wrong config yields a plausible quote mint, supply and threshold from " +
    "somebody else's launch");
  assert.equal(poolCurve(CONFIG_B64, POOL_B64), null, "and the two accounts are not interchangeable");
});

/**
 * A pool not quoted in wrapped SOL is refused rather than priced in SOL.
 *
 * 9.1% of DBC configs are USDC. `CurveState.vSol` is SOL by name and by every consumer's assumption, and filling
 * it with a quantity of USDC is how a 40 SOL buyout rule fires on 40 of something else.
 *
 * These are the REAL config bytes with one field replaced - the 32 bytes of `quote_mint` overwritten with USDC's
 * mint. Replacing a field rather than hand-rolling an account keeps every other offset honest: the test drives the
 * guard, not a fiction.
 */
test("a pool quoted in USDC is refused rather than published in SOL", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const patched = Buffer.from(CONFIG_B64, "base64");
  Buffer.from(base58Decode(USDC)).copy(patched, 8);
  const b64 = patched.toString("base64");

  const c = decodeConfig(b64)!;
  assert.equal(c.quoteMint, USDC);
  assert.equal(c.solQuoted, false);
  // The launch is still fully readable. A launch is a launch whatever it is priced in.
  const curve = poolCurve(POOL_B64, b64, CONFIG)!;
  assert.equal(curve.baseMint, MINT);
  assert.equal(curve.quoteMint, USDC);
  assert.equal(curve.progress, 1, "and the progress ratio is still right, because a ratio has no unit");
  // What is refused is the SOL-denominated shape, and only that.
  assert.equal(curveState(POOL_B64, b64, CONFIG), null,
    "CurveState.vSol is SOL by name; a quantity of USDC in it is a published falsehood");
  assert.ok(curveState(POOL_B64, CONFIG_B64, CONFIG), "the same pool on its real WSOL config must decode");
});

/**
 * DBC has no virtual reserves, and `CurveState` has no way to say that.
 *
 * `vTokens`/`vSol` are filled with the REAL reserves because there is nothing else to put there: DBC is a
 * concentrated-liquidity curve whose price is `sqrt_price` squared, not a reserve ratio. So they are honest
 * numbers under misleading names, and the consequence is that `curve.ts`'s `price()` (vSol/vTokens) and
 * `GRADUATION_V_SOL` (pump.fun's 115, against this curve's 10.95) must never be applied to a reading from here.
 * This test pins the equality so the shape is visible to whoever reads it next, rather than only described.
 */
test("virtual and real reserves are identical here, because this venue has only real ones", () => {
  const s = curveState(POOL_B64, CONFIG_B64, CONFIG)!;
  assert.equal(s.vTokens, s.realTokens);
  assert.equal(s.vSol, s.realSol);
  assert.equal(s.vSol, 10.95, "the quote reserve, in SOL, because this pool is WSOL-quoted");
  assert.equal(s.complete, true);
  assert.equal(s.creator, CREATOR);
  assert.equal(s.totalSupply, 1_000_000_000);
});

test("a truncated or foreign account decodes to null, never to zeros", () => {
  assert.equal(decodePool(Buffer.from(POOL_B64, "base64").subarray(0, 300).toString("base64")), null);
  assert.equal(decodePool(CONFIG_B64), null, "right program, wrong account: the discriminator has to be checked");
  assert.equal(decodeConfig(POOL_B64), null);
  assert.equal(decodePool(""), null);
  assert.equal(decodeConfig("not base64 at all!!"), null);
});

test("a payload that is not one of the four known events names no pool", () => {
  assert.equal(poolOf(Buffer.alloc(200)), null, "an all-zero buffer must not produce the system-program address");
  assert.equal(configOf(Buffer.alloc(200)), null);
  assert.equal(isCurveCompleteEvent(payloadOf(SWAP2_IX)), false);
  // Every event DOES name a pool and a config, which is what makes a pool-keyed feed possible.
  for (const b64 of [CREATE_IX, SWAP_IX, SWAP2_IX]) {
    assert.equal(poolOf(payloadOf(b64)), POOL);
    assert.equal(configOf(payloadOf(b64)), CONFIG);
  }
});

/**
 * The instruction accounts, and the reason this venue needs no account read to identify a trade.
 *
 * DBC's payloads come out of `meta.innerInstructions`, so the caller already holds the transaction; the swap
 * instruction lists the pool, both mints and the signer. Positions pinned against the real transactions rather
 * than trusted from the IDL, because an off-by-one here returns a well-formed pubkey for a vault or a program.
 */
test("the instruction accounts carry the identity the payloads do not", () => {
  const swapKeys = [
    "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", CONFIG, POOL,
    "7rYEYdT7Zm4CCLhdWvas2nDC8jpBFb7m9Mc8YokxHoU8", "ErUW7U8QmKZULUaEisHCQg4EfkZRG9Br4BKKVScXwpXd",
    "EEwBM2TiwT2YE2YbCTGgr4LknwDqtBxPC4QnLVKHQ6Hb", "3MYCqw9avtv6SsUcKVcUQ7UVyxLG2XQFvdgywqiiYSKh",
    MINT, WSOL, TRADER,
  ];
  assert.equal(swapKeys[ACCOUNTS.swap.pool], POOL);
  assert.equal(swapKeys[ACCOUNTS.swap.baseMint], MINT);
  assert.equal(quoteMintOf({ keys: swapKeys }, "swap"), WSOL);
  assert.equal(isSolQuoted({ keys: swapKeys }, "swap"), true);
  assert.equal(traderOf({ keys: swapKeys }), TRADER,
    "the swap event names no wallet at all; this is the only place a DBC trade can be attributed");

  // The creation instruction, Token-2022 variant. Positions 0-7 are identical in the SPL variant.
  const initKeys = [
    CONFIG, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", CREATOR, MINT, WSOL, POOL,
    "EEwBM2TiwT2YE2YbCTGgr4LknwDqtBxPC4QnLVKHQ6Hb", "3MYCqw9avtv6SsUcKVcUQ7UVyxLG2XQFvdgywqiiYSKh",
  ];
  assert.equal(initKeys[ACCOUNTS.initialize.pool], POOL);
  assert.equal(initKeys[ACCOUNTS.initialize.baseMint], MINT);
  assert.equal(initKeys[ACCOUNTS.initialize.creator], CREATOR);
  assert.equal(quoteMintOf({ keys: initKeys }, "initialize"), WSOL);
  // And with no accounts supplied, nothing is guessed.
  assert.equal(traderOf(undefined), null);
  assert.equal(quoteMintOf(undefined, "swap"), null);
  assert.equal(isSolQuoted(undefined, "swap"), false);
});
