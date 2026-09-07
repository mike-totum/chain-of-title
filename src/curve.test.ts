import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateBuy, simulateSell, price, INITIAL_V_SOL, INITIAL_V_TOKENS, marketCapSol } from "./curve.ts";

test("matches an observed PumpPortal create event", () => {
  // Observed: dev bought with 1.781209587 SOL -> 60,137,355.12 tokens, vSol 31.7812, vTokens 1,012,862,644.88
  const fresh = { vSol: INITIAL_V_SOL, vTokens: INITIAL_V_TOKENS };
  const { tokensOut, curve } = simulateBuy(fresh, 1.781209587, 0); // create event solAmount is already net of fee
  assert.ok(Math.abs(tokensOut - 60_137_355.12) < 1, `tokensOut=${tokensOut}`);
  assert.ok(Math.abs(curve.vSol - 31.78120958730366) < 1e-6);
  assert.ok(Math.abs(marketCapSol(curve) - 31.3776) < 0.01);
});

test("buy then sell round trip loses roughly the fees", () => {
  const c0 = { vSol: INITIAL_V_SOL, vTokens: INITIAL_V_TOKENS };
  const buy = simulateBuy(c0, 1);
  const sell = simulateSell(buy.curve, buy.tokensOut);
  assert.ok(sell.solOut < 1 && sell.solOut > 0.97, `round trip ${sell.solOut}`); // (1-0.0125)^2 ≈ 0.975
  assert.ok(Math.abs(price(sell.curve) - price(c0)) < 1e-15);
});
