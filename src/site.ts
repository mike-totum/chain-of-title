/**
 * Static site generator. Reads the archive and writes flat HTML + JSON - no backend, no database server, no uptime
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
import { loadReports } from "./reports.ts";
import { buildFacts, notFoundBody, methodBody, dataBody, apiBody, pledgeBody, findingsBody, correctionsBody } from "./pages.ts";
import { rpcStats } from "./rpc-http.ts";
import { tokenRecord, walletRecord, API_VERSION, PER_IP_PER_HOUR, type Coverage } from "./api.ts";
import { BRAND, CANONICAL_HOST, CONTACT, CSS, FAVICON, SEARCH, page, tokenBody, walletBody, tokenPreview, reportBody, reportsIndexBody, esc, fmt, when, dur, ago, type Chrome, type Reading } from "./render.ts";
import {
  assess, cleanAtBirth, readingCertifies, MAX_READING_AGE_MS, coverageWindows, TOKEN_COLUMNS, optionalColumns, graduationDisproved,
  BUYOUT_SOL, MAX_DEV_PCT, MIN_BUYERS, MIN_GRAD_MS, MIN_POOL_SOL,
  type Assessment, type Flag, coverageFor } from "./provenance.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out", "site");
const DAYS = Number(arg("--days", "7"));
/**
 * Per-token and per-wallet pages are rendered on request by `serve.ts` from the same code, so pre-rendering them is
 * redundant - and it does not scale: ~24,000 launches and ~1,465 graduations a day means 8.8 M pages a year, or
 * 535 k for graduations alone. Seven days of graduations already came to 19,104 files, past Cloudflare Pages'
 * 20,000-file deployment cap. `--pages` still writes them, for a portable offline copy of a bounded window.
 */
const PAGES = process.argv.includes("--pages");

/**
 * Opened without migrating. The next line declares this process read-only, and a generator that only reads has no
 * business writing the collector's schema into whatever it is pointed at - which is precisely what happened when it
 * was pointed at the record: `npm run site` put all nine collector-only tables back into data/record.db seconds
 * after servicedb had stripped them. Same bug as the web service, one caller further along.
 */
/**
 * Defaults to the published record, not the collector's working database.
 *
 * `config.dbPath` defaults to `data/pump.db`, which is right for the forty tools that read the collector and wrong
 * for this one: this generates the public pages, and the public pages describe the record. Pointed at pump.db the
 * build takes 20+ minutes and renders a file nobody can download; pointed at the record it takes seconds and renders
 * the file the download link actually hands over. HANDOFF has carried "run it as DB_PATH=data/record.db" as a known
 * trap for days, which is a default in the wrong place written down instead of moved.
 *
 * An explicit DB_PATH still wins, so anyone who does want the collector's view keeps it.
 */
const SITE_DB = process.env.DB_PATH ?? "data/record.db";
const db = openDb(SITE_DB, { migrate: false });
db.exec("PRAGMA query_only = 1");
const now = Date.now();

// ---------- coverage ----------
const win = coverageWindows(db);
// Per venue; see coverageFor. Identical to the old predicate while pumpfun is the only venue.
const covered = coverageFor(db);
const chrome: Chrome = {
  coverageFrom: win.length ? when(win[0].a) : "unknown",
  gapMin: win.slice(1).reduce((a, w, i) => a + Math.max(0, w.a - win[i].b), 0) / 60_000,
  onFile: (db.prepare("SELECT COUNT(*) c FROM tokens WHERE COALESCE(late_discovery,0)=0").get() as any).c,
  builtAt: null,
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
 * read that fails or comes back thin means no certificate - the answer to "we could not check" is never "clean".
 *
 * `fresh` records which kind of number this is. A stored reading may still be shown, always with its age attached; only
 * a reading taken during this run can support a certificate.
 */
const reading = (t: any): Reading | null =>
  t.vault_sol == null || t.vault_at == null ? null
    : { sol: t.vault_sol, at: t.vault_at, fresh: now - t.vault_at <= MAX_READING_AGE_MS };
/**
 * Clean is a claim about the launch, and nothing else. It used to also require a pool reading under five minutes old
 * showing MIN_POOL_SOL, which made a permanent finding about the first blocks contingent on our present RPC luck -
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
 * (MAX_READING_AGE_MS), and the front page is rendered per request by `serve.ts` rather than written here - so the
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
  // liquidity flag first let a balance read seconds ago decide what the record said about the first block - the same
  // contradiction serve.ts:705 was fixed for, left behind here. The comment on `isClean` above promises these two
  // files make the same split; until this line they did not.
  const cleanTok = isClean(t, a);
  if (r && r.sol < MIN_POOL_SOL)
    a.flags.push({ level: "DANGER", kind: "liquidity", code: "thin_pool_now", text: `Only ${r.sol.toFixed(1)} SOL of liquidity was in the pool ${r.fresh ? "just now" : `when it was last read, ${ago(now - r.at)}`}.` });
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
// Passed every birth test but carries no reading fresh enough to certify. Not a warning - an absence of one.
const unverified = assessed.filter(({ t, a }) => cleanAtBirth(t, a) && !readingCertifies(t.vault_at, t.vault_sol, now)).map(({ t }) => t);
const dayUnverified = unverified.filter((t) => t.created_at >= now - 86400_000);
// The page's central claim, counted rather than asserted: how many of yesterday's graduations carry a danger flag.
const dayAssessed = assessed.filter(({ t }) => t.created_at >= now - 86400_000);
const dayDanger = dayAssessed.filter(({ a }) => a.flags.some((f) => f.level === "DANGER")).length;
// A worked example, chosen from the archive each build rather than hard-coded. The argument is a sequence, not a
// snapshot: the creator takes the supply with nobody else buying, the operator then funds the pool with real SOL so
// that everything measurable looks ordinary, and later takes it back out. A scanner run during the middle window sees
// nothing wrong; one run afterwards reports thin liquidity, correctly and far too late. Only the birth record was
// true throughout. Both pool figures are read rather than assumed - the "now" one live, here.
/**
 * The worked example moved with the page that showed it. It needed a pool read to prove the "now" column, which was
 * the last network call in this generator - leaving it here would have kept a build that cannot fail on RPC
 * depending on RPC anyway, for a section nothing in this file renders.
 */


// The front page is rendered per request by `serve.ts` (homeBody), not written here.
/**
 * Every figure the prose pages state, computed once. The same call the live service makes, so a page built here
 * for the offline copy and the same page served from the cloud cannot state different numbers for one database.
 */
const FACTS = buildFacts(db, covered, COV, "data/record.db");

writeFileSync(join(OUT, "404.html"), page("No record", notFoundBody(chrome), chrome, 0, undefined, "/404.html"));

// ---------- method ----------
// The page a sceptic and a grant reviewer both need: how a claim on this site is decided, and what was done to check
// it. Every figure here is computed at build time from the same code the site runs, so the page cannot describe rules
// the site does not apply - which is the failure mode of every "methodology" page written once and left alone.

writeFileSync(join(OUT, "method.html"), page("How this is decided", methodBody(FACTS, chrome), chrome, 0,
  `How Chain of Title decides what to say about a token launch: what is recorded live, what "checked, no markers found" means, the labelled-set test behind it, and the four situations where we refuse to answer.`, "/method.html"));

// ---------- data ----------
// A public good has to be downloadable, or the claim is rhetorical. The record database is the archive itself, not an
// export of it: the same file the service reads.
/**
 * Count the file being offered, not the one this build happens to be reading.
 *
 * The download link points at `data/record.db` and the count beside it came from `config.dbPath` - the collector's
 * working database, a different file that is always ahead of the published one by however long ago the last publish
 * was. It told a downloader 166,273 and handed them 164,998.
 *
 * And it used the wrong definition under the right word. `serve.ts` distinguishes `observed` (watched from the
 * creation transaction - the population every claim on this site is about) from `held` (every row in the file, which
 * also counts launches a detector restored afterwards and the few rebuilt from chain history). Commit "Make
 * launches mean one thing on every surface" settled that for the service and missed this page, which reported `held`
 * as "Launches". Both counts are honest; publishing one under the other's name is not.
 *
 * Falls back to nulls rather than to the working database if record.db is absent: a page that quietly substitutes a
 * different file's number is the bug being fixed, and no number is better than a wrong one.
 */
/**
 * Counted from the file the page describes, not asserted. A page that states a number about the archive and gets it
 * from anywhere but the archive is the exact failure this site reports in other people.
 */
writeFileSync(join(OUT, "data.html"), page("The data", dataBody(FACTS, db, chrome), chrome, 0,
  `The whole Chain of Title archive as one CC0 SQLite file: ${FACTS.recCounts ? `${fmt(FACTS.recCounts.held)} ` : ""}Solana launch records, one row each, no key or sign-up.`, "/data.html"));

/**
 * The API page. It documents one thing above everything else - that a null is not a clean result - because the whole
 * value of an integration is that someone else's users see our UNKNOWN as an UNKNOWN, and the integrator's code is
 * the only place we cannot inspect.
 */
const H = CANONICAL_HOST || "https://chainoftitle.org";
writeFileSync(join(OUT, "api.html"), page("The API", apiBody(chrome), chrome, 0,
  `The Chain of Title launch record as JSON: free, keyless and unmetered, CC0. One rule: an unknown launch is never a clean one.`, "/api.html"));

/**
 * The pledge and the corrections route.
 *
 * Not marketing pages. A site that publishes adverse factual findings about identifiable wallets needs a stated,
 * checkable position on who pays it, and a route by which a finding can be argued with: a registry that cannot be
 * contradicted is not a registry, it is an accusation. Both are static because they make promises, and a promise that
 * moves with the data is not one.
 */
writeFileSync(join(OUT, "pledge.html"), page("Our pledge", pledgeBody(), chrome, 0, "How Chain of Title is funded, and the three things its funding will never depend on.", "/pledge.html"));

/**
 * The finding, computed at build time rather than written down.
 *
 * Every figure on this page is a query against the database the page is built from, because a published number that
 * was true when someone typed it is the failure this project exists to argue against. The same queries are printed
 * on the page so a reader can run them against the CC0 file and get the same answers, or different ones and say so.
 */

/**
 * Reports: dated pieces of work, as opposed to `findings.html`, which is a live view that changes under the reader.
 *
 * The distinction is the reason there are two. A finding recomputed every build is the right shape for "what is true
 * now" and the wrong shape for anything anyone cites, because the number they quote will have moved by the time
 * someone checks it. A report states what was true on a date, says so, and stays put.
 */
mkdirSync(join(OUT, "reports"), { recursive: true });

/**
 * Reports are RENDERED here and COMPUTED nowhere here.
 *
 * This block used to hold the query. It ran on every build, and `scripts/daily.sh` runs a build once a day, so the
 * one report we had was silently recomputed and re-dated daily - beneath its own opening sentence promising the
 * reader that its figures "are not updated afterwards". The date on the live page was the record's build time, not
 * a publication date, and it moved every night.
 *
 * `npm run publish -- <slug>` now runs the query once and writes `reports/<slug>.json`, refusing to overwrite what
 * is already there. Everything below reads that file. Prose and layout still live in code, so a typo or a stylesheet
 * fix reaches every published report; the figures cannot move, because this file no longer has a query to move them
 * with. See src/reports.ts.
 */
const REPORTS = loadReports();

for (const r of REPORTS) {
  const body = reportBody(r);
  if (!body) { console.error(`  !! no template for report "${r.slug}" - not rendered`); continue; }
  writeFileSync(join(OUT, "reports", `${r.slug}.html`), page(r.title, body, chrome, 1, r.summary, `/reports/${r.slug}.html`));
}
writeFileSync(join(OUT, "reports.html"), page("Reports", reportsIndexBody(REPORTS), chrome, 0,
  "Dated reports computed from the launch record, each with the queries to reproduce it.", "/reports.html"));

writeFileSync(join(OUT, "findings.html"), page("What the record shows", findingsBody(FACTS, builtAt), chrome, 0, `Of ${fmt(FACTS.F.watched)} bonding curves this archive watched from the creation transaction and confirmed, ${fmt(FACTS.F.noBuyer)} completed with no outside buyer at all.`, "/findings.html"));

writeFileSync(join(OUT, "corrections.html"), page("Corrections", correctionsBody(FACTS), chrome, 0, "How to tell us a record is wrong, what we will and will not change, and every correction we have issued.", "/corrections.html"));

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
// Named from what was actually written, not from a list typed once. The hardcoded version said
// "reports/ticker-factories.html" and kept saying it after a second report was published.
console.log(`  reports.html, ${REPORTS.map((r) => `reports/${r.slug}.html`).join(", ")}, findings.html, method.html, data.html, 404.html, api.html, pledge.html, corrections.html` + (PAGES ? `, api/${API_VERSION}/token/<mint>.json, api/${API_VERSION}/wallet/<wallet>.json` : ""));
