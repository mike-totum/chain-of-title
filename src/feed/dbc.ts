/**
 * Meteora Dynamic Bonding Curve, decoded from its own Anchor events.
 *
 * The third venue, and the first one whose events do not arrive in a log at all. `venues.ts` clause 7 was written
 * against this program before a byte of it was read: DBC emits every event with Anchor's `emit_cpi!`, never
 * `emit!`, so there is no `Program data:` line anywhere in a DBC transaction and the payloads exist only as
 * self-CPI instruction data inside `meta.innerInstructions`. Measured rather than assumed, twice: 25 consecutive
 * successful DBC transactions sampled from the program's signature history on 2026-09-12 carried 0 log events and
 * 25 CPI payloads, and a sweep of three whole finalized blocks (slots 446331187-446331189) found 20 DBC
 * transactions, again 0 with log events and 20 with CPI payloads. A `logsSubscribe` on this program would connect,
 * stay up, report healthy and ingest exactly nothing - the failure `venues.ts` clause 7 exists to forbid.
 *
 * SO THE DECODERS HERE TAKE A PAYLOAD, NOT A LOG LINE, and the boundary between the two channels is `eventPayload`
 * below. An Anchor event-CPI instruction is [8-byte event-CPI tag][8-byte event discriminator][borsh fields], and
 * a log-channel event is [8-byte event discriminator][borsh fields] - byte-identical once the tag is stripped.
 * Confirmed against the bytes: `EvtSwap`'s inner instruction is 170 bytes and its 162-byte tail decodes at the
 * same offsets a log payload would. Every decode function here therefore takes the POST-TAG buffer, so the same
 * functions would serve a log channel unchanged if Meteora ever added one, and nothing in this file knows how the
 * bytes arrived.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID: EVERY SWAP EMITS TWO EVENTS.
 *
 * One `swap2` instruction emits `EvtSwap` AND `EvtSwap2`, both, every time - 20 of 20 transactions in the block
 * sweep, 25 of 25 in the history sample, one of each in each. They describe the SAME swap: on the fixture pair in
 * `dbc.test.ts` the two agree byte for byte on pool, config, direction, `output_amount`, `next_sqrt_price`,
 * `trading_fee`, `protocol_fee` and `referral_fee`. A decoder that recognises both would therefore double every
 * trade in the archive - twice the volume, twice the buy count, twice the fee, on every DBC launch, with nothing
 * anywhere to contradict it because both readings are individually correct.
 *
 * `EvtSwap2` is the authoritative one and `EvtSwap` is ignored. Four reasons, in order of weight:
 *
 *  1. ONLY `EvtSwap2` SAYS WHERE THE CURVE IS. It carries `quote_reserve_amount` (the pool's quote reserve after
 *     this swap) and `migration_threshold` (the reserve at which the curve completes). `EvtSwap` carries no reserve
 *     of any kind. Those two numbers are the whole of this venue's graduation progress, and reading them from the
 *     event rather than from the account is the difference between a free curve series and one `getAccountInfo`
 *     per trade. Cross-checked: the fixture's `migration_threshold` is 10,950,000,000 and its pool's own
 *     `PoolConfig.migration_quote_threshold` is 10,950,000,000.
 *  2. IT SEPARATES WHAT THE TRADER PAID FROM WHAT REACHED THE CURVE. `included_fee_input_amount` and
 *     `excluded_fee_input_amount` are distinct fields; `EvtSwap` has one `amount_in` and one `actual_input_amount`
 *     and no way to say which side of the fee they are on. This archive publishes both "what a buyer spent" and
 *     "what the curve holds", and conflating them is the kind of quiet 0.25% error that never gets found.
 *  3. IT ADMITS A PARTIAL FILL. `amount_left` is the requested input the program did not consume, which is what a
 *     swap that runs into the end of the curve looks like. A reading that takes the requested amount as the traded
 *     amount overstates exactly the last trade before graduation - the single most consequential trade on a launch.
 *  4. IT NAMES ITS OWN FILL SEMANTICS. `swap_mode` says whether `amount_0`/`amount_1` mean in/min-out or
 *     out/max-in. `EvtSwap.params` cannot say, so its two numbers are only readable by assuming the instruction.
 *
 * WHAT THAT CHOICE COSTS, stated because a measurement's scope is part of the measurement. Both samples above ran
 * on today's traffic, and every swap in them went through the `swap2` instruction (discriminator
 * `414b3f4ceb5b5b88`); not one used the older `swap` (`f8c69e91e17587c8`). So "both events, always" is established
 * for the live path and NOT for the retired one. If `swap` ever emitted `EvtSwap` alone, a backfill through older
 * history that read only `EvtSwap2` would silently drop those trades. `tradesIn` therefore reports an `EvtSwap`
 * that arrived with no `EvtSwap2` beside it instead of dropping it quietly, so the day that case exists it is an
 * alarm rather than a gap. Absence of data must not read as absence of the thing.
 *
 * THREE MORE WAYS THIS VENUE IS NOT SHAPED LIKE THE OTHER TWO:
 *
 * A. THE EVENT DOES NOT CARRY THE TOKEN'S NAME. `EvtInitializePool` carries the pool, the config, the creator, the
 *    base mint, the pool type and the activation point - and no name, symbol or uri. Those are arguments to the
 *    `initialize_virtual_pool_with_*` instruction, not fields of the event, which is why `initializeArgs` below
 *    decodes INSTRUCTION data and is the one function here that does. pump.fun and LaunchLab both put the metadata
 *    in the event; this one does not, and a decoder that only reads events would record every DBC launch nameless.
 *
 * B. THE QUOTE ASSET IS PER POOL AND IS NOT IN THE POOL ACCOUNT. `VirtualPool` names the base mint and the config
 *    and stops; the quote mint lives in `PoolConfig`. Measured across the program's config accounts, 89.8% are
 *    wrapped SOL and 9.1% are USDC, so roughly one DBC pool in ten is priced in something that is not SOL. A
 *    SOL-labelled figure for a USDC-quoted pool is a quantity of another token wearing SOL's name - the 1000x
 *    class of error `launchlab.ts` documents and ASSUMPTIONS.md already records once. So the quote mint is carried
 *    out of every reading in this file and never defaulted, and `curveState` refuses a pool it cannot price in SOL
 *    rather than filling `CurveState.vSol` with a quantity of USDC.
 *
 * C. DBC HAS NO VIRTUAL RESERVES AT ALL. pump.fun and LaunchLab are constant-product curves and publish virtual
 *    reserves whose ratio is the price. DBC is a piecewise concentrated-liquidity curve: the price is
 *    `sqrt_price` squared, and `base_reserve`/`quote_reserve` are the real balances. Their ratio is the average
 *    price everything so far filled at, which is NOT the current price and on a young curve is wildly below it. So
 *    `DbcCurve` states the reserves and the sqrt price separately and `curveState` writes the real reserves into
 *    `CurveState`'s `v*` fields under protest - see the comment on it, and the note in the handoff, because
 *    `curve.ts`'s `price()` and `GRADUATION_V_SOL` are pump.fun's arithmetic and must not be applied to this venue.
 *
 * PREFIX ONLY, DELIBERATELY, as in `launchlab.ts`. Every check below is a minimum length, never an equality:
 * Anchor appends fields across program versions and `EvtSwap2` has already grown once relative to `EvtSwap`. A
 * layout that can lengthen must not be able to shift a field this file asserts.
 */
import { createHash } from "node:crypto";
import { base58 } from "./rpc.ts";
import type { CurveState } from "../rpc-http.ts";

/**
 * The program.
 *
 * Cited rather than copied: this is the address MeteoraAg's own `Anchor.toml` declares under
 * `[programs.mainnet] dynamic_bonding_curve`, and it is also the `address` field of the IDL that the program
 * itself owns on chain. Both were checked. The IDL account is `B8daPXJqt9sv94r1s9GM13sNH6CSak6UtYHV2yyDGbtf` -
 * Anchor's `create_with_seed(find_program_address([], program), "anchor:idl", program)` - it is owned by
 * `dbcij3LW…` and it says `dynamic_bonding_curve` v0.1.10. Every discriminator and offset in this file was taken
 * from that account and then checked against transaction bytes, in that order, because the IDL states the intended
 * layout and only a transaction states the actual one.
 */
export const DBC_PROGRAM = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

/**
 * Anchor's event-CPI tag, computed rather than pasted, because the derivation contains a byte-order flip that is
 * exactly the sort of thing a pasted constant gets wrong.
 *
 * Anchor defines `EVENT_IX_TAG: u64 = 0x1d9acb512ea545e4` - which is `sha256("anchor:event")[..8]` read as a
 * big-endian integer - and puts `EVENT_IX_TAG_LE` on the wire, i.e. those eight bytes REVERSED. So the first eight
 * bytes of a DBC event instruction are `e4 45 a5 2e 51 cb 9a 1d`, and `sha256("anchor:event")` on its own, in the
 * order the digest comes out, would never match. Derived here so the flip is visible and testable instead of being
 * a magic literal whose provenance is a comment.
 */
export const EVENT_CPI_TAG: Buffer = Buffer.from(
  createHash("sha256").update("anchor:event").digest().subarray(0, 8),
).reverse();

/**
 * Event discriminators, computed from the event name exactly as `feed/rpc.ts` computes pump.fun's.
 *
 * Anchor 0.30 publishes these as literal byte arrays in the IDL rather than deriving them, and for LaunchLab that
 * was the citation because the deployed program's IDL was the only source. Here they are recomputable: all four
 * below equal `sha256("event:<Name>")[..8]` and all four match the bytes the on-chain IDL publishes, which
 * `dbc.test.ts` asserts against the IDL's own values. Computing rather than pasting means a typo cannot produce a
 * discriminator that simply never matches anything - the failure mode that looks exactly like a quiet venue.
 */
const disc = (name: string): Buffer => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

/** `EvtInitializePool` - a launch. Carries the mint and the creator; NOT the name. See note A in the header. */
export const CREATE_DISC = disc("EvtInitializePool");
/** `EvtSwap2` - the authoritative swap event. See the trap section in the header. */
export const TRADE_DISC = disc("EvtSwap2");
/**
 * `EvtSwap` - the older swap event, emitted alongside `EvtSwap2` for the same swap and deliberately not decoded.
 * Exported so a caller can tell "this is the duplicate we drop on purpose" from "this is not a trade event",
 * which `isTradeEvent` returning false would otherwise conflate. `launchlab.ts` draws the same distinction with
 * `quoteMintOf` for a different reason: a refusal a caller cannot explain is indistinguishable from a bug.
 */
export const SUPERSEDED_TRADE_DISC = disc("EvtSwap");
/** `EvtCurveComplete` - the program stating that the curve finished. This venue's graduation, from the venue. */
export const CURVE_COMPLETE_DISC = disc("EvtCurveComplete");

/** Account discriminators, same derivation (`sha256("account:<Name>")[..8]`), checked against the IDL in the test. */
const accountDisc = (name: string): Buffer => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const POOL_DISC = accountDisc("VirtualPool");
const CONFIG_DISC = accountDisc("PoolConfig");

/** Instruction discriminators (`sha256("global:<name>")[..8]`). Needed for `initializeArgs`; see note A. */
const ixDisc = (name: string): Buffer => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const INITIALIZE_SPL_DISC = ixDisc("initialize_virtual_pool_with_spl_token");
export const INITIALIZE_T22_DISC = ixDisc("initialize_virtual_pool_with_token2022");
/** The live swap instruction; every swap sampled on 2026-09-12 used this one. */
export const SWAP2_IX_DISC = ixDisc("swap2");
/** The older swap instruction. Not seen in either sample. See "what that choice costs" in the header. */
export const SWAP_IX_DISC = ixDisc("swap");

/**
 * Wrapped SOL. The only quote asset whose amounts this archive may state in SOL.
 *
 * Declared here rather than imported from `launchlab.ts`, deliberately: Meteora's decoder must not depend on
 * Raydium's, and a venue file that reaches into another venue's file is the coupling `venues.ts` exists to prevent.
 * The duplication is noted in the handoff as a candidate for a shared constant, which is a decision for the seam
 * and not for this file to take unilaterally.
 */
export const WSOL = "So11111111111111111111111111111111111111112";

/**
 * The instruction's accounts, already resolved through any address lookup table.
 *
 * Same contract and same warning as `launchlab.ts`: a v0 transaction's account indexes point into the static keys
 * followed by `meta.loadedAddresses`, and reading only the static half is what made `research/venueshare.ts`
 * see 2.6% of pump.fun's launches while reporting a confident ranking. Whoever calls this must have done that join.
 *
 * Unlike LaunchLab, supplying these costs this venue NOTHING extra. DBC's payloads arrive from
 * `meta.innerInstructions`, which means the caller already holds the whole transaction - accounts included - by
 * the time it has a payload at all. There is no channel here that delivers a DBC event without its accounts.
 */
export interface EventAccounts {
  readonly keys: readonly string[];
}

/**
 * Account positions carrying identity, from the on-chain IDL and checked against a real transaction of each shape.
 *
 * `initialize` covers BOTH creation instructions: the SPL and Token-2022 variants diverge only from index 8
 * onward (the SPL one inserts `mint_metadata` and `metadata_program`), so every position named here is the same in
 * both. Checked on the Token-2022 creation in the fixture, whose accounts at 3, 4, 5 and 2 are the base mint, the
 * quote mint, the pool and the creator that `EvtInitializePool` independently names.
 *
 * `swap` covers `swap` and `swap2`, which share one account list.
 *
 * THE CONSEQUENCE IS THAT THIS VENUE NEEDS NO ACCOUNT READS FOR IDENTITY, which is the opposite of LaunchLab.
 * The swap instruction names the pool, the base mint, the quote mint and the signer, so a DBC trade is fully
 * identified from the transaction that carried it - no `getAccountInfo` per pool, no config read for the quote
 * mint, nothing cached. `decodePool` and `decodeConfig` below exist for reading curve state, not for identity.
 */
export const ACCOUNTS = {
  initialize: { config: 0, creator: 2, baseMint: 3, quoteMint: 4, pool: 5, baseVault: 6, quoteVault: 7 },
  swap: { config: 1, pool: 2, baseVault: 5, quoteVault: 6, baseMint: 7, quoteMint: 8, payer: 9 },
} as const;

const at = (a: EventAccounts | undefined, i: number): string | null => a?.keys[i] ?? null;

/** The pool's quote asset for this instruction shape, or null if the accounts were not supplied. */
export const quoteMintOf = (a: EventAccounts | undefined, kind: "swap" | "initialize"): string | null =>
  at(a, ACCOUNTS[kind].quoteMint);

/**
 * Is this pool quoted in wrapped SOL? Distinguishes "we cannot price this in SOL" from "this is not an event of
 * that kind", which a null return would conflate. Roughly one DBC pool in ten is not, so a caller that wants to
 * record the launch anyway - and it should, a launch is a launch whatever it is priced in - asks this first.
 */
export const isSolQuoted = (a: EventAccounts | undefined, kind: "swap" | "initialize"): boolean =>
  quoteMintOf(a, kind) === WSOL;

/**
 * The wallet that signed the swap instruction, when the accounts were supplied.
 *
 * DBC's swap events carry no trader - `EvtSwap2` names a pool, a direction and amounts and nobody - so this is the
 * only place a DBC trade can be attributed, and it is available because the CPI channel hands over the whole
 * transaction (see `EventAccounts`). That makes `tradeAttribution: "wallets"` reachable for this venue where it
 * was not for LaunchLab, which is a claim worth checking before it is published rather than after: for a swap
 * routed through an aggregator this is whatever account the router passed as the swap's signer, and that being the
 * end user is true of the direct swaps sampled here and not something this file can promise about every route.
 * `venues.ts` clause 10 is about exactly this kind of claim, so the caution is in the code and not only in a note.
 */
export const traderOf = (a: EventAccounts | undefined): string | null => at(a, ACCOUNTS.swap.payer);

/**
 * Strip Anchor's event-CPI tag and hand back the event payload.
 *
 * THIS FUNCTION IS THE BOUNDARY between the two channels `venues.ts` clause 7 describes, and it is a function so
 * that the boundary is one testable place rather than a slice repeated at every call site. Give it the `data` of a
 * self-CPI instruction from `meta.innerInstructions` whose program is DBC; it returns the
 * [discriminator][borsh fields] buffer that a `Program data:` line would have carried, or null if this instruction
 * is not an Anchor event at all (DBC's own `swap2`, `initialize_*` and the rest all land in the same place).
 *
 * Everything else in this file takes that post-tag buffer, so the decoders are channel-agnostic by construction.
 */
export function eventPayload(instructionData: Buffer): Buffer | null {
  if (instructionData.length < 16) return null;
  if (!instructionData.subarray(0, 8).equals(EVENT_CPI_TAG)) return null;
  return instructionData.subarray(8);
}

/** Does this payload look like a launch creation? Prefix length only; see the last paragraph of the header. */
export const isCreateEvent = (d: Buffer): boolean => d.length >= 145 && d.subarray(0, 8).equals(CREATE_DISC);

/**
 * Does this payload look like a trade? True for `EvtSwap2` only - never for `EvtSwap`.
 *
 * Read the trap section in the header before widening this. Accepting both doubles every trade in the archive.
 */
export const isTradeEvent = (d: Buffer): boolean => d.length >= 187 && d.subarray(0, 8).equals(TRADE_DISC);

/**
 * Is this the duplicate swap event we drop on purpose?
 *
 * Exists so "ignored" is a statement a caller can read, and so `tradesIn` can tell a paired `EvtSwap` (expected,
 * discard) from an unpaired one (unexpected, alarm). A decoder that just fails to match a discriminator cannot
 * tell those apart, and the second one is the case where trades go missing.
 */
export const isSupersededTradeEvent = (d: Buffer): boolean =>
  d.length >= 8 && d.subarray(0, 8).equals(SUPERSEDED_TRADE_DISC);

/** Did the program say the curve finished? Its own statement, not an inference from a threshold. */
export const isCurveCompleteEvent = (d: Buffer): boolean =>
  d.length >= 88 && d.subarray(0, 8).equals(CURVE_COMPLETE_DISC);

const anyEvent = (d: Buffer): boolean =>
  isCreateEvent(d) || isTradeEvent(d) || isSupersededTradeEvent(d) || isCurveCompleteEvent(d);

/**
 * The pool this event is about, which is the identity every DBC event DOES carry.
 *
 * All four events put `pool` in the first field and `config` in the second, so a feed can key on the pool from the
 * payload alone. `venues.ts` clause 8 says the payload may not name the launch; the corollary is that it always
 * names something, and for this venue the something is a pool - the same shape as LaunchLab, reached for a
 * different reason. Unlike LaunchLab the mint is also available (from `EvtInitializePool`, or from the swap
 * instruction's accounts), so the pool is a cache key here rather than a mandatory lookup.
 */
export function poolOf(d: Buffer): string | null {
  if (!anyEvent(d)) return null;
  return base58(d.subarray(8, 40));
}

/**
 * The `PoolConfig` this event's pool was created under: the partner preset that fixes the quote asset, the base
 * decimals, the curve shape and the migration threshold.
 *
 * Worth having from the payload because configs are shared - many pools per config - so a feed that caches by
 * config reads far fewer accounts than one that caches by pool. Not treated as an operator identity: as with
 * LaunchLab's `PlatformConfig`, who is behind a config is a self-asserted claim and publishing it as identity
 * would be the attribution mistake this archive exists to document, committed by us.
 */
export function configOf(d: Buffer): string | null {
  if (!anyEvent(d)) return null;
  return base58(d.subarray(40, 72));
}

/**
 * What `EvtInitializePool` says on its own.
 *
 * The mint and the creator are both here, which is more than LaunchLab's creation event manages. The name, symbol
 * and uri are not - see note A in the header and `initializeArgs`.
 */
export interface DbcCreateParts {
  pool: string;
  config: string;
  creator: string;
  baseMint: string;
  /**
   * 0 for an SPL token, 1 for Token-2022, and this is not a curiosity: 16 of 31 sampled DBC launches were
   * Token-2022, so it is the majority-adjacent case rather than an edge. It matters downstream because a
   * Token-2022 mint may carry a transfer-fee or transfer-hook extension, so the amount the program moves is not
   * necessarily the amount a wallet receives - and no event here can say otherwise.
   */
  poolType: number;
  /**
   * When the pool becomes tradeable, IN WHATEVER UNIT ITS CONFIG SAYS - and the name is a trap. `PoolConfig`
   * carries `activation_type`: 0 means this is a SLOT, 1 means a unix timestamp. The fixture's config says 0 and
   * its `activation_point` is 446,328,221, which is the slot the creation transaction landed in. Read as a
   * timestamp that is 1984. Carried raw and unconverted for that reason; the caller resolves it against the
   * config, or stamps the launch from the block as every other venue's create already does.
   */
  activationPoint: bigint;
}

export function createParts(d: Buffer): DbcCreateParts | null {
  if (!isCreateEvent(d)) return null;
  return {
    pool: base58(d.subarray(8, 40)),
    config: base58(d.subarray(40, 72)),
    creator: base58(d.subarray(72, 104)),
    baseMint: base58(d.subarray(104, 136)),
    poolType: d[136],
    activationPoint: d.readBigUInt64LE(137),
  };
}

/**
 * The token's name, symbol and uri - decoded from the CREATION INSTRUCTION, not from an event.
 *
 * The one function in this file that reads instruction data rather than an event payload, and the signature says
 * so. `EvtInitializePool` has no metadata fields at all (note A), so a decoder that read only events would record
 * every DBC launch with no name; the strings are `InitializePoolParameters` arguments to
 * `initialize_virtual_pool_with_spl_token` / `_with_token2022`. Both variants take the same single argument, so
 * one decoder serves both. Available at no extra cost for the same reason the accounts are: the payload came out
 * of `meta.innerInstructions`, so the outer instruction that produced it is already in hand.
 *
 * A length that runs past the buffer means the layout moved, and this refuses rather than returning a truncated
 * name - the same rule as `launchlab.ts`, for the same reason: a wrong name is published as the token's own claim
 * about itself, which is the one thing this archive is for.
 */
export function initializeArgs(instructionData: Buffer): { name: string; symbol: string; uri: string } | null {
  const d = instructionData;
  if (d.length < 8) return null;
  const disc8 = d.subarray(0, 8);
  if (!disc8.equals(INITIALIZE_SPL_DISC) && !disc8.equals(INITIALIZE_T22_DISC)) return null;
  let o = 8;
  const str = (): string | null => {
    if (o + 4 > d.length) return null;
    const len = d.readUInt32LE(o);
    o += 4;
    if (len > 512 || o + len > d.length) return null;
    const s = d.subarray(o, o + len).toString("utf8");
    o += len;
    return s;
  };
  const name = str(), symbol = str(), uri = str();
  if (name === null || symbol === null || uri === null) return null;
  return { name, symbol, uri };
}

/**
 * What `EvtSwap2` says on its own. RAW INTEGERS, in the mints' own smallest units, scaled by nobody.
 *
 * Scaling here is impossible and pretending otherwise is the error this venue is most likely to produce. The base
 * decimals live in `PoolConfig.token_decimal` and the quote decimals in the quote mint itself - 9 for wrapped SOL,
 * 6 for USDC, which is 9.1% of configs. Dividing by 1e9 because a curve is "usually SOL" is exactly how a
 * LaunchLab amount came out 1000x wrong, and `launchlab.ts`'s `TradeParts` is raw for the identical reason. The
 * caller that knows the pool does the arithmetic.
 */
export interface DbcTradeParts {
  pool: string;
  config: string;
  /**
   * True for a purchase of the launched token.
   *
   * `trade_direction` is 0 for BaseToQuote and 1 for QuoteToBase, which was checked against the ledger rather than
   * read off a name, because getting it backwards reports every sale as a purchase of the same size and that reads
   * as a healthy market. On the direction-0 fixture the signer's base-token balance FELL by exactly
   * `included_fee_input_amount` (121,597,336,190 to 36,705,148,724) and the quote vault fell by exactly
   * `output_amount` - a sale. On a direction-1 transaction in the same sample the signer's base balance ROSE by
   * exactly `output_amount` and the quote vault rose by exactly the input - a purchase.
   */
  isBuy: boolean;
  /** Whether a referral account took a cut. Present because `referral_fee` is meaningless without it. */
  hasReferral: boolean;
  /**
   * Which fill semantics the instruction asked for, raw. Every swap sampled used 0. It governs what `amount_0` and
   * `amount_1` mean (in/min-out versus out/max-in), which is precisely why this struct reports the swap's RESULT
   * fields instead of its requested amounts.
   */
  swapMode: number;
  /** Input the program actually consumed, fee included: what the trader parted with. Never the requested amount. */
  includedFeeInputRaw: bigint;
  /** Input net of fee: what actually reached the curve. Equal to the above when the fee is taken on the output. */
  excludedFeeInputRaw: bigint;
  /**
   * Requested input the program did NOT consume. Non-zero means a partial fill, which is what the last trade
   * before graduation looks like. `EvtSwap` cannot express this; see reason 3 in the header.
   */
  amountLeftRaw: bigint;
  /** What the trader received, net of any fee taken on the output side. */
  outputRaw: bigint;
  /** Quote-asset units, resolved from the direction. In the quote mint's units - see `quoteMint`, never assumed. */
  quoteRaw: bigint;
  /** Base-token units, resolved from the direction. In the base mint's units. */
  baseRaw: bigint;
  /**
   * Fees, raw, in whichever token `PoolConfig.collect_fee_mode` puts them in - 0 quote-only, 1 output-token. The
   * fixture's config says 1, so its sell's fee is in quote and a buy's fee on the same pool is in base. Stated
   * rather than summed into a single "fee in SOL" because that sum is only meaningful once the mode is known, and
   * the mode is in an account this function has not been given.
   */
  tradingFeeRaw: bigint;
  protocolFeeRaw: bigint;
  referralFeeRaw: bigint;
  /**
   * The pool's quote reserve after this swap, and the reserve at which this curve completes. The two numbers that
   * make `EvtSwap2` the authoritative event: graduation progress, free, per trade, with no account read. Cross-
   * checked against `PoolConfig.migration_quote_threshold` on the fixture.
   */
  quoteReserveRaw: bigint;
  migrationThresholdRaw: bigint;
  /** DBC's price is this, squared, in Q64 - not a reserve ratio. See note C in the header. */
  nextSqrtPrice: bigint;
  /** The program's own `current_timestamp`, unix seconds. Unlike `activationPoint` this really is a time. */
  timestamp: bigint;
}

const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
/** Little-endian u128. Two u64 reads because Buffer has no readBigUInt128LE. */
const u128 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);

export function tradeParts(d: Buffer): DbcTradeParts | null {
  if (!isTradeEvent(d)) return null;
  const isBuy = d[72] === 1; // TradeDirection: 0 BaseToQuote (sell), 1 QuoteToBase (buy). Checked; see `isBuy`.
  const includedFeeInputRaw = u64(d, 91);
  const outputRaw = u64(d, 115);
  return {
    pool: base58(d.subarray(8, 40)),
    config: base58(d.subarray(40, 72)),
    isBuy,
    hasReferral: d[73] === 1,
    swapMode: d[90],
    includedFeeInputRaw,
    excludedFeeInputRaw: u64(d, 99),
    amountLeftRaw: u64(d, 107),
    outputRaw,
    // A buy spends quote for base; a sell is the reverse. Resolved here rather than by the caller because this is
    // the one place in the layout where a plausible wrong number can be produced silently.
    quoteRaw: isBuy ? includedFeeInputRaw : outputRaw,
    baseRaw: isBuy ? outputRaw : includedFeeInputRaw,
    nextSqrtPrice: u128(d, 123),
    tradingFeeRaw: u64(d, 139),
    protocolFeeRaw: u64(d, 147),
    referralFeeRaw: u64(d, 155),
    quoteReserveRaw: u64(d, 163),
    migrationThresholdRaw: u64(d, 171),
    timestamp: u64(d, 179),
  };
}

/** What `EvtCurveComplete` says: the curve finished, and the reserves it finished holding. Raw, per usual. */
export interface DbcCurveCompleteParts {
  pool: string;
  config: string;
  baseReserveRaw: bigint;
  quoteReserveRaw: bigint;
}

export function curveCompleteParts(d: Buffer): DbcCurveCompleteParts | null {
  if (!isCurveCompleteEvent(d)) return null;
  return {
    pool: base58(d.subarray(8, 40)),
    config: base58(d.subarray(40, 72)),
    baseReserveRaw: u64(d, 72),
    quoteReserveRaw: u64(d, 80),
  };
}

/**
 * Every trade in one transaction, counted once, plus the thing that would otherwise go missing quietly.
 *
 * This is the function that makes the double-count structurally impossible rather than a rule someone has to
 * remember. Hand it every event payload from one transaction; it returns one `DbcTradeParts` per swap, taken from
 * `EvtSwap2`, and separately the pools of any `EvtSwap` that arrived with NO `EvtSwap2` for the same pool in the
 * same transaction.
 *
 * `unpairedLegacy` is the whole reason this is not a one-line filter. The pairing was measured on today's `swap2`
 * traffic and cannot speak for the retired `swap` instruction or for whatever Meteora deploys next (see "what that
 * choice costs"). If an `EvtSwap` ever turns up alone, a plain filter drops the trade and the archive is quietly
 * short by exactly the trades a future program version stops duplicating. This makes that case loud. `venues.ts`
 * clause 6 says prove ingestion rather than liveness; a counter nobody can read proves nothing.
 */
export function tradesIn(payloads: readonly Buffer[]): { trades: DbcTradeParts[]; unpairedLegacy: string[] } {
  const trades: DbcTradeParts[] = [];
  const pooled = new Set<string>();
  for (const d of payloads) {
    const t = tradeParts(d);
    if (!t) continue;
    trades.push(t);
    pooled.add(t.pool);
  }
  const unpairedLegacy: string[] = [];
  for (const d of payloads) {
    if (!isSupersededTradeEvent(d) || d.length < 40) continue;
    const pool = base58(d.subarray(8, 40));
    if (!pooled.has(pool)) unpairedLegacy.push(pool);
  }
  return { trades, unpairedLegacy };
}

/**
 * `VirtualPool`, the per-launch curve account.
 *
 * OFFSETS ARE NOT BORSH HERE and that is the whole risk. `VirtualPool` and `PoolConfig` are declared
 * `serialization: "bytemuck"` with `repr(C)`, so the compiler inserts alignment padding that a borsh reader would
 * not: the nested 64-byte `VolatilityTracker` comes first, and `sqrt_price` is a `u128` and therefore sits at the
 * next 16-byte boundary, leaving a gap after `partner_quote_fee` that nothing in the field list mentions. Walking
 * the struct with alignment gives a size of 416, and 8 + 416 = 424 is exactly the account length mainnet reports -
 * which is the arithmetic check that the padding was placed correctly, before any field was read.
 *
 * Then checked against the ledger, which is the part that actually counts: on the fixture pool, `base_mint` at 136
 * equals the base mint the pool's own `EvtInitializePool` named and the base mint the swap instruction listed,
 * `config` at 72 equals the config both events named, and `base_vault`/`quote_vault` at 168 and 200 equal the two
 * vault accounts in the swap instruction. A near-miss on any of these returns a perfectly well-formed pubkey
 * belonging to something else, which is the failure mode this archive exists to catch in other people's data.
 *
 * NO QUOTE MINT. It is in `PoolConfig`, not here. See note B in the header; this is why `poolCurve` takes two
 * accounts and why nothing in this interface is called "sol".
 */
export interface DbcPool {
  config: string;
  creator: string;
  baseMint: string;
  baseVault: string;
  quoteVault: string;
  /** Real balances, raw. There are no virtual reserves on this venue at all - see note C in the header. */
  baseReserveRaw: bigint;
  quoteReserveRaw: bigint;
  /** The price, squared, in Q64. The actual current price of this curve, unlike any ratio of the two reserves. */
  sqrtPrice: bigint;
  /** Slot or unix timestamp according to `PoolConfig.activation_type`. Raw; see `DbcCreateParts.activationPoint`. */
  activationPoint: bigint;
  /** 0 SPL, 1 Token-2022. */
  poolType: number;
  /** Has the pool been migrated to an AMM yet? Distinct from the curve having completed. */
  isMigrated: boolean;
  /** 0 pre-migration, then the program's own migration steps. Non-zero means the curve is done. */
  migrationProgress: number;
  /**
   * When the curve finished, unix seconds, or 0 if it has not.
   *
   * The program's own statement that the curve is over, which is why `complete` below reads this rather than
   * comparing the reserve to a threshold. `graduated_confirmed_by` exists because pump.fun's ~115 vSOL rule is a
   * guess; this is not a guess, it is the venue saying so, and it survives the pool being migrated afterwards.
   */
  finishCurveTimestamp: bigint;
  /** Has this curve finished, according to the program. Any of the three statements above is sufficient. */
  complete: boolean;
  /** Whether any swap has ever touched this pool. A launch nobody has bought is a real and different state. */
  hasSwap: boolean;
}

export function decodePool(b64: string): DbcPool | null {
  let b: Buffer;
  try {
    b = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  // 424 exactly, and the discriminator is checked as well as the length: a length test alone would accept any
  // other 424-byte account and read a pubkey out of the middle of it.
  if (b.length < 424 || !b.subarray(0, 8).equals(POOL_DISC)) return null;
  const finishCurveTimestamp = u64(b, 344);
  const isMigrated = b[305] !== 0;
  const migrationProgress = b[308];
  return {
    config: base58(b.subarray(72, 104)),
    creator: base58(b.subarray(104, 136)),
    baseMint: base58(b.subarray(136, 168)),
    baseVault: base58(b.subarray(168, 200)),
    quoteVault: base58(b.subarray(200, 232)),
    baseReserveRaw: u64(b, 232),
    quoteReserveRaw: u64(b, 240),
    sqrtPrice: u128(b, 280),
    activationPoint: u64(b, 296),
    poolType: b[304],
    isMigrated,
    migrationProgress,
    finishCurveTimestamp,
    complete: finishCurveTimestamp !== 0n || isMigrated || migrationProgress !== 0,
    hasSwap: b[370] !== 0,
  };
}

/**
 * `PoolConfig`, the partner preset a launch was created under - and the only account that names the quote asset.
 *
 * Same bytemuck walk as `DbcPool` and the same arithmetic check: the aligned struct is 1040 bytes, `u128` fields
 * (`migration_sqrt_price`, `sqrt_start_price`) and the 20-entry `curve` array all landing on 16-byte boundaries,
 * and 8 + 1040 = 1048 is exactly what mainnet reports. Checked against the ledger too, and this one has an
 * unusually good cross-check: `migration_quote_threshold` read here equals the `migration_threshold` the pool's
 * own `EvtSwap2` reported, independently, from a different account in a different transaction.
 *
 * Configs are shared by many pools, so caching by config is what makes reading the quote asset cheap.
 */
export interface DbcConfig {
  quoteMint: string;
  /** True only for a wrapped-SOL pool. Every SOL-denominated figure in this archive depends on it. See note B. */
  solQuoted: boolean;
  /** Base-token decimals for launches on this config. Read, never assumed - the fixture's is 6, USDC pools differ. */
  tokenDecimal: number;
  /** 0 SPL, 1 Token-2022, matching `DbcPool.poolType`. */
  tokenType: number;
  /** 0 means `activation_point` is a SLOT; 1 means a unix timestamp. The fixture says 0. */
  activationType: number;
  /** 0 fees always in quote, 1 fees in the output token. Without this a fee amount has no unit. */
  collectFeeMode: number;
  /** Quote raised at which the curve completes, raw, in the quote asset's own units. */
  migrationQuoteThresholdRaw: bigint;
  /** Base tokens the curve is willing to sell, and what is left for the AMM at migration. Raw. */
  swapBaseAmountRaw: bigint;
  migrationBaseThresholdRaw: bigint;
  /**
   * Tokens the launch mints, raw.
   *
   * Read rather than assumed, for the reason `launchlab.ts` spells out at length: `dev_pct` is the creator's share
   * of supply and the data dictionary calls it the most load-bearing number in the file, and it was once computed
   * against `curve.ts`'s 1,000,000,000 - which is a fact about pump.fun. The fixture config mints 1e15 raw at 6
   * decimals, which is 1e9 tokens, which is exactly why this is read: a constant that happens to be right is
   * indistinguishable from one that is right until the day it is not.
   */
  preMigrationTokenSupplyRaw: bigint;
  postMigrationTokenSupplyRaw: bigint;
}

export function decodeConfig(b64: string): DbcConfig | null {
  let b: Buffer;
  try {
    b = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  if (b.length < 1048 || !b.subarray(0, 8).equals(CONFIG_DISC)) return null;
  const quoteMint = base58(b.subarray(8, 40));
  return {
    quoteMint,
    solQuoted: quoteMint === WSOL,
    collectFeeMode: b[232],
    activationType: b[234],
    tokenDecimal: b[235],
    tokenType: b[237],
    swapBaseAmountRaw: u64(b, 256),
    migrationQuoteThresholdRaw: u64(b, 264),
    migrationBaseThresholdRaw: u64(b, 272),
    preMigrationTokenSupplyRaw: u64(b, 344),
    postMigrationTokenSupplyRaw: u64(b, 352),
  };
}

/**
 * A DBC curve, read from its two accounts, scaled by their own decimals and named for what it actually is.
 *
 * TWO ACCOUNTS BECAUSE THE QUOTE ASSET IS IN THE SECOND ONE. `VirtualPool` alone cannot say whether a reserve of
 * 10,272,713,762 is 10.27 SOL or 10,272 USDC, and a one-account curve decoder would have to guess. Note B in the
 * header is what guessing costs. The config is the cheap half: many pools share one, so a caller caches configs
 * and reads one account per launch, not two.
 *
 * `quoteReserve` is in the quote asset's own units and is deliberately not called SOL, and `progress` is the thing
 * a reader actually wants - how far along the curve is - expressed as a ratio so it is unitless and therefore
 * correct whatever the pool is priced in.
 */
export interface DbcCurve {
  baseMint: string;
  quoteMint: string;
  creator: string;
  solQuoted: boolean;
  baseDecimals: number;
  /** Base tokens still in the curve, scaled by the config's own `token_decimal`. */
  baseReserve: number;
  /** Quote raised, RAW, because the quote mint's decimals are in neither of these two accounts. */
  quoteReserveRaw: bigint;
  migrationThresholdRaw: bigint;
  /** Quote raised divided by the threshold: 0 at launch, 1 at graduation. Unitless, so it needs no decimals. */
  progress: number;
  /** Total supply, scaled. The denominator of `dev_pct`, read from this launch's config. */
  totalSupply: number;
  /** The program's own statement that the curve is over. Not a threshold guess. */
  complete: boolean;
  /** Has anyone traded this curve at all. */
  hasSwap: boolean;
}

/**
 * `configAddress` is optional and checking it is the point of passing it.
 *
 * A `PoolConfig` account does not contain its own address, so two accounts handed to this function cannot be
 * proved to belong together from their bytes alone - and pairing a pool with the WRONG config yields a quote mint,
 * a decimal scale, a supply and a threshold that are all well-formed and all some other launch's. Every one of
 * those would be published. So a caller that knows which address it fetched says so, and this refuses the
 * mismatch; a caller that does not is trusted, and the parameter being optional is the honest record of that.
 */
export function poolCurve(poolB64: string, configB64: string, configAddress?: string): DbcCurve | null {
  const p = decodePool(poolB64);
  const c = decodeConfig(configB64);
  if (!p || !c) return null;
  if (configAddress !== undefined && configAddress !== p.config) return null;
  const scale = 10 ** c.tokenDecimal;
  return {
    baseMint: p.baseMint,
    quoteMint: c.quoteMint,
    creator: p.creator,
    solQuoted: c.solQuoted,
    baseDecimals: c.tokenDecimal,
    baseReserve: Number(p.baseReserveRaw) / scale,
    quoteReserveRaw: p.quoteReserveRaw,
    migrationThresholdRaw: c.migrationQuoteThresholdRaw,
    progress: c.migrationQuoteThresholdRaw === 0n
      ? 0
      : Number(p.quoteReserveRaw) / Number(c.migrationQuoteThresholdRaw),
    totalSupply: Number(c.preMigrationTokenSupplyRaw) / scale,
    complete: p.complete,
    hasSwap: p.hasSwap,
  };
}

/**
 * The curve expressed as this archive's `CurveState`, for a wrapped-SOL pool only.
 *
 * TWO THINGS ARE WRONG WITH THIS SHAPE FOR THIS VENUE and both are worth stating in the code rather than only in a
 * handoff note, because the next person to read it will otherwise assume the fields mean what they are named.
 *
 * 1. `CurveState` HAS NO ROOM FOR A QUOTE ASSET, so this returns null for the ~10% of DBC pools quoted in
 *    something other than wrapped SOL rather than writing a quantity of USDC into a field called `vSol`. Same
 *    refusal as `launchlab.ts`'s `decodeCurve`, same reason: `vSol` is SOL by name and by every consumer's
 *    assumption, and a 40 SOL buyout rule firing on 40 of something else is a published falsehood. A caller that
 *    wants the launch anyway - and it should - uses `poolCurve`.
 *
 * 2. `vTokens` AND `vSol` ARE FILLED WITH THE REAL RESERVES, because DBC has no virtual reserves to put there
 *    (note C). They are therefore honest numbers under misleading names, and the consequence is precise:
 *    `curve.ts`'s `price()` is `vSol / vTokens`, which for a constant-product curve is the marginal price and for
 *    this one is the average price everything filled at so far. On a young DBC curve that is far below the real
 *    price. `GRADUATION_V_SOL` is likewise pump.fun's 115, and DBC's threshold is per config - the fixture's is
 *    10.95 SOL. Neither helper may be applied to a reading from this function. `complete` is safe: it is the
 *    program's own statement.
 *
 * This is a widening the venue contract needs rather than a problem this file can solve, and it is recorded in the
 * handoff. Returning null for everything would have been the alternative, and `venues.ts` clause 9 already names
 * that shape for what it is: a check that cannot fail.
 */
export function curveState(poolB64: string, configB64: string, configAddress?: string): CurveState | null {
  const c = poolCurve(poolB64, configB64, configAddress);
  if (!c || !c.solQuoted) return null;
  const LAMPORTS = 1e9; // Only reachable for a WSOL pool, which is 9 decimals by definition of the mint.
  const quote = Number(c.quoteReserveRaw) / LAMPORTS;
  return {
    vTokens: c.baseReserve,
    vSol: quote,
    realTokens: c.baseReserve,
    realSol: quote,
    totalSupply: c.totalSupply,
    complete: c.complete,
    creator: c.creator,
  };
}
