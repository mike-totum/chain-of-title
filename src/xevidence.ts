/**
 * Who promoted a launch we have already flagged.
 *
 *   npm run xevidence -- [--limit 25] [--days 3] [--dry-run] [--mint <mint>]
 *
 * This is deliberately NOT the listener that used to run here. That one polled six broad queries every two minutes
 * and thirty-seven accounts every sixty seconds - about 57,000 requests a day, roughly $390 a month, to generate a
 * signal that returned -13.8% over 543 entries. It was switched off for good reasons and this does not turn it back
 * on. DEPLOY.md already reached the conclusion this file implements: aim at already-flagged tokens, not at the market.
 *
 * One search per flagged launch, once, after the fact. At the provider's pay-as-you-go rate a search returning a
 * page of results costs about a third of a cent, so the whole of a day's graduations costs less than the listener
 * cost in an hour. The saving is not cleverness; it is asking a narrower question.
 *
 * WHAT THIS WRITES, AND WHERE IT MUST NOT GO
 *
 * Everything here lands in the collector's database and nowhere else. It is a dark archive: collected, retained,
 * unpublished, and produced if it is ever lawfully asked for. It must never reach record.db, because that file is
 * CC0 and carries a DOI that cannot be withdrawn, and the people in these rows are mostly not the operators - they
 * are people who were fooled by a launch and said so in public. Publishing them beside a manufactured-launch verdict
 * would imply a complicity we have no evidence for, permanently, with no way to take it back.
 *
 * The rule this file is built to: publish what the creator said, never what a third party said. A launch's own
 * description is the subject's claim about itself and belongs in the record. A stranger's post is their expression,
 * their personal data, and it stays here.
 *
 * `servicedb.ts` publishes an explicit list of tables and drops everything else, so a table added here cannot reach
 * the record by being forgotten about. That is checked by `xevidence.test.ts` rather than trusted.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { assess, TOKEN_COLUMNS, coverageWindows } from "./provenance.ts";
import { throttle, twitterApiIoProvider, xApiProvider, type TweetProvider, type Tweet } from "./signals/twitter.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const has = (k: string) => process.argv.includes(`--${k}`);

const LIMIT = Number(arg("limit", "25"));
const DAYS = Number(arg("days", "3"));
const ONE = arg("mint", "");
const DRY = has("dry-run");

/** twitterapi.io bills per tweet returned; a search page is ~20. Enough to print an honest number before spending. */
const PER_PAGE = 20;
const USD_PER_1K = 0.15;

const db = openDb(config.dbPath);

db.exec(`
  /**
   * One row per search we ran, not per result. A search that found nothing is a row with found = 0, because "we
   * looked and there was nothing" and "we never looked" are different statements and the second must never be read
   * as the first. Same rule the record applies to a pool reading and to graduated_confirmed_by.
   *
   * Keyed on (mint, searched_at) so a later pass is kept BESIDE an earlier one rather than replacing it. Promotion
   * arrives over hours and a second look is a new observation, not a correction of the first.
   */
  CREATE TABLE IF NOT EXISTS token_promotion (
    mint TEXT NOT NULL, searched_at INTEGER NOT NULL, provider TEXT, query TEXT,
    found INTEGER, authors INTEGER, error TEXT,
    PRIMARY KEY (mint, searched_at)
  );
  CREATE INDEX IF NOT EXISTS token_promotion_mint ON token_promotion(mint);
  /* Which post was found for which launch. The post itself lives in the tweets table, which already exists. */
  CREATE TABLE IF NOT EXISTS token_promotion_hit (
    mint TEXT NOT NULL, tweet_id TEXT NOT NULL, searched_at INTEGER,
    PRIMARY KEY (mint, tweet_id)
  );
`);

const provider: TweetProvider | null =
  config.twitterProvider === "twitterapi" && config.twitterApiIoKey ? twitterApiIoProvider(config.twitterApiIoKey)
  : config.twitterProvider === "x" && config.xBearerToken ? xApiProvider(config.xBearerToken)
  : null;

if (!provider?.search) {
  console.error("no X provider configured for search. Set TWITTER_PROVIDER=twitterapi and TWITTERAPI_IO_KEY,");
  console.error("or TWITTER_PROVIDER=x and X_BEARER_TOKEN. Nothing was spent.");
  process.exit(1);
}

/**
 * The mint address, not the ticker.
 *
 * Tickers collide constantly - that is half of what this project reports - so a `$TICKER` search returns other
 * people's launches and would attribute a stranger's post to the wrong token. The contract address is how a launch
 * is actually passed around, it is unique, and a post carrying it is unambiguously about this launch. Precision over
 * recall: a promotion we miss is a gap, a promotion we misattribute is a false accusation about a person.
 */
const queryFor = (mint: string) => `${mint} -filter:retweets`;

/** Launches we have already published an adverse finding about. Nothing else is searched. */
function flagged(): { mint: string; symbol: string | null; created_at: number }[] {
  if (ONE) return db.prepare(`SELECT mint, symbol, created_at FROM tokens WHERE mint = ?`).all(ONE) as any[];
  const since = Date.now() - DAYS * 86400_000;
  const win = coverageWindows(db);
  const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);
  const rows = db.prepare(
    `SELECT ${TOKEN_COLUMNS} FROM tokens WHERE graduated = 1 AND created_at >= ? ORDER BY created_at DESC`).all(since) as any[];
  return rows
    .filter((t) => assess(db, t, covered).flags.some((f) => f.level === "DANGER"))
    /*
     * Skip only launches we have SUCCESSFULLY searched. A failed search is stored, deliberately, so that "we could
     * not look" is on the record - but it must not also mean "and we never will". The first real run of this hit
     * six 402s for want of credits, and counting those as searched would have retired six launches permanently on
     * the strength of a billing problem. Absence of evidence, manufactured by our own bookkeeping.
     *
     * A successful search is not repeated, because a re-search is a deliberate act rather than something a cron
     * drifts into. Pass --mint to look again at one.
     */
    .filter((t) => !(db.prepare("SELECT 1 FROM token_promotion WHERE mint = ? AND found IS NOT NULL LIMIT 1").get(t.mint)))
    .slice(0, LIMIT)
    .map((t) => ({ mint: t.mint, symbol: t.symbol, created_at: t.created_at }));
}

const saveTweet = db.prepare(
  `INSERT OR IGNORE INTO tweets (id, author, followers, created_at, text, urls, query, mints, cashtags, hashtags,
    likes, retweets, views, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const saveHit = db.prepare(`INSERT OR IGNORE INTO token_promotion_hit (mint, tweet_id, searched_at) VALUES (?,?,?)`);
const saveSearch = db.prepare(
  `INSERT OR REPLACE INTO token_promotion (mint, searched_at, provider, query, found, authors, error)
   VALUES (?,?,?,?,?,?,?)`);

const targets = flagged();
const estimate = ((targets.length * PER_PAGE * USD_PER_1K) / 1000).toFixed(2);
console.log(`${targets.length} flagged launch${targets.length === 1 ? "" : "es"} with no promotion search on file` +
  (ONE ? "" : ` (last ${DAYS} days, cap ${LIMIT})`));
console.log(`provider ${provider.name}; one search each, about $${estimate} at ${USD_PER_1K}/1k tweets\n`);

if (DRY) { console.log("--dry-run: nothing requested, nothing written, nothing spent."); process.exit(0); }
if (!targets.length) process.exit(0);

let found = 0, empty = 0, failed = 0;
for (const t of targets) {
  const at = Date.now();
  const q = queryFor(t.mint);
  try {
    await throttle();
    const { tweets } = await provider.search!(q);
    const authors = new Set(tweets.map((x: Tweet) => x.author)).size;
    for (const x of tweets) {
      saveTweet.run(x.id, x.author, x.authorFollowers ?? null, x.createdAt, x.text, JSON.stringify(x.urls ?? []),
        q, t.mint, null, null, x.likes ?? null, x.retweets ?? null, x.views ?? null, at);
      saveHit.run(t.mint, x.id, at);
    }
    saveSearch.run(t.mint, at, provider.name, q, tweets.length, authors, null);
    if (tweets.length) { found++; console.log(`  ${t.symbol ?? "?"} ${t.mint.slice(0, 8)}… ${tweets.length} posts, ${authors} authors`); }
    else { empty++; console.log(`  ${t.symbol ?? "?"} ${t.mint.slice(0, 8)}… nothing found (recorded as a zero, not as unsearched)`); }
  } catch (e: any) {
    // A failed search is stored too. An error row is the difference between "we could not look" and "we did not".
    failed++;
    saveSearch.run(t.mint, at, provider.name, q, null, null, String(e?.message ?? e).slice(0, 300));
    console.log(`  ${t.symbol ?? "?"} ${t.mint.slice(0, 8)}… failed: ${String(e?.message ?? e).slice(0, 90)}`);
  }
}

console.log(`\n${found} with promotion, ${empty} with none, ${failed} failed.`);
console.log("Stored in the collector only. This never enters record.db - see the note at the top of this file.");
