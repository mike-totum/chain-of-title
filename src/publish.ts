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
 * past it — which records the reason in the file and shows it on the page. The point is not that a report can never
 * change; it is that it cannot change without somebody saying so in writing.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { coverageWindows } from "./provenance.ts";
import { REPORTS_DIR, type Report, type ReportRow } from "./reports.ts";

const argv = process.argv.slice(2);
const slug = argv.find((a) => !a.startsWith("--"));
const reviseAt = argv.indexOf("--revise");
const revise = reviseAt >= 0;
const reviseWhy = revise ? argv[reviseAt + 1] : undefined;

/**
 * One report's definition: the query, and how to turn its rows into the figures the prose quotes.
 *
 * Deliberately a table rather than one script per report. The figures a report asserts and the query that produced
 * them belong in the same place, so that "check it yourself" on the page and the number above it cannot drift — the
 * page prints `query` verbatim and the totals are derived from the rows that same query returned.
 */
const REPORTS: Record<string, {
  title: string;
  summary: (rows: ReportRow[], totals: Record<string, number>) => string;
  query: string;
  totals: (rows: ReportRow[]) => Record<string, number>;
}> = {
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
  console.error(`${out} already exists — published ${already.published}.`);
  console.error(`A published report is not rewritten by a later run; that is the point of this step.`);
  console.error(`To change it deliberately: npm run publish -- ${slug} --revise "what changed and why"`);
  process.exit(1);
}

const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");

const rows = db.prepare(def.query.replace(/;\s*$/, "")).all() as ReportRow[];
if (!rows.length) {
  // A report asserting nothing is not a report. Refusing here beats publishing an empty table under a headline.
  console.error(`the query returned no rows — nothing to publish`);
  process.exit(1);
}
const totals = def.totals(rows);

/**
 * The archive the figures were computed against, recorded beside them.
 *
 * A reader re-running the query today gets a different answer, and the honest reason is that the record has grown —
 * not that either of you is wrong. Stating the coverage window and the build the report was taken from is what lets
 * them tell those apart.
 *
 * `coverageWindows`, not `MIN(created_at)`: the raw minimum is 2026-05-10, two months before the coverage every
 * other page states, because a couple of stray rows predate the first recorded run and a bare MIN has no way to
 * know that. A report is the last place to invent a private meaning for a word the footer already defines — it
 * would have claimed a four-month archive on a page whose footer says four weeks.
 */
const win = coverageWindows(db);
const cov = { a: win.length ? win[0].a : null };
/**
 * `meta(k, v)`, which is the schema — and no clock if there is no stamp.
 *
 * This read `SELECT value FROM meta WHERE key = 'built_at'`, which does not match the table and threw on every
 * run. The throw was swallowed by the catch and the value fell back to `Date.now()`, so the first published report
 * recorded the moment the publish COMMAND ran as the build time of the record it was computed from — a wrong
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
 * A revised report is the same report, corrected — it is not republished under a new date, which would quietly
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
