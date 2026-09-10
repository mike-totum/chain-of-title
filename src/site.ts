/**
 * Static site generator. Reads the archive and writes flat HTML + JSON — no backend, no database server, no uptime
 * obligation. If generation fails, yesterday's pages are still up and still correct.
 *   npm run site -- [--out site] [--days 7]
 *
 * Every claim on a page carries the address and the number behind it, so a reader can verify it against the chain
 * themselves. That verifiability is the asset; the pages are evidence, not persuasion.
 */
import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { profile, verdictLine, walletVerdict } from "./operator.ts";
import { renderSchema, renderSamples } from "./schema-doc.ts";
import { rpcStats } from "./rpc-http.ts";
import { tokenRecord, walletRecord, API_VERSION, PER_IP_PER_HOUR, type Coverage } from "./api.ts";
import { BRAND, CANONICAL_HOST, CONTACT, CSS, FAVICON, SEARCH, page, tokenBody, walletBody, tokenPreview, esc, fmt, when, dur, ago, type Chrome, type Reading } from "./render.ts";
import {
  assess, cleanAtBirth, readingCertifies, MAX_READING_AGE_MS, coverageWindows, TOKEN_COLUMNS, optionalColumns, graduationDisproved,
  BUYOUT_SOL, MAX_DEV_PCT, MIN_BUYERS, MIN_GRAD_MS, MIN_POOL_SOL,
  type Assessment, type Flag,
} from "./provenance.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "site");
const DAYS = Number(arg("--days", "7"));
/**
 * Per-token and per-wallet pages are rendered on request by `serve.ts` from the same code, so pre-rendering them is
 * redundant — and it does not scale: ~24,000 launches and ~1,465 graduations a day means 8.8 M pages a year, or
 * 535 k for graduations alone. Seven days of graduations already came to 19,104 files, past Cloudflare Pages'
 * 20,000-file deployment cap. `--pages` still writes them, for a portable offline copy of a bounded window.
 */
const PAGES = process.argv.includes("--pages");

/**
 * Opened without migrating. The next line declares this process read-only, and a generator that only reads has no
 * business writing the collector's schema into whatever it is pointed at — which is precisely what happened when it
 * was pointed at the record: `npm run site` put all nine collector-only tables back into data/record.db seconds
 * after servicedb had stripped them. Same bug as the web service, one caller further along.
 */
const db = openDb(config.dbPath, { migrate: false });
db.exec("PRAGMA query_only = 1");
const now = Date.now();

// ---------- coverage ----------
const win = coverageWindows(db);
const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);
const chrome: Chrome = {
  coverageFrom: win.length ? when(win[0].a) : "unknown",
  gapMin: win.slice(1).reduce((a, w, i) => a + Math.max(0, w.a - win[i].b), 0) / 60_000,
};
/**
 * The same coverage statement the page footer makes, in the shape the JSON records carry. `builtAt` is the database's
 * own build time rather than this run's clock: the generator reads a record it did not produce, so the age a consumer
 * cares about is the data's, not the page's.
 */
const builtAt = (() => {
  try { const m = db.prepare("SELECT v FROM meta WHERE k='built_at'").get() as any; if (m?.v) return Number(m.v); } catch {}
  try { return (db.prepare("SELECT MAX(updated_at) m FROM tokens").get() as any)?.m ?? null; } catch { return null; }
})();
const COV: Coverage = { from: win.length ? win[0].a : null, downtimeMinutes: chrome.gapMin, builtAt };



mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "api"), { recursive: true });
if (PAGES) {
  mkdirSync(join(OUT, "t"), { recursive: true });
  mkdirSync(join(OUT, "w"), { recursive: true });
  mkdirSync(join(OUT, "api", API_VERSION, "token"), { recursive: true });
  mkdirSync(join(OUT, "api", API_VERSION, "wallet"), { recursive: true });
}

// ---------- data ----------
const since = now - DAYS * 86400_000;
// Disproved graduations are excluded from every population this page counts. The feed's threshold event is kept
// on the record; it is simply not counted as a graduation once we have read the curve and found otherwise.
const toks = (db.prepare(`SELECT ${TOKEN_COLUMNS}${optionalColumns(db)} FROM tokens WHERE graduated = 1 AND created_at >= ?`).all(since) as any[])
  .filter((t) => !graduationDisproved(t));

const look = (t: any): Assessment => assess(db, t, covered);

/**
 * A pool balance is the one number on this site that decays. HOOD and HCAT held 2,677 and 2,050 SOL when the collector
 * last read them and $21 and $19 hours later, so a stored balance cannot support a present-tense claim about whether a
 * position can be sold. Every token we are about to certify gets its pool re-read from chain at generation time, and a
 * read that fails or comes back thin means no certificate — the answer to "we could not check" is never "clean".
 *
 * `fresh` records which kind of number this is. A stored reading may still be shown, always with its age attached; only
 * a reading taken during this run can support a certificate.
 */
const reading = (t: any): Reading | null =>
  t.vault_sol == null || t.vault_at == null ? null
    : { sol: t.vault_sol, at: t.vault_at, fresh: now - t.vault_at <= MAX_READING_AGE_MS };
/**
 * Clean is a claim about the launch, and nothing else. It used to also require a pool reading under five minutes old
 * showing MIN_POOL_SOL, which made a permanent finding about the first blocks contingent on our present RPC luck —
 * over seven days that gate removed 413 of 423 clean launches from the list. Liquidity is still read and still shown,
 * beside the claim and with the age of the reading, but it no longer retracts a statement about the past.
 * `serve.ts` makes the same split; if these two ever disagree the offline tree becomes a second API.
 */
const isClean = (t: any, a: Assessment) => cleanAtBirth(t, a);

// ---------- token pages ----------
const wallets = new Map<string, { mints: string[] }>();
let clean: any[] = [];
const cleanBuyers = new Map<string, number>();

// Pass 1: read the archive. No network, so a broken RPC can never change what the launch record says.
const assessed = toks.map((t) => ({ t, a: look(t) }));

/**
 * There is no pool-reading pass here any more, and that is the point.
 *
 * This generator used to re-read every candidate's pool so it could certify one; that made a page build depend on
 * hundreds of RPC calls, took over an hour when the endpoints were throttled, and produced a page that was true at
 * build time and drifted from then on. Certification now reads a stored balance and asks how old it is
 * (MAX_READING_AGE_MS), and the front page is rendered per request by `serve.ts` rather than written here — so the
 * numbers move with the chain instead of with the build.
 *
 * What is left in this file is the part that genuinely does not move: method, data, 404 and the API page. None of
 * them assert anything about a specific token, so none of them need the network, and a build is seconds rather than
 * an hour and cannot be blocked by an RPC brownout.
 */

// Pass 3: write.
for (const { t, a } of assessed) {
  const r = reading(t);
  // Settle the birth claim BEFORE the pool reading is allowed to add a flag, and tag that flag with the kind it is.
  // `cleanAtBirth` refuses anything carrying a DANGER flag and does not ask which kind, so pushing an untagged
  // liquidity flag first let a balance read seconds ago decide what the record said about the first block — the same
  // contradiction serve.ts:705 was fixed for, left behind here. The comment on `isClean` above promises these two
  // files make the same split; until this line they did not.
  const cleanTok = isClean(t, a);
  if (r && r.sol < MIN_POOL_SOL)
    a.flags.push({ level: "DANGER", kind: "liquidity", text: `Only ${r.sol.toFixed(1)} SOL of liquidity was in the pool ${r.fresh ? "just now" : `when it was last read, ${ago(now - r.at)}`}.` });
  if (cleanTok) { clean.push(t); cleanBuyers.set(t.mint, a.curveBuyers ?? 0); }
  if (a.buyout) {
    const w = wallets.get(a.buyout.wallet) ?? { mints: [] };
    w.mints.push(t.mint); wallets.set(a.buyout.wallet, w);
  }
  if (PAGES) {
    const pv = tokenPreview(t, a, cleanTok);
    writeFileSync(join(OUT, "t", `${t.mint}.html`),
      page(pv.title, tokenBody(t, a, r, "observed", cleanTok, now), chrome, 1, pv.summary, `/t/${t.mint}.html`));
  }
  // Built by the same function the live service uses, so an offline copy of the tree cannot become a second API
  // that answers slightly differently from the real one.
  if (PAGES) writeFileSync(join(OUT, "api", API_VERSION, "token", `${t.mint}.json`),
    JSON.stringify(tokenRecord(t, a, r, "observed", cleanTok, COV), null, 2));
}

// ---------- wallet pages ----------
for (const [w] of wallets) {
  const p = profile(db, w);
  const line = verdictLine(p);
  const rows = p.buyouts.map((b) => `<tr><td>${when(b.ts)}</td><td><a href="../t/${esc(b.mint)}.html">${esc(b.symbol ?? "?")}</a></td>
    <td>${b.sol.toFixed(0)} SOL</td><td>${b.dormantH === null ? "unknown" : dur(b.dormantH * 3600_000)} after launch</td></tr>`).join("");
  if (PAGES) writeFileSync(join(OUT, "w", `${w}.html`), page(`Wallet ${w.slice(0, 8)}`, walletBody(w, p, walletVerdict(p)), chrome, 1, undefined, `/w/${w}.html`));
  if (PAGES) writeFileSync(join(OUT, "api", API_VERSION, "wallet", `${w}.json`),
    JSON.stringify(walletRecord(w, p, line, COV), null, 2));
}

// ---------- front page ----------
const day = toks.filter((t) => t.created_at >= now - 86400_000);
const dayClean = clean.filter((t) => t.created_at >= now - 86400_000);
// Passed every birth test but carries no reading fresh enough to certify. Not a warning — an absence of one.
const unverified = assessed.filter(({ t, a }) => cleanAtBirth(t, a) && !readingCertifies(t.vault_at, t.vault_sol, now)).map(({ t }) => t);
const dayUnverified = unverified.filter((t) => t.created_at >= now - 86400_000);
// The page's central claim, counted rather than asserted: how many of yesterday's graduations carry a danger flag.
const dayAssessed = assessed.filter(({ t }) => t.created_at >= now - 86400_000);
const dayDanger = dayAssessed.filter(({ a }) => a.flags.some((f) => f.level === "DANGER")).length;
// A worked example, chosen from the archive each build rather than hard-coded. The argument is a sequence, not a
// snapshot: the creator takes the supply with nobody else buying, the operator then funds the pool with real SOL so
// that everything measurable looks ordinary, and later takes it back out. A scanner run during the middle window sees
// nothing wrong; one run afterwards reports thin liquidity, correctly and far too late. Only the birth record was
// true throughout. Both pool figures are read rather than assumed — the "now" one live, here.
/**
 * The worked example moved with the page that showed it. It needed a pool read to prove the "now" column, which was
 * the last network call in this generator — leaving it here would have kept a build that cannot fail on RPC
 * depending on RPC anyway, for a section nothing in this file renders.
 */


// The front page is rendered per request by `serve.ts` (homeBody), not written here.
writeFileSync(join(OUT, "404.html"), page("No record", `
  <h1>We have no record of this launch</h1>
  <div class="sub">Either it launched outside our coverage, or it is not a pump.fun token.
  Coverage begins ${chrome.coverageFrom}.</div>
  <div class="flag UNKNOWN"><span class="tag UNKNOWN">not established</span>An absence from this archive is <b>not</b> a
  finding about the token. Once a float has been spread across wallets, a launch that was assembled and one that was
  not look the same to present-tense inspection, which is why the record has to be kept at the time, and why we do
  not guess afterwards.</div>
  ${SEARCH}`, chrome, 0, undefined, "/404.html"));

// ---------- method ----------
// The page a sceptic and a grant reviewer both need: how a claim on this site is decided, and what was done to check
// it. Every figure here is computed at build time from the same code the site runs, so the page cannot describe rules
// the site does not apply — which is the failure mode of every "methodology" page written once and left alone.
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

writeFileSync(join(OUT, "method.html"), page("How this is decided", `
  <h1 class="headline">How a claim on this site is decided</h1>
  <p class="lede">Everything here is read from the Solana chain. Where we recorded a launch's creation transaction,
  its record cites it and you can decode it yourself rather than take our figures on trust; where we did not, the
  record says so and the figures rest on our observation at the time. This page states what is recorded, how the one
  judgement we make is defined, what was done to test it, and, the part that matters most, what we refuse to say.</p>

  <div class="sec"><h2>What is recorded, and when</h2></div>
  <p class="lede">A collector decodes the pump.fun program's own events as they happen and writes down, for every
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
  fact about the first blocks of a token's life: once true, always true, and unrecoverable once the float has been
  spread. A pool balance is a reading taken at one moment and it decays. Requiring both before calling a launch clean
  meant an hour of unanswered RPC calls silently withdrew findings about the past — over seven days, 423 launches
  matched every line above and ten were published. We still read the pool, still refuse to quote a balance we could
  not confirm, and now show it beside the launch record with the age of the reading instead of gating the record on
  it. A row reading <i>not read</i> is a gap in our pool coverage, never a finding about the token.</p>

  ${labelled ? `<div class="sec"><h2>Has it been tested?</h2><span class="cnt">${fmt(labelled.checked)} known-manufactured tokens</span></div>
  <p class="lede">Yes, and the test is one-sided on purpose. A missed warning costs a reader nothing; a wrong
  all-clear costs them everything. So the gate is that <b>no known-manufactured token may be certified clean</b>.
  Failing to flag one is reported and tolerated.</p>
  <p class="lede">The labelled set cannot be built from the rules being tested, or it proves nothing. It comes from
  creator-wallet reuse instead, an axis none of the criteria above read: a ticker relaunched at least 15 times, each
  time from a fresh creator wallet. No project relaunches its own ticker under a new wallet a hundred times; an
  operation burning identities does.</p>
  <table>
    <tr><th>Result over ${fmt(labelled.checked)} tokens in ${labelled.families} factory families</th><th class="num">count</th><th class="num">share</th></tr>
    <tr><td>Flagged as dangerous</td><td class="num">${fmt(labelled.flagged)}</td><td class="num">${(100 * labelled.flagged / Math.max(labelled.checked, 1)).toFixed(1)}%</td></tr>
    <tr><td>Not flagged, and not certified either</td><td class="num">${fmt(labelled.quiet)}</td><td class="num">${(100 * labelled.quiet / Math.max(labelled.checked, 1)).toFixed(1)}%</td></tr>
    <tr><td><b>Wrongly certified clean</b></td><td class="num"><b>${fmt(labelled.falseClean)}</b></td><td class="num"><b>${(100 * labelled.falseClean / Math.max(labelled.checked, 1)).toFixed(1)}%</b></td></tr>
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
    <tr><td>We hold no record and the address has no pump.fun bonding curve</td><td>we say so, rather than guess</td></tr>
  </table>

  <div class="sec"><h2>Rebuilt records</h2></div>
  <p class="lede">A launch we did not watch can often be reconstructed: a bonding curve is a single account whose whole
  transaction history is readable, so the same on-chain events can be decoded later. Those pages are marked
  <b>rebuilt</b>. The figures are the same events read afterwards, and are judged the same way, but a rebuild cannot
  tell you what a token <i>claimed</i> to be at launch, because the name, image and links live off-chain behind a URI
  the operator can repoint. That, and only that, is genuinely unrecoverable.</p>

  <div class="sec"><h2>Known limits</h2></div>
  <p class="lede">Stated because a method page that lists no weaknesses is marketing.</p>
  <table>
    <tr><td>The labelled set is drawn from this archive, so it cannot contain a factory that uses a fresh ticker every time. It is a precision test, not a census.</td></tr>
    <tr><td>Thresholds are judgements. They are set where the labelled set shows no false certification, not where some theory says they belong.</td></tr>
    <tr><td>Operator attribution describes wallets' behaviour inside this archive only, and says nothing about intent or identity.</td></tr>
    <tr><td>A trade is timestamped when we decode it, not by block time, so the interval between a launch and the buy that completed its curve is only as fine as the batch both arrived in. Where that interval reads as zero we say the events arrived together, rather than quoting a duration. The slot is published in <span class="mono">trades</span> for anyone who wants to settle it exactly.</td></tr>
    <tr><td>Coverage of pump.fun begins ${chrome.coverageFrom}. Other launchpads are not yet recorded at all.</td></tr>
  </table>`, chrome, 0,
  `How Chain of Title decides what to say about a token launch: what is recorded live, what "checked, no markers found" means, the labelled-set test behind it, and the four situations where we refuse to answer.`, "/method.html"));

// ---------- data ----------
// A public good has to be downloadable, or the claim is rhetorical. The record database is the archive itself, not an
// export of it: the same file the service reads.
const recStat = (() => { try { return statSync("data/record.db"); } catch { return null; } })();
/**
 * Count the file being offered, not the one this build happens to be reading.
 *
 * The download link points at `data/record.db` and the count beside it came from `config.dbPath` — the collector's
 * working database, a different file that is always ahead of the published one by however long ago the last publish
 * was. It told a downloader 166,273 and handed them 164,998.
 *
 * And it used the wrong definition under the right word. `serve.ts` distinguishes `observed` (watched from the
 * creation transaction — the population every claim on this site is about) from `held` (every row in the file, which
 * also counts launches a detector restored afterwards and the few rebuilt from chain history). Commit "Make
 * launches mean one thing on every surface" settled that for the service and missed this page, which reported `held`
 * as "Launches". Both counts are honest; publishing one under the other's name is not.
 *
 * Falls back to nulls rather than to the working database if record.db is absent: a page that quietly substitutes a
 * different file's number is the bug being fixed, and no number is better than a wrong one.
 */
const recCounts = (() => {
  if (!recStat) return null;
  try {
    // Not migrated: this is the published artifact, and opening it with the collector's schema rewrites it. See openDb.
    const r = openDb("data/record.db", { migrate: false });
    const held = (r.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c as number;
    const observed = (r.prepare("SELECT COUNT(*) c FROM tokens WHERE COALESCE(late_discovery,0)=0").get() as any).c as number;
    return { held, observed };
  } catch { return null; }
})();
/**
 * Counted from the file the page describes, not asserted. A page that states a number about the archive and gets it
 * from anywhere but the archive is the exact failure this site reports in other people.
 */
const nameRefs = (() => {
  const n = (sql: string) => { try { return (db.prepare(sql).get() as any).c as number; } catch { return 0; } };
  return {
    handles: n("SELECT COUNT(*) c FROM tokens WHERE description LIKE '%@%'"),
    links: n("SELECT COUNT(*) c FROM tokens WHERE lower(description) LIKE '%x.com/%' OR lower(description) LIKE '%twitter.com/%'"),
    described: n("SELECT COUNT(description) c FROM tokens"),
  };
})();
writeFileSync(join(OUT, "data.html"), page("The data", `
  <h1 class="headline">Take the whole archive</h1>
  <p class="lede">Everything this site knows is one file. It is the same database the service reads, not an export,
  not a sample, and not a subset chosen to look good. Public domain, no attribution required, no key, no sign-up.</p>

  <div class="sec"><h2>The record database</h2>${recStat ? `<span class="cnt">${(recStat.size / 1048576).toFixed(1)} MB</span>` : ""}</div>
  <table>
    <tr><td class="k">Download</td><td><a href="data/record.db"><b>record.db</b></a>: SQLite, ${recStat ? `${(recStat.size / 1048576).toFixed(1)} MB` : "~40 MB"}, one row per launch</td></tr>
    <tr><td class="k">Launches</td><td>${recCounts ? `${fmt(recCounts.observed)} observed from the creation transaction, in ${fmt(recCounts.held)} records. The difference is launches a detector restored after the fact or rebuilt from chain history: real records, but not first-block observations.` : "unavailable — record.db was not present at build time"}</td></tr>
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
  sha256 of the bytes themselves, when we hold them — the proof rather than the picture, so the archive stays a file
  you can mirror. On most rows that hash is NULL, and it means <b>we did not fetch the image</b>. It does not mean the
  launch had none: that case is a NULL <span class="mono">image</span> with <span class="mono">meta_at</span> set,
  which is a different statement and stored differently on purpose.</p>
  <p class="lede">We fetch the bytes for launches that completed their curve. The reason is arithmetic rather than
  judgement. Around 24,000 launches a day declare an image and they average 409 KB — 13.6 GB a day, the whole storage
  volume every 33 hours. Graduations run near 1,400 a day, about 570 MB, and that is what can actually be kept.
  Pictures are stored by content hash, so the many launches reusing the same image cost one copy.</p>
  <p class="callout">This is a gap in the archive and naming it is the point. The image is the one thing here that
  cannot be rebuilt from chain by anyone willing to pay for archival RPC: it sits behind a pin the operator can drop.
  If that happens to a launch we did not fetch, the picture is gone and this file will not have it. The URLs are all
  in the record and nothing stops you fetching them yourself — the only reason we did not is that we could not
  afford the disk.</p>

  <div class="sec"><h2>When a launch names a person</h2></div>
  <p class="lede">Some launches write a handle into their own metadata. In this file ${fmt(nameRefs.handles)} descriptions
  contain an <span class="mono">@</span> and ${fmt(nameRefs.links)} link to x.com or twitter.com, out of
  ${fmt(nameRefs.described)} descriptions in total. They are published exactly as the launch wrote them.</p>
  <p class="lede">The reason is that those are the creator's words, not ours and not the named account's. When a launch
  claims someone is behind it, that claim <b>is</b> the evidence — and when the claim is false it is usually the only
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
WHERE t.venue='curve' AND t.side='buy'
GROUP BY t.wallet ORDER BY curves DESC;</td><td>who takes the most curves, counted from the trade rows in this file rather than from an aggregate you cannot check</td></tr>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT COUNT(*) FROM tokens
WHERE graduated=1
  AND graduated_confirmed_by IS NULL;</td><td>graduations our feed inferred but never confirmed against a pool or the curve account — where we say less</td></tr>
  </table>`, chrome, 0,
  `The whole Chain of Title archive as one CC0 SQLite file: ${recCounts ? `${fmt(recCounts.held)} ` : ""}Solana launch records, one row each, no key or sign-up.`, "/data.html"));

/**
 * The API page. It documents one thing above everything else — that a null is not a clean result — because the whole
 * value of an integration is that someone else's users see our UNKNOWN as an UNKNOWN, and the integrator's code is
 * the only place we cannot inspect.
 */
const H = CANONICAL_HOST || "https://chainoftitle.org";
writeFileSync(join(OUT, "api.html"), page("The API", `
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
    <tr><td class="k">What it is not</td><td>not a price feed, not a signal, not advice. A clean record means a launch was <b>not manufactured</b>, and says nothing about what it will do. Of 19,412 bonding-curve positions measured, none reached 5x.</td></tr>
  </table>
  <p class="callout">If you ship this in front of users and find a record you think is wrong, tell us: a false
  warning on an honest launch costs us more than a missed one. <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a></p>
  `, chrome, 0,
  `The Chain of Title launch record as JSON: free, keyless and unmetered, CC0. One rule: an unknown launch is never a clean one.`, "/api.html"));

/**
 * The pledge and the corrections route.
 *
 * Not marketing pages. A site that publishes adverse factual findings about identifiable wallets needs a stated,
 * checkable position on who pays it, and a route by which a finding can be argued with: a registry that cannot be
 * contradicted is not a registry, it is an accusation. Both are static because they make promises, and a promise that
 * moves with the data is not one.
 */
writeFileSync(join(OUT, "pledge.html"), page("Our pledge", `
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
`, chrome, 0, "How Chain of Title is funded, and the three things its funding will never depend on.", "/pledge.html"));

writeFileSync(join(OUT, "corrections.html"), page("Corrections", `
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

  <div class="sec"><h2>Corrections issued</h2><span class="cnt">1</span></div>

  <h3>7 September 2026: we labelled launches as manufactured that were not</h3>
  <p class="lede">Until 7 September 2026, a launch that never completed its bonding curve could be shown on its own
  record page as though it had. The page said the token "completed its bonding curve with zero outside buyers" and
  that "the graduation was funded by the creator, not by demand." For a launch that never completed a curve the first
  statement is false, and the second asserts something about a person's conduct that our record does not establish.</p>
  <p class="lede"><b>How many.</b> Up to 34,242 launch records were in a state where that text could be shown. Most
  launches end exactly this way, dying without a buyer, which is why the error mattered: it treated the ordinary end
  of a token as evidence of manufacture.</p>
  <p class="lede"><b>Why it happened.</b> The rule that fires on "no outside buyers" was never made conditional on the
  curve having completed. It was written for launches that graduated and applied to every launch.</p>
  <p class="lede"><b>A second, related error.</b> We also recorded a curve as having graduated on the strength of our
  own feed reaching the graduation threshold, without confirming it against the curve account or the existence of a
  market for the token. Records now say which of those we have, and where a graduation is unconfirmed we no longer
  describe how the curve filled.</p>
  <p class="lede"><b>What changed.</b> No statement that a curve completed is made unless completion is confirmed. The
  number of launches carrying a danger flag fell from 866 to 457 as a result.</p>
  <p class="callout">That fall is a correction, not an improvement in the market. Nothing about pump.fun changed on
  7 September. What changed is that we stopped saying something we could not support.</p>
  <p class="lede"><b>What was not affected.</b> No launch was certified clean because of this. Certification fails
  closed and separately requires a pool balance read within the previous five minutes, so an unconfirmed launch could
  not have been certified. Certification is now gated on confirmed completion as well, so this cannot become a route
  to a false all-clear.</p>
`, chrome, 0, "How to tell us a record is wrong, what we will and will not change, and every correction we have issued.", "/corrections.html"));

writeFileSync(join(OUT, "favicon.svg"), FAVICON);

// The link-preview card. A committed asset rather than a build product: it needs a real browser to render (see
// `scripts/ogcard.mjs`), which the container has not got, and it changes only when the mark or the wording does.
try { copyFileSync("assets/og.png", join(OUT, "og.png")); }
catch { console.log("  assets/og.png missing, link previews will have no image"); }

/**
 * `api/summary.json` is no longer written here. Its clean counts need a pool reading from the last five minutes, and
 * those live only inside the running service - so a build could only ever publish zero and contradict the page. It
 * is served by `serve.ts` from the same pass that renders the front page, which is why the two now agree.
 */
console.log(`\nwrote ${OUT}/`);
console.log(PAGES
  ? `  ${toks.length.toLocaleString()} token pages + ${wallets.size} wallet pages written (--pages)`
  : `  ${toks.length.toLocaleString()} graduations and ${wallets.size} curve-taking wallets assessed; their pages are rendered on request by \`npm run serve\` (pass --pages to write them)`);
console.log(`  ${clean.length} checked with no markers found; ${dayClean.length} in the last 24 h of ${day.length} graduations`);
console.log(`  method.html, data.html, 404.html, api.html, pledge.html, corrections.html` + (PAGES ? `, api/${API_VERSION}/token/<mint>.json, api/${API_VERSION}/wallet/<wallet>.json` : ""));
