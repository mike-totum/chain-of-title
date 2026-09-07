/**
 * Do social posts lead price, or follow it?
 *
 *   npm run leadlag -- [--hours 24] [--min-tweets 3]
 *
 * For every stored tweet that names a tracked token (by mint address or by $TICKER matched to a token
 * launched within the previous 6 h), find the trade price at the moment of the tweet, the price 5 min
 * earlier, and the prices 5 / 15 / 30 min later. Aggregates:
 *   - by ORDER of mention (1st tweet about the token, 2nd-3rd, 4th-10th, later)
 *   - by whether the tweet contains the contract address
 *   - by tweet position relative to launch
 * A "move before" well above 1.0 with a "move after" near 1.0 means posts follow price.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const hours = Number(args.get("hours") ?? 24);
const minTweets = Number(args.get("min-tweets") ?? 3);
const db = openDb(config.dbPath);
const since = Date.now() - hours * 3600_000;
const q = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as any[])) as T[];
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "-");

const tweets = q(`SELECT id, author, followers, created_at, mints, cashtags, text FROM tweets WHERE created_at >= ? ORDER BY created_at`, since);
const tokens = q(`SELECT mint, symbol, created_at, graduated, launch_price, peak_price, peak_at FROM tokens WHERE created_at >= ? AND launch_price > 0`, since - 6 * 3600_000);
const byMint = new Map(tokens.map((t) => [t.mint, t]));
const bySym = new Map<string, any[]>();
for (const t of tokens) (bySym.get(t.symbol.toUpperCase()) ?? bySym.set(t.symbol.toUpperCase(), []).get(t.symbol.toUpperCase())!).push(t);

// match tweets to tokens: by mint first; else by cashtag -> the most-mentioned mint for that tag in the surrounding 30 min, else the busiest token with that symbol launched in the prior 6 h
const tagMintVotes = new Map<string, Map<string, number>>();
for (const tw of tweets) for (const c of String(tw.cashtags ?? "").split(" ").filter(Boolean)) for (const m of String(tw.mints ?? "").split(" ").filter(Boolean)) {
  const v = tagMintVotes.get(c) ?? tagMintVotes.set(c, new Map()).get(c)!;
  v.set(m, (v.get(m) ?? 0) + 1);
}
interface Pair { tw: any; tok: any; hasCa: boolean }
const pairs: Pair[] = [];
for (const tw of tweets) {
  const mints = String(tw.mints ?? "").split(" ").filter(Boolean);
  const hit = new Set<string>();
  for (const m of mints) if (byMint.has(m)) hit.add(m);
  if (!hit.size)
    for (const c of String(tw.cashtags ?? "").split(" ").filter(Boolean)) {
      const votes = tagMintVotes.get(c);
      const voted = votes ? [...votes].sort((a, b) => b[1] - a[1]).find(([m]) => byMint.has(m))?.[0] : undefined;
      if (voted) { hit.add(voted); continue; }
      const cands = (bySym.get(c) ?? []).filter((t) => t.created_at <= tw.created_at && tw.created_at - t.created_at <= 6 * 3600_000);
      if (cands.length === 1) hit.add(cands[0].mint); // ambiguous symbols are skipped
    }
  for (const m of hit) pairs.push({ tw, tok: byMint.get(m), hasCa: mints.includes(m) });
}
console.log(`\n=== lead/lag — ${pairs.length} tweet→token matches from ${tweets.length} tweets over ${hours}h ===\n`);

// price lookup from stored trades (curve + amm): last trade price at or before a time
const priceCache = new Map<string, { ts: number; price: number }[]>();
function series(mint: string) {
  let s = priceCache.get(mint);
  if (!s) { s = q(`SELECT ts, price FROM trades WHERE mint = ? AND price > 0 ORDER BY ts`, mint) as any[]; priceCache.set(mint, s); }
  return s;
}
function priceAt(mint: string, ts: number): number | null {
  const s = series(mint);
  if (!s.length || ts < s[0].ts) return null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].ts <= ts) lo = mid; else hi = mid - 1; }
  return s[lo].price;
}
function maxAfter(mint: string, ts: number): number | null {
  const s = series(mint);
  let mx: number | null = null;
  for (const x of s) if (x.ts > ts && (mx === null || x.price > mx)) mx = x.price;
  return mx;
}

interface Row { order: number; hasCa: boolean; minSinceLaunch: number; before5: number | null; after5: number | null; after15: number | null; after30: number | null; peakAfter: number | null; peakBefore: number | null; author: string; followers: number; sym: string }
const rows: Row[] = [];
const seenPerToken = new Map<string, number>();
const tokenTweetCount = new Map<string, number>();
for (const p of pairs) tokenTweetCount.set(p.tok.mint, (tokenTweetCount.get(p.tok.mint) ?? 0) + 1);
for (const p of pairs.sort((a, b) => a.tw.created_at - b.tw.created_at)) {
  if ((tokenTweetCount.get(p.tok.mint) ?? 0) < minTweets) continue;
  const order = (seenPerToken.get(p.tok.mint) ?? 0) + 1;
  seenPerToken.set(p.tok.mint, order);
  const t0 = p.tw.created_at;
  const p0 = priceAt(p.tok.mint, t0);
  if (!p0) continue;
  const pb = priceAt(p.tok.mint, t0 - 5 * 60_000);
  const r = (ts: number) => { const px = priceAt(p.tok.mint, ts); return px ? px / p0 : null; };
  const pk = maxAfter(p.tok.mint, t0);
  rows.push({
    order, hasCa: p.hasCa, minSinceLaunch: (t0 - p.tok.created_at) / 60000,
    before5: pb ? p0 / pb : null, after5: r(t0 + 5 * 60_000), after15: r(t0 + 15 * 60_000), after30: r(t0 + 30 * 60_000),
    peakAfter: pk ? pk / p0 : null, peakBefore: p0 / p.tok.launch_price, author: p.tw.author, followers: p.tw.followers ?? 0, sym: p.tok.symbol,
  });
}
const nz = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null && Number.isFinite(x));
function section(title: string, groups: [string, Row[]][]) {
  console.log(title);
  console.log("  group".padEnd(30) + "n".padStart(5) + "  already up vs launch" + "  move in prior 5m" + "  +5m" .padStart(7) + "  +15m".padStart(7) + "  +30m".padStart(7) + "  peak after" + "  share >=1.5x after");
  for (const [name, g] of groups) {
    if (!g.length) continue;
    const pk = nz(g.map((r) => r.peakAfter));
    console.log(
      ("  " + name).padEnd(30) + String(g.length).padStart(5) +
        `${f(median(nz(g.map((r) => r.peakBefore))), 1)}x`.padStart(22) +
        `${f(median(nz(g.map((r) => r.before5))))}x`.padStart(18) +
        `${f(median(nz(g.map((r) => r.after5))))}x`.padStart(7) +
        `${f(median(nz(g.map((r) => r.after15))))}x`.padStart(7) +
        `${f(median(nz(g.map((r) => r.after30))))}x`.padStart(7) +
        `${f(median(pk))}x`.padStart(12) +
        `${pk.length ? ((100 * pk.filter((x) => x >= 1.5).length) / pk.length).toFixed(0) : "-"}%`.padStart(20),
    );
  }
  console.log();
}
section("BY ORDER OF MENTION (medians; 'already up' = price at tweet / launch price)", [
  ["1st tweet about the token", rows.filter((r) => r.order === 1)],
  ["2nd-3rd", rows.filter((r) => r.order >= 2 && r.order <= 3)],
  ["4th-10th", rows.filter((r) => r.order >= 4 && r.order <= 10)],
  ["11th+", rows.filter((r) => r.order > 10)],
]);
section("BY CONTENT", [
  ["contains the contract address", rows.filter((r) => r.hasCa)],
  ["ticker only", rows.filter((r) => !r.hasCa)],
]);
section("BY TIME SINCE LAUNCH", [
  ["before launch / first 2 min", rows.filter((r) => r.minSinceLaunch < 2)],
  ["2-10 min", rows.filter((r) => r.minSinceLaunch >= 2 && r.minSinceLaunch < 10)],
  ["10-30 min", rows.filter((r) => r.minSinceLaunch >= 10 && r.minSinceLaunch < 30)],
  ["30 min - 6 h", rows.filter((r) => r.minSinceLaunch >= 30)],
]);
section("BY AUTHOR REACH", [
  ["< 1k followers", rows.filter((r) => r.followers < 1000)],
  ["1k-10k", rows.filter((r) => r.followers >= 1000 && r.followers < 10000)],
  ["10k+", rows.filter((r) => r.followers >= 10000)],
]);

// accounts whose FIRST-mention tweets are followed by upside
console.log("ACCOUNTS: what happened after THEIR tweets (3+ matched tweets)");
const byAuthor = new Map<string, Row[]>();
for (const r of rows) (byAuthor.get(r.author) ?? byAuthor.set(r.author, []).get(r.author)!).push(r);
const acc = [...byAuthor].filter(([, g]) => g.length >= 3).map(([a, g]) => ({ a, g, pk: median(nz(g.map((r) => r.peakAfter))), a15: median(nz(g.map((r) => r.after15))), first: g.filter((r) => r.order === 1).length, early: g.filter((r) => r.minSinceLaunch < 2).length }))
  .sort((x, y) => y.pk - x.pk).slice(0, 20);
console.log("  account".padEnd(24) + "tweets".padStart(7) + "  1st-mentions" + "  <2min after launch" + "  median +15m" + "  median peak after" + "  followers");
for (const x of acc) console.log(("  @" + x.a).padEnd(24) + String(x.g.length).padStart(7) + String(x.first).padStart(14) + String(x.early).padStart(20) + `${f(x.a15)}x`.padStart(13) + `${f(x.pk)}x`.padStart(19) + String(x.g[0].followers).padStart(11));
console.log("\nReading: if 'already up vs launch' is high and '+15m' is ~1.0x, the posts report a move that already happened. Tweets whose '+15m' and 'peak after' are high while 'already up' is low are the ones that lead.\n");
