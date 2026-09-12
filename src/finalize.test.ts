/**
 * That finalizing a launch does not delete the trade that finished it.
 *
 * `finalizeTokenTrades` samples the curve ledger down to 100-400 rows, which is deliberate: trades are the bulk of
 * the database and the archive's scarce material is launch-time facts. What was not deliberate is WHICH rows it
 * kept. `ORDER BY ts, id LIMIT N` keeps the oldest, so a curve with more trades than the budget had its ending
 * deleted - and the trade that completes a bonding curve is its last curve trade, and the most probative row a
 * launch has. It is what separates a curve filled by a crowd from one bought out by a single wallet.
 *
 * Found by building a report against a real launch and discovering the 84.2 SOL buy that finished its curve was
 * gone, surviving only as an 84.187 SOL discrepancy between `wallet_token_stats.sol_in` and the rows left behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, finalizeTokenTrades } from "./db.ts";

const MINT = "MintUnderTest";
/** Enough of a TokenState for the aggregate query; the truncation only reads `mint`. */
const state = (over: Record<string, unknown> = {}) => ({
  mint: MINT, createdSlot: 1, createdAt: 1_000, lastPrice: 1, launchPrice: 1, peakPrice: 1,
  graduated: false, ...over,
}) as any;

function seed(trades: { ts: number; sol: number; market?: string }[]) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO tokens (mint, created_at, creator, venue) VALUES (?,?,?,?)").run(MINT, 1_000, "C", "pumpfun");
  const ins = db.prepare(
    "INSERT INTO trades (mint, wallet, side, sol, tokens, price, ts, slot, sig, age_ms, buyer_rank, is_dev, market) " +
    "VALUES (?,?,'buy',?,1,1,?,1,?,0,1,0,?)");
  for (const [i, t] of trades.entries()) ins.run(MINT, `w${i}`, t.sol, t.ts, `sig${i}`, t.market ?? "curve");
  return db;
}
const survivors = (db: any, market = "curve") =>
  (db.prepare("SELECT sol FROM trades WHERE mint = ? AND market = ? ORDER BY ts, id").all(MINT, market) as any[])
    .map((r) => r.sol);

test("the buy that completed the curve survives the sample", () => {
  // Ten trades over four hours, the last one the 84.2 SOL buy that finished the curve.
  const rows = Array.from({ length: 9 }, (_, i) => ({ ts: 1_000 + i * 60_000, sol: 0.5 }));
  rows.push({ ts: 1_000 + 13_320_000, sol: 84.2 });
  const db = seed(rows);
  finalizeTokenTrades(db, state(), { keepAll: false, keepCurve: 3 });
  const left = survivors(db);
  assert.ok(left.includes(84.2),
    "the curve-completing buy was deleted. That row is what distinguishes a curve filled by a crowd from one " +
    `bought out by a single wallet, and it cannot be re-fetched once pruned. Survivors: ${left.join(", ")}`);
  db.close();
});

test("both ends are kept, and the middle is what goes", () => {
  const db = seed(Array.from({ length: 10 }, (_, i) => ({ ts: 1_000 + i * 1_000, sol: i })));
  finalizeTokenTrades(db, state(), { keepAll: false, keepCurve: 3 });
  assert.deepEqual(survivors(db), [0, 1, 2, 7, 8, 9],
    "the keep-set should be the first N and the last N. The old behaviour returned [0,1,2] and lost the ending.");
  db.close();
});

test("a late AMM sell survives, because wallet_flow reads exactly those", () => {
  // `wallet_flow.amm_sell` is computed from post-graduation sells, which are by definition the late rows. Keeping
  // only the earliest published a wallet that sold thousands of SOL as a wallet that never sold - absence of data
  // reading as a finding, in the direction that makes an operator look clean.
  const rows = Array.from({ length: 8 }, (_, i) => ({ ts: 1_000 + i * 1_000, sol: 1, market: "amm" }));
  rows.push({ ts: 900_000, sol: 4_515, market: "amm" });
  const db = seed(rows);
  finalizeTokenTrades(db, state(), { keepAll: false, keepCurve: 2, keepAmm: 2 });
  assert.ok(survivors(db, "amm").includes(4_515),
    `the 4,515 SOL exit was deleted. Survivors: ${survivors(db, "amm").join(", ")}`);
  db.close();
});

test("keepAll keeps everything, unchanged", () => {
  const db = seed(Array.from({ length: 10 }, (_, i) => ({ ts: 1_000 + i * 1_000, sol: i })));
  finalizeTokenTrades(db, state(), { keepAll: true, keepCurve: 3 });
  assert.equal(survivors(db).length, 10);
  db.close();
});

/**
 * And that the launch says how much of its ledger we removed.
 *
 * Keeping both ends stops the worst loss but it is still a sample, and until 2026-09-12 the sampling left no trace:
 * a launch with 40 surviving rows was indistinguishable from a launch that only ever had 40. That difference
 * matters most to the reader who matters most - anyone citing the rows as evidence - so it is a published column
 * rather than something to infer from a discrepancy between two tables.
 */
const dropped = (db: any) =>
  (db.prepare("SELECT curve_rows_dropped d FROM tokens WHERE mint = ?").get(MINT) as any).d;

test("a sampled ledger records how many rows were removed", () => {
  const db = seed(Array.from({ length: 10 }, (_, i) => ({ ts: 1_000 + i * 1_000, sol: i })));
  finalizeTokenTrades(db, state(), { keepAll: false, keepCurve: 3 });
  assert.equal(dropped(db), 4, "ten rows, six kept (first three and last three), so four were removed");
  db.close();
});

test("a complete ledger records 0, which is a claim and not an absence", () => {
  // The distinction the column exists for. NULL means nobody measured; 0 means we measured and removed nothing.
  // Collapsing them would make every complete ledger indistinguishable from every unexamined one.
  const db = seed(Array.from({ length: 4 }, (_, i) => ({ ts: 1_000 + i * 1_000, sol: i })));
  finalizeTokenTrades(db, state(), { keepAll: true });
  assert.equal(dropped(db), 0);
  db.close();
});

test("finalizing twice adds the losses rather than reporting only the last pass", () => {
  // `recoverOrphans` finalizes again after a restart. Overwriting would describe a ledger as more complete than it
  // is, which is the direction that matters: a sampled ledger published as whole.
  const db = seed(Array.from({ length: 10 }, (_, i) => ({ ts: 1_000 + i * 1_000, sol: i })));
  finalizeTokenTrades(db, state(), { keepAll: false, keepCurve: 3 });
  assert.equal(dropped(db), 4);
  finalizeTokenTrades(db, state(), { keepAll: false, keepCurve: 2 });
  assert.equal(dropped(db), 6, "the second pass removed two more; the launch has lost six rows in total");
  db.close();
});
