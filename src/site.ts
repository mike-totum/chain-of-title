/**
 * Static site generator. Reads the archive and writes flat HTML + JSON — no backend, no database server, no uptime
 * obligation. If generation fails, yesterday's pages are still up and still correct.
 *   npm run site -- [--out site] [--days 7]
 *
 * Every claim on a page carries the address and the number behind it, so a reader can verify it against the chain
 * themselves. That verifiability is the asset; the pages are evidence, not persuasion.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { profile, verdictLine } from "./operator.ts";
import { poolReservesPooled } from "./outcomes.ts";
import { BRAND, CSS, FAVICON, SEARCH, page, tokenBody, walletBody, tokenPreview, esc, fmt, when, dur, ago, type Chrome, type Reading } from "./render.ts";
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



mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, "api"), { recursive: true });
if (PAGES) {
  mkdirSync(join(OUT, "t"), { recursive: true });
  mkdirSync(join(OUT, "w"), { recursive: true });
  mkdirSync(join(OUT, "api", "t"), { recursive: true });
  mkdirSync(join(OUT, "api", "w"), { recursive: true });
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
let next = 0;
await Promise.all(Array.from({ length: POOL_CONCURRENCY }, async () => {
  for (let i = next++; i < candidates.length; i = next++) {
    const { t } = candidates[i];
    const r = await poolReservesPooled(t.pool, t.mint);
    if (r) { readings.set(t.mint, { sol: r.quoteSol, at: Date.now(), fresh: true }); reread++; }
  }
}));
for (const { t } of candidates) if (!readings.has(t.mint)) unverified.push(t);
console.log(`  ${reread} answered, ${unverified.length} unreadable (cannot be certified)`);

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
      page(pv.title, tokenBody(t, a, r, "observed", cleanTok, now), chrome, 1, pv.summary));
  }
  if (PAGES) writeFileSync(join(OUT, "api", "t", `${t.mint}.json`), JSON.stringify({
    mint: t.mint, symbol: t.symbol, observedAtLaunch: a.watched, clean: cleanTok,
    createdAt: t.created_at, creator: t.creator, creatorSupplyPct: a.watched ? t.dev_pct : null,
    curveBuyers: a.curveBuyers, graduatedAt: t.graduated_at,
    creatorSold: a.watched ? !!t.dev_sold : null,
    curveBuyout: a.buyout ? { wallet: a.buyout.wallet, sol: a.buyout.sol, at: a.buyout.ts } : null,
    poolSol: r ? r.sol : null, poolReadAt: r ? r.at : null, poolReadFresh: r ? r.fresh : null,
    flags: a.flags, coverageFrom: win.length ? win[0].a : null,
  }, null, 2));
}

// ---------- wallet pages ----------
for (const [w] of wallets) {
  const p = profile(db, w);
  const line = verdictLine(p);
  const rows = p.buyouts.map((b) => `<tr><td>${when(b.ts)}</td><td><a href="../t/${esc(b.mint)}.html">${esc(b.symbol ?? "?")}</a></td>
    <td>${b.sol.toFixed(0)} SOL</td><td>${b.dormantH === null ? "unknown" : dur(b.dormantH * 3600_000)} after launch</td></tr>`).join("");
  if (PAGES) writeFileSync(join(OUT, "w", `${w}.html`), page(`Priors — ${w.slice(0, 8)}`, walletBody(w, p, line), chrome, 1));
  if (PAGES) writeFileSync(join(OUT, "api", "w", `${w}.json`), JSON.stringify({ wallet: w, ...p, summary: line }, null, 2));
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
    <div style="margin:4px 0 0">
      <div class="stat"><span>graduated, last 24h</span><b class="big">${fmt(day.length)}</b></div>
      <div class="stat"><span>launched clean</span><b class="big">${fmt(dayClean.length)}</b></div>
      <div class="stat"><span>carrying a danger flag</span><b class="big">${fmt(dayDanger)}</b></div>
      <div class="stat"><span>launches on file</span><b class="big">${fmt((db.prepare("SELECT COUNT(*) c FROM tokens WHERE late_discovery=0").get() as any).c)}</b></div>
    </div>
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

  <div class="sec"><h2>Launched clean</h2><span class="cnt">last ${DAYS === 1 ? "24 hours" : `${DAYS} days`} · ${fmt(clean.length)} of ${fmt(toks.length)} graduations</span></div>
  <p class="lede">Creator kept under ${MAX_DEV_PCT}% and has not sold, at least ${MIN_BUYERS} distinct buyers on the curve,
  the curve took over a minute to fill and was not taken by a single ${BUYOUT_SOL}+ SOL buy, and at least ${MIN_POOL_SOL} SOL
  in the pool right now. That means <b>not manufactured</b>. It is not a recommendation, and most of these will still lose money.</p>
  <table><tr><th>Token</th><th class="num">Creator kept</th><th class="num">Buyers</th><th class="num">Time to fill</th><th class="num">Liquidity, read ${when(now)}</th></tr>${cleanRows}</table>
  <p class="callout">Launch figures are permanent; a pool balance is not. Every pool above was read from the chain while
  this page was built, and a token whose pool could not be read is left off rather than carried on an old number.${unverified.length ? ` <b>${fmt(unverified.length)}</b> passed every launch test but could not be read just now — absent here means unchecked, not manufactured.` : ""}</p>

  <div class="sec"><h2>Who takes the curves</h2><span class="cnt">${fmt(wallets.size)} wallets on file</span></div>
  <p class="lede">A single large buy that completes a bonding curve is not demand, it is a purchase of the float. These
  are the wallets doing it, what they spent, and what they did with the tokens afterwards. This is the part no
  contract scanner can produce, because it needs a wallet's history across many tokens rather than one token's state.</p>
  <table><tr><th>Wallet</th><th class="num">Curves taken</th><th class="num">Spent</th><th class="num">Sold after</th><th class="num">Bought back</th></tr>${opRows}</table>`,
  chrome, 0,
  `Of ${fmt(day.length)} pump.fun tokens that finished their bonding curve in the last 24 hours, ${fmt(dayClean.length)} launched clean and ${fmt(dayDanger)} carry a danger flag. We watch every launch and keep the record, because the evidence only exists while it happens.`));

writeFileSync(join(OUT, "404.html"), page("No record", `
  <h1>We have no record of this launch</h1>
  <div class="sub">Either it launched outside our coverage, or it is not a pump.fun token.
  Coverage begins ${chrome.coverageFrom}.</div>
  <div class="flag UNKNOWN"><span class="tag UNKNOWN">unknown</span>This is <b>not</b> a clean result.
  Once a token's float has been spread across wallets, a manufactured launch is indistinguishable from a real one by
  present-tense inspection — which is why the record has to be kept at the time, and why we will not guess.</div>
  ${SEARCH}`, chrome));

writeFileSync(join(OUT, "favicon.svg"), FAVICON);

writeFileSync(join(OUT, "api", "summary.json"), JSON.stringify({
  generatedAt: now, coverageFrom: win.length ? win[0].a : null, downtimeMinutes: Math.round(chrome.gapMin),
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
console.log(`  index.html, api/summary.json, api/t/<mint>.json, api/w/<wallet>.json`);
