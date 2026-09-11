/**
 * Every page the public service serves that is not a record, a list or a report.
 *
 * These were written to disk by `npm run site` on a laptop and shipped inside the image, which made them exactly as
 * current as whoever last ran that build - and on 2026-09-11 that laptop's collector had been stopped for forty
 * hours, so findings.html was publishing figures it described as current and which were two days old. The status
 * band added the same day made it worse: every page now states the archive's size and age in its masthead, so even
 * the pages of pure prose were carrying a stale count.
 *
 * The bodies live here so `site.ts` and `serve.ts` render from one source. The build still writes the static tree -
 * it is the offline copy, and it is what `data.html` offers - but nothing the live site serves comes out of it any
 * more. That is the last personal machine out of the publish path.
 *
 * FACTS ARE PASSED IN, NEVER READ HERE. Every figure on these pages comes from `buildFacts`, run against whichever
 * database the caller opened: the collector's for a build, the served record for the live site. A body free to
 * query a database of its own could describe a different archive from the one the page is served from.
 */
import { statSync, readFileSync } from "node:fs";
import { openDb } from "./db.ts";
import { assess, cleanAtBirth, TOKEN_COLUMNS, optionalColumns,
  BUYOUT_SOL, MAX_DEV_PCT, MIN_BUYERS, MIN_GRAD_MS } from "./provenance.ts";
import { API_VERSION, PER_IP_PER_HOUR, type Coverage } from "./api.ts";
import { renderSchema, renderSamples } from "./schema-doc.ts";
import { reportDate } from "./reports.ts";
import { venuePhrase, aLaunchHere } from "./venues.ts";
import { KNOWN_PROGRAMS, launchPrograms, nonLaunchPrograms } from "./venuelist.ts";
import { CANONICAL_HOST, CONTACT, SEARCH, esc, fmt, when, type Chrome } from "./render.ts";

/** The site's own origin, for the copy-and-paste examples on the API page. */
const H = CANONICAL_HOST || "https://chainoftitle.org";

export const pct = (n: number, d: number) => d > 0 ? `${(100 * n / d).toFixed(1)}%` : "\u2014";

export interface PageFacts {
  labelled: { checked: number; flagged: number; quiet: number; falseClean: number; families: number; method: string } | null;
  recStat: { size: number } | null;
  recCounts: { held: number; observed: number } | null;
  nameRefs: { handles: number; links: number; described: number };
  F: Record<string, number>;
  /**
   * The corrections register, read from the record rather than retyped onto the page.
   *
   * corrections.html listed them as hand-written prose while servicedb wrote the same corrections into the record
   * as rows, so the two drifted the moment one was added: on 2026-09-11 the file carried five and the page
   * described one. A register whose own corrections page understates its corrections is the least affordable
   * divergence on the site.
   */
  corrections: { id: string; issued_at: number; scope: string; subject: string | null;
    finding: string; effect: string; remedy: string; supersedes: string | null }[];
  COV: Coverage;
}

/**
 * Every figure these pages state, computed once against one database.
 *
 * `recordPath` is the file data.html offers for download and counts beside the link, which is not necessarily the
 * file this process reads - on a build they differ, and a page that states a number about the archive and gets it
 * from anywhere but the archive is the exact failure this site reports in other people.
 */
export function buildFacts(db: any, covered: (ts: number) => boolean, COV: Coverage, recordPath: string): PageFacts {
  const recStat = (() => { try { return statSync(recordPath); } catch { return null; } })();
  const labelled = (() => {
    try {
      const set = JSON.parse(readFileSync("data/labels.json", "utf8")) as { labels: any[]; families: any[]; method: string };
      const q = db.prepare(`SELECT ${TOKEN_COLUMNS}${optionalColumns(db)} FROM tokens WHERE mint = ?`);
      let checked = 0, flagged = 0, quiet = 0, falseClean = 0;
      for (const l of set.labels) {
        const t = q.get(l.mint) as any;
        if (!t) continue;
        checked++;
        const a = assess(db, t, covered);
        if (cleanAtBirth(t, a)) falseClean++;
        else if (a.flags.some((f) => f.level === "DANGER")) flagged++;
        else quiet++;
      }
      return { checked, flagged, quiet, falseClean, families: set.families.length, method: set.method };
    } catch { return null; }
  })();
  const recCounts = (() => {
    if (!recStat) return null;
    try {
      // Not migrated: this is the published artifact, and opening it with the collector's schema rewrites it. See openDb.
      const r = openDb(recordPath, { migrate: false });
      const held = (r.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
      const observed = (r.prepare("SELECT COUNT(*) c FROM tokens WHERE COALESCE(late_discovery,0)=0").get() as any).c as number;
      return { held, observed };
    } catch { return null; }
  })();
  const nameRefs = (() => {
    const n = (sql: string) => { try { return (db.prepare(sql).get() as any).c as number; } catch { return 0; } };
    return {
      handles: n("SELECT COUNT(*) c FROM tokens WHERE description LIKE '%@%'"),
      links: n("SELECT COUNT(*) c FROM tokens WHERE lower(description) LIKE '%x.com/%' OR lower(description) LIKE '%twitter.com/%'"),
      described: n("SELECT COUNT(description) c FROM tokens"),
    };
  })();
  const F = (() => {
    const q = (where: string) => (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE ${where}`).get() as any).c as number;
    /**
     * "Watched from the creation transaction" is the population, and the exclusions are the whole reason the number
     * is defensible. A token a detector restored hours after launch (`late_discovery`) shows zero curve buyers
     * because nobody was watching it, not because nobody bought - counting those would inflate this finding by 42%.
     * A reconstruction is not an observation either. Both are excluded, and the raw counts are shown so the size of
     * the exclusion is visible rather than buried.
     */
    const LIVE = "graduated_confirmed_by IS NOT NULL AND COALESCE(late_discovery,0) = 0 AND rebuilt_at IS NULL";
    const watched = q(LIVE);
    return {
      launches: q("1=1"),
      confirmed: q("graduated_confirmed_by IS NOT NULL"),
      watched,
      noBuyer: q(`${LIVE} AND curve_buyers = 0`),
      devHalf: q(`${LIVE} AND dev_pct >= 50`),
      both: q(`${LIVE} AND dev_pct >= 50 AND curve_buyers = 0`),
      fastFill: q(`${LIVE} AND (graduated_at - created_at) < 60000`),
      excludedLate: q("graduated_confirmed_by IS NOT NULL AND late_discovery = 1 AND curve_buyers = 0"),
      /**
       * The archive checking its own claims, and how often it has had to withdraw one.
       *
       * The feed emits a threshold event; that event is not the curve. Where we have gone and read the bonding
       * curve account ourselves, a large share of those events turn out to have fired on a curve that had not
       * finished. Counted here because a register that corrects itself and does not publish the correction rate
       * is asking to be taken on trust - and because the size of the correction is the best available evidence
       * that the checking is real.
       */
      /**
       * The curve readings, split by whether the graduation was independently confirmed - because the checking is
       * targeted and an unsplit rate is an artefact of that targeting.
       *
       * The sweep reads unconfirmed graduations almost exhaustively (98%) and only a third of confirmed ones, so
       * the checked population is selected for being the doubtful half. Reporting "of the curves we read, 83% had
       * not completed" states our own sampling as a property of the market. Split, the same readings say something
       * both true and much stronger: the feed's graduation events divide into a set that survives an independent
       * read and a set that overwhelmingly does not.
       *
       * An explicit 0 throughout. COALESCE(curve_complete,0) would fold in the rows read after the account had
       * gone, which is "we looked and learned nothing" - see the column's schema note in servicedb.
       */
      confChecked: q("graduated = 1 AND graduated_confirmed_by IS NOT NULL AND curve_checked_at IS NOT NULL"),
      confIncomplete: q("graduated = 1 AND graduated_confirmed_by IS NOT NULL AND curve_complete = 0"),
      unconfTotal: q("graduated = 1 AND graduated_confirmed_by IS NULL"),
      unconfChecked: q("graduated = 1 AND graduated_confirmed_by IS NULL AND curve_checked_at IS NOT NULL"),
      unconfIncomplete: q("graduated = 1 AND graduated_confirmed_by IS NULL AND curve_complete = 0"),
      curveChecked: q("curve_checked_at IS NOT NULL"),
      curveDisproved: q("curve_checked_at IS NOT NULL AND curve_complete = 0"),
      curveGone: q("curve_checked_at IS NOT NULL AND curve_complete IS NULL"),
    };
  })();
  const corrections = (() => {
    try {
      return db.prepare(`SELECT id, issued_at, scope, subject, finding, effect, remedy, supersedes
        FROM corrections ORDER BY issued_at DESC, id`).all() as PageFacts["corrections"];
    } catch { return []; }
  })();
  return { labelled, recStat, recCounts, nameRefs, F, corrections, COV };
}

export function notFoundBody(chrome: Chrome): string {
  return `
  <h1>We have no record of this launch</h1>
  <div class="sub">Either it launched outside our coverage, or it is not ${aLaunchHere()}.
  Coverage begins ${chrome.coverageFrom}.</div>
  <div class="flag UNKNOWN"><span class="tag UNKNOWN">not established</span>An absence from this archive is <b>not</b> a
  finding about the token. Once a float has been spread across wallets, a launch that was assembled and one that was
  not look the same to present-tense inspection, which is why the record has to be kept at the time, and why we do
  not guess afterwards.</div>
  ${SEARCH}`;
}

export function methodBody(f: PageFacts, chrome: Chrome): string {
  return `
  <h1 class="headline">How a claim on this site is decided</h1>
  <p class="lede">Everything here is read from the Solana chain. Where we recorded a launch's creation transaction,
  its record cites it and you can decode it yourself rather than take our figures on trust; where we did not, the
  record says so and the figures rest on our observation at the time. This page states what is recorded, how the one
  judgement we make is defined, what was done to test it, and, the part that matters most, what we refuse to say.</p>

  <div class="sec"><h2>What is recorded, and when</h2></div>
  <p class="lede">A collector decodes the launch program's own events as they happen, on ${venuePhrase()}, and writes down, for every
  launch: the creator, the share of supply the creator took in the creation transaction, every distinct wallet that
  bought on the bonding curve, how long the curve took to fill, whether a single buy completed it, and whether the
  creator sold. These are facts about a moment. They stop being observable once the float is spread across wallets,
  which is why they are recorded live rather than inferred later.</p>
  <p class="callout">Coverage begins ${chrome.coverageFrom}${chrome.gapMin >= 1 ? `, with ${fmt(chrome.gapMin)} minutes of recorded downtime` : ", with no recorded downtime"}. A launch that
  happened while the collector was down has no record, and is reported as unobserved rather than as anything else.</p>

  <div class="sec"><h2>What "checked, no markers found" means</h2></div>
  <p class="lede">It means we watched the launch, checked it against every pattern below, and found none of them. It
  is a statement about what we checked, not a judgement about the token: not a prediction, not a recommendation, and
  not a claim that it will hold its value; most tokens lose money regardless. A record is described that way only
  when every one of these is true of it:</p>
  <table>
    <tr><th>Test</th><th>Threshold</th><th>Why</th></tr>
    <tr><td>Creator's share in the first block</td><td class="num">under ${MAX_DEV_PCT}%</td><td>above this share, the creator holds more of the supply than everyone who buys on the curve combined</td></tr>
    <tr><td>Distinct outside buyers on the curve</td><td class="num">at least ${MIN_BUYERS}</td><td>below this, the curve was completed by a handful of wallets rather than many</td></tr>
    <tr><td>Time to complete the curve</td><td class="num">over ${MIN_GRAD_MS / 1000}s</td><td>a curve filled this fast was completed before other wallets recorded a buy on it</td></tr>
    <tr><td>Largest single buy on the curve</td><td class="num">under ${BUYOUT_SOL} SOL</td><td>one buy that completes a curve is a purchase of the float, not a market</td></tr>
    <tr><td>Creator sold</td><td class="num">no</td><td>self-explanatory</td></tr>
  </table>
  <p class="callout"><b>Liquidity is not one of these tests, and until 2026-09-09 it was.</b> Every test above is a
  fact about the first blocks of a token's life: once true, always true, and not readable from the token's present
  state once the float has been spread. A pool balance is a reading taken at one moment and it decays. Requiring both before calling a launch clean
  meant an hour of unanswered RPC calls silently withdrew findings about the past: over seven days, 423 launches
  matched every line above and ten were published. We still read the pool, still refuse to quote a balance we could
  not confirm, and now show it beside the launch record with the age of the reading instead of gating the record on
  it. A row reading <i>not read</i> is a gap in our pool coverage, never a finding about the token.</p>

  ${f.labelled ? `<div class="sec"><h2>Has it been tested?</h2><span class="cnt">${fmt(f.labelled.checked)} known-manufactured tokens</span></div>
  <p class="lede">Yes, and the test is one-sided on purpose. A missed warning costs a reader nothing; a wrong
  all-clear costs them everything. So the gate is that <b>no known-manufactured token may be certified clean</b>.
  Failing to flag one is reported and tolerated.</p>
  <p class="lede">The labelled set cannot be built from the rules being tested, or it proves nothing. It comes from
  creator-wallet reuse instead, an axis none of the criteria above read: a ticker relaunched at least 15 times, each
  time from a fresh creator wallet. No project relaunches its own ticker under a new wallet a hundred times; an
  operation burning identities does.</p>
  <table>
    <tr><th>Result over ${fmt(f.labelled.checked)} tokens in ${f.labelled.families} factory families</th><th class="num">count</th><th class="num">share</th></tr>
    <tr><td>Flagged as dangerous</td><td class="num">${fmt(f.labelled.flagged)}</td><td class="num">${(100 * f.labelled.flagged / Math.max(f.labelled.checked, 1)).toFixed(1)}%</td></tr>
    <tr><td>Not flagged, and not certified either</td><td class="num">${fmt(f.labelled.quiet)}</td><td class="num">${(100 * f.labelled.quiet / Math.max(f.labelled.checked, 1)).toFixed(1)}%</td></tr>
    <tr><td><b>Wrongly certified clean</b></td><td class="num"><b>${fmt(f.labelled.falseClean)}</b></td><td class="num"><b>${(100 * f.labelled.falseClean / Math.max(f.labelled.checked, 1)).toFixed(1)}%</b></td></tr>
  </table>
  <p class="callout">Reproduce it: <span class="mono">npm run labels</span>. It exits non-zero if a single known-manufactured
  token is ever certified clean, so the number above cannot quietly drift.</p>` : ""}

  <div class="sec"><h2>What we refuse to say</h2></div>
  <p class="lede">Every other checker always returns an answer. An answer that is always available is sometimes
  fabricated, so this one declines in four situations, and says which:</p>
  <table>
    <tr><th>Situation</th><th>What you get</th></tr>
    <tr><td>The launch happened before coverage, or while the collector was down</td><td>UNKNOWN, with an offer to rebuild the record from chain history</td></tr>
    <tr><td>A rebuild could not read every transaction</td><td>UNKNOWN, because a truncated history looks exactly like a quiet launch</td></tr>
    <tr><td>The pool balance could not be read</td><td>no liquidity figure quoted, and the row says <i>not read</i>. The launch record is unaffected</td></tr>
    <tr><td>We hold no record and the address has no bonding curve on ${venuePhrase()}</td><td>we say so, rather than guess</td></tr>
  </table>

  <div class="sec"><h2>Rebuilt records</h2></div>
  <p class="lede">A launch we did not watch can often be reconstructed: a bonding curve is a single account whose whole
  transaction history is readable, so the same on-chain events can be decoded later. Those pages are marked
  <b>rebuilt</b>. The figures are the same events read afterwards, and are judged the same way, but a rebuild cannot
  tell you what a token <i>claimed</i> to be at launch, because the name, image and links live off-chain behind a URI
  the operator can repoint. That, and only that, is genuinely unrecoverable.</p>

  <div class="sec"><h2>What we count as a launch</h2></div>
  <p class="lede">Most tokens created on Solana are not launches. Liquidity pools mint pool tokens, concentrated
  liquidity mints a position NFT for every position, prediction markets mint an outcome token per outcome, and at
  least one program mints tokens with no supply at all. Over one measured window, <b>155.7</b> token creations a
  minute contained about <b>30.8</b> that were launches. So a count of creations and a count of launches are
  different numbers and we publish them as different numbers.</p>
  <p class="lede">Deciding which is which is a judgement, and it is ours rather than the chain's. When a launch is
  recorded through a venue's own events, the venue declares what it is. When it is found by reading blocks, nothing
  declares anything and we apply a test. This is that test, stated so it can be disagreed with:</p>
  <table>
    <tr><th>A mint is recorded as looking like a launch when</th><th class="num">threshold</th></tr>
    <tr><td>tokens were actually minted in the creation transaction</td><td class="num">supply &gt; 0</td></tr>
    <tr><td>it is divisible like a currency rather than counted like an NFT</td><td class="num">at least 6 decimals</td></tr>
  </table>
  <p class="callout"><b>How well it does, measured rather than asserted.</b> Over 392 blocks and 433 token
  creations, labelled by the program that made them, the test keeps <b>97 of 109</b> known launches and admits
  <b>6 of 317</b> known non-launches. The dozen it misses are mostly mints whose tokens are created in a later
  transaction, which is a real pattern and not a non-launch. It is therefore stored as a column and never used as a
  filter: every token creation is recorded either way, so a reader who disagrees with the threshold can recompute
  from the same file rather than asking us what we discarded. A mint failing this test is one that does not look
  like a launch to us. It is not a statement that it is not one.</p>
  <p class="lede">Where we have identified the program that created a mint, that is a stronger answer than the test
  and does not depend on our judgement at all. Those programs are listed on the
  <a href="venues.html">launch programs</a> page with the source for each, and the list grows as programs are
  identified.</p>

  <div class="sec"><h2>Known limits</h2></div>
  <p class="lede">Stated because a method page that lists no weaknesses is marketing.</p>
  <table>
    <tr><td>The labelled set is drawn from this archive, so it cannot contain a factory that uses a fresh ticker every time. It is a precision test, not a census.</td></tr>
    <tr><td>Thresholds are judgements. They are set where the labelled set shows no false certification, not where some theory says they belong.</td></tr>
    <tr><td>Operator attribution describes wallets' behaviour inside this archive only, and says nothing about intent or identity.</td></tr>
    <tr><td>A trade is timestamped when we decode it, not by block time, so the interval between a launch and the buy that completed its curve is only as fine as the batch both arrived in. Where that interval reads as zero we say the events arrived together, rather than quoting a duration. The slot is published in <span class="mono">trades</span> for anyone who wants to settle it exactly.</td></tr>
    <tr><td>Coverage of ${venuePhrase()} begins ${chrome.coverageFrom}. Launch venues other than ${venuePhrase()} are not recorded at all, and a launch on one of them reads as unwatched rather than as clean.</td></tr>
  </table>`;
}

export function dataBody(f: PageFacts, db: any, chrome: Chrome): string {
  return `
  <h1 class="headline">Take the whole archive</h1>
  <p class="lede">Everything this site knows is one file. It is the same database the service reads, not an export,
  not a sample, and not a subset chosen to look good. Public domain, no attribution required, no key, no sign-up.</p>

  <div class="sec"><h2>The record database</h2>${f.recStat ? `<span class="cnt">${(f.recStat.size / 1048576).toFixed(1)} MB</span>` : ""}</div>
  <table>
    <tr><td class="k">Download</td><td><a href="data/record.db"><b>record.db</b></a>: SQLite, ${f.recStat ? `${(f.recStat.size / 1048576).toFixed(1)} MB` : "~40 MB"}, one row per launch</td></tr>
    <tr><td class="k">Launches</td><td>${f.recCounts ? `${fmt(f.recCounts.observed)} observed from the creation transaction, in ${fmt(f.recCounts.held)} records. The difference is launches a detector restored after the fact or rebuilt from chain history: real records, but not first-block observations.` : "unavailable: record.db was not present at build time"}</td></tr>
    <tr><td class="k">Coverage</td><td>from ${chrome.coverageFrom}${chrome.gapMin >= 1 ? `, ${fmt(chrome.gapMin)} min of recorded downtime` : ", no recorded downtime"}</td></tr>
    <tr><td class="k">Licence</td><td>CC0 1.0, public domain. It is a record of public facts; nobody should have to ask us for it.</td></tr>
    <tr><td class="k">Rebuilt</td><td>on each deploy, by <span class="mono">npm run servicedb</span></td></tr>
    <tr><td class="k">Mirror</td><td><a href="https://huggingface.co/datasets/chainoftitle/chain-of-title">Hugging Face</a>, held independently of anything this project runs. If this site is gone, the record is not.</td></tr>
    <tr><td class="k">Cite it</td><td><span class="mono">doi:10.57967/hf/10338</span>. Permanent: it cannot be renamed, withdrawn or made private.</td></tr>
  </table>
  <p class="lede">Tables: <span class="mono">tokens</span> (the launch record), <span class="mono">trades</span> and
  <span class="mono">hist_trades</span> (curve buys large enough to be a buyout), <span class="mono">wallet_flow</span>
  (what each curve-taking wallet did afterwards), <span class="mono">operator_wallets</span> and
  <span class="mono">operator_policy</span>, <span class="mono">pool_map</span>, and <span class="mono">runs</span>
  (the coverage windows, so you can check what we were awake for).</p>
  <p class="callout">The collector's own database is around 7 GB and is not this. It holds every trade on every tracked
  token and exists to derive the record; it is a research instrument on a retention window, not the archive.</p>

  <div class="sec"><h2>The pictures, and why most are missing</h2></div>
  <p class="lede">Every row carries the image URL the launch declared. <span class="mono">image_sha256</span> carries the
  sha256 of the bytes themselves, when we hold them: the proof rather than the picture, so the archive stays a file
  you can mirror. On most rows that hash is NULL, and it means <b>we did not fetch the image</b>. It does not mean the
  launch had none: that case is a NULL <span class="mono">image</span> with <span class="mono">meta_at</span> set,
  which is a different statement and stored differently on purpose.</p>
  <p class="lede">We fetch the bytes for launches that completed their curve. The reason is arithmetic rather than
  judgement. Around 24,000 launches a day declare an image and they average 409 KB, which is 13.6 GB a day, the whole storage
  volume every 33 hours. Graduations run near 1,400 a day, about 570 MB, and that is what can actually be kept.
  Pictures are stored by content hash, so the many launches reusing the same image cost one copy.</p>
  <p class="callout">This is a gap in the archive and naming it is the point. The image is the one thing here that
  cannot be rebuilt from chain by anyone willing to pay for archival RPC: it sits behind a pin the operator can drop.
  If that happens to a launch we did not fetch, the picture is gone and this file will not have it. The URLs are all
  in the record and nothing stops you fetching them yourself. The only reason we did not is that we could not
  afford the disk.</p>

  <div class="sec"><h2>When a launch names a person</h2></div>
  <p class="lede">Some launches write a handle into their own metadata. In this file ${fmt(f.nameRefs.handles)} descriptions
  contain an <span class="mono">@</span> and ${fmt(f.nameRefs.links)} link to x.com or twitter.com, out of
  ${fmt(f.nameRefs.described)} descriptions in total. They are published exactly as the launch wrote them.</p>
  <p class="lede">The reason is that those are the creator's words, not ours and not the named account's. When a launch
  claims someone is behind it, that claim <b>is</b> the evidence, and when the claim is false it is usually the only
  surviving evidence that the impersonation happened at all. A launch can be edited or unpinned at its source; what it
  said at the moment we read it cannot be recovered anywhere else. Redacting the sentence would remove the thing a
  reader most needs from the record.</p>
  <p class="callout">A handle appearing in this file is <b>not a statement by us about the person who owns it</b>. We do
  not say who is behind a launch, and we publish no conclusions about intent. If a launch used your name,
  <a href="corrections.html">tell us</a> and we will publish your statement on that record.</p>

  ${renderSchema(db)}
  ${renderSamples(db)}

  <div class="sec"><h2>Live JSON</h2></div>
  <table>
    <tr><td class="k"><a href="api/${API_VERSION}/token/{mint}" class="mono">api/${API_VERSION}/token/{mint}</a></td><td>one launch record: free, keyless, CORS-open. <a href="api.html">How to read it</a>, and the one rule that matters.</td></tr>
    <tr><td class="k"><a href="api/${API_VERSION}/status" class="mono">api/${API_VERSION}/status</a></td><td>what the archive holds and what it was awake for</td></tr>
    <tr><td class="k"><a href="api/summary.json" class="mono">api/summary.json</a></td><td>yesterday's counts, coverage, and the current clean list</td></tr>
  </table>
  <p class="callout">Walking the API for bulk work is the slow way round and costs us RPC reads we would rather spend
  rebuilding launches nobody has asked for yet. Take <a href="data/record.db">record.db</a> instead: it is the same
  data, in one file, and you can join across it.</p>

  <div class="sec"><h2>Reading it</h2></div>
  <p class="lede">Any SQLite client. The counts on the front page are these queries, and disagreeing with us is the
  point of publishing it.</p>
  <table>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT COUNT(*) FROM tokens
WHERE graduated_confirmed_by IS NOT NULL
  AND dev_pct >= 50;</td><td>graduations where the creator took at least half the supply</td></tr>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT symbol, dev_pct, curve_buyers
FROM tokens
WHERE graduated_confirmed_by IS NOT NULL
  AND curve_buyers = 0;</td><td>curves that completed with no outside buyer at all</td></tr>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT t.wallet, COUNT(*) curves,
  ROUND(SUM(t.sol)) sol
FROM trades t
WHERE t.market='curve' AND t.side='buy'
GROUP BY t.wallet ORDER BY curves DESC;</td><td>who takes the most curves, counted from the trade rows in this file rather than from an aggregate you cannot check</td></tr>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT COUNT(*) FROM tokens
WHERE graduated=1
  AND graduated_confirmed_by IS NULL;</td><td>graduations our feed inferred but never confirmed against a pool or the curve account, where we say less</td></tr>
  </table>`;
}

export function apiBody(chrome: Chrome): string {
  return `
  <h1 class="headline">A launch record, as JSON</h1>
  <p class="lede">Every record on this site is also a JSON document. No key, no account, no rate limit on reads, no
  attribution required: the archive is public domain and so is everything served from it. If you run a wallet, a
  terminal, a scanner or a bot, you are meant to read this without asking us.</p>
  <p class="lede">There is one thing you have to get right, and it is the next section.</p>

  <div class="sec"><h2>Absence of a record is not a clean record</h2></div>
  <p class="lede">The field to branch on is <span class="mono">verdict.level</span>, which is one of
  <span class="mono">OK</span>, <span class="mono">DANGER</span>, <span class="mono">CAUTION</span> or
  <span class="mono">UNKNOWN</span>. <b>These name classes of entry on a record, not grades of risk and not
  advice.</b> We record what a launch was; what that is worth is yours to decide. Read them as:</p>
  <table>
    <tr><td class="k mono">DANGER</td><td>a <b>finding</b>: something we recorded that counts against the launch, such as the creator holding most of the supply, or no outside wallet buying its curve</td></tr>
    <tr><td class="k mono">CAUTION</td><td>a <b>note</b>: recorded, weaker, and often about the present rather than the launch</td></tr>
    <tr><td class="k mono">UNKNOWN</td><td><b>not established.</b> Not a mild warning: an absence. We could not settle the question</td></tr>
    <tr><td class="k mono">OK</td><td>we checked this launch against every marker we record and <b>found none</b>. A statement about what we checked, not an endorsement of the token</td></tr>
  </table>
  <p class="lede">These names are older than the vocabulary the rest of this archive now uses, and they are kept
  because they are a published interface that consumers branch on. Stability is worth more than a tidier word.</p>
  <p class="lede"><span class="mono">cleanAtBirth</span> is a convenience and it has three states, not two:</p>
  <table>
    <tr><td class="k mono">true</td><td>we watched this launch (or rebuilt its complete history) and checked it against every marker we record; none is present</td></tr>
    <tr><td class="k mono">false</td><td>we watched it and at least one marker is present, or one criterion is unmet: see <span class="mono">verdict</span> and <span class="mono">flags</span> for which. Not an accusation: a token whose pool we could not read just now is <span class="mono">false</span> and <span class="mono">UNKNOWN</span>, not <span class="mono">DANGER</span>.</td></tr>
    <tr><td class="k mono">null</td><td><b>we do not know.</b> We did not observe the launch and have not rebuilt it. <b>Do not render this as clean, safe, or "no issues found."</b></td></tr>
  </table>
  <p class="callout">Once a token's float has been spread across wallets, a launch that was assembled and one that
  was not look the same to present-tense inspection, and that is the entire reason this archive exists. A null means the
  evidence is gone, which is the opposite of reassuring. Every refusal and every error we return also carries
  <span class="mono">verdict.level = "UNKNOWN"</span>, so code that reads only that field is safe even when it ignores
  the HTTP status.</p>

  <div class="sec"><h2>Endpoints</h2></div>
  <table>
    <tr><td class="k mono">GET /api/${API_VERSION}/token/{mint}</td><td>one launch record: what the creator took in the first block, how many outside wallets bought its curve, how it graduated, who took it, and the pool right now</td></tr>
    <tr><td class="k mono">GET /api/${API_VERSION}/wallet/{address}</td><td>a wallet's priors: every bonding curve it has bought outright in this archive, and what it did with the tokens afterwards. A wallet we have never seen returns <span class="mono">inArchive: false</span> and nulls, <b>not zeros</b>, because "we hold nothing on it" is not "it has done nothing". In <span class="mono">buyouts</span>, <span class="mono">sameBatchAsLaunch: true</span> means the buy arrived in the same batch of chain events as the launch itself, <span class="mono">hoursAfterLaunch</span> is then <span class="mono">null</span> rather than <span class="mono">0</span>, because our timestamps cannot resolve it further. Don't render it as zero.</td></tr>
    <tr><td class="k mono">GET /api/${API_VERSION}/status</td><td>what the archive holds and what it was awake for</td></tr>
    <tr><td class="k mono">GET /data/record.db</td><td>the whole archive as one SQLite file, CC0. If you are going to query it in bulk, take this instead of walking the API.</td></tr>
  </table>
  <p class="lede mono" style="white-space:pre-wrap">curl ${H}/api/${API_VERSION}/token/&lt;mint&gt;</p>

  <div class="sec"><h2>Tokens we have never seen</h2></div>
  <p class="lede">Coverage begins ${chrome.coverageFrom}. Ask for an older launch and we reconstruct it from the
  bonding curve's complete transaction history: thousands of archival RPC reads, which is a background job, not a
  request. You get <span class="mono">202</span> with <span class="mono">verdict.level = "UNKNOWN"</span> and a
  <span class="mono">rebuild</span> object; poll the same URL. A finished record is permanent, so the second call is
  usually the last one you ever make for that mint.</p>
  <p class="lede">Reads are unmetered. Rebuilds are not: they cost real money, so each caller can start
  ${PER_IP_PER_HOUR} an hour and the service has a daily ceiling. When that is reached you get
  <span class="mono">503 rebuild_budget_exhausted</span>: the archive is unaffected, only new reconstruction is
  paused. If you need bulk historical coverage, <a href="mailto:${esc(CONTACT)}">say so</a>; that is a conversation
  about who pays for the RPC, not about a licence.</p>

  <div class="sec"><h2>Statuses</h2></div>
  <table>
    <tr><td class="k mono">200</td><td>a record. It may still be an <span class="mono">UNKNOWN</span> one.</td></tr>
    <tr><td class="k mono">202</td><td>accepted; a rebuild is queued or running. Retry-After is set.</td></tr>
    <tr><td class="k mono">400 not_an_address</td><td>not base58, or not 32–44 characters</td></tr>
    <tr><td class="k mono">404 not_a_pump_launch</td><td>no pump.fun bonding curve exists for this address. A finding, not a failure.</td></tr>
    <tr><td class="k mono">404 rebuild_failed</td><td>we tried to read the chain and could not. <b>Our failure, not a finding</b>. It says nothing about the token.</td></tr>
    <tr><td class="k mono">429 rate_limited</td><td>too many rebuilds started from one address this hour</td></tr>
    <tr><td class="k mono">503 rebuild_budget_exhausted / busy</td><td>we cannot pay for or keep up with more rebuilds right now</td></tr>
  </table>

  <div class="sec"><h2>Terms, such as they are</h2></div>
  <table>
    <tr><td class="k">Cost</td><td>nothing, and there is no paid tier of this data. If you need an SLA, webhooks at creation, or bulk history, that is a separate conversation; the free endpoint does not get worse to make it happen.</td></tr>
    <tr><td class="k">Licence</td><td>CC0 1.0. Republish it, cache it, resell it. We would rather you linked the record so a reader can check it.</td></tr>
    <tr><td class="k">CORS</td><td>open to every origin. Call it from your own front end.</td></tr>
    <tr><td class="k">Caching</td><td>a settled record is immutable and served <span class="mono">max-age=3600, stale-while-revalidate=86400</span>. Anything unsettled is <span class="mono">no-store</span>.</td></tr>
    <tr><td class="k">Stability</td><td>fields are added, never repurposed. A breaking change gets a new version prefix and the old one keeps answering.</td></tr>
    <tr><td class="k">What it is not</td><td>not a price feed, not a signal, not advice. A clean record means a launch was <b>not manufactured</b>, and says nothing about what it will do. Of 19,412 bonding-curve positions measured over 24 hours in September 2026, organic launches only, none reached 5x. That is a dated measurement of a favourable subset, not a claim about the whole archive.</td></tr>
  </table>
  <p class="callout">If you ship this in front of users and find a record you think is wrong, tell us: a false
  warning on an honest launch costs us more than a missed one. <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a></p>
  `;
}

export function pledgeBody(): string {
  return `
  <h1 class="headline">Our pledge</h1>
  <p class="lede">Three commitments about how this is paid for. They are here because a record is worth what its
  keeper's incentives are worth, and ours should be checkable rather than assumed.</p>

  <div class="sec"><h2>The launch record stays free</h2></div>
  <p class="lede">Every launch record is free to read, free to download in bulk, and released under
  <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a> into the public domain, permanently. There is no
  paid tier of the record and there will not be one. If this project stops, the record it has already published does
  not stop being yours.</p>

  <div class="sec"><h2>We will never be paid to send you into a trade</h2></div>
  <p class="lede">No affiliate links, no referral kickbacks, no order-flow arrangements, no buy button, no listing
  fees. Our revenue will never depend on you transacting in anything we report on.</p>
  <p class="callout">This is the clause most likely to be tested, and it is written down for that reason. Routing
  readers into trades is the largest revenue line available to a site in this category. We are refusing it in advance
  and in public, so that accepting it later would be a visible breach rather than a quiet change of policy.</p>

  <div class="sec"><h2>We do not take money from the subjects of our records</h2></div>
  <p class="lede">No project, operator, launchpad or wallet we publish a record about is ever a customer, sponsor or
  advertiser.</p>

  <div class="sec"><h2>What we do take</h2></div>
  <p class="lede">Grants, and payment for expert analysis where this record is used as evidence. Neither can change a
  published record. Records are generated on a schedule by machine, before any client exists, and no published finding
  is ever altered for a paying party. Where we are engaged on a matter, the same analysis is available to either side
  of it.</p>
`;
}

export function findingsBody(f: PageFacts, builtAt: number | null): string {
  return `
  <h1 class="headline">Nearly half of the graduations we watched had no outside buyer</h1>
  <p class="lede">Of <b>${fmt(f.F.watched)}</b> tokens that completed a bonding curve on ${venuePhrase()}, which this archive
  watched from the creation transaction and confirmed against the curve account itself,
  <b>${fmt(f.F.noBuyer)}</b> (<b>${pct(f.F.noBuyer, f.F.watched)}</b>) had no outside buyer at all. Not one wallet
  other than the creator ever bought on the curve. The creator funded the entire graduation.</p>

  <div class="sec"><h2>What ${fmt(f.F.watched)} confirmed graduations look like at birth</h2></div>
  <table>
    <tr><td>No outside buyer on the curve</td><td class="num">${fmt(f.F.noBuyer)}</td><td class="num">${pct(f.F.noBuyer, f.F.watched)}</td></tr>
    <tr><td>Creator took at least half of total supply in the first block</td><td class="num">${fmt(f.F.devHalf)}</td><td class="num">${pct(f.F.devHalf, f.F.watched)}</td></tr>
    <tr><td>Both of the above</td><td class="num">${fmt(f.F.both)}</td><td class="num">${pct(f.F.both, f.F.watched)}</td></tr>
    <tr><td>Curve filled in under 60 seconds</td><td class="num">${fmt(f.F.fastFill)}</td><td class="num">${pct(f.F.fastFill, f.F.watched)}</td></tr>
  </table>

  <div class="sec"><h2>Why this is not visible later</h2></div>
  <p class="lede">These are facts about the first blocks of a token's life, and they stop being observable almost
  immediately. Once an operator spreads the float across wallets and funds the pool with real SOL, a manufactured
  launch and an organic one are the same object under inspection: pool depth reconciles, holder concentration looks
  ordinary, mint and freeze authority are clean. Every present-tense check passes.</p>
  <p class="callout">One launch in this record was created with <b>79.3% of supply taken by its creator and zero
  outside buyers</b>, and graduated. Hours later its pool held 2,043 SOL against the 2,027 that constant product
  predicts for its market cap, and its largest holder was 4% of supply. Nothing you could measure that afternoon
  would have told you what it was that morning. That is not a gap in after-the-fact analysis. It is a property of
  after-the-fact analysis.</p>

  ${/*
      Our own error rate, published. The check is written into every record and exposed in the API, and until now
      it appeared on no page a human reads - so the one number that shows this archive audits itself was reachable
      only by a machine.
    */ ""}
  ${f.F.curveChecked ? `<div class="sec"><h2>What we found when we checked our own claims</h2>
    <span class="cnt">${fmt(f.F.curveChecked)} curves read on chain</span></div>
  <p class="lede">A graduation reaches us as an event on a feed, and an event is not a curve. Where a graduation was
  independently confirmed (by the pool existing, or by the curve account's own complete bit), reading
  the curve again disproved <b>${fmt(f.F.confIncomplete)}</b> of the ${fmt(f.F.confChecked)} we re-read
  (${pct(f.F.confIncomplete, f.F.confChecked)}). Those hold up.</p>
  <p class="lede">The graduations we could <b>not</b> confirm are a different population. We have read the curve for
  <b>${fmt(f.F.unconfChecked)}</b> of the ${fmt(f.F.unconfTotal)} of them, and
  <b>${fmt(f.F.unconfIncomplete)}</b> (${pct(f.F.unconfIncomplete, f.F.unconfChecked)}) had not
  completed. A threshold crossed on a feed, and no curve behind it.</p>
  ${/*
      The split is the finding, and stating it unsplit was the error.
      
      This page briefly reported the two populations together as "of the curves we read, N% had not completed",
      which is our own sampling published as a property of the market: the sweep reads unconfirmed graduations
      almost exhaustively and only a third of confirmed ones, so the checked set is selected for being the doubtful
      half. The corrected version says which population each rate belongs to, and the corrected version is the
      stronger claim.
    */ ""}
  <p class="lede">We publish both rates because a register that corrects itself and will not say how often is asking
  to be taken on trust. Neither is a rate over all graduations: we check the doubtful ones far more often than the
  settled ones, deliberately, so an unsplit figure would describe our own sampling rather than the market.${
    f.F.curveGone ? ` A further <b>${fmt(f.F.curveGone)}</b> were read after the account had already gone: we looked
    and learned nothing, counted as neither.` : ""}</p>` : ""}

  <div class="sec"><h2>What this does not say</h2></div>
  <p class="lede"><b>These figures were computed on ${builtAt ? when(builtAt) : "an unrecorded date"}</b>, from the record this page was built
  against, and they are a static snapshot: the archive keeps collecting and the counts keep rising, so a number here
  is a fact about that moment and not a live total. The queries below return the current answer from the current
  file.</p>
  <p class="lede">Coverage begins <b>${when(f.COV.from ?? 0)}</b>. A token that launched before then was not watched
  and this archive answers <span class="mono">UNKNOWN</span> for it: the honest answer, and not a useful one.
  Reconstruction of older launches is in progress and is marked as reconstruction wherever it lands.</p>
  <p class="lede">The population above deliberately excludes two kinds of row, and the exclusions matter more than
  the headline. A token that a detector restored <i>after</i> its launch carries a zero buyer count because nobody
  was watching it, not because nobody bought. There are <b>${fmt(f.F.excludedLate)}</b> such rows and counting them
  would inflate this finding by nearly half. A launch rebuilt from chain history is not an observation either.
  Both are excluded here and both are labelled in the file.</p>
  <p class="lede">None of this says a token was a fraud, and none of it is advice about anything. It says what the
  chain recorded in the first blocks, which is a narrower claim and the only one we can support.</p>

  <div class="sec"><h2>Check it yourself</h2></div>
  <p class="lede">The record is public domain and the whole file is one download. These are the queries above,
  verbatim, and disagreeing with us is the point of publishing it.</p>
  <table>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT COUNT(*) FROM tokens
WHERE graduated_confirmed_by IS NOT NULL
  AND COALESCE(late_discovery,0) = 0
  AND rebuilt_at IS NULL
  AND curve_buyers = 0;</td><td>the headline: confirmed graduations, watched from creation, with no outside buyer</td></tr>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT COUNT(*) FROM tokens
WHERE graduated_confirmed_by IS NOT NULL
  AND COALESCE(late_discovery,0) = 0
  AND rebuilt_at IS NULL;</td><td>the denominator</td></tr>
  </table>
  <p class="lede">Bulk file: <a href="data/record.db">record.db</a>. Permanent citable copy:
  <span class="mono">doi:10.57967/hf/10338</span>, deposited on infrastructure this project does not run.
  <a href="data.html">What every column means</a>, and <a href="method.html">how a launch is judged</a>.</p>
`;
}

export function correctionsBody(f: PageFacts): string {
  return `
  <h1 class="headline">Corrections</h1>
  <p class="lede">We publish adverse factual findings about tokens and about the wallets behind them. Anyone affected
  has to be able to argue with them, and we have to be able to be wrong in public.</p>

  <div class="sec"><h2>How to tell us we are wrong</h2></div>
  <p class="lede">Write to <a href="mailto:corrections@chainoftitle.org">corrections@chainoftitle.org</a>. We aim to
  respond within five business days.</p>
  <table>
    <tr><th>What we will correct</th><td>Any statement of fact the chain does not support: a wrong number, a wrong
    time, a wrong wallet, an event we said happened that did not. Show us the transaction and we will check it.</td></tr>
    <tr><th>What we will not remove</th><td>A record that is accurate is not removed because it is unwelcome. We
    publish what the chain shows. We do not publish conclusions about intent: we do not say "scam", "rug" or "fraud",
    and we do not claim to know who controls a wallet.</td></tr>
    <tr><th>If a launch used your name</th><td>A launch can write anything into its own description, including a
    handle that is not theirs, and we publish that text as the launch wrote it because it is the evidence that the
    claim was made. It is not our claim about you. Write to us and we will publish your statement on that record,
    alongside the text in question. You do not have to control any wallet to ask for this.</td></tr>
    <tr><th>If you control a wallet we wrote about</th><td>Sign a message from that address and we will publish your
    statement on that wallet's page, in full and unedited. A signature from the address is proof we cannot fake and
    that nobody else can impersonate you on.</td></tr>
    <tr><th>How corrections appear</th><td>On the page, dated, saying what it said before. We do not silently edit and
    we do not delete pages.</td></tr>
  </table>

  ${/*
      Rendered from the record's own corrections table, not retyped here.
      
      This section was hand-written prose describing one correction while servicedb was writing every correction
      into the record as a row. By 2026-09-11 the file carried five and this page still described one, so the page
      a reader visits to find out what we got wrong was itself understating what we got wrong. Now there is one
      source: add a row in servicedb and it appears here, in the bulk file, and in any mirror of it, together.
    */ ""}
  <div class="sec"><h2>Corrections issued</h2><span class="cnt">${fmt(f.corrections.length)}</span></div>
  ${f.corrections.length ? f.corrections.map((c) => `
  <h3>${esc(reportDate(new Date(c.issued_at).toISOString().slice(0, 10)))}: ${esc(c.id)}</h3>
  <p class="sub" style="margin:-2px 0 10px">${esc(c.scope)}${c.subject ? ` &middot; <span class="mono">${esc(c.subject)}</span>` : ""}${
    c.supersedes ? ` &middot; supersedes <span class="mono">${esc(c.supersedes)}</span>` : ""}</p>
  <p class="lede"><b>What was wrong.</b> ${esc(c.finding)}</p>
  <p class="lede"><b>What a reader who trusted it would have concluded.</b> ${esc(c.effect)}</p>
  <p class="lede"><b>What was done.</b> ${esc(c.remedy)}</p>`).join("")
    : `<p class="callout">None recorded in this copy of the archive.</p>`}
  <p class="callout">Every one of these is a row in <a href="data.html">record.db</a> under its own citable id, so a
  mirror of the file carries the corrections with it. Amending one means adding a row that names it; nothing here is
  ever silently reworded.</p>
`;
}

export function venuesBody(): string {
  const row = (p: typeof KNOWN_PROGRAMS[number]) => `
    <tr>
      <td><b>${esc(p.name)}</b><div class="mono" style="font-size:12px">${esc(p.program)}</div></td>
      <td>${esc(p.note)}${p.source ? ` <a href="${esc(p.source)}" rel="noopener">source</a>` : ""}</td>
      <td class="num">${esc(p.confirmed)}</td>
    </tr>`;
  return `
  <h1 class="headline">Which programs launch tokens, and which only look like it</h1>
  <p class="lede">Reading every block on Solana finds every token creation, and most of them are not launches. This
  is the list of programs we have identified, with the evidence for each, so that a reader can check the label
  rather than take it. It is incomplete by construction and grows as programs are identified.</p>
  <p class="lede">A program absent from this list is one we have not identified. That is not a statement that it
  launches nothing, and a mint from such a program is judged by the
  <a href="method.html">published test</a> instead.</p>

  <div class="sec"><h2>Programs that create launches</h2><span class="cnt">${launchPrograms().length} identified</span></div>
  <p class="lede">Two of these are engines rather than launchpads: shared bonding-curve programs that many
  front-ends build on, so one entry covers many brands. The brand names those front-ends register are
  permissionless and self-asserted - some claim to be pump.fun, which does not run on either - so they are recorded
  as behaviour and never published as identity.</p>
  <table>
    <tr><th>Program</th><th>How we know</th><th class="num">Confirmed</th></tr>
    ${launchPrograms().map(row).join("")}
  </table>

  <div class="sec"><h2>Programs that create token mints that are not launches</h2><span class="cnt">${nonLaunchPrograms().length} identified</span></div>
  <p class="lede">Listed because naming them is what stops them being re-investigated every time an unfamiliar
  address appears at the top of a ranking. One of these led a 596-block sample at 49.3% of all token creations and
  launches nothing whatsoever.</p>
  <table>
    <tr><th>Program</th><th>How we know</th><th class="num">Confirmed</th></tr>
    ${nonLaunchPrograms().map(row).join("")}
  </table>

  <div class="sec"><h2>Why the label is never an identity claim</h2></div>
  <p class="lede">A mint is attributed to the outermost program in its creation transaction that is not
  infrastructure. That is a useful label and a bad identity: trading terminals and routers wrap other programs and
  appear outermost, and this archive has been wrong that way twice - once on a terminal's vanity address in the
  funder tracer, and once on a router mistaken for a launchpad's own instruction set. So the program is recorded as
  a fact about the transaction, this page records what we have since identified, and neither is presented as a
  claim about who operated a launch.</p>`;
}
