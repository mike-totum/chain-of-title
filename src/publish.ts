/**
 * Publish a report: run its query once, write the answer to `reports/<slug>.json`, and never touch it again.
 *
 *   npm run publish -- ticker-factories
 *   npm run publish -- ticker-factories --revise "corrected the coverage window"
 *
 * This is the only code in the project that may compute a report's figures. `site.ts` renders from the manifest and
 * cannot reach a database, which is what makes the sentence "computed on that date and not updated afterwards" true
 * rather than aspirational. Before this existed, every daily `npm run site` re-queried and re-dated the one report
 * we had, so a reader who cited it in the morning was citing a different document by the next run.
 *
 * REFUSING TO OVERWRITE IS THE WHOLE MECHANISM. A publish step that quietly rewrites what is already published is
 * the same thing as no publish step, so an existing manifest stops the run, and `--revise <reason>` is the only way
 * past it - which records the reason in the file and shows it on the page. The point is not that a report can never
 * change; it is that it cannot change without somebody saying so in writing.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { coverageWindows } from "./provenance.ts";
import { REPORTS_DIR, type Report, type ReportRow } from "./reports.ts";

const fmtInt = (n: number) => n.toLocaleString("en-US");

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
const reviseAt = argv.indexOf("--revise");
const revise = reviseAt >= 0;
const reviseWhy = revise ? argv[reviseAt + 1] : undefined;

/**
 * One report's definition: the query, and how to turn its rows into the figures the prose quotes.
 *
 * Deliberately a table rather than one script per report. The figures a report asserts and the query that produced
 * them belong in the same place, so that "check it yourself" on the page and the number above it cannot drift - the
 * page prints `query` verbatim and the totals are derived from the rows that same query returned.
 */
const REPORTS: Record<string, {
  title: string;
  summary: (rows: ReportRow[], totals: Record<string, number>) => string;
  query: string;
  totals: (rows: ReportRow[]) => Record<string, number>;
  /**
   * The database the figures come from, and it should be the one the report tells readers to query.
   *
   * Every report prints its query beside its table and points at record.db. If the figures were computed against
   * the collector's own database instead, a reader following that instruction would get different numbers for a
   * reason we caused and did not state. The file the reader can download is the file the report describes.
   */
  source?: string;
  /** Frozen figures that are not a product of `query` - see `Report.measurements`. */
  measurements?: ReportRow[];
  /** Replaces the generic verification block - see `Report.verify`. */
  verify?: string;
  /** Replaces the generic row-exclusion sentence - see `Report.excludes`. */
  excludes?: string;
}> = {
  /**
   * What a graduation event is worth, measured against the curve account itself.
   *
   * The comparison has to avoid a circularity that is easy to miss: `graduated_confirmed_by` takes the value
   * 'curve_complete' when the curve read IS the confirmation, so those rows are complete by construction and
   * cannot appear in any rate about curve reads. The rows confirmed by 'pool' are the ones worth comparing, because
   * a PumpSwap pool existing is evidence entirely independent of the curve account. The query returns all three
   * groups rather than the two that make the point, so a reader can see the excluded one and why.
   */
  "graduation-events": {
    title: "A graduation event is not a graduation",
    source: "data/record.db",
    query: `SELECT COALESCE(graduated_confirmed_by, '(none)') AS confirmed_by,
       COUNT(*) AS feed_events,
       SUM(curve_checked_at IS NOT NULL) AS read_on_chain,
       SUM(curve_complete = 1) AS read_complete,
       SUM(curve_complete = 0) AS read_incomplete,
       SUM(curve_checked_at IS NOT NULL AND curve_complete IS NULL) AS account_gone
FROM tokens
WHERE graduated = 1
GROUP BY confirmed_by
ORDER BY feed_events DESC;`,
    totals: (rows) => {
      const g = (k: string) => rows.find((r) => r.confirmed_by === k) ?? {};
      const pool = g("pool"), none = g("(none)"), circ = g("curve_complete");
      return {
        events: rows.reduce((a, r) => a + Number(r.feed_events ?? 0), 0),
        poolEvents: Number(pool.feed_events ?? 0),
        poolRead: Number(pool.read_on_chain ?? 0),
        poolIncomplete: Number(pool.read_incomplete ?? 0),
        noneEvents: Number(none.feed_events ?? 0),
        noneRead: Number(none.read_on_chain ?? 0),
        noneIncomplete: Number(none.read_incomplete ?? 0),
        noneComplete: Number(none.read_complete ?? 0),
        noneGone: Number(none.account_gone ?? 0),
        circular: Number(circ.feed_events ?? 0),
      };
    },
    summary: (_rows, t) => `Of ${t.events.toLocaleString()} graduation events on the feed, `
      + `${t.noneEvents.toLocaleString()} have no pool behind them, and of those we read on chain `
      + `${(100 * t.noneIncomplete / Math.max(t.noneRead, 1)).toFixed(1)}% had no completed curve either.`,
  },
  /**
   * How long a launch's own account of itself keeps being served, and by whom.
   *
   * The population comes from the record and the printed query reproduces it exactly. The SURVIVAL figures cannot:
   * they came from re-fetching documents over the network on 2026-09-12 and comparing sha256 against the bytes
   * captured at launch, which is why they live in `measurements` with their own provenance rather than being
   * dressed up as a product of this query. See `Report.measurements`.
   *
   * The query deliberately groups by HOST rather than reporting one archive-wide rate. A single "93% survived"
   * describes no host in the record and hides the only one losing anything - which is the finding.
   */
  "metadata-retention": {
    title: "A launch's own account of itself is not uniformly durable",
    /**
     * A DOWNLOADED COPY OF THE PUBLISHED RECORD, not the local research database:
     *   curl -o data/prod-record.db https://chainoftitle.org/data/record.db
     * `data/record.db` on a dev machine is a stale research artefact - it held 206,018 launches against 290,096
     * live when this was published - and a report quoting it would state figures no reader could reproduce from
     * the file the page tells them to download. The file the reader can get is the file the report describes.
     */
    source: "data/prod-record.db",
    /**
     * The `all other self-hosted` row is not decoration. A first cut used a bare `HAVING launches >= 1500`, which
     * silently dropped 8,234 launches across the long tail of small hosts - so the page's "share of self-hosted"
     * was computed against 73,942 when the real denominator is 82,176, and it would have printed 58% beside a
     * finding document saying 52%. The table now accounts for every launch that has a URI.
     *
     * `uri != ''` excludes 4,177 launches whose URI is the EMPTY STRING rather than null. They first appeared as an
     * unlabelled row of 4,177 with a blank host, because the host expression has nothing to parse - which is the
     * only reason they were noticed. They are excluded because this report is about where documents are served
     * from and a launch that declared no document has no host; the count is stated on the page rather than
     * silently dropped, since "declared nothing" and "we did not look" are the distinction this archive exists to
     * keep apart.
     */
    query: `WITH h AS (
  SELECT CASE WHEN uri LIKE '%/ipfs/%' OR uri LIKE 'ipfs://%' THEN 'ipfs'
              ELSE substr(uri, 1, instr(substr(uri, 9), '/') + 8) END AS host,
         COUNT(*) AS launches, SUM(meta_sha256 IS NOT NULL) AS held
  FROM tokens WHERE uri IS NOT NULL AND uri != '' GROUP BY host)
SELECT host, launches, held FROM h WHERE launches >= 1500
UNION ALL
SELECT 'all other self-hosted', SUM(launches), SUM(held) FROM h WHERE launches < 1500
ORDER BY launches DESC;`,
    totals: (rows) => {
      const n = (r: ReportRow, k: string) => Number(r[k] ?? 0);
      const ipfs = rows.find((r) => r.host === "ipfs");
      const j7 = rows.find((r) => String(r.host).includes("j7tracker"));
      const selfHosted = rows.filter((r) => r.host !== "ipfs");
      return {
        launches: rows.reduce((a, r) => a + n(r, "launches"), 0),
        ipfsLaunches: ipfs ? n(ipfs, "launches") : 0,
        selfHosted: selfHosted.reduce((a, r) => a + n(r, "launches"), 0),
        j7Launches: j7 ? n(j7, "launches") : 0,
        j7Held: j7 ? n(j7, "held") : 0,
      };
    },
    summary: (_rows, t) =>
      `Documents on ${fmtInt(t.ipfsLaunches)} IPFS-addressed launches lost nothing in ten days; one host carrying ` +
      `${fmtInt(t.j7Launches)} launches stops serving them after about two days.`,
    /**
     * The probe, frozen exactly as run on 2026-09-12. `sampled` is documents this archive HOLDS, so the denominator
     * is known to have existed - that is what makes this a survival rate rather than an estimate. `served` counts
     * a fetch returning the same sha256; anything else is a 404 or different bytes.
     */
    measurements: [
      { host: "ipfs", sampled: 202, served: 202, method: "ordered by mint, across every day in the record" },
      { host: "https://meta.uxento.io/", sampled: 275, served: 275, method: "ordered by mint, 25 per day" },
      { host: "https://m.rapidlaunch.io/", sampled: 268, served: 268, method: "ordered by mint, 25 per day" },
      { host: "https://md.sdfgsdfsdf.uk/", sampled: 265, served: 264, method: "ordered by mint, 25 per day" },
      { host: "https://metadata.j7tracker.io/", sampled: 150, served: 57, method: "random within each day, 25 per day" },
    ],
    excludes: `No rows are excluded for how they were discovered: a launch found late still declares a URI, and ` +
      `which host serves that URI is not affected by when this archive noticed the launch. The only exclusion is ` +
      `the 4,177 launches whose URI is the empty string, stated above.`,
    verify: `<p class="lede">Two halves, and they are checked differently. The population table is the query below,
    run against the public-domain file; it will return larger numbers than those above, because the archive has
    grown since publication.</p>
    <p class="lede">The survival table cannot be re-derived from any file, because it is a measurement of what other
    people's servers were doing on the day. To repeat it: take any launch from the record that has both a
    <span class="mono">meta_sha256</span> and a <span class="mono">uri</span>, fetch the URI, and compare the sha256
    of what comes back against the stored one. Re-run it later and the answer moves AWAY from these figures rather
    than toward them, as documents that were still being served stop being served - the opposite of how the
    population table ages, and the whole subject of this report.</p>`,
  },

  "ticker-factories": {
    title: "The same ticker, a new creator every time",
    query: `SELECT symbol, COUNT(*) mints,
       COUNT(DISTINCT creator) creators,
       SUM(graduated_confirmed_by IS NOT NULL) grads,
       AVG(dev_pct) dev, SUM(curve_buyers = 0) zero
FROM tokens
WHERE COALESCE(late_discovery,0) = 0
  AND rebuilt_at IS NULL
  AND symbol IS NOT NULL AND symbol != ''
GROUP BY symbol
HAVING mints >= 15
   AND creators >= mints * 0.9
   AND grads >= 5
ORDER BY grads DESC
LIMIT 20;`,
    totals: (rows) => rows.reduce<Record<string, number>>((a, r) => ({
      mints: a.mints + Number(r.mints ?? 0),
      creators: a.creators + Number(r.creators ?? 0),
      grads: a.grads + Number(r.grads ?? 0),
    }), { mints: 0, creators: 0, grads: 0 }),
    summary: (rows) => `${rows.length} ticker symbols, each used by fifteen or more separate mints with a fresh `
      + `creator wallet almost every time.`,
  },
};

if (!slug || !REPORTS[slug]) {
  console.error(`usage: npm run publish -- <slug> [--revise "what changed"]`);
  console.error(`known reports: ${Object.keys(REPORTS).join(", ")}`);
  process.exit(1);
}
if (revise && !reviseWhy) {
  console.error(`--revise needs a reason: npm run publish -- ${slug} --revise "what changed and why"`);
  process.exit(1);
}

const def = REPORTS[slug];
const out = join(REPORTS_DIR, `${slug}.json`);
const already = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as Report : null;

if (already && !revise) {
  console.error(`${out} already exists - published ${already.published}.`);
  console.error(`A published report is not rewritten by a later run; that is the point of this step.`);
  console.error(`To change it deliberately: npm run publish -- ${slug} --revise "what changed and why"`);
  process.exit(1);
}

const src = def.source ?? "data/record.db";
const db = openDb(src, { migrate: false });
db.exec("PRAGMA query_only = 1");
console.log(`reading ${src}`);

const rows = db.prepare(def.query.replace(/;\s*$/, "")).all() as ReportRow[];
if (!rows.length) {
  // A report asserting nothing is not a report. Refusing here beats publishing an empty table under a headline.
  console.error(`the query returned no rows - nothing to publish`);
  process.exit(1);
}
const totals = def.totals(rows);

/**
 * The archive the figures were computed against, recorded beside them.
 *
 * A reader re-running the query today gets a different answer, and the honest reason is that the record has grown -
 * not that either of you is wrong. Stating the coverage window and the build the report was taken from is what lets
 * them tell those apart.
 *
 * `coverageWindows`, not `MIN(created_at)`: the raw minimum is 2026-05-10, two months before the coverage every
 * other page states, because a couple of stray rows predate the first recorded run and a bare MIN has no way to
 * know that. A report is the last place to invent a private meaning for a word the footer already defines - it
 * would have claimed a four-month archive on a page whose footer says four weeks.
 */
const win = coverageWindows(db);
const cov = { a: win.length ? win[0].a : null };
/**
 * `meta(k, v)`, which is the schema - and no clock if there is no stamp.
 *
 * This read `SELECT value FROM meta WHERE key = 'built_at'`, which does not match the table and threw on every
 * run. The throw was swallowed by the catch and the value fell back to `Date.now()`, so the first published report
 * recorded the moment the publish COMMAND ran as the build time of the record it was computed from - a wrong
 * number that looked entirely plausible, in the one field whose job is to say which archive the figures came from.
 *
 * A collector database legitimately carries no `built_at`; only a record built by servicedb does. So an absent
 * stamp is now recorded as absent and the page says "unknown", rather than being quietly filled with a timestamp
 * that means something else. Substituting the current time for a missing measurement is the shape this codebase
 * has a whole section about.
 */
const builtAt = (() => {
  try {
    const m = db.prepare("SELECT v FROM meta WHERE k = 'built_at'").get() as any;
    return m?.v ? Number(m.v) : null;
  } catch { return null; }
})();

/**
 * The publication date is today, and on a revision it stays the day of first publication.
 *
 * A revised report is the same report, corrected - it is not republished under a new date, which would quietly
 * detach it from every citation already made to it. What changed goes in `revisions`, where the page prints it.
 */
const today = new Date().toISOString().slice(0, 10);
const report: Report = {
  slug,
  title: def.title,
  published: already?.published ?? today,
  summary: def.summary(rows, totals),
  coverageFrom: cov?.a ? new Date(cov.a).toISOString() : "",
  recordBuiltAt: builtAt ? new Date(builtAt).toISOString() : "",
  totals,
  rows,
  query: def.query,
  ...(def.measurements ? { measurements: def.measurements } : {}),
  ...(def.verify ? { verify: def.verify } : {}),
  ...(def.excludes ? { excludes: def.excludes } : {}),
  ...(already || revise
    ? { revisions: [...(already?.revisions ?? []), ...(revise ? [{ at: today, what: reviseWhy! }] : [])] }
    : {}),
};

mkdirSync(REPORTS_DIR, { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

console.log(`${already ? "revised" : "published"} ${out}`);
console.log(`  ${report.title}`);
console.log(`  published   ${report.published}${already && revise ? ` (revised ${today}: ${reviseWhy})` : ""}`);
console.log(`  rows        ${rows.length}`);
console.log(`  totals      ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`  record      built ${report.recordBuiltAt || "unstamped (this database carries no built_at)"}, coverage from ${report.coverageFrom}`);
console.log(`\nCommit it. The rendered page is built from this file and cannot recompute it.`);
