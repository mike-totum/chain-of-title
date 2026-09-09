/**
 * The clean criteria, in one place.
 *
 * These rules decide whether we tell a stranger a token was not manufactured, which is the only claim this project
 * makes and the only one that can destroy it. They live here rather than inside the site generator so that the site,
 * the API and the labelled-set validator (`npm run labels`) all execute the *same* code — a validator that re-implements
 * the rules it is checking proves nothing about what visitors are shown.
 *
 * Two invariants hold everywhere below:
 *   1. Absence of evidence is never evidence. A launch we did not watch, a buyer count with no trade rows behind it,
 *      or a pool we could not read all produce UNKNOWN, never a clean result.
 *   2. Launch facts are permanent; pool balances are not. Nothing here quotes a pool balance — that is the caller's
 *      job, and the caller must read it at the moment it makes the claim. See `Reading` in site.ts.
 */
import type { DatabaseSync } from "node:sqlite";
import { profile, verdictLine, findBuyout } from "./operator.ts";

/** A single large buy that completes a curve is a buyout, not demand. */
export const BUYOUT_SOL = 40;

/**
 * What retention must never delete from `trades`, as one SQL fragment used by both pruners.
 *
 * The collector prunes itself (`pruneWorkingData` in index.ts) and `npm run prune` prunes by hand, and a rule that
 * holds in only one of them is not a rule — the buyout exemption lived as two copies of a string for exactly one day
 * before this needed a second clause.
 *
 * That second clause: the AMM trades on the mints a buyout wallet actually took. `wallet_flow.amm_sell` is computed
 * from them, and with only the buyout clause they aged out on the retention timer — so a wallet that sold 4,515 SOL
 * into buyers four days ago published a 0, silently, and read as a wallet that never sold. Absence of data as a
 * finding, in the direction that makes an operator look clean, which is the direction this project cannot afford.
 * 1,916 rows across the whole archive: it costs nothing to keep and cannot be rebuilt once dropped.
 */
/**
 * What retention must never delete from `tweets`.
 *
 * `tweets` was written by the old street/KOL firehose — a sample nobody uses, for a strategy that measured -13.8%,
 * and pruning that residue is correct. But `xevidence` now writes promotion evidence into the SAME table, keyed from
 * `token_promotion_hit`, and those rows are archive rather than working data: a post about a launch we have flagged
 * is retrievable exactly once, and its deletion is itself the event worth recording.
 *
 * Without this guard the outcome is worse than losing them. `token_promotion` and `token_promotion_hit` are not
 * pruned, so what survives is a row saying "we found 7 posts about this manufactured launch" pointing at seven rows
 * that no longer exist — evidence replaced by our own claim about evidence, by our own housekeeping. That is the
 * fourth time today that a bookkeeping step manufactured an absence.
 *
 * The clause is empty when `token_promotion_hit` does not exist, which is the case on any collector that has never
 * run xevidence — a subquery against a missing table throws, and a prune that dies is a prune that silently stops
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
    (venue = 'curve' AND side = 'buy' AND sol >= ${BUYOUT_SOL})
    OR (venue = 'amm' AND EXISTS (
          SELECT 1 FROM trades b
           WHERE b.wallet = trades.wallet AND b.mint = trades.mint
             AND b.venue = 'curve' AND b.side = 'buy' AND b.sol >= ${BUYOUT_SOL}))
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
 * is a reading useful for" — it is "how long are we willing to be wrong for". Staleness on a certificate does not
 * produce a missing answer, it produces a false all-clear, and that is the only error on this site that ends the
 * project. Everything else here can be minutes old and nobody is harmed.
 *
 * Five minutes because a pool is drained in a single transaction, so the true worst case is bounded only by how often
 * we look, and we have never measured the distribution of drain rates — any figure is a guess, so it should be a
 * short one. HOOD and HCAT held 2,677 and 2,050 SOL when measured and $21 and $19 hours later; we do not know how
 * fast that happened, which is precisely the reason not to be generous.
 *
 * It is affordable because certification only applies to launches that already passed every birth test — about 150 in
 * a 24-hour window, so roughly 30 reads a minute on our own schedule. If the refresher cannot keep up, the honest
 * response is a smaller candidate set or better RPC, never a wider window: widening trades a real guarantee for a
 * cosmetically fuller list.
 */
export const MAX_READING_AGE_MS = 5 * 60_000;

/**
 * Whether a pool reading can still carry a certificate. Fail-closed in both directions: no reading, or one older than
 * the window, means uncertified — which is the correct answer to "we do not currently know if you could sell this",
 * and is not the same as a warning.
 */
export const readingCertifies = (at: number | null | undefined, sol: number | null | undefined, now: number): boolean =>
  at != null && sol != null && now - at <= MAX_READING_AGE_MS && sol >= MIN_POOL_SOL;

export type Level = "DANGER" | "CAUTION" | "UNKNOWN";
export type Flag = { level: Level; text: string };
export type Assessment = {
  flags: Flag[];
  /** we watched this launch happen, so its creator share and buyer count are real observations */
  watched: boolean;
  buyout: ReturnType<typeof findBuyout>;
  /** distinct non-dev curve buyers, or null when no trade rows exist — null is unknown, not zero */
  curveBuyers: number | null;
  /**
   * Whether the curve is confirmed to have completed — a pool or the curve account's own `complete` bit, never the
   * vSOL inference alone. Published on the assessment rather than left a local, because every consumer that states a
   * manufacture conclusion needs the same gate, and a second derivation of it in the renderer is how the page came to
   * assert "nobody bought its curve" about tokens that never graduated at all.
   */
  completed: boolean;
};

export const TOKEN_COLUMNS = `mint, symbol, name, creator, created_at, late_discovery, dev_pct, dev_sold, unique_buyers,
  snap30_buyers, bundled_buyers, graduated, graduated_at, pool, vault_sol, vault_at, last_price, updated_at,
  rebuilt_at, rebuilt_complete, curve_buyers, venue, graduated_confirmed_by,
  -- what the launch claimed to be, and our commitments to the documents behind it. Off-chain and mutable at the
  -- source, which is exactly why the record page shows them and why they are read from here rather than re-fetched.
  description, uri, image, meta_at, meta_sha256, meta_bytes, image_sha256, image_bytes`;

/** Union of the collector's run intervals. A launch outside them happened while we were blind. */
export function coverageWindows(db: DatabaseSync): { a: number; b: number }[] {
  const runs = db.prepare("SELECT started_at, stopped_at FROM runs WHERE started_at IS NOT NULL ORDER BY started_at").all() as any[];
  const win: { a: number; b: number }[] = [];
  for (const r of runs) {
    const end = r.stopped_at ?? r.started_at, last = win[win.length - 1];
    if (last && r.started_at - last.b <= 180_000) last.b = Math.max(last.b, end); else win.push({ a: r.started_at, b: end });
  }
  return win;
}

// assess() runs once per token over every graduation in the window, so its statements are prepared once per database
// rather than once per call — preparing this inside the loop cost more than the queries themselves.
const curveBuyersStmt = new WeakMap<DatabaseSync, any>();
function curveBuyersQ(db: DatabaseSync) {
  let s = curveBuyersStmt.get(db);
  if (!s) {
    s = db.prepare(`SELECT COUNT(DISTINCT wallet) n, COUNT(*) rows FROM trades
      WHERE mint = ? AND venue='curve' AND side='buy' AND COALESCE(is_dev,0)=0`);
    curveBuyersStmt.set(db, s);
  }
  return s;
}

export function assess(db: DatabaseSync, t: any, covered: (ts: number) => boolean): Assessment {
  const flags: Flag[] = [];
  // A launch is judgeable if we watched it, or if its complete history was rebuilt from chain — the same on-chain
  // events, read later. This must be decided here rather than patched onto the result afterwards: the checks below
  // are skipped entirely for an unjudgeable token, so flipping the flag after the fact produced a rebuilt page for
  // USWS (wash factory: graduated instantly with one buyer) carrying no warnings at all.
  const watched = (!t.late_discovery && covered(t.created_at)) || !!t.rebuilt_complete;
  const bo = findBuyout(db, t.mint, BUYOUT_SOL);
  // tokens.unique_buyers also counts post-graduation AMM buyers, which is not what "outside buyers before it
  // graduated" means. Count from the trade rows; no rows at all is unknown, and unknown never certifies.
  // Prefer the stored count when it exists: it is the same number, and it is the only way the public service can
  // answer without carrying the whole trades table.
  const cb = t.curve_buyers != null ? { n: t.curve_buyers as number, rows: 1 } : curveBuyersQ(db).get(t.mint) as { n: number; rows: number };
  // A completely rebuilt launch has no rows in `trades` — its history was read from chain long afterwards and the
  // count was taken over the whole of it. Falling through to "unknown" there would make every rebuilt token
  // permanently unjudgeable, which defeats the point of rebuilding it.
  const curveBuyers = cb.rows > 0 ? cb.n : (t.rebuilt_complete ? (t.unique_buyers ?? null) : null);
  if (!watched) {
    flags.push({ level: "UNKNOWN", text: "We did not observe this launch, so its creator share and outside-buyer count are unknown. A manufactured token is indistinguishable from a real one once its float has been spread." });
    return { flags, watched, buyout: bo, curveBuyers, completed: false };
  }
  /**
   * The creator bought its own curve.
   *
   * The strongest single fact the record can hold about a launch, and until now it was never stated: the creator's
   * address appeared in the launch table and the same address appeared under "who took the curve" two sections
   * below, as two 44-character base58 strings a reader was left to compare for themselves.
   *
   * Split in two on purpose. That the creator bought is true whether or not the curve completed, so it is said
   * first and unconditionally. That the buy FUNDED the graduation asserts the graduation, and may only be said
   * once `completed` is confirmed — the same rule every statement below this point obeys.
   *
   * It does not change certification: `cleanAtBirth` already refuses any launch with a buyout at all.
   */
  const selfBought = bo && t.creator && bo.wallet === t.creator;

  const gradS = t.graduated_at ? (t.graduated_at - t.created_at) / 1000 : null;
  if (selfBought) flags.push({ level: "DANGER", text:
    `The creator bought its own bonding curve — ${bo!.sol.toFixed(0)} SOL, from the same wallet that created the token.` });
  if (t.dev_pct >= 50) flags.push({ level: "DANGER", text: `The creator took ${t.dev_pct.toFixed(1)}% of the entire supply in the first block. Nothing visible on-chain today shows this — the float has since been spread across wallets.` });
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
  // has its own coverage — it was nearly blind on 09-02 and good by 09-07 — so a missing pool is never evidence that
  // a curve did not complete. Unconfirmed means we say less, never that we say the opposite. Invariant 1, turned
  // around and pointed at our own inference, which is the direction it keeps being forgotten in.
  const confirmedBy = t.graduated_confirmed_by ?? (t.pool ? "pool" : null);
  const completed = gradS !== null && confirmedBy !== null;
  if (completed) {
    if (selfBought) flags.push({ level: "DANGER", text:
      "That purchase completed the curve, so the graduation was paid for by the creator rather than bought by demand." });
    if (curveBuyers === 0) flags.push({ level: "DANGER", text: "It completed its bonding curve with zero outside buyers. The graduation was funded by the creator, not by demand." });
    else if (curveBuyers !== null && curveBuyers < 10) flags.push({ level: "DANGER", text: `Only ${curveBuyers} outside buyer${curveBuyers === 1 ? "" : "s"} bought on the bonding curve before it graduated.` });
    if (gradS <= 60) flags.push({ level: "DANGER", text: `It left the curve ${Math.round(gradS)}s after launch — the float was taken before anyone could buy at a normal price.` });
  } else if (gradS !== null) {
    // Recorded as graduating, not confirmed. Say exactly that and make no claim about how it filled.
    flags.push({ level: "UNKNOWN", text: "Our feed recorded this curve reaching the graduation threshold, but we have not confirmed that against the curve account or a PumpSwap pool, so we do not state that it completed or how it filled." });
  }
  // A launch that never completed its curve and never found a buyer is the ordinary way a token dies, not evidence of
  // manufacture — 34,242 rows in this archive read `curve_buyers = 0, graduated = 0` and were being told, on their
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
 * always true. The liquidity gate is deliberately NOT here — it decays, so the caller applies it against a balance it
 * has just read.
 */
export const cleanAtBirth = (t: any, a: Assessment): boolean =>
  a.watched && !a.buyout && t.dev_pct < MAX_DEV_PCT && !t.dev_sold &&
  // `a.completed`, not `t.graduated_at`: a certificate says a curve filled slowly from real demand, and that sentence
  // cannot rest on the same unconfirmed inference the warnings are no longer allowed to rest on. In practice this
  // removes nothing today — certification separately needs a pool balance read in the last five minutes, and a pool
  // that can be read is itself the confirmation — but the two gates are independent and the weaker one must not be
  // the only thing standing between an inference and a clean result.
  a.curveBuyers !== null && a.curveBuyers >= MIN_BUYERS && a.completed && (t.graduated_at - t.created_at) > MIN_GRAD_MS &&
  !a.flags.some((f) => f.level === "DANGER");
