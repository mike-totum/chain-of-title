/**
 * That a document is captured for a launch on EVERY venue, not just the one the resolver was written for.
 *
 * The metadata document behind a launch's `uri` is the most perishable thing this archive holds. The creator can
 * repoint the URI, the host can expire, the account can be deleted; the chain facts are reconstructible from an
 * archival node next year at the same price and the document is not reconstructible by anyone. So a launch whose
 * document was never fetched is a permanent hole, and a venue whose launches never enter the fetch queue is that
 * hole repeated at the venue's full launch rate.
 *
 * Today this works by the ABSENCE of a filter: `backfillmeta.ts` selects on `meta_at IS NULL AND uri IS NOT NULL`
 * and says nothing about venue, so every venue's launches queue up. That is the most fragile way for a thing to be
 * correct - it is correct until someone adds a venue predicate for a plausible reason, and the failure is silent
 * because a launch with no document looks exactly like a launch whose document has not been fetched yet.
 *
 * These are source-reading tests, in the same style as `venues.test.ts`'s guards on the record build, and for the
 * same reason: the fault is a line nobody wrote rather than a value nobody set, so there is nothing in a database
 * to assert against.
 *
 * SCOPE: the VENUE side only - whether a launch arrives carrying a uri at all. The resolver's own query is guarded
 * in the off-chain layer, deliberately not here: a second test of `backfillmeta.ts` in this file would be a copy
 * that keeps passing while the real one is changed, which is the failure this whole file is about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VENUES } from "./venues.ts";

const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");

test("each venue's OWN feed source carries a uri into the create event", () => {
  /**
   * Written once as "does any file under feed/ mention uri:", which passed for every venue because pump.fun's
   * does - a loop over venues that asserts the same thing every iteration. That is a check that cannot fail, and
   * it would have reported a venue with no document path as fine. So the mapping is explicit: a venue is tied to
   * the source file that builds ITS feed, and a venue with no entry fails rather than borrowing another's pass.
   *
   * Not every venue can satisfy it, and the test has to admit that rather than force one shape. Meteora DBC's
   * creation event carries no name, symbol or uri at all - they are InitializePoolParameters instruction
   * arguments - so its feed has to decode instruction data (`initializeArgs()`) or record every launch nameless
   * and documentless.
   */
  const FEED_SOURCE: Record<string, string> = {
    pumpfun: "./feed/rpc.ts",
    launchlab: "./feed/launchlab-feed.ts",

  };
  for (const v of VENUES) {
    const file = FEED_SOURCE[v.id];
    assert.ok(file, `venue ${v.id} has no feed source listed here, so nothing checks that its launches arrive ` +
      `with a uri. Add it - and if its events carry no uri (Meteora DBC), name the instruction-data path instead.`);
    const s = src(file);
    assert.match(s, /uri:/,
      `${file} builds ${v.id}'s feed and never sets uri on the event it emits. Every launch on that venue enters ` +
      `the record with uri NULL, the resolver never queues it, and its document is lost at the venue's full rate.`);
  }
});

test("a venue added to the registry is a venue whose documents someone has thought about", () => {
  // The tripwire, and the only test here that will fail on a FUTURE change rather than a present one. It exists
  // because clause 7's lesson was that a venue can be subscribed, healthy and silently ingesting nothing: the same
  // is true one layer along, where a venue can be ingesting launches and silently capturing no documents.
  const known = new Set(["pumpfun", "launchlab"]);
  const unreviewed = VENUES.map((v) => v.id).filter((id) => !known.has(id));
  assert.deepEqual(unreviewed, [],
    `venue(s) ${unreviewed.join(", ")} joined VENUES without the document path being checked. Confirm the feed ` +
    `emits a uri (Meteora DBC needs initializeArgs() from instruction data - its event has none), measure that ` +
    `meta_at is actually being set for that venue in production, then add the id here.`);
});
