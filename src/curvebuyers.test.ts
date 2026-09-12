/**
 * The outside-buyer count, and the rule that decides whether there is one to publish.
 *
 * This is the most damaging number this archive prints. Zero outside buyers raises a DANGER finding, carries the
 * front page's headline, and is the sentence a reader repeats. It was computed by counting wallets in `trades` -
 * a table that finalize samples to 100-400 curve rows per token and retention prunes outright, both deliberately -
 * and SQL's COUNT over no rows returns 0, not NULL. So a launch whose only surviving row was the creator's own
 * first buy was published as having had no outside buyer at all. 43 confirmed graduations were in that state; 41
 * of them were contradicted by their own `bundled_buyers`.
 *
 * The rule is now: count the rows only where they are demonstrably all still there - at least as many surviving
 * curve-buy rows as the live `buys` counter recorded - and answer NULL otherwise. These cases are the ones the
 * production data actually contains, each built as a row rather than described.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/**
 * The published expression, lifted out of `servicedb.ts` rather than retyped.
 *
 * A copy here would be a test of a copy: it would keep passing while the real build published something else, which
 * is the shape of every fault this file exists to catch. The extraction fails loudly if the definition moves.
 */
function publishedExpression(): string {
  const src = readFileSync(new URL("./servicedb.ts", import.meta.url), "utf8");
  const m = src.match(/const CURVE_BUYERS = \(tbl = "tokens"\) => `([\s\S]*?)`;/);
  assert.ok(m, "CURVE_BUYERS is no longer defined in servicedb.ts in the shape this test reads it from. " +
    "Do not copy the SQL into this file: point this at wherever the real definition now lives.");
  return m![1].replace(/\$\{tbl\}/g, "tokens");
}

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE tokens (mint TEXT PRIMARY KEY, buys INTEGER, curve_buyers_live INTEGER);
           CREATE TABLE trades (mint TEXT, wallet TEXT, market TEXT, side TEXT, is_dev INTEGER)`);
  return db;
}
const addToken = (db: DatabaseSync, mint: string, buys: number | null, live: number | null) =>
  db.prepare("INSERT INTO tokens VALUES (?,?,?)").run(mint, buys, live);
const addBuy = (db: DatabaseSync, mint: string, wallet: string, isDev = 0) =>
  db.prepare("INSERT INTO trades VALUES (?,?,'curve','buy',?)").run(mint, wallet, isDev);

function counted(db: DatabaseSync, mint: string): number | null {
  const r = db.prepare(`SELECT ${publishedExpression()} AS n FROM tokens WHERE mint = ?`).get(mint) as any;
  return r.n === undefined ? null : r.n;
}

test("a launch whose curve trades were pruned is unknown, not zero", () => {
  const db = fixture();
  // EFSy2VB3…, as production held it: 1,160 curve buys watched, every row since pruned but the creator's.
  addToken(db, "pruned", 1160, null);
  addBuy(db, "pruned", "creator", 1);
  assert.equal(counted(db, "pruned"), null,
    "1,160 curve buys were watched and one row survives. Counting it gives zero outside buyers, which is the " +
    "strongest accusation this archive makes, asserted from the absence of rows we deleted ourselves.");
  db.close();
});

test("a launch that genuinely had no outside buyer still reports zero", () => {
  const db = fixture();
  // The headline finding, and the reason the fix cannot simply null every zero: 2,472 confirmed graduations are
  // really in this state. The creator bought; nobody else ever did; no rows are missing because none ever existed.
  addToken(db, "real", 0, null);
  addBuy(db, "real", "creator", 1);
  assert.equal(counted(db, "real"), 0,
    "a zero that is a measurement must survive. Widening the rule until it swallowed these would delete the " +
    "archive's headline finding to fix a different problem.");
  db.close();
});

test("a complete set of rows is counted, and the creator is not one of the buyers", () => {
  const db = fixture();
  addToken(db, "whole", 3, null);
  addBuy(db, "whole", "creator", 1);
  addBuy(db, "whole", "alice");
  addBuy(db, "whole", "bob");
  addBuy(db, "whole", "alice"); // alice twice: distinct wallets, not trades
  assert.equal(counted(db, "whole"), 2);
  db.close();
});

test("the live count wins, and it is what makes retention irrelevant", () => {
  const db = fixture();
  // The same pruned launch, once the collector has counted it as it happened. Nothing about the surviving rows
  // matters any more, which is the whole point of writing the number down at the only moment it is exact.
  addToken(db, "live", 1160, 208);
  addBuy(db, "live", "creator", 1);
  assert.equal(counted(db, "live"), 208);
  db.close();
});

test("a live count of zero is a count, not a missing value", () => {
  const db = fixture();
  // COALESCE would fall through on 0 if the column were ever written as a falsy sentinel. It is not: 0 here means
  // the collector watched the whole curve and saw no outside buyer, which is exactly the finding we publish.
  addToken(db, "zerolive", 0, 0);
  assert.equal(counted(db, "zerolive"), 0);
  db.close();
});

test("a launch nobody has counted at all is unknown", () => {
  const db = fixture();
  addToken(db, "nothing", 12, null); // watched 12 buys, no rows survive, no live count
  assert.equal(counted(db, "nothing"), null);
  db.close();
});

/**
 * The independent check, run against the same rule.
 *
 * `bundled_buyers` is recorded by a different code path at launch time and counts distinct non-creator buyers in
 * the creation block, so it is a floor on the true outside-buyer count. A published count below it is impossible.
 * In production this holds for all 5,264 launches the rule calls complete and fails for 41 of the 43 it rejects,
 * which is what makes the rule a measurement rather than a preference.
 */
test("a count the rule accepts can never fall below the launch's own bundled-buyer figure", () => {
  const db = fixture();
  db.exec("ALTER TABLE tokens ADD COLUMN bundled_buyers INTEGER");
  db.prepare("INSERT INTO tokens (mint, buys, curve_buyers_live, bundled_buyers) VALUES ('x', 1160, NULL, 15)").run();
  addBuy(db, "x", "creator", 1);
  const n = counted(db, "x");
  assert.ok(n === null || n >= 15,
    `published ${n} outside buyers for a launch that recorded 15 distinct non-creator buyers in its creation ` +
    `block alone. The record would be contradicting itself on its own page.`);
  db.close();
});

/**
 * The live count is a count, or it is nothing.
 *
 * `curve_buyers_live` is written from the size of a Set, and a Set has a size whether or not anything could ever go
 * into it. On a venue whose trade events name no wallet it is 0 for every launch - the invented zero this column
 * exists to prevent, reproduced one layer below the guard. Found by running the collector against LaunchLab and
 * reading the column, not by reading the code.
 */
import { Tracker } from "./tracker.ts";
import type { CreateEvent } from "./feed/pumpportal.ts";
import { VENUES } from "./venues.ts";

test("a venue that cannot name a trader stores no live buyer count, not a zero", () => {
  const tk = new Tracker({ watchMinutes: 60, deadAfterSeconds: 3600, watchMaxMinutes: 60 });
  const base = (venue: string): CreateEvent => ({
    venue, signature: "s", mint: `mint_${venue}`, traderPublicKey: "creator", txType: "create",
    initialBuy: 1, solAmount: 1, bondingCurveKey: "pool", vTokensInBondingCurve: 1e9, vSolInBondingCurve: 30,
    marketCapSol: 0, name: "n", symbol: "S", uri: "u", pool: "pool",
  });
  for (const v of VENUES) {
    const t = tk.onCreate(base(v.id), 1000);
    if (v.tradeAttribution === "wallets") {
      assert.equal(t.tradesNameWallets, true, `venue "${v.id}" says its trades name wallets and the token disagrees`);
    } else {
      assert.equal(t.tradesNameWallets, false,
        `venue "${v.id}" cannot name a trader, so its launches must be stamped as uncountable at decode. Without ` +
        `this the empty set's size is written as 0 and a launch nobody could count reads as a launch nobody bought.`);
    }
  }
});
