/**
 * That a launch recovered after a restart keeps the AMM rows a buyout wallet's exit is computed from.
 *
 * `recoverOrphans` finalizes the launches that were still being watched when the collector stopped. It is a
 * deletion path by delegation: it calls `finalizeTokenTrades`, which samples the trade ledger down to a budget per
 * market. It passed only `keepAll`, so both budgets came from the defaults - and the AMM default is `0`. A budget
 * of zero is not a sample, it is a DELETE of every AMM row the launch has, and it ran on every orphan a restart
 * left behind that was not interesting enough to keep whole.
 *
 * Among those rows are the post-graduation trades of wallets that took a buyout, which is exactly what
 * `wallet_flow.amm_sell` is computed from. So a wallet that sold thousands of SOL into buyers came out of a restart
 * as a wallet that never sold: not an error message, not a missing page, a zero. Absence of data reading as a
 * finding, in the direction that makes an operator look clean, which is the direction this project cannot afford.
 *
 * This is the third arrival of the same fault. `KEEP_TRADE_EVIDENCE` grew a clause for it on 2026-09-11 after a
 * wallet that sold 4,515 SOL published a 0; `finalizeTokenTrades` was changed on 2026-09-12 to keep the first AND
 * last N rows because post-graduation sells are by definition the late ones; and it still came back through a
 * caller that named neither budget. A rule enforced in the callee's defaults is a rule every caller must remember,
 * so the test is written against the caller.
 *
 * The fixture is deliberately an uninteresting launch - not graduated, no 2x, no KOL signal - because
 * `keepAll: true` hides the whole question. That is the population this path samples, and a buyout on a launch
 * nobody has published a report about is still the strongest fact the archive holds about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, recoverOrphans } from "./db.ts";
import { BUYOUT_SOL } from "./provenance.ts";

const MINT = "OrphanUnderTest";
const OLD = 1_000;
/**
 * Below the graduation threshold (115 / 279,900,000 ≈ 4.1e-7) and flat, so the recovery recomputes no new peak.
 * `keepAll` is true for a graduated orphan, for one that doubled and for one with a KOL signal; this launch is
 * none of those, which is the only way to exercise the sampling at all.
 */
const PRICE = 1e-7;

function seed(amm: number) {
  const db = openDb(":memory:");
  db.prepare(`INSERT INTO tokens (mint, created_at, creator, venue, launch_price, peak_price, last_price,
      graduated, kol_signals, finalized, updated_at) VALUES (?,?,?,'pumpfun',?,?,?,0,0,0,?)`)
    .run(MINT, OLD, "creator", PRICE, PRICE, PRICE, OLD);
  const ins = db.prepare(`INSERT INTO trades (mint, wallet, side, sol, tokens, price, ts, slot, sig, age_ms,
    buyer_rank, is_dev, market) VALUES (?,?,?,?,1,${PRICE},?,1,?,?,1,?,?)`);
  // The creation buy, then the buy that took the curve: a buyout-sized curve buy by `buyer`.
  ins.run(MINT, "creator", "buy", 1, OLD, "dev-buy", 0, 1, "curve");
  ins.run(MINT, "buyer", "buy", BUYOUT_SOL + 4.2, OLD + 60_000, "buyout", 60_000, 0, "curve");
  // What the buyout wallet did afterwards, on the market. The last of these is the exit that matters.
  for (let i = 0; i < amm - 1; i++)
    ins.run(MINT, "buyer", "buy", 1, OLD + 120_000 + i, `amm-${i}`, 120_000 + i, 0, "amm");
  ins.run(MINT, "buyer", "sell", 4_515, OLD + 900_000, "amm-exit", 900_000, 0, "amm");
  return db;
}

const sigs = (db: any, market: string): string[] =>
  (db.prepare("SELECT sig FROM trades WHERE mint = ? AND market = ? ORDER BY ts, id").all(MINT, market) as any[])
    .map((r) => r.sig);

test("a recovered orphan keeps the AMM rows of the wallet that took its curve", () => {
  const db = seed(6);
  assert.equal(recoverOrphans(db), 1, "the fixture is not an orphan, so this test proves nothing");
  assert.equal((db.prepare("SELECT graduated FROM tokens WHERE mint = ?").get(MINT) as any).graduated, 0,
    "the recovery decided this launch had graduated, which takes the keepAll path and skips the sampling entirely - " +
    "so the fixture would pass whatever the budgets were");
  const amm = sigs(db, "amm");
  assert.ok(amm.includes("amm-exit"),
    "the buyout wallet's 4,515 SOL exit was deleted by a restart. `wallet_flow.amm_sell` is computed from exactly " +
    "these rows, so the operator page would publish a wallet that sold thousands of SOL as a wallet that never " +
    `sold. Surviving AMM rows: ${amm.length ? amm.join(", ") : "none at all"}`);
  assert.equal(amm.length, 6,
    "an orphan with six AMM rows should keep all six: the live path gives a non-graduated launch a budget of 1,500 " +
    `a side. Survivors: ${amm.join(", ")}`);
  assert.ok(sigs(db, "curve").includes("buyout"),
    "the buyout itself was deleted, which is the same fault on the other market");
  db.close();
});

test("the AMM budget is the live one, 1500 a side, and not a blanket keep", () => {
  /**
   * The number, pinned. `index.ts` passes `keepAmm: t.graduated ? 6000 : 1500`, and an orphan that reaches the
   * sampling is by definition not graduated, so 1,500 is what a comparable launch gets when nothing crashed. A
   * launch should not hold a different amount of the same evidence because the process happened to restart - in
   * either direction, which is why this asserts an exact count rather than "more than zero".
   */
  const db = seed(3_010);
  recoverOrphans(db);
  assert.equal(sigs(db, "amm").length, 3_000,
    "3,010 AMM rows should come down to the first 1,500 and the last 1,500. Zero means the budget defaulted to 0 " +
    "again; 3,010 means this path now keeps every AMM row of every orphan, which the volume cannot pay for.");
  assert.ok(sigs(db, "amm").includes("amm-exit"), "the last row is the exit, and it is the one that must survive");
  db.close();
});
