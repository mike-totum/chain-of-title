/**
 * Minimal Solana JSON-RPC over HTTP with endpoint rotation and 429 back-off, plus the pump.fun
 * bonding-curve PDA and account decoder. No dependencies: base58 and the ed25519 on-curve test
 * needed for PDA derivation are implemented here with BigInt.
 *
 * Endpoints: SOLANA_RPC_URLS (comma separated) or the defaults below. A request that gets 429 / 5xx /
 * a network error moves to the next endpoint and penalises the failing one for a while.
 */
import { createHash } from "node:crypto";
import { PUMP_PROGRAM, base58 } from "./feed/rpc.ts";

const DEFAULT_URLS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
interface Ep { url: string; penaltyUntil: number; nextAt: number; minGapMs: number; errors: number; calls: number; rateLimited: number }
/**
 * Per-endpoint minimum gap between requests. The official endpoint 429s under load; publicnode is generous but
 * blocks some calls.
 *
 * `HELIUS_MIN_GAP_MS` exists because this limiter was written against the FREE tier's 10 req/s and matched on the
 * hostname, so a paid key would have been throttled to 9 req/s by a hardcoded constant with nothing logging that it
 * was the constant and not the plan. Buying capacity and not receiving it is the kind of failure that looks like the
 * vendor's fault for a week. Default unchanged at 110 ms; set it when the plan says otherwise.
 */
const HELIUS_GAP_MS = Number(process.env.HELIUS_MIN_GAP_MS ?? 110) || 110;
const gapFor = (url: string) => (url.includes("mainnet-beta") ? 600 : url.includes("helius") ? HELIUS_GAP_MS : 70);
let eps: Ep[] = [];
/** Endpoints in priority order: the first non-penalised one that accepts the method is used. */
export function configureEndpoints(urls: string[]): void {
  eps = urls.map((url) => ({ url, penaltyUntil: 0, nextAt: 0, minGapMs: gapFor(url), errors: 0, calls: 0, rateLimited: 0 }));
}
export const RPC_URLS = (process.env.SOLANA_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
configureEndpoints(RPC_URLS.length ? RPC_URLS : DEFAULT_URLS);

export function rpcStats(): string {
  return eps.map((e) => `${new URL(e.url).host.replace("mainnet.helius-rpc.com", "helius")}: ${e.calls} calls, ${e.rateLimited} 429s, ${e.errors} errors${[...blocked].filter((b) => b.startsWith(e.url)).map((b) => ` (refuses ${b.split("|")[1]})`).join("")}`).join("; ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** (endpoint, method) pairs a node refused outright ("Request blocked", batch-size limits); learned at runtime */
const blocked = new Set<string>();
/** method name, with the account count for getMultipleAccounts (nodes cap that separately: publicnode takes 10, refuses 20+) */
const methodOf = (body: any): string => { const b = Array.isArray(body) ? body[0] : body; const m = b?.method ?? ""; return m === "getMultipleAccounts" && Array.isArray(b?.params?.[0]) ? `${m}/${b.params[0].length}` : m; };

/** One JSON-RPC call (or a batch when `body` is an array). Throws after every endpoint failed repeatedly. */
export async function rpcRaw(body: unknown, timeoutMs = 20_000, only?: RegExp): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = Date.now();
    const method = methodOf(body);
    const usable = eps.filter((e) => !blocked.has(`${e.url}|${method}`) && (!only || only.test(e.url)));
    if (usable.length === 0) throw new Error(`${method}: refused by every endpoint`);
    const ep = usable.find((e) => e.penaltyUntil <= now);
    if (!ep) { await sleep(Math.max(200, Math.min(...usable.map((e) => e.penaltyUntil)) - now)); continue; }
    const wait = ep.nextAt - now;
    if (wait > 0) await sleep(wait);
    ep.nextAt = Date.now() + ep.minGapMs;
    ep.calls++;
    try {
      const res = await fetch(ep.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) { ep.rateLimited++; ep.penaltyUntil = Date.now() + 3000 * (attempt + 1); lastErr = new Error("429"); continue; }
      if (!res.ok) {
        // publicnode answers its policy refusals ("Request blocked", batch limits) with HTTP 400 and a JSON-RPC error body
        let msg = "";
        try { const j = await res.json(); const first = Array.isArray(j) ? j[0] : j; msg = first?.error?.message ?? ""; } catch {}
        if (/request blocked|maximum number of|not allowed|upgrade to/i.test(msg)) { blocked.add(`${ep.url}|${method}`); lastErr = new Error(msg); continue; }
        ep.errors++; ep.penaltyUntil = Date.now() + 2000; lastErr = new Error(`http ${res.status}`); continue;
      }
      const j = await res.json();
      const first = Array.isArray(j) ? j[0] : j;
      if (first?.error?.code === 429 || /rate limit/i.test(first?.error?.message ?? "")) { ep.rateLimited++; ep.penaltyUntil = Date.now() + 3000 * (attempt + 1); lastErr = new Error(first.error.message); continue; }
      if (/request blocked|maximum number of|not allowed|upgrade to/i.test(first?.error?.message ?? "")) { blocked.add(`${ep.url}|${method}`); lastErr = new Error(first.error.message); continue; }
      return j;
    } catch (e) {
      ep.errors++;
      ep.penaltyUntil = Date.now() + 2000;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("rpc failed");
}

/** `only` restricts the call to matching endpoints (e.g. archival nodes for account history). */
export async function rpc(method: string, params: unknown[], timeoutMs?: number, only?: RegExp): Promise<any> {
  const j = await rpcRaw({ jsonrpc: "2.0", id: 1, method, params }, timeoutMs, only);
  if (j?.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

/** Batched calls: one HTTP request, results in input order (null where the node returned an error). */
export async function rpcBatch(calls: { method: string; params: unknown[] }[], timeoutMs?: number): Promise<any[]> {
  if (calls.length === 0) return [];
  const j = await rpcRaw(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })), timeoutMs);
  const out: any[] = new Array(calls.length).fill(null);
  if (Array.isArray(j)) for (const r of j) if (typeof r?.id === "number" && !r.error) out[r.id] = r.result;
  return out;
}

// ---- base58 decode + ed25519 on-curve test + PDA ----
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return Uint8Array.from(out);
}
const P = (1n << 255n) - 19n;
const mod = (a: bigint) => { a %= P; return a < 0n ? a + P : a; };
function modpow(b: bigint, e: bigint): bigint { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
const D = mod(-121665n * modpow(121666n, P - 2n));
/** true if the 32 bytes decompress to a point on ed25519 (then they cannot be a PDA) */
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P, u = mod(y2 - 1n), v = mod(D * y2 + 1n);
  const v3 = (((v * v) % P) * v) % P, v7 = (((v3 * v3) % P) * v) % P;
  let x = (((u * v3) % P) * modpow((u * v7) % P, (P - 5n) / 8n)) % P;
  const vx2 = (((v * x) % P) * x) % P;
  if (vx2 === u) { /* ok */ } else if (vx2 === mod(-u)) x = (x * modpow(2n, (P - 1n) / 4n)) % P; else return false;
  if (x === 0n && sign === 1n) return false;
  return true;
}
export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] {
  const pid = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.from([bump]));
    h.update(pid);
    h.update("ProgramDerivedAddress");
    const d = h.digest();
    if (!onCurve(d)) return [base58(d), bump];
  }
  throw new Error("no PDA");
}
const curveCache = new Map<string, string>();
/** pump.fun bonding-curve account for a mint: PDA("bonding-curve", mint) under the pump program. */
export function bondingCurveAddress(mint: string): string {
  let c = curveCache.get(mint);
  if (!c) { c = findProgramAddress([Buffer.from("bonding-curve"), base58Decode(mint)], PUMP_PROGRAM)[0]; curveCache.set(mint, c); }
  return c;
}

export interface CurveState { vTokens: number; vSol: number; realTokens: number; realSol: number; totalSupply: number; complete: boolean; creator: string | null }
/** Decode a BondingCurve account (discriminator, 5 x u64, complete flag, creator). Units: tokens (6 dp applied) and SOL. */
export function decodeCurveAccount(b64: string): CurveState | null {
  const b = Buffer.from(b64, "base64");
  if (b.length < 49 || b.subarray(0, 8).toString("hex") !== "17b7f83760d8ac60") return null;
  const u = (o: number) => Number(b.readBigUInt64LE(o));
  return { vTokens: u(8) / 1e6, vSol: u(16) / 1e9, realTokens: u(24) / 1e6, realSol: u(32) / 1e9, totalSupply: u(40) / 1e6, complete: b[48] === 1, creator: b.length >= 81 ? base58(b.subarray(49, 81)) : null };
}
