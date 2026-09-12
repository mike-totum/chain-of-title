/**
 * Published reports: what one is, where they live, and how a page gets hold of them.
 *
 * A report is the only thing this project publishes that is meant to stay still. Every other figure on the site is a
 * window that moves - the front page says so beside each one, and that is right for a front page. A report is the
 * opposite: it is the artifact somebody cites, and a citation to a number that has since changed is worse than no
 * citation, because the reader cannot tell which of you is wrong.
 *
 * It was not staying still. `site.ts` re-ran the report's query and re-stamped its date from the record's build time
 * on every build, and `scripts/daily.sh` runs that build once a day - under a lede telling the reader, in the
 * report's own first sentence, that "the figures below were computed from the record on that date and are not
 * updated afterwards". The sentence was false every day after the first.
 *
 * So the figures and the date now come from a file in git, written once by `npm run publish` and read by everything
 * else. The page is still rendered from source, so a layout or typo fix reaches every report; the numbers cannot
 * move, because nothing in the render path can reach a database.
 *
 * WHY `reports/` AND NOT `data/reports/`. The obvious home is taken, and worse than taken: `data/reports/` holds
 * `scripts/daily.sh`'s run logs and is excluded by .gitignore, .railwayignore AND .dockerignore. A manifest there
 * would be uncommitted, unuploaded and absent from the image - healthy locally and simply gone in production, which
 * is the failure those three files' own comments were written about. `reports/` at the repository root is source,
 * versioned and shipped, and nothing excludes it.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Where published manifests live. Source, committed, shipped - see the note above on why not `data/reports`. */
export const REPORTS_DIR = "reports";

/**
 * One row of the ticker-factory table, exactly as it was when the report was published.
 *
 * Typed loosely on purpose: a manifest is a record of what a query returned on a day, and the day a report needs a
 * column this interface does not have is the day that report is written, not the day this file is refactored.
 */
export interface ReportRow { [column: string]: string | number | null }

export interface Report {
  /** URL slug and file stem. `reports/<slug>.json` renders to `site/reports/<slug>.html`. */
  slug: string;
  title: string;
  /** The publication date, ISO yyyy-mm-dd. Set once, by the publish step, and never derived from a build clock. */
  published: string;
  /** One sentence for the index, the link preview, and the front page's latest-release block. */
  summary: string;
  /** The archive this was computed against, so a reader can tell what "the record" meant that day. */
  coverageFrom: string;
  recordBuiltAt: string;
  /** Headline figures the prose interpolates. Frozen with everything else. */
  totals: Record<string, number>;
  rows: ReportRow[];
  /** The query printed beside the table, so a reader can run it themselves and compare against today. */
  query: string;
  /**
   * A second frozen table whose figures did NOT come from `query`, with its own provenance in the prose.
   *
   * Added for the metadata-retention report, whose central measurement is a network probe: it re-fetched documents
   * from their hosts and compared bytes. That is not expressible as SQL over the record, and putting it in `rows`
   * would have filed a measurement of the outside world under a query that cannot produce it - the reader would
   * run the printed query, get different columns, and have no way to tell which of us was wrong.
   *
   * A report using this must say, in its own prose, where these numbers came from and how to repeat them.
   */
  measurements?: ReportRow[];
  /**
   * Replaces the standard "check it yourself" block for a report whose verification is not one query.
   *
   * The generic block promises that re-running the query gives a LARGER answer because the archive has grown. For
   * a survival measurement that promise is false in a way that matters: re-run it later and documents that were
   * being served will have stopped being served, so the answer moves the other way and for a different reason. A
   * report that prints a false instruction for checking it is worse than one that prints none.
   */
  verify?: string;
  /**
   * Replaces the standard sentence about which rows a report's query excludes. See the note in `reportBody`: the
   * default describes the late-discovery exclusion the buyer-behaviour reports make, and a report that does not
   * make it must not print it.
   */
  excludes?: string;
  /**
   * Set only when a published report has been revised, and says what changed and when. A report that is corrected
   * silently is not a correction, it is a second version wearing the first one's date - see corrections.html.
   */
  revisions?: { at: string; what: string }[];
}

/**
 * Every published report, newest first.
 *
 * Never throws and never guesses. A missing directory means nothing has been published yet, which is a real state
 * with a real answer ("no reports yet"), not an error - and a malformed manifest is skipped loudly rather than
 * rendered as a report with holes in it. An unreadable report must not take down the page it appears on.
 */
export function loadReports(dir = REPORTS_DIR): Report[] {
  if (!existsSync(dir)) return [];
  const out: Report[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Report;
      // The four fields every consumer dereferences. A manifest without them would render a report with an empty
      // title or an undefined date, which is a worse artifact than no report at all.
      if (!r.slug || !r.title || !r.published || !r.summary) {
        console.error(`[reports] ${f} is missing slug, title, published or summary, skipped`);
        continue;
      }
      /**
       * Defaults AFTER the spread, not before it.
       *
       * Written the other way round first, which reads as "these are the fallbacks" and is not what it does: the
       * spread wins, so a manifest missing `rows` would have put `undefined` straight into a `.map()` on the page.
       * The four fields checked above are required; these five are the ones a hand-written or older manifest can
       * legitimately lack, and they fall back to empty rather than to a crash.
       */
      out.push({
        ...r,
        totals: r.totals ?? {}, rows: r.rows ?? [], query: r.query ?? "",
        coverageFrom: r.coverageFrom ?? "", recordBuiltAt: r.recordBuiltAt ?? "",
      });
    } catch (e) {
      console.error(`[reports] ${f} could not be read: ${(e as Error).message}, skipped`);
    }
  }
  return out.sort((a, b) => b.published.localeCompare(a.published) || a.slug.localeCompare(b.slug));
}

/** "11 September 2026" from "2026-09-11", for prose. Date-only input, so it is parsed as UTC and stays that day. */
export function reportDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
