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
import { profile, verdictLine } from "./operator.ts";
import { poolReservesPooled } from "./outcomes.ts";
import { rpcStats } from "./rpc-http.ts";
import { tokenRecord, walletRecord, API_VERSION, PER_IP_PER_HOUR, type Coverage } from "./api.ts";
import { BRAND, CANONICAL_HOST, CONTACT, CSS, FAVICON, SEARCH, page, tokenBody, walletBody, tokenPreview, esc, fmt, when, dur, ago, type Chrome, type Reading } from "./render.ts";
import {
  assess, cleanAtBirth, coverageWindows, TOKEN_COLUMNS,
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

const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");
const now = Date.now();

// ---------- coverage ----------
const win = coverageWindows(db);
const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);
const chrome: Chrome = {
  coverageFrom: win.length ? when(win[0].a) : "unknown",
  gapMin: win.slice(1).reduce((a, w, i) => a + Math.max(0, w.a - win[i].b), 0) / 60_000,
};
/** The same coverage statement the page footer makes, in the shape the JSON records carry. */
const COV: Coverage = { from: win.length ? win[0].a : null, downtimeMinutes: chrome.gapMin };



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
const toks = db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE graduated = 1 AND created_at >= ?`).all(since) as any[];

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
const readings = new Map<string, Reading>();
const stored = (t: any): Reading | null =>
  t.vault_sol == null || t.vault_at == null ? null : { sol: t.vault_sol, at: t.vault_at, fresh: false };
const reading = (t: any): Reading | null => readings.get(t.mint) ?? stored(t);
const isClean = (t: any, a: Assessment) => {
  if (!cleanAtBirth(t, a)) return false;
  const r = readings.get(t.mint);
  return !!r && r.fresh && r.sol >= MIN_POOL_SOL;
};

// ---------- token pages ----------
const wallets = new Map<string, { mints: string[] }>();
let clean: any[] = [];
const cleanBuyers = new Map<string, number>();

// Pass 1: read the archive. No network, so a broken RPC can never change what the launch record says.
const assessed = toks.map((t) => ({ t, a: look(t) }));

// Pass 2: re-read the pool for every token whose launch record would certify it. Bounded by construction — this is
// the handful of tokens a day that survive the birth tests, not the thousands that graduate.
const candidates = assessed.filter(({ t, a }) => cleanAtBirth(t, a) && t.pool);
const unverified: any[] = [];   // passed every launch test; pool could not be read, so not certified
console.log(`re-reading ${candidates.length} pools from chain…`);
let reread = 0;
// Reads go through the managed endpoint pool, not the single public node the collector saturates: reading 249 pools
// from api.mainnet-beta returned 429 for 133 of them, and every failure silently becomes "not certified".
const POOL_CONCURRENCY = 4;
/**
 * A deadline on the whole pass.
 *
 * Every read is individually bounded — 15 s, catching its own failure — but the pass over them was not, and each
 * failure costs up to eight attempts across three endpoints with escalating back-off. On 2026-09-07 every endpoint
 * 429'd on every attempt and 279 candidates ran for over an hour without finishing; the daily pipeline's own run hit
 * the same wall and was still going five hours after it started. An unbounded step in a scheduled job is a job that
 * can silently stop finishing, and nothing downstream of it runs.
 *
 * Giving up is safe here precisely because the gate exists: an abandoned read is an uncertified token, and enough of
 * those refuse the build. So the deadline degrades into a loud stop rather than a quiet one.
 */
const POOL_DEADLINE = Date.now() + Number(process.env.POOL_DEADLINE_MIN ?? 10) * 60_000;
let next = 0, abandoned = 0;
await Promise.all(Array.from({ length: POOL_CONCURRENCY }, async () => {
  for (let i = next++; i < candidates.length; i = next++) {
    if (Date.now() > POOL_DEADLINE) { abandoned++; continue; }
    const { t } = candidates[i];
    const r = await poolReservesPooled(t.pool, t.mint);
    if (r) { readings.set(t.mint, { sol: r.quoteSol, at: Date.now(), fresh: true }); reread++; }
  }
}));
if (abandoned) console.log(`  gave up on ${abandoned} after ${process.env.POOL_DEADLINE_MIN ?? 10} min; they count as unreadable`);
for (const { t } of candidates) if (!readings.has(t.mint)) unverified.push(t);
console.log(`  ${reread} answered, ${unverified.length} unreadable (cannot be certified)`);

/**
 * Refuse the build when too many pools could not be read.
 *
 * Certification already fails closed per token, which is right, but the aggregate did not: a run during an RPC
 * brownout still produced a complete, publishable page whose only signal was a footnote beside the seven-day table.
 * On 2026-09-07 a run read 54 of 279 pools and published "5 of 9,035 graduations" where a healthy run the night
 * before had found 27 — and `clean24h` was 4 against 24 unverified, so the headline could have been out by seven
 * times. The headline is also the og:title, which means it travels into every shared link on its own, with no
 * footnote anywhere near it.
 *
 * So the failure belongs to the build, not the page. Writing nothing leaves yesterday's correct pages up and exits
 * non-zero, which the GATE in daily.sh already treats as a stop — the same shape as `npm run labels`. A loud failure
 * beats a quiet degradation, and this is a site whose entire claim is that it declines rather than guesses.
 */
const MAX_UNREADABLE = Number(process.env.MAX_UNREADABLE_PCT ?? 20) / 100;
const unreadableFrac = candidates.length ? unverified.length / candidates.length : 0;
if (unreadableFrac > MAX_UNREADABLE) {
  console.error(`\nREFUSING TO BUILD: ${unverified.length} of ${candidates.length} pools unreadable ` +
    `(${(100 * unreadableFrac).toFixed(0)}%, limit ${(100 * MAX_UNREADABLE).toFixed(0)}%).`);
  console.error(`Every unreadable pool is a token that cannot be certified, so the clean counts this run would`);
  console.error(`publish — including the headline, which is also the link preview — are understated by an unknown`);
  console.error(`amount. Nothing has been written; the previous build's pages are still correct and still up.`);
  console.error(`Re-run when the RPC endpoints answer. Override deliberately with MAX_UNREADABLE_PCT.`);
  console.error(`  ${rpcStats()}`);
  process.exit(1);
}

// Pass 3: write.
for (const { t, a } of assessed) {
  const r = reading(t);
  if (r && r.sol < MIN_POOL_SOL)
    a.flags.push({ level: "DANGER", text: `Only ${r.sol.toFixed(1)} SOL of liquidity was in the pool ${r.fresh ? "just now" : `when it was last read, ${ago(now - r.at)}`}; a position cannot be sold near the quoted price.` });
  const cleanTok = isClean(t, a);
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
  if (PAGES) writeFileSync(join(OUT, "w", `${w}.html`), page(`Priors — ${w.slice(0, 8)}`, walletBody(w, p, line), chrome, 1, undefined, `/w/${w}.html`));
  if (PAGES) writeFileSync(join(OUT, "api", API_VERSION, "wallet", `${w}.json`),
    JSON.stringify(walletRecord(w, p, line, COV), null, 2));
}

// ---------- front page ----------
const day = toks.filter((t) => t.created_at >= now - 86400_000);
const dayClean = clean.filter((t) => t.created_at >= now - 86400_000);
const dayUnverified = unverified.filter((t) => t.created_at >= now - 86400_000);
// The page's central claim, counted rather than asserted: how many of yesterday's graduations carry a danger flag.
const dayAssessed = assessed.filter(({ t }) => t.created_at >= now - 86400_000);
const dayDanger = dayAssessed.filter(({ a }) => a.flags.some((f) => f.level === "DANGER")).length;
// A worked example, chosen from the archive each build rather than hard-coded. The argument is a sequence, not a
// snapshot: the creator takes the supply with nobody else buying, the operator then funds the pool with real SOL so
// that everything measurable looks ordinary, and later takes it back out. A scanner run during the middle window sees
// nothing wrong; one run afterwards reports thin liquidity, correctly and far too late. Only the birth record was
// true throughout. Both pool figures are read rather than assumed — the "now" one live, here.
const proofCandidates = assessed
  .filter(({ t, a }) => t.graduated && !t.late_discovery && t.dev_pct >= 50 && a.curveBuyers === 0 && t.pool && (t.vault_sol ?? 0) >= 500)
  .sort((x, y) => (y.t.vault_sol ?? 0) - (x.t.vault_sol ?? 0));
let proof: typeof proofCandidates[number] | undefined;
let proofNow = 0;
for (const c of proofCandidates.slice(0, 8)) {
  const r = await poolReservesPooled(c.t.pool, c.t.mint);
  if (r) { proof = c; proofNow = r.quoteSol; break; }
}
if (!proof) console.log("  no worked example could be read this build; the page omits that section");
const cleanRows = clean.sort((a, b) => b.created_at - a.created_at).slice(0, 40).map((t) => `<tr>
  <td><a href="t/${esc(t.mint)}.html">${esc(t.symbol ?? "?")}</a></td><td class="num">${t.dev_pct.toFixed(1)}%</td>
  <td class="num">${fmt(cleanBuyers.get(t.mint) ?? 0)}</td><td class="num">${dur(t.graduated_at - t.created_at)}</td><td class="num">${(readings.get(t.mint)!.sol).toFixed(0)} SOL</td></tr>`).join("");
const opRows = [...wallets.entries()].map(([w, v]) => ({ w, p: profile(db, w), n: v.mints.length }))
  .filter((x) => x.p.buyouts.length >= 1).sort((a, b) => b.p.ammSell - a.p.ammSell).slice(0, 15)
  .map((x) => `<tr><td class="mono"><a href="w/${esc(x.w)}.html">${esc(x.w.slice(0, 12))}…</a></td>
    <td class="num">${x.p.buyouts.length}</td><td class="num">${fmt(x.p.curveSol)} SOL</td><td class="num">${fmt(x.p.ammSell)} SOL</td><td class="num">${fmt(x.p.ammBuy)} SOL</td></tr>`).join("");


writeFileSync(join(OUT, "index.html"), page(`${fmt(dayClean.length)} of ${fmt(day.length)} tokens launched clean yesterday`, `
  <div class="hero">
    <h1 class="headline">In the last 24 hours ${fmt(day.length)} tokens finished their bonding curve.
    <b>${fmt(dayClean.length)}</b> of them launched clean.</h1>
    <p class="lede">Most were manufactured. The creator took the supply, or a single wallet bought the whole curve and
    called it demand. That evidence exists for about thirty seconds and is unrecoverable afterwards — so we watch every
    launch on pump.fun and keep the record.</p>
    <p class="lede">Paste any mint. If we hold its launch, you get what happened. If we do not, we rebuild it from the
    chain, and if we cannot do that we say so rather than guess.</p>
    ${SEARCH}
    ${proof ? `<p class="sub" style="margin:-18px 0 24px">Nothing to hand? Read <a href="t/${esc(proof.t.mint)}.html">${esc(proof.t.symbol ?? "?")}</a>, a launch this archive holds.</p>` : ""}
    <div style="margin:4px 0 0">
      <div class="stat"><span>graduated, last 24h</span><b class="big">${fmt(day.length)}</b></div>
      <div class="stat"><span>launched clean</span><b class="big">${fmt(dayClean.length)}</b></div>
      <div class="stat"><span>carrying a danger flag</span><b class="big">${fmt(dayDanger)}</b></div>
      <div class="stat"><span>launches on file</span><b class="big">${fmt((db.prepare("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0").get() as any).c)}</b></div>
    </div>
    <p class="sub" style="margin:6px 0 0">Counted over the 24 hours to ${when(now)}, when this page was built.</p>
  </div>

  ${proof ? `<div class="sec"><h2>Why a scanner cannot tell you this</h2></div>
  <p class="lede">One launch from this archive — <a href="t/${esc(proof.t.mint)}.html">${esc(proof.t.symbol ?? "?")}</a> — and several hundred like it. Read left to right.</p>
  <div class="proof">
    <div class="birth">
      <h3>1 · At birth, recorded live</h3>
      <ul>
        <li>Creator took <b>${proof.t.dev_pct.toFixed(1)}%</b> of supply in the first block</li>
        <li><b>Zero</b> outside wallets bought on the curve</li>
        <li>Curve completed${proof.t.graduated_at ? ` in <b>${dur(proof.t.graduated_at - proof.t.created_at)}</b>` : ""}, without a market</li>
      </ul>
    </div>
    <div class="now">
      <h3>2 · Then, and this is what a scanner sees</h3>
      <ul>
        <li>Pool funded to <b>${fmt(proof.t.vault_sol)} SOL</b> of real liquidity</li>
        <li>Mint and freeze authority <b>renounced</b></li>
        <li>Supply <b>spread across wallets</b>, no large holder</li>
      </ul>
    </div>
    <div class="birth">
      <h3>3 · Now</h3>
      <ul>
        <li>Pool holds <b>${proofNow < 10 ? proofNow.toFixed(1) : fmt(proofNow)} SOL</b>, read just now</li>
        <li>The SOL that made it look ordinary <b>has been taken back out</b></li>
        <li>Whoever bought during step 2 <b>cannot sell into this</b></li>
      </ul>
    </div>
  </div>
  <p class="verdictline">A checker run at step 2 finds nothing wrong, because at step 2 there is nothing left to find:
  the operator bought the float, then paid for the appearance of a market. A checker run at step 3 reports thin
  liquidity — correctly, and far too late to be worth anything. The launch record was true at every step, and it is
  the only thing here that could not be bought.</p>` : ""}

  <div class="sec"><h2>Launched clean — last ${DAYS === 1 ? "24 hours" : `${DAYS} days`}</h2><span class="cnt">${fmt(clean.length)} of ${fmt(toks.length)} graduations</span></div>
  <p class="lede">Creator kept under ${MAX_DEV_PCT}% and has not sold, at least ${MIN_BUYERS} distinct buyers on the curve,
  the curve took over a minute to fill and was not taken by a single ${BUYOUT_SOL}+ SOL buy, and at least ${MIN_POOL_SOL} SOL
  in the pool right now. That means <b>not manufactured</b>. It is not a recommendation, and most of these will still lose money.</p>
  <table class="data"><tr><th>Token</th><th class="num">Creator kept</th><th class="num">Buyers</th><th class="num">Time to fill</th><th class="num">Liquidity, read ${when(now)}</th></tr>${cleanRows}</table>
  <p class="callout">Launch figures are permanent; a pool balance is not. Every pool above was read from the chain while
  this page was built, and a token whose pool could not be read is left off rather than carried on an old number.${unverified.length ? ` <b>${fmt(unverified.length)}</b> passed every launch test but could not be read just now — absent here means unchecked, not manufactured.` : ""}</p>

  <div class="sec"><h2>Who takes the curves</h2><span class="cnt">${fmt(wallets.size)} wallets on file</span></div>
  <p class="lede">A single large buy that completes a bonding curve is not demand, it is a purchase of the float. These
  are the wallets doing it, what they spent, and what they did with the tokens afterwards. This is the part no
  contract scanner can produce, because it needs a wallet's history across many tokens rather than one token's state.</p>
  <table class="data"><tr><th>Wallet</th><th class="num">Curves taken</th><th class="num">Spent</th><th class="num">Sold after</th><th class="num">Bought back</th></tr>${opRows}</table>`,
  chrome, 0,
  `Of ${fmt(day.length)} pump.fun tokens that finished their bonding curve in the last 24 hours, ${fmt(dayClean.length)} launched clean and ${fmt(dayDanger)} carry a danger flag. We watch every launch and keep the record, because the evidence only exists while it happens.`));

writeFileSync(join(OUT, "404.html"), page("No record", `
  <h1>We have no record of this launch</h1>
  <div class="sub">Either it launched outside our coverage, or it is not a pump.fun token.
  Coverage begins ${chrome.coverageFrom}.</div>
  <div class="flag UNKNOWN"><span class="tag UNKNOWN">unknown</span>This is <b>not</b> a clean result.
  Once a token's float has been spread across wallets, a manufactured launch is indistinguishable from a real one by
  present-tense inspection — which is why the record has to be kept at the time, and why we will not guess.</div>
  ${SEARCH}`, chrome, 0, undefined, "/404.html"));

// ---------- method ----------
// The page a sceptic and a grant reviewer both need: how a claim on this site is decided, and what was done to check
// it. Every figure here is computed at build time from the same code the site runs, so the page cannot describe rules
// the site does not apply — which is the failure mode of every "methodology" page written once and left alone.
const labelled = (() => {
  try {
    const set = JSON.parse(readFileSync("data/labels.json", "utf8")) as { labels: any[]; families: any[]; method: string };
    const q = db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE mint = ?`);
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
  <p class="lede">Everything here is read from the Solana chain and can be checked against it. This page states what is
  recorded, how the one judgement we make is defined, what was done to test it, and — the part that matters most —
  what we refuse to say.</p>

  <div class="sec"><h2>What is recorded, and when</h2></div>
  <p class="lede">A collector decodes the pump.fun program's own events as they happen and writes down, for every
  launch: the creator, the share of supply the creator took in the creation transaction, every distinct wallet that
  bought on the bonding curve, how long the curve took to fill, whether a single buy completed it, and whether the
  creator sold. These are facts about a moment. They stop being observable once the float is spread across wallets,
  which is why they are recorded live rather than inferred later.</p>
  <p class="callout">Coverage begins ${chrome.coverageFrom}${chrome.gapMin >= 1 ? `, with ${fmt(chrome.gapMin)} minutes of recorded downtime` : ", with no recorded downtime"}. A launch that
  happened while the collector was down has no record, and is reported as unobserved rather than as anything else.</p>

  <div class="sec"><h2>The one judgement: "launched clean"</h2></div>
  <p class="lede">It means <b>not manufactured</b>. It is not a prediction, not a recommendation, and not a statement
  that the token will hold its value — most tokens lose money regardless. A launch is called clean only when every one
  of these is true of the record:</p>
  <table>
    <tr><th>Test</th><th>Threshold</th><th>Why</th></tr>
    <tr><td>Creator's share in the first block</td><td class="num">under ${MAX_DEV_PCT}%</td><td>above this the creator is the market, and every buyer is bidding against their inventory</td></tr>
    <tr><td>Distinct outside buyers on the curve</td><td class="num">at least ${MIN_BUYERS}</td><td>a curve filled by a handful of wallets was bought, not demanded</td></tr>
    <tr><td>Time to complete the curve</td><td class="num">over ${MIN_GRAD_MS / 1000}s</td><td>a curve that fills faster than this was taken before anyone could buy at a normal price</td></tr>
    <tr><td>Largest single buy on the curve</td><td class="num">under ${BUYOUT_SOL} SOL</td><td>one buy that completes a curve is a purchase of the float, not a market</td></tr>
    <tr><td>Creator sold</td><td class="num">no</td><td>self-explanatory</td></tr>
    <tr><td>Liquidity in the pool</td><td class="num">at least ${MIN_POOL_SOL} SOL</td><td>read from the chain at the moment the claim is made, never from a stored number</td></tr>
  </table>
  <p class="callout">Launch facts are permanent; a pool balance is not. The liquidity test is deliberately separate
  from the rest and is applied against a balance read during the build that produced the page. A token whose pool
  could not be read is left off the clean list rather than carried forward on an old figure.</p>

  ${labelled ? `<div class="sec"><h2>Has it been tested?</h2><span class="cnt">${fmt(labelled.checked)} known-manufactured tokens</span></div>
  <p class="lede">Yes, and the test is one-sided on purpose. A missed warning costs a reader nothing; a wrong
  all-clear costs them everything. So the gate is that <b>no known-manufactured token may be certified clean</b> —
  failing to flag one is reported and tolerated.</p>
  <p class="lede">The labelled set cannot be built from the rules being tested, or it proves nothing. It comes from
  creator-wallet reuse instead — an axis none of the criteria above read: a ticker relaunched at least 15 times, each
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
    <tr><td>A rebuild could not read every transaction</td><td>UNKNOWN — a truncated history looks exactly like a quiet launch</td></tr>
    <tr><td>The pool balance could not be read</td><td>no clean certificate, and no liquidity figure quoted</td></tr>
    <tr><td>We hold no record and the address has no pump.fun bonding curve</td><td>we say so, rather than guess</td></tr>
  </table>

  <div class="sec"><h2>Rebuilt records</h2></div>
  <p class="lede">A launch we did not watch can often be reconstructed: a bonding curve is a single account whose whole
  transaction history is readable, so the same on-chain events can be decoded later. Those pages are marked
  <b>rebuilt</b>. The figures are the same events read afterwards, and are judged the same way — but a rebuild cannot
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
  `How Chain of Title decides what to say about a token launch: what is recorded live, how "launched clean" is defined, the labelled-set test behind it, and the four situations where we refuse to answer.`, "/method.html"));

// ---------- data ----------
// A public good has to be downloadable, or the claim is rhetorical. The record database is the archive itself, not an
// export of it: the same file the service reads.
const recStat = (() => { try { return statSync("data/record.db"); } catch { return null; } })();
writeFileSync(join(OUT, "data.html"), page("The data", `
  <h1 class="headline">Take the whole archive</h1>
  <p class="lede">Everything this site knows is one file. It is the same database the service reads — not an export,
  not a sample, and not a subset chosen to look good. Public domain, no attribution required, no key, no sign-up.</p>

  <div class="sec"><h2>The record database</h2>${recStat ? `<span class="cnt">${(recStat.size / 1048576).toFixed(1)} MB</span>` : ""}</div>
  <table>
    <tr><td class="k">Download</td><td><a href="data/record.db"><b>record.db</b></a> — SQLite, ${recStat ? `${(recStat.size / 1048576).toFixed(1)} MB` : "~40 MB"}, one row per launch</td></tr>
    <tr><td class="k">Launches</td><td>${fmt((db.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c)}</td></tr>
    <tr><td class="k">Coverage</td><td>from ${chrome.coverageFrom}${chrome.gapMin >= 1 ? `, ${fmt(chrome.gapMin)} min of recorded downtime` : ", no recorded downtime"}</td></tr>
    <tr><td class="k">Licence</td><td>CC0 1.0 — public domain. It is a record of public facts; nobody should have to ask us for it.</td></tr>
    <tr><td class="k">Rebuilt</td><td>on each deploy, by <span class="mono">npm run servicedb</span></td></tr>
  </table>
  <p class="lede">Tables: <span class="mono">tokens</span> (the launch record), <span class="mono">trades</span> and
  <span class="mono">hist_trades</span> (curve buys large enough to be a buyout), <span class="mono">wallet_flow</span>
  (what each curve-taking wallet did afterwards), <span class="mono">operator_wallets</span> and
  <span class="mono">operator_policy</span>, <span class="mono">pool_map</span>, and <span class="mono">runs</span>
  (the coverage windows, so you can check what we were awake for).</p>
  <p class="callout">The collector's own database is around 7 GB and is not this. It holds every trade on every tracked
  token and exists to derive the record; it is a research instrument on a retention window, not the archive.</p>

  <div class="sec"><h2>Live JSON</h2></div>
  <table>
    <tr><td class="k"><a href="api/${API_VERSION}/token/{mint}" class="mono">api/${API_VERSION}/token/{mint}</a></td><td>one launch record — free, keyless, CORS-open. <a href="api.html">How to read it</a>, and the one rule that matters.</td></tr>
    <tr><td class="k"><a href="api/${API_VERSION}/status" class="mono">api/${API_VERSION}/status</a></td><td>what the archive holds and what it was awake for</td></tr>
    <tr><td class="k"><a href="api/summary.json" class="mono">api/summary.json</a></td><td>yesterday's counts, coverage, and the current clean list</td></tr>
  </table>
  <p class="callout">Walking the API for bulk work is the slow way round and costs us RPC reads we would rather spend
  rebuilding launches nobody has asked for yet. Take <a href="data/record.db">record.db</a> instead — it is the same
  data, in one file, and you can join across it.</p>

  <div class="sec"><h2>Reading it</h2></div>
  <p class="lede">Any SQLite client. The counts on the front page are these queries, and disagreeing with us is the
  point of publishing it.</p>
  <table>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT COUNT(*) FROM tokens
WHERE graduated=1 AND dev_pct >= 50;</td><td>graduations where the creator took at least half the supply</td></tr>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT symbol, dev_pct, curve_buyers
FROM tokens WHERE graduated=1
  AND curve_buyers = 0;</td><td>curves that completed with no outside buyer at all</td></tr>
    <tr><td class="mono" style="white-space:pre-wrap">SELECT wallet, amm_sell, curve_sol
FROM wallet_flow
ORDER BY amm_sell DESC LIMIT 20;</td><td>who sold the most into buyers after taking a curve</td></tr>
  </table>`, chrome, 0,
  `The whole Chain of Title archive as one CC0 SQLite file: ${fmt((db.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c)} Solana launch records, one row each, no key or sign-up.`, "/data.html"));

/**
 * The API page. It documents one thing above everything else — that a null is not a clean result — because the whole
 * value of an integration is that someone else's users see our UNKNOWN as an UNKNOWN, and the integrator's code is
 * the only place we cannot inspect.
 */
const H = CANONICAL_HOST || "https://chainoftitle.org";
writeFileSync(join(OUT, "api.html"), page("The API", `
  <h1 class="headline">A launch record, as JSON</h1>
  <p class="lede">Every record on this site is also a JSON document. No key, no account, no rate limit on reads, no
  attribution required — the archive is public domain and so is everything served from it. If you run a wallet, a
  terminal, a scanner or a bot, you are meant to read this without asking us.</p>
  <p class="lede">There is one thing you have to get right, and it is the next section.</p>

  <div class="sec"><h2>Absence of a record is not a clean record</h2></div>
  <p class="lede">The field to branch on is <span class="mono">verdict.level</span>, which is one of
  <span class="mono">OK</span>, <span class="mono">DANGER</span>, <span class="mono">CAUTION</span> or
  <span class="mono">UNKNOWN</span>. <span class="mono">cleanAtBirth</span> is a convenience and it has three states,
  not two:</p>
  <table>
    <tr><td class="k mono">true</td><td>we watched this launch (or rebuilt its complete history) and it shows no sign of manufacture</td></tr>
    <tr><td class="k mono">false</td><td>we watched it and it failed at least one test — see <span class="mono">verdict</span> and <span class="mono">flags</span> for which. Not necessarily an accusation: a token whose pool we could not read just now is <span class="mono">false</span> and <span class="mono">UNKNOWN</span>, not <span class="mono">DANGER</span>.</td></tr>
    <tr><td class="k mono">null</td><td><b>we do not know.</b> We did not observe the launch and have not rebuilt it. <b>Do not render this as clean, safe, or "no issues found."</b></td></tr>
  </table>
  <p class="callout">Once a token's float has been spread across wallets, a manufactured launch is indistinguishable
  from a real one by present-tense inspection — that is the entire reason this archive exists. A null means the
  evidence is gone, which is the opposite of reassuring. Every refusal and every error we return also carries
  <span class="mono">verdict.level = "UNKNOWN"</span>, so code that reads only that field is safe even when it ignores
  the HTTP status.</p>

  <div class="sec"><h2>Endpoints</h2></div>
  <table>
    <tr><td class="k mono">GET /api/${API_VERSION}/token/{mint}</td><td>one launch record: what the creator took in the first block, how many outside wallets bought its curve, how it graduated, who took it, and the pool right now</td></tr>
    <tr><td class="k mono">GET /api/${API_VERSION}/wallet/{address}</td><td>a wallet's priors: every bonding curve it has bought outright in this archive, and what it did with the tokens afterwards. A wallet we have never seen returns <span class="mono">inArchive: false</span> and nulls — <b>not zeros</b>, because "we hold nothing on it" is not "it has done nothing". In <span class="mono">buyouts</span>, <span class="mono">sameBatchAsLaunch: true</span> means the buy arrived in the same batch of chain events as the launch itself — <span class="mono">hoursAfterLaunch</span> is then <span class="mono">null</span> rather than <span class="mono">0</span>, because our timestamps cannot resolve it further. Don't render it as zero.</td></tr>
    <tr><td class="k mono">GET /api/${API_VERSION}/status</td><td>what the archive holds and what it was awake for</td></tr>
    <tr><td class="k mono">GET /data/record.db</td><td>the whole archive as one SQLite file, CC0. If you are going to query it in bulk, take this instead of walking the API.</td></tr>
  </table>
  <p class="lede mono" style="white-space:pre-wrap">curl ${H}/api/${API_VERSION}/token/&lt;mint&gt;</p>

  <div class="sec"><h2>Tokens we have never seen</h2></div>
  <p class="lede">Coverage begins ${chrome.coverageFrom}. Ask for an older launch and we reconstruct it from the
  bonding curve's complete transaction history — thousands of archival RPC reads, which is a background job, not a
  request. You get <span class="mono">202</span> with <span class="mono">verdict.level = "UNKNOWN"</span> and a
  <span class="mono">rebuild</span> object; poll the same URL. A finished record is permanent, so the second call is
  usually the last one you ever make for that mint.</p>
  <p class="lede">Reads are unmetered. Rebuilds are not: they cost real money, so each caller can start
  ${PER_IP_PER_HOUR} an hour and the service has a daily ceiling. When that is reached you get
  <span class="mono">503 rebuild_budget_exhausted</span> — the archive is unaffected, only new reconstruction is
  paused. If you need bulk historical coverage, <a href="mailto:${esc(CONTACT)}">say so</a>; that is a conversation
  about who pays for the RPC, not about a licence.</p>

  <div class="sec"><h2>Statuses</h2></div>
  <table>
    <tr><td class="k mono">200</td><td>a record. It may still be an <span class="mono">UNKNOWN</span> one.</td></tr>
    <tr><td class="k mono">202</td><td>accepted; a rebuild is queued or running. Retry-After is set.</td></tr>
    <tr><td class="k mono">400 not_an_address</td><td>not base58, or not 32–44 characters</td></tr>
    <tr><td class="k mono">404 not_a_pump_launch</td><td>no pump.fun bonding curve exists for this address. A finding, not a failure.</td></tr>
    <tr><td class="k mono">404 rebuild_failed</td><td>we tried to read the chain and could not. <b>Our failure, not a finding</b> — it says nothing about the token.</td></tr>
    <tr><td class="k mono">429 rate_limited</td><td>too many rebuilds started from one address this hour</td></tr>
    <tr><td class="k mono">503 rebuild_budget_exhausted / busy</td><td>we cannot pay for or keep up with more rebuilds right now</td></tr>
  </table>

  <div class="sec"><h2>Terms, such as they are</h2></div>
  <table>
    <tr><td class="k">Cost</td><td>nothing, and there is no paid tier of this data. If you need an SLA, webhooks at creation, or bulk history, that is a separate conversation — the free endpoint does not get worse to make it happen.</td></tr>
    <tr><td class="k">Licence</td><td>CC0 1.0. Republish it, cache it, resell it. We would rather you linked the record so a reader can check it.</td></tr>
    <tr><td class="k">CORS</td><td>open to every origin. Call it from your own front end.</td></tr>
    <tr><td class="k">Caching</td><td>a settled record is immutable and served <span class="mono">max-age=3600, stale-while-revalidate=86400</span>. Anything unsettled is <span class="mono">no-store</span>.</td></tr>
    <tr><td class="k">Stability</td><td>fields are added, never repurposed. A breaking change gets a new version prefix and the old one keeps answering.</td></tr>
    <tr><td class="k">What it is not</td><td>not a price feed, not a signal, not advice. A clean record means a launch was <b>not manufactured</b> — nothing about what it will do. Of 19,412 bonding-curve positions measured, none reached 5x.</td></tr>
  </table>
  <p class="callout">If you ship this in front of users and find a record you think is wrong, tell us — a false
  warning on an honest launch costs us more than a missed one. <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a></p>
  `, chrome, 0,
  `The Chain of Title launch record as JSON: free, keyless and unmetered, CC0. One rule — an unknown launch is never a clean one.`, "/api.html"));

writeFileSync(join(OUT, "favicon.svg"), FAVICON);

// The link-preview card. A committed asset rather than a build product: it needs a real browser to render (see
// `scripts/ogcard.mjs`), which the container has not got, and it changes only when the mark or the wording does.
try { copyFileSync("assets/og.png", join(OUT, "og.png")); }
catch { console.log("  assets/og.png missing — link previews will have no image"); }

writeFileSync(join(OUT, "api", "summary.json"), JSON.stringify({
  generatedAt: now, coverageFrom: win.length ? win[0].a : null, downtimeMinutes: Math.round(chrome.gapMin),
  // What the clean counts below are worth. A consumer reading this instead of the page needs the same caveat.
  poolsRead: reread, poolsUnreadable: unverified.length,
  unreadableFraction: Number(unreadableFrac.toFixed(4)), degraded: unreadableFrac > 0.05,
  graduated24h: day.length, clean24h: dayClean.length, unverified24h: dayUnverified.length,
  archivedLaunches: (db.prepare("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0").get() as any).c,
  clean: clean.map((t) => ({
    mint: t.mint, symbol: t.symbol, creatorSupplyPct: t.dev_pct, curveBuyers: cleanBuyers.get(t.mint) ?? null,
    poolSol: readings.get(t.mint)!.sol, poolReadAt: readings.get(t.mint)!.at,
  })),
}, null, 2));

console.log(`\nwrote ${OUT}/`);
console.log(PAGES
  ? `  ${toks.length.toLocaleString()} token pages + ${wallets.size} wallet pages written (--pages)`
  : `  ${toks.length.toLocaleString()} graduations and ${wallets.size} curve-taking wallets assessed; their pages are rendered on request by \`npm run serve\` (pass --pages to write them)`);
console.log(`  ${clean.length} launched clean; ${dayClean.length} in the last 24 h of ${day.length} graduations`);
console.log(`  index.html, api.html, api/summary.json` + (PAGES ? `, api/${API_VERSION}/token/<mint>.json, api/${API_VERSION}/wallet/<wallet>.json` : ""));
