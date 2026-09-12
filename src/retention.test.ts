/**
 * That retention cannot delete the trade ledger of a launch that graduated.
 *
 * The default here was inverted on 2026-09-12: it was "delete curve rows on a timer, exempting the few cases we
 * had been bitten by", and it is now "if a row can be used, deleting it needs a reason". Every exemption in
 * `KEEP_TRADE_EVIDENCE` before this one was added AFTER a published figure had already been computed over rows the
 * project had thrown away itself - an outside-buyer count read as zero, a wallet that sold 4,515 SOL published as
 * never having sold. The launch record IS the trade rows.
 *
 * The fragment is tested rather than the pruners, because there are several pruners and they share this one string
 * precisely so the rule cannot hold in only some of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { KEEP_TRADE_EVIDENCE, BUYOUT_SOL } from "./provenance.ts";

const OLD = 1_000; // long past any retention horizon

function seed() {
  const db = openDb(":memory:");
  const tok = db.prepare(`INSERT INTO tokens (mint, created_at, creator, venue, graduated, graduated_confirmed_by)
    VALUES (?,?,?,'pumpfun',?,?)`);
  tok.run("GRAD", OLD, "c1", 1, "pool");        // graduated and confirmed
  tok.run("INFERRED", OLD, "c2", 1, null);      // graduated by inference only, never confirmed
  tok.run("NEVER", OLD, "c3", 0, null);         // never graduated
  const tr = db.prepare(`INSERT INTO trades (mint, wallet, side, sol, tokens, price, ts, slot, sig, age_ms,
    buyer_rank, is_dev, market) VALUES (?,?,?,?,1,1,?,1,?,0,1,0,?)`);
  for (const m of ["GRAD", "INFERRED", "NEVER"]) {
    tr.run(m, "w1", "buy", 0.5, OLD, `${m}-small`, "curve");
    tr.run(m, "w2", "sell", 0.5, OLD, `${m}-sell`, "curve");
    tr.run(m, "w3", "buy", 1.0, OLD, `${m}-amm`, "amm");
  }
  tr.run("NEVER", "w9", "buy", BUYOUT_SOL + 1, OLD, "NEVER-buyout", "curve");
  return db;
}
/** Retention as the pruners run it: everything older than the horizon, minus what the fragment protects. */
const prune = (db: any) => db.exec(`DELETE FROM trades WHERE ts < 9999999 ${KEEP_TRADE_EVIDENCE}`);
const left = (db: any, mint: string, market = "curve") =>
  (db.prepare("SELECT sig FROM trades WHERE mint = ? AND market = ? ORDER BY sig").all(mint, market) as any[])
    .map((r) => r.sig);

test("a confirmed graduation keeps its whole curve ledger", () => {
  const db = seed(); prune(db);
  assert.deepEqual(left(db, "GRAD"), ["GRAD-sell", "GRAD-small"],
    "the buys AND sells both matter: a fill time, an outside-buyer count and the order of events are computed " +
    "from them, and every one of those has already been published over rows retention had removed.");
  db.close();
});

test("an inferred graduation keeps it too, because confirmation can arrive later", () => {
  // Deliberately the broader set. The inferred flag overstates graduation by roughly three quarters, so this costs
  // disk - but a launch whose ledger is gone can never be confirmed, measured or reported on again. Keeping rows
  // for a launch that did not graduate wastes space; deleting rows for one that did is unrecoverable.
  const db = seed(); prune(db);
  assert.deepEqual(left(db, "INFERRED"), ["INFERRED-sell", "INFERRED-small"]);
  db.close();
});

test("a launch that never graduated is still pruned, except its buyout", () => {
  // The default is still deletion for the 94% of launches nothing is ever published about. This change is not
  // "keep everything" - it is "keep what analysis uses", and the buyout exemption that predates it still holds.
  const db = seed(); prune(db);
  assert.deepEqual(left(db, "NEVER"), ["NEVER-buyout"],
    "either the ordinary rows of a never-graduated launch survived - which is 389 GB/year, not 42 - or the " +
    "buyout exemption that predates this change was lost.");
  db.close();
});

test("the exemption is scoped to curve rows, not post-graduation market trades", () => {
  // Stated as a test so the scope is explicit rather than incidental: AMM volume is the expensive half and is not
  // the launch record. The wallets that took a buyout keep their AMM rows through the clause above this one.
  const db = seed(); prune(db);
  assert.deepEqual(left(db, "GRAD", "amm"), [],
    "AMM rows of a graduated launch were spared. That is 389 GB/year and it is not what a launch record is.");
  db.close();
});
