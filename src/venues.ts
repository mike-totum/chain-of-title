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
import { decodeCreate, decodeTrade, PUMP_PROGRAM, RpcFeed, type DecodedCreate, type DecodedTrade } from "./feed/rpc.ts";
import { bondingCurveAddress, decodeCurveAccount, type CurveState } from "./rpc-http.ts";
import { LAUNCHLAB_PROGRAM, decodeCurve as decodeLaunchLabCurve } from "./feed/launchlab.ts";
import { LaunchLabFeed } from "./feed/launchlab-feed.ts";

/**
 * 7. A VENUE'S EVENTS DO NOT NECESSARILY ARRIVE IN A LOG, AND THIS INTERFACE ASSUMED THEY DID.
 *
 * Added 2026-09-11, before the second decoder rather than after it, because the assumption was invisible until
 * measured and would have been load-bearing by then.
 *
 * pump.fun and Raydium LaunchLab both emit Anchor events as `Program data:` log lines. Meteora DBC emits none at
 * all: it uses `emit_cpi!` exclusively, so its events exist only as self-CPI instruction data in
 * `meta.innerInstructions`, tagged with the Anchor event-CPI discriminator `e445a52e51cb9a1d` and followed by the
 * same 8-byte event discriminator and Borsh payload a log would have carried. Sampled live: LaunchLab 1 of 1
 * transactions carried log events, DBC 0 of 7 carried any and 7 of 7 carried inner CPI data.
 *
 * `feed/rpc.ts` reads only lines beginning `Program data: `, so a DBC subscription would have connected, stayed up,
 * reported healthy and ingested exactly nothing - the failure this project has now met four times in one day and
 * once already in Helius carrying two sockets while nothing arrived.
 *
 * The decoders themselves do not change: after the event-CPI tag is stripped, both channels hand over the identical
 * discriminator-plus-Borsh buffer. So the venue declares its channel and the feed does the extraction, which keeps
 * `decodeCreate` and `decodeTrade` honest about what they take - one event payload, however it reached us.
 *
 * DECLARATIVE UNTIL THE FEED HONOURS IT. `feed/rpc.ts` currently implements `logs` only. A venue declaring `cpi`
 * would be subscribed and silently produce nothing, so it must not be added to VENUES until the extraction path
 * exists. That is the same trap this clause is about, which is why it is written down rather than assumed.
 */
/**
 * 8. THE EVENT DOES NOT NECESSARILY SAY WHICH LAUNCH IT IS ABOUT, AND THIS INTERFACE ASSUMED IT DID.
 *
 * Found 2026-09-11 while writing the LaunchLab decoder, and it is the same fault as clause 7 one layer down: an
 * assumption true of pump.fun, invisible because pump.fun was the only venue, and load-bearing by the time a second
 * venue would have exposed it.
 *
 * Every pump.fun event carries `mint`, and its TradeEvent carries the trading wallet. LaunchLab's carry neither. A
 * `TradeEvent` names a `pool_state`; a `PoolCreateEvent` names a pool, a creator and the token's name, symbol and
 * uri - and no mint anywhere. Identity lives in the instruction's accounts, and `logsSubscribe` delivers logs and a
 * signature with no accounts at all. So `decodeCreate(d)` and `decodeTrade(d)`, which take a payload and return a
 * record naming a mint, cannot be satisfied by this venue from the live feed.
 *
 * WHAT THE SHAPE ACTUALLY IS. A venue's event identifies a launch by SOMETHING - a mint for pump.fun, a pool for
 * LaunchLab - and turning that into a mint may need a lookup the decoder cannot do synchronously. For LaunchLab the
 * lookup is one `getAccountInfo` on the pool, whose account carries both mints, both decimal scales and the
 * creator, cached forever after; roughly 9,400 reads a day at current launch rates, and nothing per trade. The
 * interface has to admit that step rather than pretend the payload was self-describing.
 *
 * RESOLVED 2026-09-12, and the resolution is `feed/launchlab-feed.ts`. Both events name the POOL in their first
 * field, so the feed keys on the pool, reads that account once and caches it forever: one `getAccountInfo` per pool,
 * nothing per trade. Ordering is kept by serialising every event for a pool behind that pool's own promise chain, so
 * a create still reaches the database before anything that follows it and different pools never wait on each other.
 * The payload-only decoders below are what could not be satisfied, and the interface now says so by making them
 * optional rather than by having them return null. See clause 9.
 */
/**
 * 9. A VENUE'S REAL CONTRACT IS ITS FEED, NOT ITS DECODERS, AND THIS INTERFACE HAD IT BACKWARDS.
 *
 * Written 2026-09-12, wiring the second venue. Clauses 7 and 8 each found an assumption that was true of pump.fun
 * and invisible while pump.fun was the only venue. This is the third and it is about this file: the interface asked
 * every venue for four functions that turn bytes into a record, LaunchLab could satisfy two of them, and the thing
 * it CAN do - subscribe and produce launches - was not on the interface at all.
 *
 * Nothing called any of the four. `curveAddress` and `decodeCurve` had no consumer anywhere in the repo; `curvepoll`
 * and `confirm` import pump.fun's directly from `rpc-http.ts`. So the registry described capabilities nobody used
 * and omitted the one thing `index.ts` actually needed, which it took from `VENUES[0]` by hand.
 *
 * The two it could not satisfy are the payload decoders (clause 8: the payload names a pool, not a launch). The
 * third, `curveAddress`, needed an answer it did not have - see CurveLocation. Only `decodeCurve` was fine as it
 * stood, which is why it is the one member below that did not change.
 *
 * `feed(url)` is the fix: a venue knows how it is observed, and the collector loops. The payload decoders stay,
 * optional, under `payload` - and ABSENCE IS THE STATEMENT. A venue whose events do not name the launch they are
 * about has no payload decoders, and saying that by leaving the key off is checkable; saying it with a function that
 * returns null every time is the same shape as a check that cannot fail.
 *
 * 10. WHAT A VENUE CANNOT ANSWER HAS TO BE ON THE VENUE, BECAUSE THE ROW CANNOT TELL.
 *
 * The one that would have done real damage, and it was found by measuring rather than by reading.
 *
 * pump.fun's TradeEvent carries the trading wallet. LaunchLab's does not: it names a pool and an amount and nobody.
 * So LaunchLab produces no `trades` rows, and `servicedb` computes the published outside-buyer count as
 * `COUNT(DISTINCT wallet)` over that table - which for a launch with no rows returns **0, not NULL**. Zero outside
 * buyers is the single most damaging thing this archive says about a launch: `assess` raises DANGER
 * `few_outside_buyers` on it and the front page counts it. Every LaunchLab graduation would have been published
 * carrying an accusation computed from the absence of a table it was never going to have rows in.
 *
 * `unknown never certifies` was already the rule and `curveBuyers === null` was already the mechanism. What was
 * missing is that nothing could produce the null, because SQL's COUNT will not. A venue therefore declares what its
 * stream can attribute, and the record build reads that declaration rather than inferring capability from row
 * counts. Absence of data as a finding, in the direction that accuses, is the one direction this project cannot
 * afford - and the guard is `venues.test.ts`, not this paragraph.
 */
export type EventChannel = "logs" | "cpi";

/**
 * What a venue's live stream can say about the wallet behind a curve trade.
 *
 * `wallets` - every trade event names its trader, so distinct-buyer counts, creator-sold and buyouts are all
 *   answerable from the stream (pump.fun).
 * `none` - the events name the pool and the amounts and no trader at all, so those questions are not answerable
 *   from this stream and the record must publish NULL for them rather than a count over an empty table
 *   (LaunchLab). It does not mean the venue is unwatched: its launches, its documents, its curve reserves and its
 *   graduations are all recorded, and its `runs` coverage is real. It means precisely one class of question has no
 *   answer here yet. See clause 10.
 */
export type TradeAttribution = "wallets" | "none";

/**
 * Where a launch's curve state lives, which is not always a function of the mint.
 *
 * `derived` - a PDA computable from the mint alone (pump.fun), so it is never stored: anyone can recompute it.
 * `recorded` - the account exists, but its address is not determined by the mint, so it has to be written down or
 *   it is lost. LaunchLab's pool PDA is seeded with the platform config and the quote mint, neither of which the
 *   mint fixes. This is a third answer, not a failure, and it exists because returning null for it would have
 *   collapsed into "the venue has no curve" - which clause 7's note on `curveAddress` already forbade in writing.
 * `none` - the venue has no curve account at all; completion can only be confirmed from a market.
 *
 * A PROPERTY OF THE VENUE, NOT A FUNCTION OF THE MINT, which is what it was first written as. Asking "does this
 * venue's curve address have to be stored" is a question about the venue, and answering it by deriving a PDA meant
 * a sha256 per launch to produce an address the caller discarded - and a throw on any mint that is not valid
 * base58, which is how a test of this exposed it. The address itself is `curveAddress` and is asked for only when
 * somebody wants the address.
 */
export type CurveLocation = "derived" | "recorded" | "none";

/** Decoders that work from an event payload alone. Only a venue whose events name the launch has these. Clause 9. */
export interface PayloadDecoders {
  /** Decode a creation event from one event payload, or null if this is not one. */
  decodeCreate(d: Buffer): DecodedCreate | null;
  /** Decode a trade event from one event payload, or null if this is not one. */
  decodeTrade(d: Buffer): DecodedTrade | null;
}

export interface LaunchVenue {
  /** Value written to `tokens.venue`. Stable forever: it is published, and renaming it rewrites history. */
  readonly id: string;
  /** Shown to readers. May change; `id` may not. */
  readonly label: string;
  /** Program whose events we subscribe to. */
  readonly program: string;
  /**
   * Where this venue's events come from. See clause 7. `logs` means `Program data:` lines; `cpi` means self-CPI
   * instruction data in `meta.innerInstructions`, which `feed/rpc.ts` does not read yet.
   */
  readonly events: EventChannel;
  /**
   * What this venue's stream can say about who traded. See clause 10. The record build reads this to decide whether
   * a buyer count is a measurement or a NULL, so it is a published fact about the archive, not an implementation note.
   */
  readonly tradeAttribution: TradeAttribution;
  /**
   * Construct the live feed for this venue. Clause 9: this is the member the collector actually needs, and it was
   * the one the interface did not have.
   */
  feed(url: string): RpcFeed;
  /** See clause 9. Absent for a venue whose events do not name the launch they are about. */
  readonly payload?: PayloadDecoders;
  /** Where this venue's curve accounts live, if it has them. */
  readonly curveLocation: CurveLocation;
  /** The curve account's address, when the mint determines it. Null for any venue whose `curveLocation` is not "derived". */
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
  events: "logs",
  // Every pump.fun TradeEvent carries the trading wallet, which is why this archive has outside-buyer counts at all.
  tradeAttribution: "wallets",
  feed: (url) => new RpcFeed(url, PUMP_PROGRAM),
  payload: { decodeCreate, decodeTrade },
  curveLocation: "derived",
  curveAddress: bondingCurveAddress,
  decodeCurve: decodeCurveAccount,
};

/**
 * Raydium LaunchLab, the second venue.
 *
 * No `payload`: its events name a pool, never a mint, so nothing here can turn a payload into a record on its own.
 * That is clause 8, and the absence of this key is the machine-readable form of it - `launchlab.ts` does export
 * decoders, but they need the instruction's accounts and the live feed has none, so binding them here would put a
 * pair of functions in the registry that return null for every event this venue ever emits.
 *
 * `tradeAttribution: "none"` is the load-bearing line. Its TradeEvent carries no wallet, the feed emits `curve`
 * readings rather than trades, and `servicedb` reads this to publish NULL where it would otherwise publish a count
 * over an empty table. See clause 10 for what that zero would have said about every graduation here.
 */
export const launchlab: LaunchVenue = {
  id: "launchlab",
  label: "Raydium LaunchLab",
  program: LAUNCHLAB_PROGRAM,
  events: "logs",
  tradeAttribution: "none",
  feed: (url) => new LaunchLabFeed(url),
  // The pool PDA is seeded with the platform config and the quote mint. The mint alone does not fix it, so the
  // address is read off the launch record's own `curve_account` column rather than derived. Not "we could not work
  // it out": the account is known, and this says where it is known FROM.
  curveLocation: "recorded",
  curveAddress: () => null,
  decodeCurve: decodeLaunchLabCurve,
};

/** Every venue the collector observes. A venue absent here is unwatched, and its launches are not in the record. */
export const VENUES: readonly LaunchVenue[] = [pumpfun, launchlab];

export const venueById = (id: string): LaunchVenue | undefined => VENUES.find((v) => v.id === id);

/**
 * SQL that is TRUE for a launch whose venue cannot name a trader. See clause 10.
 *
 * Here rather than in `servicedb.ts` so it can be tested against a real database without running the build script,
 * and so the list comes from the registry in the one place that holds it. A venue declares `tradeAttribution` and
 * the record build stops publishing counts of people for it; nobody has to remember a second file.
 *
 * `COALESCE(venue,'pumpfun')` because a row written before the column existed has no venue and every one of those
 * is a pump.fun launch - the same recorded reason the column's default is what it is.
 */
/**
 * The published columns that count PEOPLE, every one of which is a claim a venue without wallets cannot make.
 *
 * Listed here rather than in the record build so the two cannot drift: `venues.test.ts` checks that `servicedb.ts`
 * guards each of these, by name. `dev_pct` is deliberately not among them - the creator's share comes from the
 * creation transaction and is measured on every venue, which is the whole line between what a venue can and cannot
 * say. See clause 10.
 */
export const PERSON_COLUMNS = ["dev_sold", "unique_buyers", "curve_buyers", "snap30_buyers", "bundled_buyers"] as const;

/**
 * Wrap a published expression so it is NULL for a venue that cannot name a trader.
 *
 * A function rather than a string spliced in five places, because the failure this guards against is one of the
 * five being missed - and a missed one is invisible: it publishes a plausible zero. CASE rather than COALESCE
 * because COALESCE would evaluate the count before discarding it, which is both wasted work and a subquery running
 * against a table the venue has no rows in.
 */
export const nullForUnattributed = (expr: string, column = "venue"): string =>
  `CASE WHEN ${cannotAttributeSql(column)} THEN NULL ELSE ${expr} END`;

export function cannotAttributeSql(column = "venue"): string {
  const ids = VENUES.filter((v) => v.tradeAttribution !== "wallets").map((v) => `'${v.id.replace(/'/g, "''")}'`);
  // "0" and not "NULL": this is used inside NOT (...) as well as CASE WHEN, and NOT (NULL) is NULL, which would
  // silently drop every row from the update it guards on the day every venue can attribute its trades.
  return ids.length ? `COALESCE(${column},'pumpfun') IN (${ids.join(",")})` : "0";
}

/**
 * What the site is allowed to say about which venues it covers.
 *
 * `src/site.ts` keeps BRAND as the single place the product's name appears, for the same reason this exists: a name
 * written in forty places is forty places to be wrong. The site currently says "pump.fun" in its prose because
 * pump.fun is currently the only venue, and every one of those sentences becomes a false statement of scope on the
 * day a second one starts arriving. A reader cannot tell a claim that means "this venue" from one that means "every
 * venue we watch", and the archive's whole claim is about scope.
 *
 * So scope sentences ask here. A sentence genuinely ABOUT pump.fun - that it renounces mint authority on every
 * token, that its curve completes near 411 SOL - is not a scope sentence and stays written out, because it would be
 * wrong to generalise it. `venues.test.ts` holds the line between the two.
 */
export const venueLabels = (): string[] => VENUES.map((v) => v.label);

/** "pump.fun", or "pump.fun and Raydium LaunchLab", or "pump.fun, Raydium LaunchLab and Meteora DBC". */
export function venuePhrase(): string {
  return phraseOf(venueLabels());
}

function phraseOf(l: string[]): string {
  if (!l.length) return "no venue";
  if (l.length === 1) return l[0];
  return `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}

/**
 * The venues whose events name the trader, and therefore the only ones the buyer-count findings can be about.
 *
 * A finding counted over `curve_buyers` is computed from a column that is NULL for every venue that cannot
 * attribute (clause 10), so those launches are in neither the numerator nor the denominator. The sentence carrying
 * that finding has to say so, or it names a scope its own number does not cover - which is the same failure as a
 * page saying "pump.fun" when it means "everything we watch", pointed the other way.
 */
export const attributingVenues = (): LaunchVenue[] => VENUES.filter((v) => v.tradeAttribution === "wallets");

/** "pump.fun" - the venues a distinct-buyer finding is actually measured over. */
export const attributedPhrase = (): string => phraseOf(attributingVenues().map((v) => v.label));

/** True when some venue we watch cannot be included in a buyer-count finding, so the sentence needs a scope clause. */
export const someVenueUnattributed = (): boolean => attributingVenues().length < VENUES.length;

/**
 * "a pump.fun launch" / "a launch on any venue we cover". Used where the singular reads badly once there are
 * several, so the sentence does not have to be rewritten when the second venue lands.
 */
export const aLaunchHere = (): string =>
  VENUES.length === 1 ? `a ${VENUES[0].label} launch` : `a launch on any venue we cover`;

/** Where a reader can see this launch on the venue's own site. Null when the venue has no such page. */
export function venueLink(venueId: string | null | undefined, mint: string): { href: string; label: string } | null {
  const v = venueById(venueId ?? "pumpfun");
  if (!v) return null;
  const href = v.id === "pumpfun" ? `https://pump.fun/coin/${mint}` : null;
  return href ? { href, label: v.label } : null;
}
