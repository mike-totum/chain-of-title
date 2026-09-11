/**
 * Raydium LaunchLab, decoded from its own Anchor events.
 *
 * The second venue, and the reason it is second: LaunchLab emits `Program data:` log lines with 8-byte event
 * discriminators, exactly as pump.fun does, so it reuses the log-reading path the collector already has. Meteora
 * DBC does not emit logs at all and needs a second ingestion path before any of its bytes can be read.
 *
 * WHY THIS IS ONE FILE AND NOT A REFACTOR. `venues.ts` holds the contract. Everything venue-specific about
 * LaunchLab is here: two discriminators, two byte layouts, and the account positions that carry identity.
 *
 * TWO WAYS IT IS NOT SHAPED LIKE PUMP.FUN, both of which change what a decoder can promise:
 *
 * 1. NEITHER EVENT CARRIES THE MINT. `TradeEvent` names a `pool_state`; `PoolCreateEvent` names a `pool_state`, a
 *    creator, a config and the token's name, symbol and uri - and no mint pubkey anywhere. `TradeEvent` does not
 *    carry the trading wallet either, where pump.fun's does. Identity lives in the instruction's accounts:
 *    `initialize` puts the pool at [5], the mint at [6] and the creator at [1]; `buy_exact_in` and `sell_exact_in`
 *    put the pool at [4], the mint at [9] and the trader at [0]. So these decoders take the accounts alongside the
 *    payload, and say so in their signature rather than returning a record with a hole in it.
 *
 * 2. IT IS A MULTI-TENANT ENGINE, NOT A LAUNCHPAD. 2,231 `PlatformConfig` accounts are registered against this
 *    program, each a front-end with its own brand and fee split - letsbonk.fun, cook.meme, boop.fun and the rest.
 *    `PoolCreateEvent.config` says which. That is worth recording eventually and is deliberately not recorded yet:
 *    `PlatformConfig.name` and `.web` are permissionless self-asserted strings, and there are configs calling
 *    themselves "Pump.fun" and pointing at pump.fun, which does not run on this program at all. Publishing those as
 *    identity would be the operator-attribution mistake this archive exists to document, committed by us.
 *
 * 3. IT IS NOT QUOTED IN SOL. This is the one that would have silently corrupted the record. A pump.fun curve is
 *    always SOL against the token; a LaunchLab pool names its quote mint per pool, and in an 84-swap sample not one
 *    was wrapped SOL - they were the PUMP token, several 8-decimal liquid-staking tokens, and various 6-decimal
 *    mints. Decoding every quote as 9-decimal SOL made the amounts wrong by exactly 1000x and 10x, which is how it
 *    was caught: cross-checking decoded amounts against the pool vault's own balance change produced disagreement
 *    ratios that clustered on powers of ten instead of scattering.
 *
 *    ASSUMPTIONS.md already records this exact failure on the other side of the house - a token with non-standard
 *    decimals produced a price 1000x too low and a fake 986x paper trade. So `solAmount` is stated only for a
 *    WSOL-quoted pool, and `decodeTrade` declines a pool quoted in anything else rather than publishing a number in
 *    the wrong unit. Every SOL-denominated rule in this archive - the 40 SOL buyout, MIN_POOL_SOL, buy_vol_sol -
 *    would otherwise fire on quantities that are not SOL.
 *
 * PREFIX ONLY, DELIBERATELY. `PoolCreateEvent` continues past the fields read here into `curve_param`, whose enum
 * variants each carry a different struct, so the tail's layout depends on which curve the launch chose. Reading the
 * fixed prefix and stopping is what `decodeTrade` already does for pump.fun, for the same reason: a layout that
 * varies by program version or by variant must not be able to shift a field we do assert.
 */
import { base58, type DecodedCreate, type DecodedTrade } from "./rpc.ts";
import type { CurveState } from "../rpc-http.ts";

export const LAUNCHLAB_PROGRAM = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

/**
 * Discriminators are taken from the on-chain IDL account (`E6wT2uNeoWUvDrwdch1R8ETsyewR1ZM4WAwsa5hLJK5Z`), not from
 * `raydium-io/raydium-idl` on GitHub, whose launchpad file was last touched 2026-05-18 and is missing instructions
 * the deployed program has. Written as literals rather than recomputed from a name, because unlike pump.fun's
 * `sha256("event:TradeEvent")` these are what the deployed program actually emits and the IDL is the citation.
 */
const TRADE_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const CREATE_DISC = Buffer.from([151, 215, 226, 9, 118, 161, 115, 174]);

const LAMPORTS = 1e9;
/** Base decimals for a LaunchLab launch. Every one sampled mints 6, and `PoolCreateEvent` carries the real value. */
const BASE_DECIMALS = 1e6;

/** Account positions carrying identity, from the IDL. Named so a layout change is a one-line diff, not a hunt. */
export const ACCOUNTS = {
  initialize: { pool: 5, mint: 6, creator: 1, quoteMint: 7 },
  swap: { pool: 4, mint: 9, user: 0, quoteMint: 10 },
} as const;

/** Wrapped SOL. The only quote asset whose amounts this archive can state in SOL. */
export const WSOL = "So11111111111111111111111111111111111111112";

/**
 * The accounts of the instruction that emitted the event, already resolved through any address lookup table.
 *
 * Resolved, not raw: a v0 transaction's `programIdIndex` and account indexes point into the static keys followed by
 * `meta.loadedAddresses`, and reading only the static half is what made `research/venueshare.ts` see 2.6% of
 * pump.fun's launches while reporting a confident ranking. Whoever calls this must have done that join already.
 */
export interface EventAccounts {
  readonly keys: readonly string[];
}

const at = (a: EventAccounts | undefined, i: number): string | null => a?.keys[i] ?? null;

/** The pool's quote asset for this instruction shape, or null if the accounts were not supplied. */
export const quoteMintOf = (a: EventAccounts | undefined, kind: "swap" | "initialize"): string | null =>
  at(a, ACCOUNTS[kind].quoteMint);

/**
 * Is this pool quoted in wrapped SOL? Distinguishes "we cannot price this in SOL" from "this is not a trade event",
 * which `decodeTrade` returning null would otherwise conflate. A caller that wants to record the launch anyway -
 * and it should, a launch is a launch whatever it is priced in - asks this first.
 */
export const isSolQuoted = (a: EventAccounts | undefined, kind: "swap" | "initialize"): boolean =>
  quoteMintOf(a, kind) === WSOL;

/**
 * A LaunchLab pool creation. Returns null when this is not one, never a partial record.
 *
 * The mint comes from the instruction accounts and there is no fallback, because a create we cannot name is not a
 * launch record - it is a hole that would be published as one. `bondingCurve` is the pool state account, which is
 * this venue's equivalent and what `curveAddress` has to agree with.
 */
export function decodeCreate(d: Buffer, accounts?: EventAccounts): DecodedCreate | null {
  if (d.length < 105 || !d.subarray(0, 8).equals(CREATE_DISC)) return null;
  const poolState = base58(d.subarray(8, 40));
  const creator = base58(d.subarray(40, 72));
  let o = 104; // 8 disc + pool_state 32 + creator 32 + config 32, then MintParams.decimals
  o += 1;
  const str = (): string | null => {
    if (o + 4 > d.length) return null;
    const len = d.readUInt32LE(o);
    o += 4;
    // A length that runs past the buffer means the layout moved. Refuse rather than return a truncated name: a
    // wrong name is published as the token's own claim about itself, which is the one thing this archive is for.
    if (len > 512 || o + len > d.length) return null;
    const s = d.subarray(o, o + len).toString("utf8");
    o += len;
    return s;
  };
  const name = str(), symbol = str(), uri = str();
  if (name === null || symbol === null || uri === null) return null;

  const mint = at(accounts, ACCOUNTS.initialize.mint);
  if (!mint) return null;
  return { name, symbol, uri, mint, bondingCurve: poolState, user: creator, creator };
}

/**
 * A LaunchLab trade. `amount_in` and `amount_out` swap meaning with the direction, which is the one place this
 * layout can silently produce a plausible wrong number, so it is resolved here rather than by the caller.
 */
export function decodeTrade(d: Buffer, accounts?: EventAccounts): DecodedTrade | null {
  if (d.length < 147 || !d.subarray(0, 8).equals(TRADE_DISC)) return null;
  // Not a SOL-quoted pool, so there is no SOL amount to report. See point 3 in the header: returning the number
  // anyway is how a quantity of some other token gets published as SOL and trips a 40 SOL buyout rule.
  if (!isSolQuoted(accounts, "swap")) return null;
  const u64 = (o: number) => Number(d.readBigUInt64LE(o));
  const isBuy = d[144] === 0; // TradeDirection: 0 Buy, 1 Sell
  const amountIn = u64(96), amountOut = u64(104);
  // Buy spends quote (SOL) for base (tokens); sell is the reverse. Getting this backwards would report every sale
  // as a purchase of the same size, which reads as a healthy market.
  const solRaw = isBuy ? amountIn : amountOut;
  const tokenRaw = isBuy ? amountOut : amountIn;

  const mint = at(accounts, ACCOUNTS.swap.mint);
  const user = at(accounts, ACCOUNTS.swap.user);
  if (!mint || !user) return null;

  return {
    mint,
    solAmount: solRaw / LAMPORTS,
    tokenAmount: tokenRaw / BASE_DECIMALS,
    isBuy,
    user,
    // LaunchLab's TradeEvent carries no timestamp. The caller stamps it from the block, exactly as a pump.fun trade
    // decoded without one would be; 0 here means "ask the block", never "the epoch".
    timestamp: 0,
    vSol: u64(56) / LAMPORTS,
    vTokens: u64(48) / BASE_DECIMALS,
    realSol: u64(88) / LAMPORTS,
    realTokens: u64(80) / BASE_DECIMALS,
    // Fees are absolute lamports here, not basis points, so the bps fields stay null rather than carrying a number
    // in the wrong unit. protocol + platform + creator + share, in SOL, is available if a caller wants it.
    feeBps: null,
    creator: null,
    creatorFeeBps: null,
  };
}

/** Total fee taken on a trade, in SOL. Separate from decodeTrade because DecodedTrade has nowhere to put it yet. */
export function tradeFeeSol(d: Buffer): number | null {
  if (d.length < 147 || !d.subarray(0, 8).equals(TRADE_DISC)) return null;
  const u64 = (o: number) => Number(d.readBigUInt64LE(o));
  return (u64(112) + u64(120) + u64(128) + u64(136)) / LAMPORTS;
}

/** The platform config this launch was created under: which front-end on the engine. Self-asserted, see the header. */
export function createPlatformConfig(d: Buffer): string | null {
  if (d.length < 104 || !d.subarray(0, 8).equals(CREATE_DISC)) return null;
  return base58(d.subarray(72, 104));
}

/**
 * The pool account, which is what makes this venue tractable without an RPC call per trade.
 *
 * `TradeEvent` names a `pool_state` and nothing else identifying, so a naive ingester would have to fetch the
 * transaction for every trade to learn which token it was. It does not: the pool account itself carries both mints,
 * both decimal scales, the creator, the platform config and the live reserves. One `getAccountInfo` the first time
 * a pool is seen answers every later trade on it for free.
 *
 * Offsets computed from the on-chain IDL's `PoolState`, walking the nested `VestingSchedule` (40 bytes) rather than
 * guessing: `base_mint` sits at 205 and is 64 bytes further into the account than a reader who skipped that struct
 * would look. Total account size 429.
 */
export interface LaunchLabPool {
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  creator: string;
  platformConfig: string;
  /** PoolStatus: 0 Fund (still on the curve), 1 Migrate, 2 Trade (graduated to an AMM). */
  status: number;
  vBase: number;
  vQuote: number;
  realBase: number;
  realQuote: number;
  /** True only for a wrapped-SOL pool. Everything SOL-denominated in this archive depends on it. */
  solQuoted: boolean;
}

export function decodePool(b64: string): LaunchLabPool | null {
  const b = Buffer.from(b64, "base64");
  // 429 exactly, and shorter means this is not a PoolState. Length is the check because the account is fixed size;
  // a discriminator match on a truncated buffer would still read garbage from the offsets below.
  if (b.length < 429) return null;
  const u = (o: number) => Number(b.readBigUInt64LE(o));
  const baseDecimals = b[18], quoteDecimals = b[19];
  const bScale = 10 ** baseDecimals, qScale = 10 ** quoteDecimals;
  const quoteMint = base58(b.subarray(237, 269));
  return {
    baseMint: base58(b.subarray(205, 237)),
    quoteMint,
    baseDecimals,
    quoteDecimals,
    creator: base58(b.subarray(333, 365)),
    platformConfig: base58(b.subarray(173, 205)),
    status: b[17],
    // Scaled by the pool's OWN decimals, read from the account, never assumed. This is the fix for the 1000x and
    // 10x errors described in point 3 of the header.
    vBase: u(37) / bScale,
    vQuote: u(45) / qScale,
    realBase: u(53) / bScale,
    realQuote: u(61) / qScale,
    solQuoted: quoteMint === WSOL,
  };
}

/**
 * The pool expressed as this archive's `CurveState`, for a SOL-quoted pool only.
 *
 * Null for anything else, and that is the point: `CurveState.vSol` and `.realSol` are SOL by name and by every
 * consumer's assumption, so filling them with a quantity of PUMP or an LST would put a wrong number into the one
 * structure the graduation and liquidity checks read. A non-SOL pool is not a curve we can express here; the caller
 * still has `decodePool` for everything that does not need a SOL figure.
 *
 * `complete` is the pool's own status leaving the fundraising phase, which is a reading of the venue's account
 * rather than an inference from our feed - the distinction `graduated_confirmed_by` already draws.
 */
export function decodeCurve(b64: string): CurveState | null {
  const p = decodePool(b64);
  if (!p || !p.solQuoted) return null;
  return {
    vTokens: p.vBase, vSol: p.vQuote, realTokens: p.realBase, realSol: p.realQuote,
    totalSupply: 0, complete: p.status !== 0, creator: p.creator,
  };
}
