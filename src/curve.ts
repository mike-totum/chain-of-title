/**
 * pump.fun bonding curve: constant-product on virtual reserves.
 * A fresh curve starts at 30 virtual SOL / 1,073,000,000 virtual tokens;
 * 1,000,000,000 tokens exist, ~793M are sold on the curve before graduation
 * (~85 real SOL raised => vSol ~115).
 */
export const TOTAL_SUPPLY = 1_000_000_000;
export const INITIAL_V_SOL = 30;
export const INITIAL_V_TOKENS = 1_073_000_000;
export const GRADUATION_V_SOL = 115;
export const FEE_BPS = 125; // observed live: 1.25% (protocol + creator fee) on the bonding curve; overridden per token from trade events

export interface Curve {
  vSol: number;
  vTokens: number;
}

/** SOL per token */
export function price(c: Curve): number {
  return c.vSol / c.vTokens;
}

/** Market cap in SOL (what pump.fun / PumpPortal report as marketCapSol) */
export function marketCapSol(c: Curve): number {
  return price(c) * TOTAL_SUPPLY;
}

export function isGraduated(c: Curve): boolean {
  return c.vSol >= GRADUATION_V_SOL;
}

/** Spend `solIn` SOL (fee included). Returns tokens received and the curve after the trade. */
export function simulateBuy(c: Curve, solIn: number, feeBps = FEE_BPS): { tokensOut: number; curve: Curve } {
  const solNet = solIn * (1 - feeBps / 10_000);
  const k = c.vSol * c.vTokens;
  const newVSol = c.vSol + solNet;
  const newVTokens = k / newVSol;
  return { tokensOut: c.vTokens - newVTokens, curve: { vSol: newVSol, vTokens: newVTokens } };
}

/** Sell `tokensIn` tokens. Returns SOL received after fee and the curve after the trade. */
export function simulateSell(c: Curve, tokensIn: number, feeBps = FEE_BPS): { solOut: number; curve: Curve } {
  const k = c.vSol * c.vTokens;
  const newVTokens = c.vTokens + tokensIn;
  const newVSol = k / newVTokens;
  const gross = c.vSol - newVSol;
  return { solOut: gross * (1 - feeBps / 10_000), curve: { vSol: newVSol, vTokens: newVTokens } };
}
