/**
 * Pattern mining: which observable features at (or shortly after) launch correlate with graduation
 * and with real runners. Humans are creatures of habit - operators launch at habitual times, size the
 * dev buy habitually, reuse names, and bring the same wallets.
 *
 *   npm run patterns -- [--hours 48] [--min-n 30]
 *
 * For each feature the table shows bucket, n, graduation rate, real-runner rate and lift vs the base
 * rate. The STRONGEST section lists buckets with the biggest positive and negative lift (min n).
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { isRealOutcome, organicDemand } from "./label.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const hours = Number(args.get("hours") ?? 48);
const minN = Number(args.get("min-n") ?? 30);
const db = openDb(config.dbPath);
const since = Date.now() - hours * 3600_000;
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];

interface Tok {
  mint: string; symbol: string; name: string; uri: string; creator: string; created_at: number; dev_pct: number; dev_sold: number;
  graduated: number; graduated_at: number | null; launch_price: number; peak_price: number; unique_buyers: number; bundled_buyers: number;
  snap30_buyers: number | null; snap30_buys: number | null; snap30_sells: number | null; snap30_vol: number | null;
  twitter: string | null; telegram: string | null; website: string | null; buys: number; sells: number;
  mcap_sol: number | null; mcap_usd: number | null; pool_sol: number | null; verified: number | null; dev_sol: number | null;
}
const toks = q<Tok>(
  `SELECT t.*, o.mcap_sol, o.mcap_usd, o.pool_sol, o.verified, (SELECT sol FROM trades x WHERE x.mint=t.mint AND x.is_dev=1 AND x.age_ms=0 LIMIT 1) dev_sol
   FROM tokens t LEFT JOIN token_outcomes o ON o.mint=t.mint
   WHERE t.created_at >= ? AND t.late_discovery=0 AND t.finalized=1 AND t.launch_price > 0`,
  since,
);
const realCache = new Map<string, boolean>();
const real = (t: Tok) => { let v = realCache.get(t.mint); if (v === undefined) { v = t.graduated === 1 && t.mcap_sol !== null && isRealOutcome({ mcapSol: t.mcap_sol, mcapUsd: t.mcap_usd, poolSol: t.pool_sol, verified: !!t.verified }) && organicDemand(db, t); realCache.set(t.mint, v); } return v; };
const n = toks.length, nG = toks.filter((t) => t.graduated === 1).length, nR = toks.filter(real).length;
const baseG = nG / n, baseR = nR / n;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(`\n=== pattern mining - ${n} finalized launches (last ${hours}h), graduated ${nG} (${pct(baseG)}), real runners ${nR} (${pct(baseR)}) ===`);
console.log("lift = bucket rate / base rate. Real-runner rates need outcomes fetched (run the backtest or daily report first).\n");

interface Bucket { n: number; g: number; r: number }
interface Finding { feature: string; bucket: string; n: number; g: number; r: number; liftG: number; liftR: number }
const findings: Finding[] = [];
function feature(name: string, f: (t: Tok) => string | null, order?: string[]) {
  const b = new Map<string, Bucket>();
  for (const t of toks) {
    const k = f(t);
    if (k === null) continue;
    const e = b.get(k) ?? b.set(k, { n: 0, g: 0, r: 0 }).get(k)!;
    e.n++;
    if (t.graduated) e.g++;
    if (real(t)) e.r++;
  }
  const keys = order ? order.filter((k) => b.has(k)) : [...b.keys()].sort();
  console.log(name.toUpperCase());
  console.log("  bucket".padEnd(34) + "n".padStart(7) + "graduated".padStart(12) + "lift".padStart(7) + "real".padStart(9) + "lift".padStart(7));
  for (const k of keys) {
    const e = b.get(k)!;
    const liftG = e.g / e.n / baseG, liftR = baseR ? e.r / e.n / baseR : 0;
    console.log(("  " + k).padEnd(34) + String(e.n).padStart(7) + pct(e.g / e.n).padStart(12) + `${liftG.toFixed(2)}x`.padStart(7) + pct(e.r / e.n).padStart(9) + `${liftR.toFixed(2)}x`.padStart(7));
    if (e.n >= minN) findings.push({ feature: name, bucket: k, n: e.n, g: e.g, r: e.r, liftG, liftR });
  }
  console.log();
}
const bin = (v: number | null | undefined, edges: number[], labels: string[]) => {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[edges.length];
};

// ---------- timing habits ----------
feature("launch hour (UTC)", (t) => String(new Date(t.created_at).getUTCHours()).padStart(2, "0") + ":00");
feature("launch minute of hour", (t) => bin(new Date(t.created_at).getUTCMinutes(), [15, 30, 45], [":00-14", ":15-29", ":30-44", ":45-59"]));
feature("launch second of minute", (t) => bin(new Date(t.created_at).getUTCSeconds(), [10, 20, 30, 40, 50], [":00-09", ":10-19", ":20-29", ":30-39", ":40-49", ":50-59"]));

// ---------- dev habits ----------
feature("dev buy (% of supply)", (t) => bin(t.dev_pct, [0.01, 1, 3, 6, 10], ["0 (no dev buy)", "0-1%", "1-3%", "3-6%", "6-10%", ">10%"]), ["0 (no dev buy)", "0-1%", "1-3%", "3-6%", "6-10%", ">10%"]);
feature("dev buy (SOL)", (t) => bin(t.dev_sol, [0.01, 0.1, 0.5, 1, 2, 5], ["0", "<0.1", "0.1-0.5", "0.5-1", "1-2", "2-5", ">=5"]), ["0", "<0.1", "0.1-0.5", "0.5-1", "1-2", "2-5", ">=5"]);
feature("dev buy is a round number of SOL", (t) => (t.dev_sol === null ? null : t.dev_sol === 0 ? "no dev buy" : Math.abs(t.dev_sol * 10 - Math.round(t.dev_sol * 10)) < 0.005 ? "round (x.x0)" : "not round"));

// ---------- creator history ----------
const byCreator = new Map<string, Tok[]>();
for (const t of toks) (byCreator.get(t.creator) ?? byCreator.set(t.creator, []).get(t.creator)!).push(t);
for (const arr of byCreator.values()) arr.sort((a, b) => a.created_at - b.created_at);
const priorOf = (t: Tok) => byCreator.get(t.creator)!.filter((x) => x.created_at < t.created_at);
feature("creator: prior launches in window", (t) => bin(priorOf(t).length, [1, 2, 5, 10], ["0 (first seen)", "1", "2-4", "5-9", ">=10"]), ["0 (first seen)", "1", "2-4", "5-9", ">=10"]);
feature("creator: previous token graduated?", (t) => { const p = priorOf(t); if (!p.length) return null; return p[p.length - 1].graduated ? "yes" : "no"; });
feature("creator: previous token dev sold?", (t) => { const p = priorOf(t); if (!p.length) return null; return p[p.length - 1].dev_sold ? "yes" : "no"; });
feature("creator: minutes since their previous launch", (t) => { const p = priorOf(t); if (!p.length) return null; return bin((t.created_at - p[p.length - 1].created_at) / 60000, [2, 10, 60, 360], ["<2 min", "2-10 min", "10-60 min", "1-6 h", ">6 h"]); }, ["<2 min", "2-10 min", "10-60 min", "1-6 h", ">6 h"]);
feature("creator: launch index (Nth token by this wallet)", (t) => bin(priorOf(t).length + 1, [2, 3, 6], ["1st", "2nd", "3rd-5th", "6th+"]), ["1st", "2nd", "3rd-5th", "6th+"]);

// ---------- naming habits ----------
const hasEmoji = (s: string) => /[^\x00-\x7F]/.test(s);
feature("symbol length", (t) => bin(t.symbol.length, [3, 5, 7], ["1-2", "3-4", "5-6", "7+"]), ["1-2", "3-4", "5-6", "7+"]);
feature("symbol style", (t) => (t.symbol === t.symbol.toUpperCase() && /^[A-Z0-9]+$/.test(t.symbol) ? "ALLCAPS" : /^[a-z0-9]+$/.test(t.symbol) ? "lowercase" : hasEmoji(t.symbol) ? "emoji/non-ascii" : "mixed"));
feature("name contains digits", (t) => (/\d/.test(t.name) ? "yes" : "no"));
feature("name mentions a celebrity/brand word", (t) => (/trump|elon|musk|pepe|doge|shib|bonk|wif|nvidia|tesla|nasa|ai\b|grok|openai|solana|pump|cat|dog/i.test(t.name) ? "yes" : "no"));
// clone waves: same symbol launched by others within +-60 min
const bySym = new Map<string, Tok[]>();
for (const t of toks) (bySym.get(t.symbol.toUpperCase()) ?? bySym.set(t.symbol.toUpperCase(), []).get(t.symbol.toUpperCase())!).push(t);
for (const arr of bySym.values()) arr.sort((a, b) => a.created_at - b.created_at);
const wave = (t: Tok) => bySym.get(t.symbol.toUpperCase())!.filter((x) => Math.abs(x.created_at - t.created_at) <= 3600_000);
feature("clone wave size (same symbol within 1 h)", (t) => bin(wave(t).length, [2, 4, 10], ["unique", "2-3", "4-9", ">=10"]), ["unique", "2-3", "4-9", ">=10"]);
feature("position in clone wave", (t) => { const w = wave(t); if (w.length < 2) return null; const i = w.findIndex((x) => x.mint === t.mint); return i === 0 ? "first" : i === 1 ? "second" : i < 5 ? "3rd-5th" : "later"; }, ["first", "second", "3rd-5th", "later"]);

// ---------- metadata habits ----------
feature("socials in metadata", (t) => { const s = [t.twitter ? "X" : "", t.telegram ? "TG" : "", t.website ? "web" : ""].filter(Boolean); return s.length ? s.join("+") : "none"; });
feature("X link type", (t) => (!t.twitter ? "none" : /\/status\//.test(t.twitter) ? "a specific tweet" : /\/i\/communities\//.test(t.twitter) ? "a community" : "a profile"));
feature("metadata host", (t) => { try { const h = new URL(t.uri).hostname; return h.includes("ipfs") ? "ipfs" : h.includes("pump.fun") ? "pump.fun" : h; } catch { return "invalid"; } });

// ---------- early activity habits ----------
feature("same-block buyers (bundle)", (t) => bin(t.bundled_buyers, [1, 3, 6, 12], ["0", "1-2", "3-5", "6-11", ">=12"]), ["0", "1-2", "3-5", "6-11", ">=12"]);
feature("distinct buyers in first 30 s", (t) => bin(t.snap30_buyers, [1, 3, 8, 15, 30], ["0", "1-2", "3-7", "8-14", "15-29", ">=30"]), ["0", "1-2", "3-7", "8-14", "15-29", ">=30"]);
feature("sells / buys in first 30 s", (t) => (t.snap30_buys ? bin((t.snap30_sells ?? 0) / t.snap30_buys, [0.01, 0.25, 0.5, 1], ["no sells", "<25%", "25-50%", "50-100%", ">=100%"]) : null), ["no sells", "<25%", "25-50%", "50-100%", ">=100%"]);
feature("volume in first 30 s (SOL)", (t) => bin(t.snap30_vol, [0.5, 2, 5, 15, 40], ["<0.5", "0.5-2", "2-5", "5-15", "15-40", ">=40"]), ["<0.5", "0.5-2", "2-5", "5-15", "15-40", ">=40"]);
feature("dev sold during watch", (t) => (t.dev_sold ? "yes" : "no"));

// ---------- wallet habits from wallet_token_stats ----------
const repeat = new Set((q(`SELECT wallet FROM wallet_token_stats WHERE token_created_at >= ? AND is_dev=0 GROUP BY wallet HAVING COUNT(*) >= 5`, since) as any[]).map((r) => r.wallet));
const first10 = new Map<string, any[]>();
for (const r of q(`SELECT mint, wallet, first_buy_rank, sol_in, hold_s, first_buy_slot_delta FROM wallet_token_stats WHERE token_created_at >= ? AND is_dev=0 AND first_buy_rank <= 10`, since) as any[])
  (first10.get(r.mint) ?? first10.set(r.mint, []).get(r.mint)!).push(r);
feature("first-10 buyers who are repeat players (>=5 tokens)", (t) => { const f = first10.get(t.mint); if (!f || f.length < 5) return null; const k = f.filter((r) => repeat.has(r.wallet)).length / f.length; return bin(k, [0.01, 0.3, 0.6], ["none", "<30%", "30-60%", ">=60%"]); }, ["none", "<30%", "30-60%", ">=60%"]);
feature("median first-10 buy size (SOL)", (t) => { const f = first10.get(t.mint); if (!f || f.length < 5) return null; const s = f.map((r) => r.sol_in).sort((a, b) => a - b); return bin(s[Math.floor(s.length / 2)], [0.05, 0.2, 0.5, 1, 3], ["<0.05 (dust)", "0.05-0.2", "0.2-0.5", "0.5-1", "1-3", ">=3"]); }, ["<0.05 (dust)", "0.05-0.2", "0.2-0.5", "0.5-1", "1-3", ">=3"]);
feature("first-10 buyers who flipped within 60 s", (t) => { const f = first10.get(t.mint); if (!f || f.length < 5) return null; const k = f.filter((r) => r.hold_s !== null && r.hold_s <= 60).length / f.length; return bin(k, [0.01, 0.3, 0.6], ["none", "<30%", "30-60%", ">=60%"]); }, ["none", "<30%", "30-60%", ">=60%"]);

// ---------- wallet co-occurrence clusters ----------
console.log("WALLET CLUSTERS - pairs of wallets that are both in the first 10 buyers of 3+ tokens");
console.log("  (graduation credit only when it took >= 60 s: instant graduations are dev-funded and were mislabelling operator bundles as winning crews)");
// a graduation an outsider could have traded: the token spent at least a minute on the curve
const gradTradeable = (t: Tok) => t.graduated === 1 && (t.graduated_at === null || t.graduated_at - t.created_at >= 60_000);
const pairCount = new Map<string, { n: number; g: number; r: number; mints: Set<string> }>();
for (const [mint, f] of first10) {
  const t = toks.find((x) => x.mint === mint);
  if (!t) continue;
  const ws = [...new Set(f.map((r) => r.wallet as string))].sort();
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++) {
      const k = ws[i] + "|" + ws[j];
      const e = pairCount.get(k) ?? pairCount.set(k, { n: 0, g: 0, r: 0, mints: new Set() }).get(k)!;
      e.n++; e.mints.add(mint);
      if (gradTradeable(t)) e.g++;
      if (real(t)) e.r++;
    }
}
const pairs = [...pairCount].filter(([, e]) => e.n >= 3).sort((a, b) => b[1].g / b[1].n - a[1].g / a[1].n || b[1].n - a[1].n).slice(0, 15);
// union-find recurring pairs into teams and persist them for the live team-wallet strategy
{
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const stats = new Map<string, { n: number; g: number; r: number }>();
  // wallets that touch a large share of all launches are sniper bots, not crews
  const touched = new Map<string, number>();
  for (const f of first10.values()) for (const r of f) touched.set(r.wallet, (touched.get(r.wallet) ?? 0) + 1);
  const maxTouched = Math.max(20, 0.02 * first10.size);
  for (const [k, e] of pairCount) {
    if (e.n < 4 || e.g / e.n < 0.6) continue; // recurring AND their tokens usually graduate
    const [a, b] = k.split("|");
    if ((touched.get(a) ?? 0) > maxTouched || (touched.get(b) ?? 0) > maxTouched) continue;
    union(a, b);
    for (const w of [a, b]) { const s = stats.get(w) ?? stats.set(w, { n: 0, g: 0, r: 0 }).get(w)!; s.n = Math.max(s.n, e.n); s.g = Math.max(s.g, e.g); s.r = Math.max(s.r, e.r); }
  }
  const teams = new Map<string, string[]>();
  for (const w of stats.keys()) (teams.get(find(w)) ?? teams.set(find(w), []).get(find(w))!).push(w);
  db.exec("DELETE FROM wallet_teams");
  const ins = db.prepare("INSERT INTO wallet_teams (team_id, wallet, tokens_together, graduated, real, updated_at) VALUES (?,?,?,?,?,?)");
  let id = 0;
  for (const members of teams.values()) {
    if (members.length < 2 || members.length > 20) continue; // >20 co-buying wallets is a farm, not a crew
    id++;
    for (const w of members) { const s = stats.get(w)!; ins.run(id, w, s.n, s.g, s.r, Date.now()); }
  }
  console.log(`  → ${id} team(s) with ${[...teams.values()].filter((m) => m.length >= 2).reduce((a, m) => a + m.length, 0)} wallets saved to wallet_teams (pairs recurring on 4+ tokens with >=60% graduation, wallets touching <=2% of launches, crews of 2-20). The live team-wallet strategy uses them.`);
}
if (!pairs.length) console.log("  (none yet)");
for (const [k, e] of pairs) {
  const [a, b] = k.split("|");
  console.log(`  ${a.slice(0, 4)}…${a.slice(-4)} + ${b.slice(0, 4)}…${b.slice(-4)}   ${String(e.n).padStart(3)} tokens together   graduated ${e.g} (${pct(e.g / e.n)})   real ${e.r}`);
}
console.log(`  ${pairCount.size} pairs seen; ${[...pairCount.values()].filter((e) => e.n >= 3).length} recur on 3+ tokens. A recurring pair with a high graduation rate is a team, not a coincidence.\n`);

// ---------- strongest ----------
console.log(`STRONGEST PATTERNS (buckets with n >= ${minN}), by graduation lift`);
const sorted = [...findings].sort((a, b) => b.liftG - a.liftG);
const show = (f: Finding) => console.log(`  ${(f.feature + " = " + f.bucket).slice(0, 62).padEnd(63)} n=${String(f.n).padStart(5)}  graduated ${pct(f.g / f.n).padStart(6)} (${f.liftG.toFixed(2)}x)   real ${pct(f.r / f.n).padStart(5)} (${f.liftR.toFixed(2)}x)`);
console.log("  positive:");
for (const f of sorted.slice(0, 12)) show(f);
console.log("  negative:");
for (const f of sorted.slice(-8).reverse()) show(f);
console.log("\nA pattern is only a habit if it repeats tomorrow. Compare this section day over day before acting on it.\n");
