/**
 * The masthead nav's current-section rule, and the report manifest loader.
 *
 * Both are small and both have the kind of edge case that is invisible until a page ships wrong: a nav that goes
 * blank one link deep, and a manifest whose missing field becomes `undefined` inside a `.map()` on a live page.
 */
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { navCurrent, NAV, reportBody } from "./render.ts";
import { loadReports, reportDate } from "./reports.ts";

test("the nav marks the section a reader is in, not only the exact page", () => {
  assert.equal(navCurrent("reports.html", "/reports.html"), true);
  // One link deep. The nav used to go blank here, which reads as having left the site.
  assert.equal(navCurrent("reports.html", "/reports/ticker-factories.html"), true);
  assert.equal(navCurrent("live.html", "/live.html"), true);

  // and does not over-match
  assert.equal(navCurrent("reports.html", "/method.html"), false);
  assert.equal(navCurrent("data.html", "/api.html"), false);
  // A token record is not a nav section; nothing should light up.
  assert.equal(NAV.some((n) => navCurrent(n.href, "/t/abc.html")), false);
  // The front page is not in the nav, so nothing is current there either.
  assert.equal(NAV.some((n) => navCurrent(n.href, "/")), false);
  assert.equal(NAV.some((n) => navCurrent(n.href, undefined)), false);
});

test("a report manifest missing its figures loads empty rather than undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "reports-"));
  try {
    // Everything required, nothing optional. This must not put `undefined` where a page calls .map().
    writeFileSync(join(dir, "bare.json"), JSON.stringify({
      slug: "bare", title: "A bare report", published: "2026-01-02", summary: "no figures",
    }));
    // Missing `title`: not renderable, must be skipped rather than published with a blank headline.
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ slug: "broken", published: "2026-03-01" }));
    writeFileSync(join(dir, "garbage.json"), "{ not json");
    writeFileSync(join(dir, "newer.json"), JSON.stringify({
      slug: "newer", title: "Later", published: "2026-05-05", summary: "s", rows: [{ a: 1 }], totals: { n: 1 },
    }));

    const got = loadReports(dir);
    assert.deepEqual(got.map((r) => r.slug), ["newer", "bare"], "newest first, unreadable ones dropped");
    assert.deepEqual(got[1].rows, [], "a missing rows array is empty, never undefined");
    assert.deepEqual(got[1].totals, {});
    assert.equal(got[1].query, "");
    // The defaults must not clobber a manifest that does carry figures.
    assert.deepEqual(got[0].rows, [{ a: 1 }]);
    assert.deepEqual(got[0].totals, { n: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nothing published is an empty list, not a throw", () => {
  assert.deepEqual(loadReports(join(tmpdir(), "definitely-not-here-xyz")), []);
});

test("a publication date reads as a date and never drifts a day", () => {
  // Parsed as UTC on purpose: `new Date("2026-09-11")` west of Greenwich renders as the 10th.
  assert.equal(reportDate("2026-09-11"), "11 September 2026");
  assert.equal(reportDate("2026-01-01"), "1 January 2026");
  assert.equal(reportDate("not a date"), "not a date");
});

test("a report that excludes nothing does not print the exclusion sentence", () => {
  /**
   * The generic provenance block says late-discovered and rebuilt rows "are excluded throughout". That is true of
   * the buyer-behaviour reports and false of metadata-retention, whose query excludes no row for how it was found.
   * Printing it anyway would assert an exclusion that did not happen, on the page whose whole claim is that a
   * reader can check it - and nothing about the page would look wrong.
   */
  const r = loadReports("reports").find((x) => x.slug === "metadata-retention");
  assert.ok(r, "the metadata-retention manifest must load; loadReports skips invalid ones silently");
  const html = reportBody(r!);
  assert.ok(!html.includes("are excluded throughout"),
    "the generic exclusion sentence is printed over a report whose query makes no such exclusion");
  assert.ok(html.includes("No rows are excluded for how they were discovered"));
  assert.ok(html.includes("cannot be re-derived from any file"),
    "a survival measurement must not print the generic 'run the query' promise, which is false for it");
  /**
   * 264 of 265 must not round to 100% on a page about what survives. Asserted on the ROW, not on the document:
   * a first version searched the whole page for "100.0%" followed by "264", which matches across unrelated rows
   * and failed on correct output - a test that reported a bug that was not there.
   */
  const row = html.split("<tr>").find((x) => x.includes("sdfgsdfsdf") && x.includes("265"));
  assert.ok(row, "the survival table must carry the host that lost exactly one document");
  assert.ok(row!.includes("99.6%"), `a loss was rounded away: ${row}`);
});
