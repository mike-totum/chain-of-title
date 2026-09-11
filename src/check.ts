/**
 * What was this token at birth, and does what you are shown now match the chain?
 *   npm run check -- <mint>
 *
 * Archive first. The facts that identify a manufactured token - the creator taking most of the supply, a curve
 * completed with no outside buyer - are only visible while it happens. Once the operator funds the pool with real SOL
 * and spreads the float, every present-tense check passes: WOFI showed 2,029 SOL against an expected 2,027 under
 * constant product and a 4 % top holder, while having been created with 79.3 % dev supply and zero outside buyers.
 * Cold inspection is therefore the fallback, not the product, and where we did not watch we say so.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { rpc as rpcMulti } from "./rpc-http.ts";
import { profile, verdictLine, findBuyout } from "./operator.ts";

const WSOL = "So11111111111111111111111111111111111111112";
const GRAD_POOL_SOL = 85, GRAD_CAP_SOL = 411;
const mint = process.argv[2];
if (!mint) { console.error("usage: npm run check -- <mint>"); process.exit(1); }

const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");
const rpc = (m: string, p: unknown[]) => rpcMulti(m, p, 20_000);
const pct = (n: number) => `${n.toFixed(1)}%`;

type Line = { level: "DANGER" | "CAUTION" | "INFO"; text: string };
const out: Line[] = [];
const notRun: string[] = [];

// ---------- coverage ----------
// "we watched this launch" is only true if the collector was demonstrably running at that instant. Run heartbeats
// (runs.stopped_at, refreshed every 60 s) make downtime visible; a launch inside a gap has no provenance and must be
// reported as unobserved rather than answered from whatever partial rows happen to exist.
const GAP_TOLERANCE_MS = 180_000;
const runs = db.prepare("SELECT started_at, stopped_at FROM runs WHERE started_at IS NOT NULL ORDER BY started_at").all() as { started_at: number; stopped_at: number | null }[];
const windows: { a: number; b: number }[] = [];
for (const r of runs) {
  const end = r.stopped_at ?? r.started_at;
  const last = windows[windows.length - 1];
  if (last && r.started_at - last.b <= GAP_TOLERANCE_MS) last.b = Math.max(last.b, end);
  else windows.push({ a: r.started_at, b: end });
}
const inCoverage = (ts: number) => windows.some((w) => ts >= w.a && ts <= w.b);
const cov = db.prepare("SELECT COUNT(*) n FROM tokens WHERE late_discovery=0").get() as { n: number };
const since = windows.length ? new Date(windows[0].a).toISOString().slice(0, 16).replace("T", " ") : "unknown";
const gapMin = windows.slice(1).reduce((acc, w, i) => acc + Math.max(0, w.a - windows[i].b), 0) / 60_000;

// ---------- archive ----------
const t = db.prepare(`SELECT symbol, name, creator, created_at, late_discovery, dev_pct, dev_sold, unique_buyers,
  snap30_buyers, bundled_buyers, graduated, graduated_at, buy_vol_sol, sell_vol_sol, pool
  FROM tokens WHERE mint = ?`).get(mint) as any;

const watched = !!t && !t.late_discovery && inCoverage(t.created_at);
const inGap = !!t && !t.late_discovery && !inCoverage(t.created_at);
console.log(`\n${t?.symbol ? `${t.symbol}  ` : ""}${mint}`);
console.log(`  archive covers pump.fun launches since ${since} UTC - ${cov.n.toLocaleString()} watched from creation${gapMin >= 1 ? `, with ${gapMin.toFixed(0)} min of recorded downtime` : ", no recorded downtime"}\n`);

if (watched) {
  const gradS = t.graduated_at ? Math.round((t.graduated_at - t.created_at) / 1000) : null;
  console.log("  AT LAUNCH - recorded live, not reconstructed");
  console.log(`    created         ${new Date(t.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  console.log(`    creator         ${t.creator || "unknown"}`);
  console.log(`    creator took    ${t.dev_pct?.toFixed(1) ?? "?"}% of supply in the first block`);
  console.log(`    outside buyers  ${t.unique_buyers ?? 0} on the curve (${t.snap30_buyers ?? 0} in the first 30s, ${t.bundled_buyers ?? 0} bundled into the creation block)`);
  console.log(`    graduated       ${t.graduated ? (gradS !== null ? `yes, ${gradS}s after launch` : "yes") : "no"}`);
  console.log(`    creator sold    ${t.dev_sold ? "yes" : "not while we watched"}`);

  // the checks that only launch-time observation can make
  if (t.dev_pct >= 50)
    out.push({ level: "DANGER", text: `the creator took ${pct(t.dev_pct)} of the entire supply at launch. Nothing visible on-chain today shows this - the float has since been spread across wallets.` });
  else if (t.dev_pct >= 20)
    out.push({ level: "CAUTION", text: `the creator took ${pct(t.dev_pct)} of supply at launch.` });
  if (t.graduated && (t.unique_buyers ?? 0) === 0)
    out.push({ level: "DANGER", text: `it completed its bonding curve with zero outside buyers. The "graduation" was funded by the creator, not by demand.` });
  else if (t.graduated && (t.unique_buyers ?? 0) < 10)
    out.push({ level: "CAUTION", text: `only ${t.unique_buyers} outside buyers existed on the curve before it graduated.` });
  if (t.graduated && gradS !== null && gradS <= 60)
    out.push({ level: "DANGER", text: `it left the curve ${gradS}s after launch - the float was taken before anyone could buy at a normal price.` });
  if (t.dev_sold) out.push({ level: "CAUTION", text: `the creator sold while we were watching.` });

  // Who took the curve, and what they did the last time. A flag says "be careful"; this says who is about to sell to
  // you, and it is the one thing a configuration scanner cannot produce because it needs the wallet's whole history.
  const bo = findBuyout(db, mint, 40);
  if (bo) {
    const p = profile(db, bo.wallet);
    const line = verdictLine(p);
    console.log("\n  WHO TOOK THE CURVE");
    console.log(`    ${bo.wallet}`);
    console.log(`    bought ${bo.sol.toFixed(0)} SOL of this curve in one transaction${t.created_at ? `, ${((bo.ts - t.created_at) / 3600_000).toFixed(1)} h after launch` : ""}`);
    console.log(`    across our archive: ${p.buyouts.length} curve buyout${p.buyouts.length === 1 ? "" : "s"}, ${p.curveSol.toFixed(0)} SOL spent, ${p.ammBuy.toFixed(0)} SOL bought and ${p.ammSell.toFixed(0)} SOL sold on the open market`);
    if (line) out.push({ level: p.ammSell > p.ammBuy * 3 && p.ammSell >= 20 ? "DANGER" : "CAUTION", text: line });
  }

  const cl = db.prepare(`SELECT DISTINCT w.cluster FROM trades tr JOIN operator_wallets w ON w.wallet = tr.wallet
    WHERE tr.mint = ? AND w.cluster IS NOT NULL`).all(mint) as { cluster: string }[];
  const avoid = new Set((db.prepare("SELECT cluster FROM operator_policy WHERE policy='avoid'").all() as any[]).map((x) => x.cluster));
  const bad = cl.map((c) => c.cluster).filter((c) => avoid.has(c));
  if (bad.length) out.push({ level: "CAUTION", text: `wallets from operator cluster${bad.length > 1 ? "s" : ""} ${bad.join(", ")} traded it; those farms sell into buyers on every play we have measured.` });
} else if (inGap) {
  console.log("  AT LAUNCH - not observed");
  console.log(`    It launched at ${new Date(t.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC, while the collector was down.`);
  console.log("    We hold partial rows for it, but they are not provenance and are not reported here.");
} else if (t) {
  console.log("  AT LAUNCH - not observed");
  console.log(`    This token was added to our records only after we found it trading (${new Date(t.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC).`);
  console.log("    Its creation is outside what we watched, so creator share and outside-buyer count are unknown.");
} else {
  console.log("  AT LAUNCH - not observed");
  console.log("    We have no record of this token. It launched outside our coverage window, or on another venue.");
}

// ---------- now ----------
let poolLine = "";
const local = (db.prepare("SELECT pool FROM pool_map WHERE mint=? ORDER BY created_at DESC LIMIT 1").get(mint) as any)?.pool ?? t?.pool ?? null;
let pool: string | null = local;
if (!pool) {
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
    if (r.ok) { const j: any = await r.json(); if (typeof j?.pump_swap_pool === "string") pool = j.pump_swap_pool; }
  } catch {}
}
console.log("\n  NOW - read from the chain just now");
if (!pool) {
  console.log("    no PumpSwap pool found; nothing about a displayed price can be verified.");
} else {
  // read the pool's own vaults through the endpoint pool; outcomes.poolReserves pins a single public node that our
  // own monitor keeps saturated, and a rate-limited read must not degrade the answer
  const vault = async (m: string): Promise<number | null> => {
    try {
      const j = await rpc("getTokenAccountsByOwner", [pool, { mint: m }, { encoding: "jsonParsed" }]);
      return (j?.value ?? []).reduce((a: number, x: any) => a + Number(x.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
    } catch { return null; }
  };
  const [baseTokens, quoteSol] = await Promise.all([vault(mint), vault(WSOL)]);
  const r = baseTokens !== null && quoteSol !== null && baseTokens > 0
    ? { baseTokens, quoteSol, priceSol: quoteSol / baseTokens } : null;
  const supplyRes = await rpc("getTokenSupply", [mint]).catch((e) => { notRun.push(`supply (${(e as Error).message})`); return null; });
  if (!r || !supplyRes) {
    notRun.push("pool reserves");
    console.log(`    pool ${pool} - could not read balances.`);
  } else {
    const supply = Number(supplyRes.value.uiAmount);
    const capSol = r.priceSol * supply;
    const k = capSol / GRAD_CAP_SOL;
    const expected = GRAD_POOL_SOL * Math.sqrt(Math.max(k, 1));
    console.log(`    pool            ${pool}`);
    console.log(`    in the pool     ${r.quoteSol.toFixed(1)} SOL and ${r.baseTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`);
    console.log(`    implied cap     ${capSol.toFixed(0)} SOL (${k.toFixed(1)}x the graduation cap)`);
    console.log(`    backed by pool  ${(100 * r.quoteSol / Math.max(capSol, 1e-9)).toFixed(2)}% of the cap is actually in the pool`);
    if (k >= 2 && r.quoteSol < expected * 0.25)
      out.push({ level: "DANGER", text: `the pool holds ${r.quoteSol.toFixed(1)} SOL where a genuine ${k.toFixed(0)}x move leaves about ${expected.toFixed(0)}. The displayed cap is not backed by this pool.` });
    if (r.quoteSol < 40)
      out.push({ level: "DANGER", text: `only ${r.quoteSol.toFixed(1)} SOL of liquidity exists; a position cannot be sold near the quoted price.` });
  }
}

// ---------- verdict ----------
console.log("");
if (notRun.length) {
  console.log(`  [UNKNOWN] could not complete: ${notRun.join("; ")}. This is not a clean result - re-run.`);
}
if (!watched && !out.length && !notRun.length) {
  console.log("  [UNKNOWN] present-tense checks pass, but we did not watch this token launch.");
  console.log("            A manufactured token looks exactly like this once its float has been spread.");
}
if (watched && !out.length && !notRun.length)
  console.log("  no warning - watched from creation, the creator did not take the supply, real buyers existed, and the pool supports the price.");
for (const l of out) console.log(`  [${l.level}] ${l.text}`);
console.log("");
