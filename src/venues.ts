/**
 * What a launch venue has to provide, and what onboarding one is not allowed to do.
 *
 * The record format has always been venue-neutral - `tokens.venue` exists and every published row currently reads
 * `pumpfun` - but the collector is not: the program id, the two Anchor discriminators, the byte layouts and the
 * curve PDA are constants in `feed/rpc.ts` and `rpc-http.ts`. This is the seam between the parts that are one
 * venue's and the parts that are every venue's, so the second one is a file rather than a refactor.
 *
 * WHY THIS IS THE FIRST MILESTONE AND NOT THE LAST
 *
 * Breadth expires; depth does not. Every on-chain fact about a pump.fun launch from last week is still on chain and
 * an archival node will rebuild it next year for the same price. A launch happening on another venue right now is
 * observable only right now - which is the founding argument of this project, applied for a year to one venue and
 * not to the rest. pump.fun runs at 62-80% of Solana launches today, and LetsBonk held more than half of that market
 * at a point in 2025 before pump.fun recovered. A single-venue collector would have watched the minority venue for
 * months without knowing.
 *
 * THE CONTRACT, WRITTEN BEFORE THE CODE THAT WILL HAVE TO SATISFY IT
 *
 * This repo already does this once - HANDOFF banked the seed-merge criteria before the merge existed, so review had
 * something to check against rather than a description of what had been built. Venue onboarding is the next change
 * of that size, and every clause below is here because something has already gone wrong in its shape.
 *
 * 1. A BULK IMPORT ENFORCES NOTHING. Onboarding a venue is an arrival of rows that are all new, and that is exactly
 *    the branch no policy governs. `TOKEN_POLICY` in db.ts is an ON CONFLICT DO UPDATE clause: it resolves conflicts
 *    and says nothing about inserts. mergeSeed's INSERT ... SELECT carried the seed's columns verbatim straight past
 *    it and produced 1,255 launches holding a pool balance with no reading time - a pair the policy two lines above
 *    forbids in writing. A merge policy is not a schema constraint.
 *
 * 2. SO THE INVARIANTS GO ON THE TABLE, AND THIS IS THE ONE MOMENT THEY ARE FREE. SQLite takes
 *    `CHECK ((vault_sol IS NULL) = (vault_at IS NULL))`, which binds INSERT and UPDATE alike and cannot be bypassed
 *    by an import path nobody thought about. Adding one to a live table means rebuilding it, and pump.db is 6.5 GB -
 *    which is why it has not happened. A new or widened schema is when that cost is zero. The pairs `servicedb`'s
 *    coherence guard asserts are the candidate list; the guard is the last line of defence and should not be the
 *    only one.
 *
 * 3. COVERAGE IS PER VENUE OR IT IS A LIE. `runs` records when the collector was observing, and with two venues a
 *    single interval cannot answer "were you watching THIS launch". A venue we do not watch must read as unwatched,
 *    never as clean, and the claim the site makes is "every Solana launch we watched" - never "every Solana launch".
 *
 * 4. NO VENUE MAY QUIETLY BECOME THE DEFAULT. `venue` is NOT NULL with a default of 'pumpfun' because every row
 *    predates the column. A row arriving from a second venue that forgets to set it inherits that default and is
 *    published as a pump.fun launch. Set it explicitly at the point of decode, here, and never rely on the default
 *    again.
 *
 * 5. ONBOARDING MUST NOT REQUIRE A MERGE. Each mergeSeed run writes a full-size copy of the database first; tonight's
 *    was 5.3 GB and two stale ones had taken the volume to 88%. A per-venue merge is the fastest way to fill a disk,
 *    and a full disk drops launches, which is the one failure that cannot be undone. A venue is a subscription and a
 *    decoder, not an import.
 *
 * 6. PROVE INGESTION, NOT LIVENESS. After adding a venue, compare two timestamped [status] lines and confirm the new
 *    venue's own counter advanced. The process staying up proves nothing: Helius carried two concurrent
 *    logsSubscribe connections for exactly as long as it took to look healthy while ingestion sat at zero.
 */
import { decodeCreate, decodeTrade, PUMP_PROGRAM, type DecodedCreate, type DecodedTrade } from "./feed/rpc.ts";
import { bondingCurveAddress, decodeCurveAccount, type CurveState } from "./rpc-http.ts";

export interface LaunchVenue {
  /** Value written to `tokens.venue`. Stable forever: it is published, and renaming it rewrites history. */
  readonly id: string;
  /** Shown to readers. May change; `id` may not. */
  readonly label: string;
  /** Program whose logs carry this venue's events, and the subscription target. */
  readonly program: string;
  /** Decode a creation event from one `Program data:` payload, or null if this is not one. */
  decodeCreate(d: Buffer): DecodedCreate | null;
  /** Decode a trade event from one `Program data:` payload, or null if this is not one. */
  decodeTrade(d: Buffer): DecodedTrade | null;
  /**
   * Address of the account holding this launch's curve state, derived from the mint.
   *
   * Returning null is a legitimate answer for a venue with no curve - it means completion cannot be confirmed from
   * an account and must come from a market, exactly as `graduated_confirmed_by` already distinguishes. It must never
   * mean "we could not work it out".
   */
  curveAddress(mint: string): string | null;
  /** Decode that account. Null means the bytes were not a curve, never that the curve is incomplete. */
  decodeCurve(b64: string): CurveState | null;
}

/**
 * pump.fun, expressed against the existing decoders rather than reimplemented.
 *
 * Deliberately a binding and not a copy: if this drifted from what the collector actually runs, the abstraction
 * would be describing a venue we do not observe, and the first thing anyone would trust it for is telling two
 * venues apart.
 */
export const pumpfun: LaunchVenue = {
  id: "pumpfun",
  label: "pump.fun",
  program: PUMP_PROGRAM,
  decodeCreate,
  decodeTrade,
  curveAddress: bondingCurveAddress,
  decodeCurve: decodeCurveAccount,
};

/** Every venue the collector observes. A venue absent here is unwatched, and its launches are not in the record. */
export const VENUES: readonly LaunchVenue[] = [pumpfun];

export const venueById = (id: string): LaunchVenue | undefined => VENUES.find((v) => v.id === id);
