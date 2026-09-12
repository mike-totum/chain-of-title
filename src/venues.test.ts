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
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { VENUES, venueById, venuePhrase as venuePhraseValue, cannotAttributeSql, PERSON_COLUMNS } from "./venues.ts";
import { coverageFor } from "./provenance.ts";
import { WSOL } from "./feed/launchlab.ts";

const POOL = "7L2sWFH3rjHCBbjye28oHXDW1H9Vkt2WNeMJcW4B1hUK";
const MINT = "ALvT2usBGUC8C21dDiXpwAGVwA3x1GBKtut3VFWQcX8x";
const TRADER = "DsGJkPzFEQZuwy7JjZzPcJEyEfdC6StV7rarXG4ftRSA";
const CREATOR = "EbnaLtRA2HFunxAWsCRzy4dfMwAhVAjbwvkQUGoFQfbJ";

/**
 * A LaunchLab TradeEvent payload, built from the layout `launchlab.ts` pins against live bytes.
 *
 * Assembled rather than captured because what is being tested here is which EVENT the feed emits, not whether the
 * offsets are right - that has its own fixture, taken from the chain, in `feed/launchlab.test.ts`. The pool id is
 * the only field this needs to carry, and `poolOf` reads it from the first one.
 */
function launchlabTradePayload(pool: string): Buffer {
  const d = Buffer.alloc(147);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(d, 0);
  base58Decode(pool).copy(d, 8);
  d.writeBigUInt64LE(1_000_000_000n, 96); // amount_in
  d.writeBigUInt64LE(5_000_000n, 104);    // amount_out
  d[144] = 0; // TradeDirection::Buy
  d[145] = 0; // PoolStatus::Fund
  return d;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

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

/**
 * The site must not name one venue where it means "the venues we cover".
 *
 * Every scope sentence on the site said "pump.fun" because pump.fun was the only venue, and each one becomes a
 * false statement of scope the day a second venue starts arriving - silently, with nothing failing, on an archive
 * whose entire claim is about what it did and did not watch. Coverage is already recorded per venue; the prose was
 * the part still hard-coded.
 *
 * A sentence genuinely ABOUT pump.fun is different and must stay written out, because generalising it would make it
 * wrong: pump.fun renounces mint authority on every token it creates, and that is a fact about pump.fun, not about
 * launch venues. So this holds the line between the two rather than banning the word.
 *
 * Adding to ALLOWED is allowed. Doing it without reading the sentence first is the thing this prevents.
 */
const ALLOWED: [string, string][] = [
  ["some claim to be pump.fun, which does not run on either",
    "the launch-programs page warning that LaunchLab and DBC front-ends self-assert their names, and some assert " +
    "one that is false. It is a statement about pump.fun specifically and generalising it would destroy the point."],
  ["which pump.fun does to every token it creates",
    "a fact about pump.fun's own behaviour, in a worked example about a pump.fun token"],
  ["no pump.fun bonding curve exists for this address. A finding, not a failure.",
    "documents the published API error code not_a_pump_launch, which is a contract with existing consumers"],
  ["No pump.fun bonding curve exists for this address, so there is no launch of ours to rebuild.",
    "the rebuild path genuinely only reconstructs pump.fun curves; widen this when backfill.ts learns another venue"],
];

test("published prose names a venue only where it means that venue", () => {
  for (const f of ["render.ts", "pages.ts", "serve.ts"]) {
    let code = readFileSync(new URL(f, import.meta.url), "utf8")
      // Comments are not published. Only what reaches a reader is in scope here.
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [phrase] of ALLOWED) code = code.split(phrase).join("");
    const hit = code.match(/.{0,90}pump\.fun.{0,90}/s);
    assert.equal(hit, null,
      `${f} names pump.fun in published prose:\n\n  ...${hit?.[0].replace(/\s+/g, " ")}...\n\n` +
      `If it means "the venues we cover", call venuePhrase() or aLaunchHere() from venues.ts. If it is genuinely ` +
      `about pump.fun specifically, add it to ALLOWED in this test with the reason.`);
  }
});

test("the scope phrase actually reflects the registry", () => {
  // Guards the other direction: a helper that hard-codes its answer would pass the test above and still be wrong.
  const labels = VENUES.map((v) => v.label);
  for (const l of labels) assert.ok(venuePhraseValue().includes(l), `venuePhrase() omits the venue "${l}"`);
  assert.equal(venuePhraseValue().includes(" and "), labels.length > 1,
    "venuePhrase() should join with 'and' only when there is more than one venue");
});

/**
 * Clause 9: every venue in the registry can actually be observed, and observes itself.
 *
 * `feed(url)` exists because `index.ts` was reaching into `VENUES[0]` for a program id and building the feed by
 * hand, which worked exactly as long as there was one venue. A feed whose `venueId` disagrees with the venue that
 * built it stamps another venue's launches with this one's id - clause 4, one layer up from the column default.
 */
test("every venue builds a feed that agrees about which venue it is", () => {
  for (const v of VENUES) {
    const f = v.feed("wss://example.invalid");
    assert.equal(f.venueId, v.id,
      `venue "${v.id}" built a feed reporting venueId "${f.venueId}". Its launches would be published under the ` +
      `wrong venue, and tokens.venue is the column that says which archive claim covers them.`);
    assert.equal((f as any).program ?? v.program, v.program, `venue "${v.id}" subscribed to the wrong program`);
    f.close();
  }
});

/**
 * Clause 8, made checkable. A venue supplies payload-only decoders or it does not, and the absence is the claim.
 *
 * A decoder that returns null for every event this venue will ever emit is the same shape as a check that cannot
 * fail: present, plausible, and never once doing its job. So a venue that has `payload` must decode something from
 * the payload of its own creation event, and a venue that does not have it must not pretend otherwise.
 */
test("a venue's payload decoders, if it has them, are not permanently null", () => {
  for (const v of VENUES) {
    if (!v.payload) continue;
    assert.equal(typeof v.payload.decodeCreate, "function", `venue "${v.id}" has a payload block with no decodeCreate`);
    assert.equal(typeof v.payload.decodeTrade, "function", `venue "${v.id}" has a payload block with no decodeTrade`);
    // A payload that is not this venue's event decodes to null, which is the only universal assertion available
    // here; the per-venue fixtures that prove the positive live beside each decoder.
    assert.equal(v.payload.decodeCreate(Buffer.alloc(8)), null);
    assert.equal(v.payload.decodeTrade(Buffer.alloc(8)), null);
  }
});

/**
 * Clause 10, run against a database rather than asserted in a comment.
 *
 * This is the one that would have published a false accusation on every LaunchLab graduation. `curve_buyers` is
 * COUNT(DISTINCT wallet) over `trades`; a launch on a venue whose events carry no wallet has no rows there, and
 * COUNT over no rows is 0, not NULL. Zero outside buyers is the most damaging sentence this archive prints.
 *
 * So the guard is exercised the way it is used: two launches, one per venue, each with the single dev-buy row that
 * makes `EXISTS (SELECT 1 FROM trades)` pass - which is exactly why the EXISTS guard already in servicedb.ts was
 * not enough on its own.
 */
test("a venue that cannot name a trader publishes NULL buyers, not zero", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tokens (mint TEXT, venue TEXT);
           CREATE TABLE trades (mint TEXT, wallet TEXT, market TEXT, side TEXT, is_dev INTEGER)`);
  for (const v of VENUES) {
    db.prepare("INSERT INTO tokens VALUES (?,?)").run(`mint_${v.id}`, v.id);
    // The creator's own buy: attributable on every venue here, and enough to defeat a bare EXISTS check.
    db.prepare("INSERT INTO trades VALUES (?,?,?,?,1)").run(`mint_${v.id}`, "creator", "curve", "buy");
  }
  // A row with no venue at all, which is what every launch predating the column looks like. Given one real outside
  // buyer, so that "the guard swallowed a legacy row" and "the legacy row had no buyers" cannot look the same.
  db.prepare("INSERT INTO tokens VALUES ('mint_legacy', NULL)").run();
  db.prepare("INSERT INTO trades VALUES ('mint_legacy','someone','curve','buy',0)").run();

  const rows = db.prepare(`SELECT mint, venue,
      CASE WHEN ${cannotAttributeSql()} THEN NULL ELSE (
        SELECT COUNT(DISTINCT tr.wallet) FROM trades tr
        WHERE tr.mint = tokens.mint AND tr.market='curve' AND tr.side='buy' AND COALESCE(tr.is_dev,0)=0
      ) END AS curve_buyers
    FROM tokens`).all() as { mint: string; venue: string | null; curve_buyers: number | null }[];

  for (const r of rows) {
    const v = VENUES.find((x) => x.id === r.venue);
    if (v && v.tradeAttribution === "none") {
      assert.equal(r.curve_buyers, null,
        `venue "${v.id}" published curve_buyers=${r.curve_buyers} for a launch whose events carry no wallet. ` +
        `0 there reads as "it completed its bonding curve with zero outside buyers on record" - a DANGER flag ` +
        `computed from the absence of a table this venue was never going to have rows in.`);
    } else {
      // Counted, and counted correctly: the dev buy is excluded and a real outside buy is not. A guard widened until
      // it swallowed pump.fun would delete the archive's headline finding, so the zero has to survive where it is
      // earned - and the legacy row proves the count is still doing arithmetic rather than returning a constant.
      assert.equal(r.curve_buyers, r.mint === "mint_legacy" ? 1 : 0,
        `venue "${r.venue ?? "(none)"}" must still be counted from its trade rows: it names its traders.`);
    }
  }
  db.close();
});

/**
 * Every column that counts people is guarded, by name, in the build that publishes it.
 *
 * The first version of this counted occurrences of the guard and asked for "at least three". Deleting the guard
 * from the one expression that matters left four behind and the test passed - a check measuring the wrong thing,
 * which is how the bug it is guarding got published in the first place.
 *
 * PERSON_COLUMNS lives in venues.ts beside the declaration it belongs to, so this fails when a column joins the
 * published record unguarded AND when one is quietly unwrapped. Note which expression matters: production builds
 * with --read-only, so the source UPDATE never runs on the collector and the record copy is the only thing
 * deciding what a reader sees.
 */
test("servicedb guards every published count of people", () => {
  const src = readFileSync(new URL("./servicedb.ts", import.meta.url), "utf8");
  const copy = src.slice(src.indexOf("INSERT INTO rec.tokens"));
  assert.ok(copy.length > 0, "servicedb.ts no longer has a rec.tokens copy; this test is checking nothing");
  /**
   * A column need not be published under its own name. `curve_buyers` is produced by a named expression, because a
   * count over trade rows that finalize and retention have already thinned is a floor rather than a measurement and
   * the expression is what decides whether there is an answer at all. Listing the producer here keeps this test
   * specific: an unguarded `CURVE_BUYERS(...)` still fails, and so does an unguarded bare column.
   */
  const PRODUCED_BY: Record<string, string> = { curve_buyers: "CURVE_BUYERS(" };
  for (const col of PERSON_COLUMNS) {
    const producer = PRODUCED_BY[col];
    const guarded = copy.includes(`nullForUnattributed("${col}")`)
      || (producer ? copy.includes(`nullForUnattributed(${producer}`) : false)
      || new RegExp(`nullForUnattributed\\([^)]*\\b${col}\\b`, "s").test(copy);
    assert.ok(guarded,
      `${col} reaches the published record unguarded. On a venue whose events carry no wallet it is an empty set ` +
      `reporting 0, and 0 beside "distinct buyers" is a measurement a reader will act on. Wrap it in ` +
      `nullForUnattributed() - see venues.ts clause 10.`);
  }
  assert.match(src, /AND NOT \(\$\{CANNOT_ATTRIBUTE\}\)/,
    "the source UPDATE no longer skips unattributed venues, so it will store a counted-looking 0 in the collector");
});


/**
 * What each venue's feed ACTUALLY produces from its own trade event, checked against what the venue claims.
 *
 * The first version of this test was worthless and the way it was worthless is the fault this project keeps
 * meeting. It branched on `v.tradeAttribution`: for a venue declaring "none" it asserted a NULL, and for one
 * declaring "wallets" it asserted a count. Flipping LaunchLab's declaration to "wallets" - the exact mistake the
 * declaration exists to prevent - made the test take the other branch and pass. It checked the guard against the
 * claim and never once against the chain.
 *
 * So the claim is now measured. Each venue's feed is driven with a trade event of that venue's own shape and the
 * emissions are recorded, which fails in both directions: a venue that says "wallets" and emits no attributable
 * trade, and a venue that says "none" and emits one anyway. Both feeds are driven offline - the pump.fun payload is
 * assembled from the layout in feed/rpc.ts, and LaunchLab's pool cache is seeded so no `getAccountInfo` is needed,
 * because identity resolution is clause 8's business and not this test's.
 *
 * A venue with no fixture fails rather than being skipped. A third venue must not be able to join the registry by
 * being unmeasured.
 */
const TRADE_FIXTURES: Record<string, (f: any) => { logs: string[] }> = {
  pumpfun: () => {
    const d = Buffer.alloc(129);
    createHash("sha256").update("event:TradeEvent").digest().subarray(0, 8).copy(d, 0);
    base58Decode(MINT).copy(d, 8);
    d.writeBigUInt64LE(1_000_000_000n, 40); // solAmount
    d.writeBigUInt64LE(5_000_000n, 48);     // tokenAmount
    d[56] = 1;                              // isBuy
    base58Decode(TRADER).copy(d, 57);
    d.writeBigUInt64LE(30_000_000_000n, 97);      // vSol
    d.writeBigUInt64LE(1_073_000_000_000_000n, 105); // vTokens
    return { logs: [`Program data: ${d.toString("base64")}`] };
  },
  launchlab: (f) => {
    // What the pool read would have returned. Seeded so the async identity step is not what is under test.
    f.pools.set(POOL, {
      baseMint: MINT, quoteMint: WSOL, baseDecimals: 6, quoteDecimals: 9, solQuoted: true,
      creator: CREATOR, supply: 1e9,
    });
    return { logs: [`Program data: ${launchlabTradePayload(POOL).toString("base64")}`] };
  },
};

test("what a venue says its trades can name is what its feed actually produces", async () => {
  for (const v of VENUES) {
    const fixture = TRADE_FIXTURES[v.id];
    assert.ok(fixture, `venue "${v.id}" has no trade fixture in this test, so its tradeAttribution is unmeasured. ` +
      `Add one: a venue may not join the registry by being the one nobody checked.`);
    const f: any = v.feed("wss://example.invalid");
    const trades: any[] = [];
    const curves: any[] = [];
    f.on("trade", (e: any) => trades.push(e));
    f.on("curve", (u: any) => curves.push(u));
    const { logs } = fixture(f);
    f.handleLogs("sig", logs, 1);
    // LaunchLab serialises every event for a pool behind that pool's own promise chain; let it settle.
    await new Promise((r) => setTimeout(r, 20));
    f.close();

    // The feed decoded the event at all. Without this the whole test passes on a feed that reads nothing.
    assert.ok(trades.length + curves.length > 0,
      `venue "${v.id}" decoded nothing from a trade event of its own shape. Either the fixture is stale or the feed ` +
      `is deaf - and a deaf feed is what every guard in this file exists to catch.`);

    const named = trades.filter((e) => typeof e.traderPublicKey === "string" && e.traderPublicKey.length > 0);
    if (v.tradeAttribution === "wallets") {
      assert.equal(named.length, trades.length,
        `venue "${v.id}" declares tradeAttribution "wallets" but emitted a trade with no wallet. trades.wallet is ` +
        `NOT NULL and that constraint is correct: a trade row with no wallet cannot answer the question the table ` +
        `exists for.`);
      assert.ok(named.length > 0,
        `venue "${v.id}" declares tradeAttribution "wallets" and produced no attributable trade. Its outside-buyer ` +
        `counts would be published as measured zeros computed from an empty table. See venues.ts clause 10.`);
    } else {
      assert.equal(trades.length, 0,
        `venue "${v.id}" declares tradeAttribution "${v.tradeAttribution}" but emitted ${trades.length} trade ` +
        `event(s). Its events carry no wallet, so those rows could only reach the database by relaxing ` +
        `trades.wallet NOT NULL or by being dropped at the writer. It must emit "curve" readings instead.`);
      assert.ok(curves.length > 0,
        `venue "${v.id}" emitted neither trades nor curve readings, so its reserves and its graduations go ` +
        `unrecorded - the venue would be subscribed, healthy, and silent.`);
    }
  }
});

/**
 * Clause 3, and the guard that exists because the type system could not hold it.
 *
 * Coverage used to take `(ts, venue?)` and four of the five callers omitted the venue, so they asked "was the
 * archive watching at this moment" and silently received pump.fun's answer. With one venue that was the same
 * question. With two it refused a LaunchLab launch the archive held a complete record of and told the reader
 * "we have no record of this launch" - found by rendering the page, not by reading the code.
 *
 * Taking the row makes it uncallable without the venue, except that every caller reads its row out of SQLite as
 * `any`, which type-checks against anything. So the refusal is also enforced at runtime, and here is where that is
 * checked - loudly wrong beats silently wrong about whether we were watching.
 */
test("coverage refuses a bare timestamp instead of answering about the wrong venue", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at INTEGER, stopped_at INTEGER, note TEXT, venue TEXT)`);
  db.prepare("INSERT INTO runs (started_at, stopped_at, venue) VALUES (?,?,?)").run(1000, 9000, "pumpfun");
  const covered = coverageFor(db);

  assert.equal(covered({ created_at: 5000, venue: "pumpfun" }), true, "inside the pump.fun window");
  assert.equal(covered({ created_at: 5000, venue: "launchlab" }), false,
    "no launchlab window exists, so a launch there is unwatched - it must not inherit another venue's coverage");
  assert.equal(covered({ created_at: 5000 }), true, "a row with no venue is a pump.fun row predating the column");
  assert.equal(covered({ created_at: 50_000, venue: "pumpfun" }), false, "outside every window");

  // The shape the four callers used. It must not quietly answer.
  assert.throws(() => (covered as any)(5000), /launch row, not a timestamp/,
    "a bare timestamp was accepted. It carries no venue, so it answers about whichever venue the default names - " +
    "which is how an unwatched launch reads as watched, the one error clause 3 exists to prevent.");
  db.close();
});
