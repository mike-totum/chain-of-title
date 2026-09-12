/**
 * The clean criteria, in one place.
 *
 * These rules decide whether we tell a stranger a token was not manufactured, which is the only claim this project
 * makes and the only one that can destroy it. They live here rather than inside the site generator so that the site,
 * the API and the labelled-set validator (`npm run labels`) all execute the *same* code - a validator that re-implements
 * the rules it is checking proves nothing about what visitors are shown.
 *
 * Two invariants hold everywhere below:
 *   1. Absence of evidence is never evidence. A launch we did not watch, a buyer count with no trade rows behind it,
 *      or a pool we could not read all produce UNKNOWN, never a clean result.
 *   2. Launch facts are permanent; pool balances are not. Nothing here quotes a pool balance - that is the caller's
 *      job, and the caller must read it at the moment it makes the claim. See `Reading` in site.ts.
 */
import type { DatabaseSync } from "node:sqlite";
import { profile, verdictLine, findBuyout } from "./operator.ts";
import { venueById } from "./venues.ts";

/**
 * Can this launch's venue name the wallet behind a curve trade?
 *
 * A launch whose venue cannot is watched, recorded and unjudged on one axis: we hold its creator, its share of
 * supply, its claim about itself and its curve, and we hold nothing about who bought. A venue this archive does not
 * know is treated as able to - it is either pump.fun predating the column, or a rebuild, and both are - because the
 * consequence of guessing wrong in the other direction is silently withdrawing findings that were measured.
 */
const attributesTrades = (venue: string | null | undefined): boolean =>
  (venueById(venue ?? "pumpfun")?.tradeAttribution ?? "wallets") === "wallets";

/** A single large buy that completes a curve is a buyout, not demand. */
export const BUYOUT_SOL = 40;

/**
 * What retention must never delete from `trades`, as one SQL fragment used by both pruners.
 *
 * The collector prunes itself (`pruneWorkingData` in index.ts) and `npm run prune` prunes by hand, and a rule that
 * holds in only one of them is not a rule - the buyout exemption lived as two copies of a string for exactly one day
 * before this needed a second clause.
 *
 * That second clause: the AMM trades on the mints a buyout wallet actually took. `wallet_flow.amm_sell` is computed
 * from them, and with only the buyout clause they aged out on the retention timer - so a wallet that sold 4,515 SOL
 * into buyers four days ago published a 0, silently, and read as a wallet that never sold. Absence of data as a
 * finding, in the direction that makes an operator look clean, which is the direction this project cannot afford.
 * 1,916 rows across the whole archive: it costs nothing to keep and cannot be rebuilt once dropped.
 */
/**
 * What retention must never delete from `tweets`.
 *
 * `tweets` was written by the old street/KOL firehose - a sample nobody uses, for a strategy that measured -13.8%,
 * and pruning that residue is correct. But `xevidence` now writes promotion evidence into the SAME table, keyed from
 * `token_promotion_hit`, and those rows are archive rather than working data: a post about a launch we have flagged
 * is retrievable exactly once, and its deletion is itself the event worth recording.
 *
 * Without this guard the outcome is worse than losing them. `token_promotion` and `token_promotion_hit` are not
 * pruned, so what survives is a row saying "we found 7 posts about this manufactured launch" pointing at seven rows
 * that no longer exist - evidence replaced by our own claim about evidence, by our own housekeeping. That is the
 * fourth time today that a bookkeeping step manufactured an absence.
 *
 * The clause is empty when `token_promotion_hit` does not exist, which is the case on any collector that has never
 * run xevidence - a subquery against a missing table throws, and a prune that dies is a prune that silently stops
 * happening. Found by the other session, who owns the data it protects.
 */
export function keepTweetEvidence(db: { prepare(sql: string): { get(...a: unknown[]): unknown } }): string {
  try {
    const t = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='token_promotion_hit'").get() as any;
    if (!t?.c) return "";
  } catch { return ""; }
  return "AND id NOT IN (SELECT tweet_id FROM token_promotion_hit WHERE tweet_id IS NOT NULL)";
}

export const KEEP_TRADE_EVIDENCE = `AND NOT (
    (market = 'curve' AND side = 'buy' AND sol >= ${BUYOUT_SOL})
    OR (market = 'amm' AND EXISTS (
          SELECT 1 FROM trades b
           WHERE b.wallet = trades.wallet AND b.mint = trades.mint
             AND b.market = 'curve' AND b.side = 'buy' AND b.sol >= ${BUYOUT_SOL}))
  )`;
/** Above this share of supply in the first block, the creator is the market. */
export const MAX_DEV_PCT = 20;
/** Distinct non-dev wallets that had to buy on the curve before it graduated. */
export const MIN_BUYERS = 30;
/** A curve that fills faster than this was taken, not bought. */
export const MIN_GRAD_MS = 60_000;
/** SOL that has to be in the pool for a position to be sellable near the quoted price. */
export const MIN_POOL_SOL = 40;
/**
 * How old a pool reading may be and still support a clean certificate.
 *
 * This is a criterion, not a tuning knob, so it lives here with the others. The question it answers is not "how long
 * is a reading useful for" - it is "how long are we willing to be wrong for". Staleness on a certificate does not
 * produce a missing answer, it produces a false all-clear, and that is the only error on this site that ends the
 * project. Everything else here can be minutes old and nobody is harmed.
 *
 * Five minutes because a pool is drained in a single transaction, so the true worst case is bounded only by how often
 * we look, and we have never measured the distribution of drain rates - any figure is a guess, so it should be a
 * short one. HOOD and HCAT held 2,677 and 2,050 SOL when measured and $21 and $19 hours later; we do not know how
 * fast that happened, which is precisely the reason not to be generous.
 *
 * It is affordable because certification only applies to launches that already passed every birth test - about 150 in
 * a 24-hour window, so roughly 30 reads a minute on our own schedule. If the refresher cannot keep up, the honest
 * response is a smaller candidate set or better RPC, never a wider window: widening trades a real guarantee for a
 * cosmetically fuller list.
 */
export const MAX_READING_AGE_MS = 5 * 60_000;

/**
 * Whether a pool reading can still carry a certificate. Fail-closed in both directions: no reading, or one older than
 * the window, means uncertified - which is the correct answer to "we do not currently know if you could sell this",
 * and is not the same as a warning.
 */
export const readingCertifies = (at: number | null | undefined, sol: number | null | undefined, now: number): boolean =>
  readingIsFresh(at, now) && sol != null && sol >= MIN_POOL_SOL;

/**
 * Whether a stored reading is recent enough to quote at all - the age half of `readingCertifies`, without the
 * threshold. The two were one test, and merging them meant a pool we had just read and found thin was reported the
 * same way as a pool we had not read: both simply vanished. "We read it and it holds 26 SOL" and "we have not read
 * it" are different sentences and the page now has to be able to say each.
 */
export const readingIsFresh = (at: number | null | undefined, now: number): boolean =>
  at != null && now - at <= MAX_READING_AGE_MS;

export type Level = "DANGER" | "CAUTION" | "UNKNOWN";
/**
 * `kind` marks a flag that describes the present rather than the launch. Only liquidity does today. It exists so a
 * consumer can tell the two apart without parsing English: a thin pool right now is a real warning and belongs on
 * the page, but it is not evidence about how the token was created and must never retract a finding about that.
 */
/**
 * `code` names the finding without its numbers, so it can be counted, grouped and translated. Anything that wants
 * to say "38 launches had this" had to regex the sentence before, which breaks the first time the wording improves
 * - and the wording on this page has improved four times in a day.
 */
export type FindingCode =
  | "creator_kept_supply" | "creator_bought_own_curve" | "filled_in_seconds" | "few_outside_buyers"
  | "creator_completed_curve" | "thin_pool_now" | "buyer_distributes";
export type Flag = { level: Level; text: string; kind?: "liquidity"; code?: FindingCode };
export type Assessment = {
  flags: Flag[];
  /** we watched this launch happen, so its creator share and buyer count are real observations */
  watched: boolean;
  buyout: ReturnType<typeof findBuyout>;
  /** distinct non-dev curve buyers, or null when no trade rows exist - null is unknown, not zero */
  curveBuyers: number | null;
  /**
   * Whether the curve is confirmed to have completed - a pool or the curve account's own `complete` bit, never the
   * vSOL inference alone. Published on the assessment rather than left a local, because every consumer that states a
   * manufacture conclusion needs the same gate, and a second derivation of it in the renderer is how the page came to
   * assert "nobody bought its curve" about tokens that never graduated at all.
   */
  completed: boolean;
};

/**
 * Columns one of the two databases has and the other does not, selected only where they are present.
 *
 * `curve_checked_at` and `curve_complete` are written by the record build from the collector's `curve_checks`
 * table, so the collector's own `tokens` has neither. Putting them in TOKEN_COLUMNS would throw on every query the
 * collector answers - which is exactly how `meta_sha256` took the live lookup down for a day. Callers append
 * `optionalColumns(db)` instead, and code that reads them must treat undefined as "not checked".
 *
 * It now runs in both directions, and that is worth saying out loud because the name does not. `snap30_buys` and
 * `dev_sold_at` are the opposite case: the collector has held them since the beginning and the published record has
 * never carried them, because the record is deliberately small and neither is load-bearing for a verdict. They are
 * here so the launch timeline can state them where they exist rather than not at all - the offline tree `npm run
 * site` writes is built from the collector and has them - and so that adding them to the record later needs no
 * change here. Undefined therefore means two different things depending on the file, and the timeline says neither:
 * it omits the line. A column absent from the file is not an absence on the launch, and printing one as the other is
 * the error this whole module exists to refuse.
 */
/**
 * A graduation our own on-chain check disproved: the feed recorded the threshold, we read the curve account, and it
 * had not completed. Applied in JavaScript rather than SQL because the collector's schema has no such column, and a
 * WHERE clause naming it would throw there. Undefined columns read as "not checked", which is the safe direction.
 */
/**
 * A graduation we read the curve for and found incomplete. An explicit 0, never a falsy one.
 *
 * This was `!t.curve_complete`, and `!null` is true, so the third of the four states this column encodes - read it,
 * the account was gone, learned nothing - was being counted as a disconfirmation. 191 launches were excluded from
 * every graduation count on the site because our RPC read found nothing, which is our failure published as a
 * finding about someone else's token: this project's recurring fault with the sign flipped, and the exact thing
 * the schema comment beside the column was written to prevent.
 *
 * Not read and read-but-gone are both "we do not know", and we do not know is never a finding.
 */
export const graduationDisproved = (t: any) => t.curve_checked_at != null && t.curve_complete === 0;
/**
 * Call this. Never spell it out again.
 *
 * The predicate above was corrected once and the correction did not travel: two callers had written
 * `curve_checked_at != null && !curve_complete` out longhand, and `!null` is true, so both went on folding "we read
 * it and the account was gone" into "we read it and it had not completed". One was the token page and the other was
 * `launch.graduated` in api/v1, so the fix that produced correction `disproved-conflated-with-unreadable` was live
 * in the helper and absent from the two surfaces most people actually read.
 *
 * A test pinned the function while the copies drifted, which is the failure this codebase keeps producing in a new
 * costume: the guard living somewhere the producer never passes through. Removing the possibility beats detecting
 * the failure, so there is now one spelling and every caller shares it.
 */

export const OPTIONAL_TOKEN_COLUMNS = ["curve_checked_at", "curve_complete", "snap30_buys", "dev_sold_at"];

/**
 * The name this database gives the trades column that says curve or amm.
 *
 * `trades.venue` was renamed to `trades.market` on 2026-09-11, and the two sides of that rename cannot deploy at
 * the same instant: the collector migrates its own database and rebuilds the record, while the web service opens
 * the record with `migrate: false` on purpose - it serves that file to the public and must not be the reason its
 * bytes differ from what servicedb built. So for a window, a reader can be handed either shape.
 *
 * Detecting it costs one pragma at query-build time and removes the ordering hazard completely: neither deploy has
 * to go first. Delete this and hard-code "market" once no record older than the rename is in circulation, which
 * means after the next DOI deposit at the earliest.
 */
export function tradeMarketColumn(dbh: any): string {
  try {
    const cols = dbh.prepare("PRAGMA table_info(trades)").all() as { name: string }[];
    return cols.some((c) => c.name === "market") ? "market" : "venue";
  } catch { return "market"; }
}

export function optionalColumns(dbh: any): string {
  try {
    const have = new Set((dbh.prepare("PRAGMA table_info(tokens)").all() as any[]).map((c) => c.name));
    const present = OPTIONAL_TOKEN_COLUMNS.filter((c) => have.has(c));
    return present.length ? `, ${present.join(", ")}` : "";
  } catch { return ""; }
}

export const TOKEN_COLUMNS = `mint, symbol, name, creator, created_at, late_discovery, dev_pct, dev_sold, unique_buyers,
  snap30_buyers, bundled_buyers, graduated, graduated_at, pool, vault_sol, vault_at, last_price, updated_at,
  rebuilt_at, rebuilt_complete, curve_buyers, venue, graduated_confirmed_by, create_sig, create_slot,
  -- The highest price we ever saw, and when. Read together or not at all: `peak_at` dates the reading exactly as
  -- `vault_at` dates a balance, and `peak_source` says whether a transaction was decoded at that price or a
  -- third-party feed merely reported one. All three are in both schemas, so they belong here rather than in
  -- OPTIONAL_TOKEN_COLUMNS; they were selected by nothing until the launch timeline needed a moment to put in it,
  -- which is this codebase's recurring shape - the column published, documented, and reachable only by machine.
  peak_price, peak_at, peak_source,
  -- what the launch claimed to be, and our commitments to the documents behind it. Off-chain and mutable at the
  -- source, which is exactly why the record page shows them and why they are read from here rather than re-fetched.
  description, uri, image, meta_at, meta_sha256, meta_bytes, image_sha256, image_bytes`;

/** Union of the collector's run intervals. A launch outside them happened while we were blind. */
export function coverageWindows(db: DatabaseSync, venue?: string): { a: number; b: number }[] {
  /**
   * Filter only if this database HAS the column, which a published record may not.
   *
   * `runs.venue` is added by openDb's migration, and the web service opens the record with `migrate: false` on
   * purpose - it serves that file to the public and must not be the reason its bytes differ from what servicedb
   * built. So a served record written before this change has a `runs` table with no `venue` column, and asking for
   * one throws "no such column" on every page that computes coverage, which is every page. Caught in rehearsal
   * rather than in production, unlike the identical mistake made in schema-doc an hour earlier.
   *
   * Where the column is absent the archive is single-venue by construction, so ignoring the filter is not a
   * fallback that hides anything: every window in that file is a pump.fun window.
   *
   * The column defaults to 'pumpfun', so even where it exists this is a no-op today. It stops being one the moment
   * a second venue is subscribed, which is the point.
   */
  const hasVenue = (() => {
    try { return (db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).some((c) => c.name === "venue"); }
    catch { return false; }
  })();
  const filter = venue && hasVenue;
  const sql = "SELECT started_at, stopped_at FROM runs WHERE started_at IS NOT NULL"
    + (filter ? " AND venue = ?" : "") + " ORDER BY started_at";
  const st = db.prepare(sql);
  const runs = (filter ? st.all(venue) : st.all()) as any[];
  const win: { a: number; b: number }[] = [];
  for (const r of runs) {
    const end = r.stopped_at ?? r.started_at, last = win[win.length - 1];
    if (last && r.started_at - last.b <= 180_000) last.b = Math.max(last.b, end); else win.push({ a: r.started_at, b: end });
  }
  return win;
}

/**
 * Was this archive watching THIS venue at this moment?
 *
 * `runs` records when the collector was observing, and with one venue a single interval could answer the question.
 * With two it cannot: a launch on a venue we were not subscribed to sat inside a window recorded for a different
 * one, and would have read as watched. Watched is what separates "no markers found" from "we were not looking",
 * so getting it wrong does not produce a gap - it produces a finding we cannot support. venues.ts clause 3.
 *
 * Windows are read once per database and cached per venue. A launch whose venue is missing is treated as pumpfun,
 * which is what every row in the archive predating the column actually is; it is a fact about the history, not a
 * default that a new venue may inherit, because `CreateEvent.venue` is stamped at decode for anything live.
 *
 * IT TAKES THE ROW, NOT A TIMESTAMP, AND THAT IS THE WHOLE POINT.
 *
 * The venue used to be an optional second argument, and four of the five callers omitted it - so they asked "were
 * you watching at this moment" and silently got pump.fun's answer. Harmless with one venue and wrong the day there
 * were two: `serve.ts` refused a LaunchLab launch it held a complete record of, told the reader "we have no record
 * of this launch", and offered to rebuild a pump.fun curve that does not exist. Found by rendering the page, not by
 * reading the code, which is the only way this class of fault has ever been found here.
 *
 * An optional argument is a default nobody types, and clause 3 says a venue we were not watching must never read as
 * clean. Taking the row makes the venue impossible to drop: there is no call that compiles without it.
 */
export interface CoverableLaunch {
  created_at: number;
  /** Missing or null means pump.fun: every row predating the column is one. See above. */
  venue?: string | null;
}

export function coverageFor(db: DatabaseSync): (launch: CoverableLaunch) => boolean {
  const byVenue = new Map<string, { a: number; b: number }[]>();
  return (launch: CoverableLaunch) => {
    /**
     * Checked at runtime because the type alone cannot check it.
     *
     * Every caller reads its row out of SQLite as `any`, so `covered(t.created_at)` type-checks perfectly: `any` is
     * assignable to anything, and the compiler reports nothing. That is exactly how the old optional argument
     * survived in four places. A number arriving here is a caller that dropped the venue, and the consequence is a
     * launch answered against the wrong venue's windows - silently, in the direction that calls an unwatched launch
     * watched. Loud is strictly better than that. venues.ts clause 3.
     */
    if (typeof launch !== "object" || launch === null)
      throw new TypeError(
        "coverage takes the launch row, not a timestamp. The venue decides which windows apply, so it cannot be " +
        "left out: pass the row (it needs created_at and venue). See venues.ts clause 3.");
    const v = launch.venue || "pumpfun";
    let win = byVenue.get(v);
    if (!win) { win = coverageWindows(db, v); byVenue.set(v, win); }
    const ts = launch.created_at;
    return win.some((w) => ts >= w.a && ts <= w.b);
  };
}

// assess() runs once per token over every graduation in the window, so its statements are prepared once per database
// rather than once per call - preparing this inside the loop cost more than the queries themselves.
const curveBuyersStmt = new WeakMap<DatabaseSync, any>();
function curveBuyersQ(db: DatabaseSync) {
  let s = curveBuyersStmt.get(db);
  if (!s) {
    s = db.prepare(`SELECT COUNT(DISTINCT wallet) n, COUNT(*) rows FROM trades
      WHERE mint = ? AND market='curve' AND side='buy' AND COALESCE(is_dev,0)=0`);
    curveBuyersStmt.set(db, s);
  }
  return s;
}

export function assess(db: DatabaseSync, t: any, covered: (launch: CoverableLaunch) => boolean): Assessment {
  const flags: Flag[] = [];
  // A launch is judgeable if we watched it, or if its complete history was rebuilt from chain - the same on-chain
  // events, read later. This must be decided here rather than patched onto the result afterwards: the checks below
  // are skipped entirely for an unjudgeable token, so flipping the flag after the fact produced a rebuilt page for
  // USWS (wash factory: graduated instantly with one buyer) carrying no warnings at all.
  const watched = (!t.late_discovery && covered(t)) || !!t.rebuilt_complete;
  const bo = findBuyout(db, t.mint, BUYOUT_SOL);
  // tokens.unique_buyers also counts post-graduation AMM buyers, which is not what "outside buyers before it
  // graduated" means. Count from the trade rows; no rows at all is unknown, and unknown never certifies.
  // Prefer the stored count when it exists: it is the same number, and it is the only way the public service can
  // answer without carrying the whole trades table.
  const cb = t.curve_buyers != null ? { n: t.curve_buyers as number, rows: 1 } : curveBuyersQ(db).get(t.mint) as { n: number; rows: number };
  // A completely rebuilt launch has no rows in `trades` - its history was read from chain long afterwards and the
  // count was taken over the whole of it. Falling through to "unknown" there would make every rebuilt token
  // permanently unjudgeable, which defeats the point of rebuilding it.
  const curveBuyers = cb.rows > 0 ? cb.n : (t.rebuilt_complete ? (t.unique_buyers ?? null) : null);
  if (!watched) {
    flags.push({ level: "UNKNOWN", text: "We did not observe this launch, so its creator share and outside-buyer count are not on record. Once a float has been spread, a launch that was assembled and one that was not look the same on-chain." });
    return { flags, watched, buyout: bo, curveBuyers, completed: false };
  }
  /**
   * Watched, and still unable to answer one whole class of question.
   *
   * Said out loud rather than left to be inferred from a blank field. Every check below that counts wallets is
   * skipped for these launches, and a page that simply omitted them would read as a launch we checked and cleared -
   * which is the same error as an unwatched launch reading as clean, one layer in. The reader is told which half of
   * the record exists. venues.ts clause 10.
   */
  if (!attributesTrades(t.venue)) flags.push({ level: "UNKNOWN", text:
    "This launch was recorded live, but its venue's trade events do not name the wallet that traded. Who bought on the bonding curve, and whether the creator sold, are therefore not on our record - not zero, and not checked and cleared. The creator's share of supply, the launch's own claim about itself, and whether the curve completed are recorded as normal." });
  /**
   * The creator bought its own curve.
   *
   * The strongest single fact the record can hold about a launch, and until now it was never stated: the creator's
   * address appeared in the launch table and the same address appeared under "who took the curve" two sections
   * below, as two 44-character base58 strings a reader was left to compare for themselves.
   *
   * Split in two on purpose. That the creator bought is true whether or not the curve completed, so it is said
   * first and unconditionally. That the buy FUNDED the graduation asserts the graduation, and may only be said
   * once `completed` is confirmed - the same rule every statement below this point obeys.
   *
   * It does not change certification: `cleanAtBirth` already refuses any launch with a buyout at all.
   */
  const selfBought = bo && t.creator && bo.wallet === t.creator;

  const gradS = t.graduated_at ? (t.graduated_at - t.created_at) / 1000 : null;
  if (selfBought) flags.push({ level: "DANGER", code: "creator_bought_own_curve", text:
    `The creator bought its own bonding curve - ${bo!.sol.toFixed(0)} SOL, from the same wallet that created the token.` });
  if (t.dev_pct >= 50) flags.push({ level: "DANGER", code: "creator_kept_supply", text: `The creator took ${t.dev_pct.toFixed(1)}% of the entire supply in the first block. Nothing visible on-chain today shows this - the float has since been spread across wallets.` });
  else if (t.dev_pct >= MAX_DEV_PCT) flags.push({ level: "CAUTION", text: `The creator took ${t.dev_pct.toFixed(1)}% of supply at launch.` });
  // Every statement below asserts that the curve *completed*, so none of them may be made until that is confirmed.
  //
  // `tokens.graduated` is written from two sources the column cannot tell apart. `curvepoll` reads the bonding curve
  // account and takes its own `complete` bit, which is authoritative. The tracker infers graduation from a decoded
  // trade reaching ~115 vSOL (`tracker.ts`), which is not. `graduated_confirmed_by` records which of those we have:
  // 'pool', 'curve_complete', or NULL for an inference nobody ever confirmed.
  //
  // The evidence that the inference fires spuriously is a speed gradient, not a raw count. Restricted to days when
  // pool discovery was working, confirmation runs 38-42% for curves flagged at or under 60 s against 87-88% at 10-60
  // min. It is not a clean rise across every bucket: past an hour it falls back to about 72% on 118 tokens, so the
  // contrast that carries the argument is fast against slow, and calling it monotonic would overstate it in the same
  // way the first attempt at this measurement did. Detection improving over the week cannot produce even the fast
  // versus slow contrast, because pool discovery does not know how quickly a curve filled. Of 628 recent fast-flagged
  // tokens without confirmation, exactly one had a creator holding 50% or more of supply.
  //
  // The converse does not hold, and reading it that way would be the project's own besetting error. Pool discovery
  // has its own coverage - it was nearly blind on 09-02 and good by 09-07 - so a missing pool is never evidence that
  // a curve did not complete. Unconfirmed means we say less, never that we say the opposite. Invariant 1, turned
  // around and pointed at our own inference, which is the direction it keeps being forgotten in.
  const confirmedBy = t.graduated_confirmed_by ?? (t.pool ? "pool" : null);
  const completed = gradS !== null && confirmedBy !== null;
  if (completed) {
    // States what the purchase did, not what it was for. "Bought by demand" is a claim about other people's
    // intentions, which we do not observe and do not get to characterise.
    if (selfBought) flags.push({ level: "DANGER", code: "creator_completed_curve", text:
      "That purchase is what completed the curve: the token left the curve on the creator's own money." });
    if (curveBuyers === 0) flags.push({ level: "DANGER", code: "few_outside_buyers", text: "It completed its bonding curve with zero outside buyers on record." });
    else if (curveBuyers !== null && curveBuyers < 10) flags.push({ level: "DANGER", code: "few_outside_buyers", text: `Only ${curveBuyers} outside buyer${curveBuyers === 1 ? "" : "s"} bought on the bonding curve before it graduated.` });
    if (gradS <= 60) flags.push({ level: "DANGER", code: "filled_in_seconds", text: `It left the curve ${Math.round(gradS)}s after launch.` });
  } else if (gradS !== null && graduationDisproved(t)) {
    /**
     * Checked and disproved, which is not the same as unchecked and was being reported as if it were. Our feed
     * recorded a threshold event; reading the curve account afterwards showed it was not complete. 3,195 rows in
     * the published archive are in this state and every one of them was telling readers only that we "have not
     * confirmed" it - understating what we actually know, about the one field this archive is most often wrong on.
     */
    flags.push({ level: "UNKNOWN", text: `Our feed recorded this curve reaching the graduation threshold, but when we read the curve account${
      t.curve_checked_at ? ` on ${new Date(Number(t.curve_checked_at)).toISOString().slice(0, 10)}` : ""} it was not complete. We do not state that this curve graduated.` });
  } else if (gradS !== null) {
    // Recorded as graduating, not confirmed. Say exactly that and make no claim about how it filled.
    flags.push({ level: "UNKNOWN", text: "Our feed recorded this curve reaching the graduation threshold, but we have not confirmed that against the curve account or a PumpSwap pool, so we do not state that it completed or how it filled." });
  }
  // A launch that never completed its curve and never found a buyer is the ordinary way a token dies, not evidence of
  // manufacture - 34,242 rows in this archive read `curve_buyers = 0, graduated = 0` and were being told, on their
  // own public page, that they "completed [their] bonding curve" and that "the graduation was funded by the creator",
  // one of them about a creator holding 1.7% of supply. Never assert an event absent from the record, and never state
  // a mechanism the record does not establish.
  if (t.dev_sold) flags.push({ level: "CAUTION", text: "The creator sold while we were watching." });
  if (bo) {
    const p = profile(db, bo.wallet);
    const line = verdictLine(p);
    if (line) flags.push({ level: p.ammSell > p.ammBuy * 3 && p.ammSell >= 20 ? "DANGER" : "CAUTION", text: line });
  }
  return { flags, watched, buyout: bo, curveBuyers, completed };
}

/**
 * Everything the launch record has to say about whether a token was manufactured. Facts about the past: once true,
 * always true. The liquidity gate is deliberately NOT here - it decays, so the caller applies it against a balance it
 * has just read.
 */
export const cleanAtBirth = (t: any, a: Assessment): boolean =>
  a.watched && !a.buyout && t.dev_pct < MAX_DEV_PCT && !t.dev_sold &&
  // `a.completed`, not `t.graduated_at`: a certificate says a curve filled slowly from real demand, and that sentence
  // cannot rest on the same unconfirmed inference the warnings are no longer allowed to rest on. In practice this
  // removes nothing today - certification separately needs a pool balance read in the last five minutes, and a pool
  // that can be read is itself the confirmation - but the two gates are independent and the weaker one must not be
  // the only thing standing between an inference and a clean result.
  a.curveBuyers !== null && a.curveBuyers >= MIN_BUYERS && a.completed && (t.graduated_at - t.created_at) > MIN_GRAD_MS &&
  !a.flags.some((f) => f.level === "DANGER");
