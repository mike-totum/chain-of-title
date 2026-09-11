/**
 * Clause 7 of the venue contract, enforced rather than described.
 *
 * A venue whose events arrive as self-CPI instruction data cannot be observed by a feed that reads only
 * `Program data:` log lines. Adding one to VENUES before the extraction path exists produces a subscription that
 * connects, stays up, reports healthy and ingests nothing - which is the exact failure this project has now found
 * four times in a day, and which Helius already demonstrated by carrying two sockets while nothing arrived.
 *
 * So the trap is closed with an assertion instead of a paragraph. When `feed/rpc.ts` learns to read inner-CPI
 * events, CHANNELS_THE_FEED_READS gains "cpi" and this test stops blocking Meteora DBC. Until then it fails loudly
 * at the moment someone tries, rather than quietly two days later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VENUES, venueById } from "./venues.ts";

/** Widen this only together with the feed. It is the whole point that these two move at the same time. */
const CHANNELS_THE_FEED_READS = new Set(["logs"]);

test("no venue is observed through a channel the feed cannot read", () => {
  for (const v of VENUES) {
    assert.ok(CHANNELS_THE_FEED_READS.has(v.events),
      `venue "${v.id}" declares events: "${v.events}", which feed/rpc.ts does not read. It would subscribe, stay ` +
      `up, look healthy and record nothing. Implement the extraction path and widen CHANNELS_THE_FEED_READS first.`);
  }
});

test("the feed really does only read Program data:, which is what the guard above assumes", () => {
  // If this ever fails, the guard has gone stale in the dangerous direction: it would keep blocking a channel the
  // feed has since learned to read, or keep permitting one it has stopped reading.
  const feed = readFileSync(new URL("./feed/rpc.ts", import.meta.url), "utf8");
  const readsLogs = feed.includes('"Program data: "') || feed.includes("'Program data: '");
  assert.ok(readsLogs, "feed/rpc.ts no longer looks for Program data: lines; CHANNELS_THE_FEED_READS is now wrong");
});

test("venue ids are unique and stable-looking, because they are published into tokens.venue", () => {
  const ids = VENUES.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, "two venues share an id; tokens.venue could not tell them apart");
  for (const v of VENUES) {
    assert.match(v.id, /^[a-z0-9_]+$/, `venue id "${v.id}" should be a stable lowercase slug: it is published`);
    assert.equal(venueById(v.id), v, `venueById cannot find "${v.id}"`);
  }
});

test("every venue names a program, and no two venues share one", () => {
  const progs = VENUES.map((v) => v.program);
  assert.equal(new Set(progs).size, progs.length,
    "two venues subscribe to the same program; a launch would be attributed to whichever matched first");
  for (const v of VENUES) assert.match(v.program, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `venue "${v.id}" program id looks wrong`);
});
