/**
 * The machine-readable record - `/api/v1/…`, served live by `serve.ts` and mirrored into the offline tree by
 * `site.ts --pages`.
 *
 * Why this is its own module and not a `JSON.stringify` at each call site: a record page and its JSON must never be
 * able to say different things about the same launch. `render.ts` exists for exactly that reason on the HTML side,
 * and the same argument applies with more force here - an integrator's users never see our page, so a JSON shape that
 * quietly diverged would be wrong in public and invisible to us. Both surfaces are handed the *same* `Assessment`
 * (from `provenance.ts`) and the same `Reading`, and both render the same `verdict()`.
 *
 * The one invariant worth stating twice, because an integrator will write `if (!clean) warn()` and we have to make
 * that safe: **absence of evidence is never a clean result.** A launch we did not watch returns
 * `cleanAtBirth: null` and `verdict.level: "UNKNOWN"` - never `false` (which reads as a finding we did not make) and
 * never `true`. Any consumer that treats null as clean is doing so against the documented contract.
 */
import { graduationDisproved, type Assessment } from "./provenance.ts";
import { verdict, CANONICAL_HOST, type Reading } from "./render.ts";
import type { Profile } from "./operator.ts";

export const API_VERSION = "v1";
export const LICENSE = "CC0-1.0";

/**
 * The published limits. They live here, with the rest of the contract, rather than in the server that enforces them,
 * because the API page states these numbers to strangers - and a documented limit that no longer matches the enforced
 * one is a promise we are quietly breaking.
 *
 * Reads are deliberately absent: they are unmetered, and that is the product. Only reconstruction is bounded, because
 * every rebuild spends real money on thousands of archival RPC reads and the request comes from the open internet.
 */
export const PER_IP_PER_HOUR = 5;
export const GLOBAL_PER_HOUR = 60;
export const GLOBAL_PER_DAY = 400;

/** Milliseconds are what the database holds; ISO-8601 is what a consumer in another language can read. Publish both. */
const at = (ms: number | null | undefined) => (ms == null ? null : { ms, iso: new Date(ms).toISOString() });

export type Coverage = { from: number | null; downtimeMinutes: number; builtAt: number | null };

/** Common envelope. Every response carries where it came from and under what terms, including the errors. */
const envelope = (cov: Coverage, path: string) => ({
  apiVersion: API_VERSION,
  coverage: {
    from: at(cov.from),
    downtimeMinutes: Math.round(cov.downtimeMinutes),
    note: "Launches outside these windows were not observed. We rebuild them from chain history on request; until that succeeds their provenance is unknown, not clean.",
  },
  /**
   * `asOf` describes the DATA, not this response. It used to be Date.now(), which meant the API stamped the current
   * time on an archive that can be hours old: production served `launches: 143102, asOf: 18:18` while the record it
   * was reading had been built at 16:01 and the collector already held 146,061. A consumer reads `asOf` to decide
   * how much to trust a number, so pointing it at the clock rather than at the data made it worse than absent.
   *
   * The record carries its own build time in `meta.built_at`; that is what belongs here. `generatedAt` keeps the
   * response time for anyone who wants it, under a name that cannot be mistaken for freshness of the archive.
   */
  asOf: at(cov.builtAt),
  generatedAt: at(Date.now()),
  source: CANONICAL_HOST ? `${CANONICAL_HOST}${path}` : path,
  license: LICENSE,
});

/**
 * One launch record. `origin` says how we know: "observed" - watched live from creation; "rebuilt" - reconstructed
 * from the bonding curve's complete transaction history, which is the same on-chain events read later.
 */
export function tokenRecord(
  t: any, a: Assessment, r: Reading | null, origin: "observed" | "rebuilt", clean: boolean, cov: Coverage,
): object {
  const v = verdict(t, a, clean);
  const gradMs = t.graduated_at && t.created_at ? t.graduated_at - t.created_at : null;
  return {
    ...envelope(cov, `/t/${t.mint}.html`),
    mint: t.mint,
    symbol: t.symbol ?? null,
    name: t.name ?? null,
    /**
     * The launchpad this token was launched on. Always "pumpfun" today - the collector has only ever watched that one
     * program - but it is published from the day the column exists rather than the day a second venue arrives, so a
     * consumer can branch on it without ever having to assume that an absent field meant pump.fun.
     */
    venue: t.venue ?? null,
    // The answer, and the only field a caller should branch on. `label`/`why` are the same sentences the page prints.
    verdict: { level: v.level, label: v.label, why: v.why },
    // true = the launch record shows no sign of manufacture. false = it failed at least one test.
    // null = we did not observe it and could not rebuild it. NULL IS NOT CLEAN.
    cleanAtBirth: a.watched ? clean : null,
    observedAtLaunch: a.watched,
    origin: a.watched ? origin : null,
    // Facts about the first blocks of this token's life. Once true, always true - which is why they can be cached
    // hard, and why they are the only thing here an operator cannot buy back later.
    launch: a.watched ? {
      createdAt: at(t.created_at),
      creator: t.creator || null,
      creatorSupplyPct: t.dev_pct ?? null,
      creatorSold: !!t.dev_sold,
      curveBuyers: a.curveBuyers,
      buyersFirst30s: origin === "observed" ? (t.snap30_buyers ?? null) : null,
      bundledBuyers: origin === "observed" ? (t.bundled_buyers ?? null) : null,
      /**
       * Our best knowledge, not our first observation. This was `!!t.graduated` - the raw threshold event from the
       * feed - and 3,195 records in the published archive carried `true` for curves we had since read on-chain and
       * found incomplete. A field that is knowably wrong is worse than a missing one, because a reader cannot tell
       * which rows to distrust. The raw observation is kept beside it rather than discarded.
       */
      graduated: !!t.graduated && !graduationDisproved(t),
      /** What the feed saw at the time: the curve reached the graduation threshold in our decoded events. */
      graduationObserved: !!t.graduated,
      /**
       * The on-chain check, where we have run one. `complete: false` is a disproof, not an absence: we read the
       * curve account and it had not completed. Undefined where the database does not carry the check at all.
       */
      graduationCheck: t.curve_checked_at == null ? null : {
        checkedAt: { ms: Number(t.curve_checked_at), iso: new Date(Number(t.curve_checked_at)).toISOString() },
        complete: !!t.curve_complete,
      },
      /**
       * How we know the curve completed: "pool", "curve_complete", or null. **Null does not mean it did not
       * graduate** - it means we inferred graduation from decoded trade events reaching the threshold and never
       * confirmed it. A PumpSwap pool cannot exist unless the curve completed, so a pool is proof; its absence is
       * only the absence of proof. Measured on the days our pool discovery was working, the inference is confirmed
       * 87% of the time for curves that took 10-60 minutes and 38% of the time for curves flagged as completing
       * inside 60 seconds, so treat an unconfirmed fast graduation as unknown rather than as a finding.
       */
      graduationConfirmedBy: t.graduated_confirmed_by ?? null,
      graduatedAt: at(t.graduated_at),
      secondsToGraduate: gradMs === null ? null : Math.round(gradMs / 1000),
      /**
       * The transaction every field above was decoded from - the one carrying the creator's initial buy, and so the
       * one `creatorSupplyPct` is computed from. Present for 88% of launches. **null means we did not record one**
       * (the launch predates the field, or we found it late, or its trade rows aged out before we backfilled): it is
       * never a claim that the launch has no creation transaction, and it must not be rendered as one.
       */
      transaction: t.create_sig ? { signature: t.create_sig, slot: t.create_slot ?? null } : null,
    } : null,
    curveBuyout: a.buyout ? {
      wallet: a.buyout.wallet,
      sol: a.buyout.sol,
      at: at(a.buyout.ts),
      // The transaction the buyout was decoded from. null where retention removed the row before we published this.
      signature: a.buyout.sig ?? null,
      secondsAfterLaunch: t.created_at ? Math.round((a.buyout.ts - t.created_at) / 1000) : null,
      priors: CANONICAL_HOST ? `${CANONICAL_HOST}/api/${API_VERSION}/wallet/${a.buyout.wallet}` : null,
    } : null,
    /**
     * Deliberately separate from `launch`, and deliberately stamped. A pool balance is a fact about now that decays
     * within minutes; quoting one without saying when it was read is the exact failure this project accuses the
     * incumbent scanners of. `fresh` is true only when it was read from chain to answer this request.
     */
    pool: r ? { sol: r.sol, readAt: at(r.at), fresh: r.fresh } : null,
    flags: a.flags.map((f) => ({ level: f.level, text: f.text })),
  };
}

/**
 * A wallet's priors: every bonding curve it has bought outright, and what it did with the tokens afterwards.
 *
 * A wallet we have never seen is the dangerous case. Rendered naively it comes back as `curveBuyouts: 0,
 * marketSold: 0` - a row of zeros that reads, to any consumer, as a wallet with a clean history, when what we
 * actually mean is that it does not appear in this archive at all. This is the project's recurring failure shape
 * (a record database carrying only buyouts once reported "sold 0 SOL" about a wallet that had sold 3,512), so an
 * absent wallet reports `inArchive: false` and **nulls, never zeros**. Zeros here are measurements.
 */
export function walletRecord(w: string, p: Profile, line: string | null, cov: Coverage): object {
  const inArchive = p.buyouts.length > 0 || p.tokens > 0;
  return {
    ...envelope(cov, `/w/${w}.html`),
    wallet: w,
    inArchive,
    note: inArchive ? null
      : "This wallet does not appear in our archive: it has not bought out a bonding curve or traded a token we tracked inside our coverage window. That is not a statement about the wallet: the figures below are unknown, not zero.",
    // The plain sentence the page leads with, or null when the wallet has no pattern worth stating. Never invented:
    // `verdictLine` returns null rather than reaching for something to say.
    summary: line,
    operatorCluster: p.cluster,
    operatorPolicy: p.policy,
    curveBuyouts: inArchive ? p.buyouts.length : null,
    tokensTouched: inArchive ? p.tokens : null,
    /** All SOL figures are "in this archive", not "ever". A wallet's record here starts when our coverage does. */
    curveSol: inArchive ? p.curveSol : null,
    marketBought: inArchive ? p.ammBuy : null,
    marketSold: inArchive ? p.ammSell : null,
    buyouts: p.buyouts.map((b) => {
      /**
       * A gap of zero is not a measurement, and 1,692 of 1,736 buyouts on record have one.
       *
       * Trade timestamps are wall-clock at ingest, taken once per batch of websocket events - so an exact match with
       * the launch time means the two events arrived in the same batch. That is almost certainly the same block, but
       * the archive cannot prove it, because it carries no creation slot to check against. Publishing `0` would let
       * an integrator render "bought the curve 0 hours after launch" in their own UI, reintroducing precisely the
       * overclaim the site removed from its own pages. So: null, and a flag that says why it is null.
       */
      const sameBatch = b.dormantH !== null && b.dormantH <= 0;
      return {
        mint: b.mint, symbol: b.symbol, sol: b.sol, at: at(b.ts),
        hoursAfterLaunch: sameBatch ? null : b.dormantH,
        sameBatchAsLaunch: sameBatch,
        record: CANONICAL_HOST ? `${CANONICAL_HOST}/api/${API_VERSION}/token/${b.mint}` : null,
      };
    }),
  };
}

/**
 * What this archive currently holds, so a consumer can decide whether to trust an UNKNOWN.
 *
 * `launches` is the count observed from the creation transaction, matching every figure on the pages. A caller
 * wanting the size of the file wants `records`, which also counts launches restored after creation and those rebuilt
 * from chain history. One word, one meaning, everywhere.
 */
export function statusRecord(cov: Coverage, launches: number, extra: Record<string, unknown> = {}): object {
  return { ...envelope(cov, "/data.html"), launches, ...extra };
}

/**
 * The honest answer for a launch we hold no record of. Deliberately the same shape as a real record - same `verdict`
 * and `cleanAtBirth` fields - so a consumer that only reads those two cannot accidentally treat "we did not see it"
 * as "nothing was found". `cleanAtBirth` is null here, never false.
 */
export function unknownRecord(mint: string, why: string, cov: Coverage): object {
  return {
    ...envelope(cov, `/t/${mint}.html`),
    mint,
    symbol: null,
    name: null,
    verdict: {
      level: "UNKNOWN",
      label: "Launch not observed",
      why: `${why} An absence from this archive is not a finding about the token: once a float has been spread across wallets, a launch that was assembled and one that was not look the same to present-tense inspection.`,
    },
    cleanAtBirth: null,
    observedAtLaunch: false,
    origin: null,
    launch: null,
    curveBuyout: null,
    pool: null,
    flags: [],
  };
}

/**
 * Errors are records too, and they carry a verdict for the same reason `unknownRecord` does: a caller that branches on
 * `verdict.level` and never reads the HTTP status must still be told UNKNOWN rather than handed `undefined`, which in
 * JavaScript is falsy and therefore reads as "no danger". A rate-limited RPC call once rendered as "no warning" on a
 * wash token; the shape of every failure here is chosen so that cannot happen in someone else's code either.
 *
 * A caller must also be able to tell "this address is not a pump.fun launch" - a finding - from "we could not read the
 * chain just now" - our failure. `code` keeps those apart.
 */
export function errorRecord(code: string, message: string, cov: Coverage, path = "/"): object {
  return {
    ...envelope(cov, path),
    error: code,
    message,
    verdict: { level: "UNKNOWN", label: "No answer", why: message },
    cleanAtBirth: null,
  };
}
