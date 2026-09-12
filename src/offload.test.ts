/**
 * That the offloader still recognises the rows it must never take.
 *
 * `offload.ts` is the fourth trade-deletion path and the only one that does not read `KEEP_TRADE_EVIDENCE`. It
 * uploads a range of old rows to R2, verifies the object by size, records it in a local ledger, and then DELETES
 * those rows from the collector - so everything it does correctly depends on one predicate, `evidenceFilter`,
 * deciding which rows are evidence and stay.
 *
 * On 2026-09-11 `trades.venue` was renamed to `trades.market`, a metadata-only rename that could not fail. This
 * file was not renamed with it, in two places: the column list it SELECTs, and the predicate, which compared
 * `r.venue === "curve"`. Both stale, and the accident is that the first one hid the second: the SELECT threw, the
 * pass died before the delete, and the collector logged `[offload] FAILED, nothing deleted` every ~17 minutes for
 * a day. The archive was saved by the query being broken.
 *
 * Which makes this the most dangerous half-fix in the codebase. Repair the column list on its own and the query
 * succeeds, the predicate reads `undefined` on every row, NOTHING is evidence, and the next pass exports and then
 * deletes every buyout row in the archive - the row that distinguishes a curve filled by a crowd from one bought
 * out by a single wallet, the row `BUYOUT_SOL` exists for, the row the buyout detectors, the operator clusters and
 * `assess` are all built on, and the one thing here that cannot be re-derived cheaply once the local copy is gone.
 *
 * So the test does not check the predicate against hand-made objects. It inserts rows into a real `trades` table,
 * reads them back through the offloader's OWN column list, and then asks the predicate about them - which is the
 * only shape that fails when half of a rename lands. A stale column list makes the SELECT throw; a stale field
 * name makes the buyout stop being held. Either one is red.
 *
 * The graduation case below is not part of that repair. Retention's default was inverted on 2026-09-12 - "if a row
 * can be used, deleting it needs a reason" - and the whole curve ledger of every graduated launch became exempt.
 * This deletion path had no such clause, so it would have gone on moving off-disk precisely the population every
 * report and every outside-buyer count is about. Off-disk is not lost, but it is not here either, and `servicedb`
 * rebuilds the published record from what the collector currently holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { evidenceFilter, offloadTrades, restoreColumns, TRADE_COLUMNS } from "./offload.ts";
import { BUYOUT_SOL } from "./provenance.ts";

const OLD = 1_000; // long past any retention horizon, so every row here is eligible for offload

function seed() {
  const db = openDb(":memory:");
  const tok = db.prepare(`INSERT INTO tokens (mint, created_at, creator, venue, graduated, graduated_confirmed_by)
    VALUES (?,?,?,'pumpfun',?,?)`);
  tok.run("NEVER", OLD, "c1", 0, null);      // never graduated: ordinary working data
  tok.run("GRAD", OLD, "c2", 1, "pool");     // graduated, confirmed by a pool
  tok.run("INFERRED", OLD, "c3", 1, null);   // graduated by inference only, confirmation may still arrive
  /** Rows in the real table's shape - the offloader reads every column, because the archive is meant to be complete. */
  const tr = db.prepare(`INSERT INTO trades (mint, wallet, side, sol, tokens, price, ts, slot, sig, age_ms,
    buyer_rank, is_dev, market) VALUES (?,?,?,?,1,1,?,1,?,0,1,0,?)`);
  tr.run("NEVER", "buyer", "buy", BUYOUT_SOL + 4.2, OLD, "buyout", "curve");
  tr.run("NEVER", "w1", "buy", 0.5, OLD, "ordinary-curve-buy", "curve");
  tr.run("NEVER", "w1", "sell", 0.5, OLD, "ordinary-curve-sell", "curve");
  tr.run("NEVER", "buyer", "sell", 4_515, OLD, "buyout-wallet-amm-sell", "amm");
  tr.run("NEVER", "stranger", "buy", 3, OLD, "stranger-amm", "amm");
  tr.run("GRAD", "w2", "buy", 0.5, OLD, "grad-curve-buy", "curve");
  tr.run("GRAD", "w2", "sell", 0.5, OLD, "grad-curve-sell", "curve");
  tr.run("GRAD", "w3", "buy", 1, OLD, "grad-amm", "amm");
  tr.run("INFERRED", "w4", "buy", 0.5, OLD, "inferred-curve-buy", "curve");
  return db;
}

/**
 * The rows the offloader would consider, read the way the offloader reads them, and the signatures of the ones it
 * would hold back from the delete. Going through `TRADE_COLUMNS` is the point: it is the same statement the pass
 * prepares, so a column list that no longer matches the table throws here exactly as it does in production.
 */
const held = (db: any): string[] => {
  const rows = db.prepare(`SELECT ${TRADE_COLUMNS.join(", ")} FROM trades ORDER BY id`).all() as any[];
  return rows.filter(evidenceFilter(db)).map((r) => r.sig).sort();
};

test("a buyout row is held and an ordinary curve trade is not", () => {
  const db = seed();
  const kept = held(db);
  assert.ok(kept.includes("buyout"),
    "the buyout was not recognised as evidence, so the next pass would export it and DELETE it. A buyout-sized " +
    "curve buy is the single most probative row a launch has: it is what separates a curve filled by a crowd " +
    "from one taken by one wallet, and `findBuyout`, the buyout detectors, the operator clusters and `assess` " +
    `all read it. Held instead: ${kept.join(", ")}`);
  assert.ok(!kept.includes("ordinary-curve-buy") && !kept.includes("ordinary-curve-sell"),
    "the ordinary curve rows of a launch that never graduated were held. Nothing would ever be offloaded and the " +
    "volume fills, which stops ingestion - the one loss that cannot be repaired.");
  db.close();
});

test("the AMM trades of a buyout wallet are held, a stranger's are not", () => {
  // `servicedb` builds `rec.trades` from buyout-sized curve buys PLUS the AMM trades on those same (wallet, mint)
  // pairs, and `wallet_flow.amm_sell` is computed from exactly those. Take them and a wallet that sold 4,515 SOL
  // into buyers publishes as a wallet that never sold - absence of data in the direction that flatters an operator.
  const db = seed();
  const kept = held(db);
  assert.ok(kept.includes("buyout-wallet-amm-sell"),
    `the buyout wallet's exit was not held, so wallet_flow.amm_sell would be rebuilt as 0. Held: ${kept.join(", ")}`);
  assert.ok(!kept.includes("stranger-amm"),
    "an unrelated wallet's AMM trade was held. AMM volume is the expensive half of the table and only the buyout " +
    "wallets' own rows are evidence; holding all of it defeats the offload.");
  db.close();
});

test("the whole curve ledger of a graduated launch is held, confirmed or merely inferred", () => {
  /**
   * Parity with `KEEP_TRADE_EVIDENCE`, which three other deletion paths already honour. The launch record IS the
   * trade rows: a fill time, an outside-buyer count, a buyout and the order of events are all computed from them,
   * and every one of those has at some point been published as a measurement taken over whatever had survived a
   * timer. Both sides matter - a sell is as much part of the ledger as a buy - and an inferred graduation is kept
   * too, deliberately, because confirmation can arrive after this pass would have run and a ledger that is gone
   * can never be confirmed, measured or reported on again.
   */
  const db = seed();
  const kept = held(db);
  for (const sig of ["grad-curve-buy", "grad-curve-sell", "inferred-curve-buy"])
    assert.ok(kept.includes(sig),
      `${sig} was not held. The offloader is the fourth trade-deletion path and the only one that does not read ` +
      "KEEP_TRADE_EVIDENCE, so it is the one that can still move a graduated launch's ledger off the collector - " +
      `where servicedb rebuilds rec.trades and recounts curve_buyers from it. Held: ${kept.join(", ")}`);
  assert.ok(!kept.includes("grad-amm"),
    "the exemption is scoped to curve rows, exactly as the retention fragment scopes it. A graduated launch's AMM " +
    "volume is the expensive half and it is not what a launch record is.");
  db.close();
});

/**
 * And that a whole pass runs, because the way this defect presented was a pass that never ran.
 *
 * The predicate tests above would all have passed on 2026-09-11 if the predicate alone had been repaired - the
 * thing that was actually broken in production was the statement, and its failure was swallowed by the caller as
 * one line of log: `[offload] FAILED, nothing deleted`, every ~17 minutes, for a day. So one test drives
 * `offloadTrades` itself. A dry run, which is the whole of the pass except the PUT and the DELETE: it prepares the
 * same statements, walks the same id windows and applies the same predicate, and reports what it WOULD have sent.
 */
test("a dry run exports the bulk and holds the evidence back", async () => {
  const db = seed();
  const r = await offloadTrades(db, { dryRun: true, retainDays: 0, log: () => {} });
  assert.equal(r.rows, 4,
    "a pass over this fixture should export exactly the four ordinary rows - the three curve trades of the launch " +
    "that never graduated and the stranger's AMM buy - and hold the other five. A pass that exports 0 rows either " +
    `threw or has stopped making progress; one that exports 9 is taking the evidence with it. Exported: ${r.rows}`);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM trades").get() as any).c, 9,
    "a dry run deleted rows. Nothing may leave this database before the object holding it has been read back.");
  db.close();
});

/**
 * And that the column list is the table.
 *
 * The rename is the kind of change that leaves a string literal behind, and a list that has drifted does not fail
 * loudly here - it fails as a swallowed `[offload] FAILED, nothing deleted` in a log nobody reads, for as long as
 * it takes someone to notice the volume is still filling. Asserted in both directions: a column missing from the
 * list is silently absent from the archived object, which is a gap in the copy we keep in order to be allowed to
 * delete the original.
 */
test("the offloader's column list is exactly the trades table", () => {
  const db = openDb(":memory:");
  const have = (db.prepare("SELECT name FROM pragma_table_info('trades')").all() as any[]).map((r) => r.name);
  assert.deepEqual([...TRADE_COLUMNS].sort(), [...have].sort(),
    "TRADE_COLUMNS and `trades` have drifted apart. Every offload pass prepares a SELECT from this list, so a " +
    "stale name makes the whole pass throw before it moves a row; a missing name makes the uploaded object an " +
    "incomplete copy of rows we then delete locally.");
  db.close();
});

/**
 * And that an object written before the rename can still be put back.
 *
 * `restoreOffloaded` is the way back for rows that exist nowhere else - it reads each object the ledger names and
 * re-inserts its rows under their original ids - and it builds that INSERT from the object's own CSV header. Every
 * object uploaded before 2026-09-11 ends its header with `venue`, the column's name at the time, so after the
 * rename the restore threw `no such column: venue` on the first object and took the rest down with it. A rename in
 * our schema must not invalidate the archive's own files, which is the whole reason the files are CSV.
 */
test("a legacy `venue` header restores into `market`", () => {
  const legacy = "id,mint,wallet,side,sol,tokens,price,ts,slot,sig,age_ms,buyer_rank,is_dev,venue".split(",");
  assert.deepEqual(restoreColumns(legacy), TRADE_COLUMNS,
    "an object written before the rename maps onto no known column, so the only way back for those rows throws.");
  const db = openDb(":memory:");
  const cols = restoreColumns(legacy);
  db.prepare(`INSERT OR IGNORE INTO trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(1, "NEVER", "buyer", "buy", BUYOUT_SOL + 4.2, 1, 1, OLD, 1, "restored-buyout", 0, 1, 0, "curve");
  assert.equal((db.prepare("SELECT market FROM trades WHERE sig = ?").get("restored-buyout") as any).market, "curve",
    "the restored row's market did not survive the header mapping");
  db.close();
});
