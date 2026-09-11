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
import { navCurrent, NAV } from "./render.ts";
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
