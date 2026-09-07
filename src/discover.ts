/**
 * Discover which X accounts post pump.fun mints EARLY on tokens that actually ran.
 *
 *   npm run discover -- [--hours 24] [--winners 40] [--control 40] [--min-x 3] [--pages 2]
 *
 * For each winner (peak >= --min-x launch price, or graduated) and each control token
 * (random launches that went nowhere) it searches Twitter for the mint address, records
 * every tweet in the `mentions` table, then ranks accounts by:
 *   winners hit      - distinct winning tokens the account posted
 *   early hits       - posts made while the token was <= 10 min old (or before launch)
 *   precision        - winners / (winners + controls) among tokens the account posted
 *   median age       - how old the token was when they posted
 * Accounts that post nearly every mint (aggregator bots) show low precision and are down-ranked.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { twitterApiIoProvider, xApiProvider, type TweetProvider } from "./signals/twitter.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const hours = Number(args.get("hours") ?? 24);
const nWinners = Number(args.get("winners") ?? 40);
const nControl = Number(args.get("control") ?? 40);
const minX = Number(args.get("min-x") ?? 3);
const pages = Number(args.get("pages") ?? 2);

const provider: TweetProvider | null =
  config.twitterProvider === "twitterapi" && config.twitterApiIoKey
    ? twitterApiIoProvider(config.twitterApiIoKey)
    : config.twitterProvider === "x" && config.xBearerToken
      ? xApiProvider(config.xBearerToken)
      : null;
if (!provider?.search) {
  console.error("No Twitter provider configured. Set TWITTER_PROVIDER=twitterapi and TWITTERAPI_IO_KEY (or TWITTER_PROVIDER=x and X_BEARER_TOKEN) in .env");
  process.exit(1);
}

const db = openDb(config.dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS mentions (
    tweet_id TEXT PRIMARY KEY, account TEXT, followers INTEGER, mint TEXT, posted_at INTEGER, text TEXT, url TEXT, fetched_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS mentions_mint ON mentions(mint);
  CREATE TABLE IF NOT EXISTS mention_scans (mint TEXT PRIMARY KEY, scanned_at INTEGER, tweets INTEGER);
`);
const since = Date.now() - hours * 3600_000;

interface Tok { mint: string; symbol: string; created_at: number; launch_price: number; peak_price: number; peak_at: number; graduated: number; p_1m: number | null; p_5m: number | null; p_15m: number | null; p_60m: number | null; }
let winners: Tok[];
if (args.has("real")) {
  // strict label: graduated AND still holding market cap now (see label.ts)
  const { labelRealRunners } = await import("./label.ts");
  const real = await labelRealRunners(db, since);
  const all = db
    .prepare(`SELECT t.mint, t.symbol, t.created_at, t.launch_price, t.peak_price, t.peak_at, t.graduated, t.p_1m, t.p_5m, t.p_15m, t.p_60m, o.mcap_usd
              FROM tokens t LEFT JOIN token_outcomes o ON o.mint = t.mint WHERE t.created_at >= ? AND t.late_discovery = 0 AND t.launch_price > 0 AND t.graduated = 1`)
    .all(since) as any[];
  winners = all.filter((t) => real.has(t.mint)).sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0)).slice(0, nWinners);
  console.log(`--real: ${real.size} graduated tokens still hold >= 2x graduation market cap; scanning the top ${winners.length} by market cap`);
} else {
  winners = db
    .prepare(`SELECT mint, symbol, created_at, launch_price, peak_price, peak_at, graduated, p_1m, p_5m, p_15m, p_60m FROM tokens
              WHERE created_at >= ? AND late_discovery = 0 AND launch_price > 0 AND (peak_price >= ? * launch_price OR graduated = 1)
              ORDER BY peak_price / launch_price DESC LIMIT ?`)
    .all(since, minX, nWinners) as unknown as Tok[];
}
const controls = db
  .prepare(`SELECT mint, symbol, created_at, launch_price, peak_price, peak_at, graduated, p_1m, p_5m, p_15m, p_60m FROM tokens
            WHERE created_at >= ? AND late_discovery = 0 AND launch_price > 0 AND peak_price < 1.5 * launch_price AND finalized = 1
            ORDER BY RANDOM() LIMIT ?`)
  .all(since, nControl) as unknown as Tok[];

console.log(`scanning ${winners.length} winners (>= ${minX}x or graduated) and ${controls.length} controls from the last ${hours}h via ${provider.name}\n`);

const insert = db.prepare(`INSERT OR IGNORE INTO mentions (tweet_id, account, followers, mint, posted_at, text, url, fetched_at) VALUES (?,?,?,?,?,?,?,?)`);
const scanned = db.prepare(`SELECT scanned_at FROM mention_scans WHERE mint = ?`);
const markScanned = db.prepare(`INSERT OR REPLACE INTO mention_scans (mint, scanned_at, tweets) VALUES (?,?,?)`);

let requests = 0;
async function scan(t: Tok): Promise<void> {
  if (scanned.get(t.mint)) return; // cached from a previous run
  let cursor: string | null = null;
  let total = 0;
  for (let p = 0; p < pages; p++) {
    let r;
    try {
      requests++;
      r = await provider!.search!(t.mint, cursor);
    } catch (e) {
      console.error(`  search failed for ${t.symbol}: ${(e as Error).message}`);
      break;
    }
    for (const tw of r.tweets) {
      insert.run(tw.id, tw.author, tw.authorFollowers ?? null, t.mint, tw.createdAt, tw.text.slice(0, 500), tw.url, Date.now());
      total++;
    }
    cursor = r.next;
    if (!cursor || r.tweets.length === 0) break;
  }
  markScanned.run(t.mint, Date.now(), total);
  process.stdout.write(`  ${t.symbol.padEnd(10)} ${(t.peak_price / t.launch_price).toFixed(1).padStart(6)}x peak  ${String(total).padStart(3)} tweets\n`);
}

for (const t of winners) await scan(t);
for (const t of controls) await scan(t);
console.log(`\n${requests} search requests made\n`);

// ---------- rank accounts ----------
const winSet = new Set(winners.map((w) => w.mint));
const ctlSet = new Set(controls.map((c) => c.mint));
const tokByMint = new Map<string, Tok>([...winners, ...controls].map((t) => [t.mint, t]));

/** price at the first checkpoint after `ageS`, used to estimate upside remaining after the post */
function priceAfter(t: Tok, ageS: number): number | null {
  if (ageS <= 0) return t.launch_price;
  if (ageS <= 60) return t.p_1m ?? t.launch_price;
  if (ageS <= 300) return t.p_5m;
  if (ageS <= 900) return t.p_15m;
  if (ageS <= 3600) return t.p_60m;
  return null;
}

interface Acc { account: string; followers: number; winners: Set<string>; controls: Set<string>; ages: number[]; upside: number[]; posts: number }
const accs = new Map<string, Acc>();
const rows = db
  .prepare(`SELECT account, followers, mint, MIN(posted_at) posted_at FROM mentions WHERE mint IN (${[...tokByMint.keys()].map(() => "?").join(",")}) GROUP BY account, mint`)
  .all(...tokByMint.keys()) as { account: string; followers: number | null; mint: string; posted_at: number }[];
for (const r of rows) {
  const t = tokByMint.get(r.mint)!;
  let a = accs.get(r.account);
  if (!a) accs.set(r.account, (a = { account: r.account, followers: r.followers ?? 0, winners: new Set(), controls: new Set(), ages: [], upside: [], posts: 0 }));
  a.posts++;
  a.followers = Math.max(a.followers, r.followers ?? 0);
  const ageS = (r.posted_at - t.created_at) / 1000;
  if (winSet.has(r.mint)) {
    a.winners.add(r.mint);
    a.ages.push(ageS);
    const pa = priceAfter(t, ageS);
    if (pa && pa > 0) a.upside.push(t.peak_price / pa);
  } else if (ctlSet.has(r.mint)) a.controls.add(r.mint);
}
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const fmtAge = (s: number) => (Number.isNaN(s) ? "-" : s < 0 ? `${(-s / 60).toFixed(0)}m BEFORE launch` : s < 3600 ? `${(s / 60).toFixed(1)}m` : `${(s / 3600).toFixed(1)}h`);

const ranked = [...accs.values()]
  .filter((a) => a.winners.size >= 1)
  .map((a) => {
    const early = a.ages.filter((x) => x <= 600).length;
    const precision = a.winners.size / (a.winners.size + a.controls.size);
    // score: early winners, weighted by precision; an account that posts every mint gets ~50% precision and no bonus
    const score = (early + 0.5 * (a.winners.size - early)) * (precision - 0.4) * 2;
    return { a, early, precision, score };
  })
  .sort((x, y) => y.score - x.score)
  .slice(0, 40);

console.log("ACCOUNTS RANKED BY EARLY, SELECTIVE CALLS");
console.log("  account".padEnd(26) + "score".padStart(6) + "  winners" + "  early(<=10m)" + "  controls" + "  precision" + "  median age at post" + "  median upside after post" + "  followers");
for (const { a, early, precision, score } of ranked) {
  console.log(
    ("  @" + a.account).padEnd(26) +
      score.toFixed(1).padStart(6) +
      String(a.winners.size).padStart(9) +
      String(early).padStart(14) +
      String(a.controls.size).padStart(10) +
      `${(precision * 100).toFixed(0)}%`.padStart(11) +
      fmtAge(median(a.ages)).padStart(21) +
      (a.upside.length ? `${median(a.upside).toFixed(1)}x` : "-").padStart(26) +
      String(a.followers).padStart(11),
  );
}
console.log(`\nAdd the accounts you trust to ${config.kolFile}; the live kol-signal strategy will then paper-trade their calls.`);
console.log("Note: this is descriptive, not causal — an account that is 'early' may be the one paying for the pump.");
