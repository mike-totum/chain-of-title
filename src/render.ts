/**
 * Page chrome and the token page, shared by the static generator (`site.ts`) and the live service (`serve.ts`).
 *
 * Both must produce byte-identical pages for the same record: the service renders a token the moment its history has
 * been rebuilt, and the generator rewrites the same file on its next run. If the two drifted, a page would change
 * appearance for no reason a reader could account for, on a site whose whole claim is that nothing is asserted without
 * a reason. The clean *criteria* are shared separately in `provenance.ts`; this module only decides how a record reads.
 */
import type { Assessment } from "./provenance.ts";
import { MIN_POOL_SOL, MAX_DEV_PCT } from "./provenance.ts";

/** In property law, the unbroken documented history of ownership from origin. */
export const BRAND = "Chain of Title";

/**
 * Two interlocking links. Literal rather than clever, which is the right register for a registry, and it survives
 * being 16 pixels wide in a browser tab — the size at which a mark actually has to work. Inline, so it costs no
 * request and inherits the page's colour in both themes.
 */
export const MARK = `<svg class="mark" viewBox="0 0 34 20" width="26" height="16" aria-hidden="true" focusable="false">
  <rect x="1.5" y="1.5" width="20" height="17" rx="8.5" fill="none" stroke="currentColor" stroke-width="3"/>
  <rect x="12.5" y="1.5" width="20" height="17" rx="8.5" fill="none" stroke="currentColor" stroke-width="3"/>
</svg>`;

/** The same mark as a standalone file, for the browser tab. */
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 20">
  <rect x="1.5" y="1.5" width="20" height="17" rx="8.5" fill="none" stroke="#1a1a19" stroke-width="3"/>
  <rect x="12.5" y="1.5" width="20" height="17" rx="8.5" fill="none" stroke="#a4342a" stroke-width="3"/>
</svg>`;

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const fmt = (n: number, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d });
export const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
export const dur = (ms: number) => ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86400_000).toFixed(1)} days`;
export const ago = (ms: number) => ms < 90_000 ? "just now" : `${dur(ms)} ago`;

export const CSS = `
:root{--bg:#fbfbfa;--fg:#1a1a19;--mut:#6b6b68;--line:#e4e4e1;--bad:#a4342a;--warn:#8a6a1f;--ok:#2f6b46;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e6;--mut:#9a9a96;--line:#2c2c2a;--bad:#e0796d;--warn:#d6b25e;--ok:#7fc39a;--card:#1b1b1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
/* One measure for the whole page. Prose was capped at 62ch inside an 860px column while every table ran the full
   width, so each section began with a short paragraph over a wide grid and the eye had two left-to-right rhythms to
   follow. 800px is ~70ch at this size: inside the comfortable range for reading, and still wide enough for a
   five-column table of numbers. Prose and tables now share one edge. */
.wrap{max-width:800px;margin:0 auto;padding:32px 20px 80px}
a{color:inherit}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:32px 0 10px;font-weight:600}
/* Keyboard users could see the focus ring on the search input and nowhere else. */
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
.sub{color:var(--mut);font-size:13px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-weight:600;color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
th,td{padding:7px 10px 7px 0;border-bottom:1px solid var(--line);vertical-align:top}
.k{color:var(--mut);width:180px}
.flag{padding:10px 12px;border-left:3px solid;margin:8px 0;background:var(--card);font-size:14px}
.DANGER{border-color:var(--bad)}.CAUTION{border-color:var(--warn)}.OK{border-color:var(--ok)}.UNKNOWN{border-color:var(--mut)}
.tag{font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;margin-right:6px}
.tag.DANGER{color:var(--bad)}.tag.CAUTION{color:var(--warn)}.tag.OK{color:var(--ok)}.tag.UNKNOWN{color:var(--mut)}
.note{color:var(--mut);font-size:13px;border-top:1px solid var(--line);margin-top:40px;padding-top:16px}
.big{font-size:30px;font-weight:600}.stat{display:inline-block;margin-right:36px;margin-bottom:12px}
.stat span{display:block;color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.mast{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding-bottom:14px;margin-bottom:28px;border-bottom:1.5px solid var(--fg)}
.mast a.brand{font-weight:600;font-size:15px;letter-spacing:.02em;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.mast a.brand:hover span{text-decoration:underline;text-underline-offset:3px}
.mark{flex:none;overflow:visible}
.mark rect:last-child{color:var(--bad);stroke:currentColor}
.mast .tag2{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.09em}
form.find{display:flex;gap:8px;margin:20px 0 28px}
form.find input{flex:1;min-width:0;padding:11px 12px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:0}
form.find input:focus{outline:2px solid var(--fg);outline-offset:-1px}
form.find button{padding:11px 18px;font:600 13px/1.4 inherit;color:var(--bg);background:var(--fg);border:0;cursor:pointer}
.miss{display:none;margin:-14px 0 24px;color:var(--bad);font-size:13px}
.prog{height:3px;background:var(--line);overflow:hidden;margin:18px 0}
.prog i{display:block;height:100%;width:34%;background:var(--fg);animation:sl 1.5s ease-in-out infinite}
@keyframes sl{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
@media(prefers-reduced-motion:reduce){.prog i{animation:none;width:100%;opacity:.4}}

/* A registry should read like one: a serif for anything asserted, the sans for apparatus, mono for what came off the
   chain. The serif is a system stack, so the page stays a single self-contained file with no network font. */
.serif{font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif}
.mast{align-items:baseline}
.mast .what{color:var(--mut);font-size:12.5px;flex-basis:100%;margin-top:2px}
.hero{padding:6px 0 0}
.headline{font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  font-size:clamp(28px,4.6vw,40px);line-height:1.12;letter-spacing:-.015em;font-weight:600;margin:0 0 14px;text-wrap:balance}
.headline b{font-weight:600;border-bottom:3px solid var(--bad);padding-bottom:1px}
.lede{font-size:16px;line-height:1.62;color:var(--fg);margin:0 0 6px}
.lede + .lede{margin-top:12px;color:var(--mut);font-size:14.5px}
.sec{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:44px 0 6px;
  padding-bottom:8px;border-bottom:1.5px solid var(--fg)}
.sec h2{margin:0;border:0;padding:0}
.sec .cnt{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--mut)}
/* The contrast that is the whole argument: what is measurable now, against what was true at birth.
   Three panels in a two-column grid put step 3, the step that lands the argument, alone on a second row with an
   empty cell beside it, directly under a sentence telling the reader to read left to right. It is a sequence, so it
   gets a column each. */
.proof{display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid var(--line);background:var(--card);margin:22px 0 0}
.proof > div{padding:18px 20px;min-width:0}
.proof > div + div{border-left:1px solid var(--line)}
.proof h3{margin:0 0 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--mut);font-weight:700}
.proof ul{margin:0;padding:0;list-style:none;font-size:14px;line-height:1.5}
.proof li{padding:5px 0;border-bottom:1px solid var(--line)}
.proof li:last-child{border-bottom:0}
.proof .now h3{color:var(--ok)}
.proof .birth h3{color:var(--bad)}
.proof b{font-variant-numeric:tabular-nums}
.verdictline{margin:0;padding:14px 20px;border:1px solid var(--line);border-top:0;background:var(--card);
  font-size:14px;color:var(--mut)}
/* Three narrow columns stop being readable well before the phone breakpoint. */
@media(max-width:820px){.proof{grid-template-columns:1fr}.proof > div + div{border-left:0;border-top:1px solid var(--line)}}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:var(--card)}
.callout{border-left:3px solid var(--fg);padding:2px 0 2px 16px;margin:18px 0 0;font-size:14.5px;color:var(--mut)}

/* A row grid of five or six columns cannot be squeezed into a phone: "22.6 h" wrapped onto two lines and the header
   "Time to fill" stacked three deep. Tables of records scroll sideways instead, which keeps every figure on one line
   and next to its own label. Key-and-value tables are not marked .data and keep wrapping, which is right for them. */
@media(max-width:620px){
  .data{display:block;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch}
  .data th,.data td{padding-right:16px}
  .k{width:auto}
  .stat{margin-right:24px}
}

/* The verdict. A record page is read to settle one question, and it used to open with a stack of flag boxes of equal
   weight, leaving the reader to assemble the answer. The answer goes first; the flags below it are the evidence. */
.verdict{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:0 0 6px;padding:14px 0 12px;border-top:1.5px solid var(--fg);border-bottom:1px solid var(--line)}
.verdict .v{font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;font-size:26px;font-weight:600;line-height:1.1;letter-spacing:-.01em}
.verdict .v.DANGER{color:var(--bad)}.verdict .v.OK{color:var(--ok)}.verdict .v.UNKNOWN{color:var(--mut)}
.verdict .vwhy{color:var(--mut);font-size:14px;flex:1;min-width:220px}
/* The mint, with the two things a reader immediately wants to do with it: copy it, or go and check it themselves. */
.addr{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 22px}
.addr .mono{flex:1;min-width:0;color:var(--mut)}
.addr a,.addr button{font:600 11px/1 inherit;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);
  background:none;border:1px solid var(--line);padding:6px 9px;cursor:pointer;text-decoration:none;white-space:nowrap}
.addr a:hover,.addr button:hover{color:var(--fg);border-color:var(--fg)}
/* Attribution. A registry that will not say who keeps it is asking for a trust it has not offered. */
.who{margin-top:14px}
.who b{font-weight:600;color:var(--fg)}
`;

export interface Chrome { coverageFrom: string; gapMin: number }

/**
 * A record page is this project's only real distribution. Nobody shares a registry's front page; they paste a link to
 * one record into a group chat to settle an argument. With no metadata every such link rendered as a blank grey box,
 * so the most persuasive thing here — a specific, checkable finding about a specific token — was invisible at exactly
 * the moment someone chose to pass it on. The preview is written from the record, so it is an advertisement that
 * cannot say anything the page does not.
 */
/**
 * The site's one true origin. Every page declares which URL it really lives at, or the same record served from a
 * second hostname — an apex and a www, or the platform's own *.up.railway.app — is two documents to a crawler and two
 * link previews to a chat client, which splits the only distribution this project has.
 *
 * This defaults to the real host rather than to nothing. It was an env var alone, CANONICAL_HOST was never set on the
 * deployed service, and so the tag shipped on no live page at all — a mechanism that exists only in the repository
 * protects nothing. CANONICAL_HOST still overrides, for a staging host that must not claim to be this one.
 */
export const CANONICAL_HOST = (process.env.CANONICAL_HOST ?? "https://chainoftitle.org").replace(/\/+$/, "");

/**
 * Who keeps this. A registry that will not say who stands behind it is asking for a trust it has not offered, and it
 * is the first thing a grant reviewer looks for. The address must be a real mailbox before this ships — a published
 * contact that bounces is worse than none.
 */
export const CONTACT = "hello@chainoftitle.org";
export const KEEPER = "the Chain of Title project";
/**
 * Set this to the public repository URL once the auditable half of the code is pushed — the criteria (`provenance.ts`),
 * the site, and the validation harness (`labels.ts`). Until then the footer says nothing about source rather than
 * linking somewhere dead, which is the same discipline the rest of the site applies to its own claims.
 */
export const SOURCE_URL = process.env.SOURCE_URL ?? "";

/**
 * The link preview card. A record link pasted into a group chat is this project's only real distribution, and with no
 * image every one of them rendered as a bare grey box at exactly the moment someone chose to pass it on. The card is
 * static and brand-level; the specific finding still travels in og:title and og:description, which is the part that
 * carries the argument. Generated by `scripts/ogcard.mjs`.
 */
const OG_IMAGE = "/og.png";

export function page(title: string, body: string, c: Chrome, depth = 0, summary?: string, path?: string): string {
  const root = depth ? "../" : "";
  const canonical = CANONICAL_HOST && path ? `${CANONICAL_HOST}${path.startsWith("/") ? path : `/${path}`}` : "";
  const desc = summary ?? "The documented history of a Solana token from its first block: who created it, what they took, and who actually bought.";
  const head = [
    `<title>${esc(title)} · ${BRAND}</title>`,
    ...(canonical ? [`<link rel="canonical" href="${esc(canonical)}">`, `<meta property="og:url" content="${esc(canonical)}">`] : []),
    `<meta name="description" content="${esc(desc)}">`,
    `<meta property="og:site_name" content="${BRAND}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    ...(CANONICAL_HOST ? [
      `<meta property="og:image" content="${esc(CANONICAL_HOST + OG_IMAGE)}">`,
      `<meta property="og:image:width" content="1200">`,
      `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="${esc(BRAND)}: Solana launch records">`,
    ] : []),
    // The large card is what makes the headline legible in a chat client; `summary` renders it at thumbnail size.
    `<meta name="twitter:card" content="${CANONICAL_HOST ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
  ].join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
${head}<style>${CSS}</style></head>
<body><div class="wrap">
<div class="mast"><a class="brand serif" href="${root}index.html">${MARK}<span>${BRAND}</span></a><span class="tag2">Solana launch records</span><span class="what">In property law, the chain of title is the unbroken documented history of ownership from origin: what you establish before you believe a claim about what something is.</span></div>
${body}
<div class="note"><a href="${root}method.html">How this is decided</a> · <a href="${root}corrections.html">Tell us we are wrong</a> · <a href="${root}data.html">Take the data</a> · <a href="${root}api.html">API</a> · <a href="${root}pledge.html">Pledge</a> · <a href="${root}index.html">${BRAND}</a><br>
The documented history of a token from its first block. Coverage begins ${c.coverageFrom}${c.gapMin >= 1 ? `, with ${fmt(c.gapMin)} min of recorded downtime` : ", no recorded downtime"}.
Everything here is read from the Solana chain and can be checked against it. A clean record means a launch was <b>not manufactured</b>. It is not a prediction and not advice.
Most tokens lose money regardless: of 19,412 bonding-curve positions measured, none reached 5x.
<div class="who">Kept by <b>${esc(KEEPER)}</b> · <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>${SOURCE_URL ? ` · <a href="${esc(SOURCE_URL)}">Source</a>` : ""}<br>
Free to use, with no account and no wallet connection. The archive is public domain (<a href="${root}data.html">CC0</a>) and
downloadable in full, so nothing here depends on trusting us to keep publishing it. Funded by grants and by the
services that read it, never by the projects it reports on, and never by sending you into a trade.</div></div>
</div></body></html>`;
}

/**
 * The search box. On the front page, on every page that could not answer, and — because checking one token is rarely
 * what anyone came to do — at the foot of every record.
 *
 * The form submits for real. It was an `onsubmit` handler with no action or method, so with scripting off the button
 * did nothing at all and the site's one interactive element was a decoration; `/lookup` (serve.ts) redirects to the
 * record. The script is still there to validate before spending a request, and to keep the relative path right on the
 * static tree, but it is now an improvement on a working form rather than the only thing holding it up.
 */
export const SEARCH = `
  <form class="find" action="/lookup" method="get" onsubmit="return look(event)">
    <input id="q" name="mint" placeholder="paste a token mint address" spellcheck="false" autocomplete="off"
      pattern="[1-9A-HJ-NP-Za-km-z]{32,44}" required aria-label="Token mint address">
    <button type="submit">Look up</button>
  </form>
  <div class="miss" id="miss" role="alert"></div>
  <script>
  function look(e){
    e.preventDefault();
    var v=document.getElementById('q').value.trim(), m=document.getElementById('miss');
    m.style.display='none';
    if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)){
      m.textContent='That does not look like a Solana address.'; m.style.display='block'; return false;
    }
    location.href=(location.pathname.indexOf('/t/')===0||location.pathname.indexOf('/w/')===0?'../':'')+'t/'+v+'.html';
    return false;
  }
  </script>`;

/**
 * How long after launch a curve was taken — stated only as finely as the record can support.
 *
 * A curve trade's `ts` is `Date.now()` inside the handler that decodes the websocket batch it arrived in, and so is
 * the launch's `created_at`. 1,692 of the 1,736 recorded buyouts have a gap of exactly zero, which is not 1,692
 * measurements of "the same instant": it is one clock reading assigned twice in one batch. The tracker's own bundling
 * heuristic knows this and falls back to a 2 s window when slots are unknown (tracker.ts:313).
 *
 * So "0 min after launch" printed a limit of the collector as a finding about the operator — on 97% of the wallet
 * rows, in the section whose whole purpose is to say that a curve was taken suspiciously fast. Below the resolution
 * we actually have, the page says what it knows instead. Settling it properly needs the creation slot stored on
 * `tokens` and compared against the trade slot; `slot` is now carried into the published record so the comparison is
 * at least possible for anyone who wants to make it.
 */
export function curveAge(ms: number | null): string {
  if (ms === null) return "at an unrecorded time";
  return ms <= 0 ? "in the same batch of events as the launch" : `${dur(ms)} after launch`;
}

export type Reading = { sol: number; at: number; fresh: boolean };

/**
 * The one-line finding a shared link should carry, and the title it should carry it under. Built from the record
 * only: if we cannot say what happened, the preview says that instead of implying anything.
 */
export function tokenPreview(t: any, a: Assessment, clean: boolean): { title: string; summary: string } {
  const sym = t.symbol ?? "This token";
  if (!a.watched)
    return { title: `${sym}: launch not observed`,
      summary: `We have no record of this launch, so we cannot tell you what it was at birth. That is not a clean result: once a token's float has been spread, a manufactured launch is indistinguishable from a real one.` };
  const bits: string[] = [];
  if (t.dev_pct != null) bits.push(`the creator took ${t.dev_pct.toFixed(1)}% of supply in the first block`);
  if (a.curveBuyers != null) bits.push(`${fmt(a.curveBuyers)} outside wallet${a.curveBuyers === 1 ? "" : "s"} bought on the bonding curve`);
  if (t.graduated_at && t.created_at) bits.push(`the curve filled in ${dur(t.graduated_at - t.created_at)}`);
  const evidence = bits.join(", ") + ".";
  if (clean) return { title: `${sym}: launched clean`, summary: `Recorded live at launch: ${evidence} Not manufactured, which is not a prediction, and most tokens lose money regardless.` };
  const headline = manufactureHeadline(t, a);
  return { title: headline ? `${sym}: ${headline}` : `${sym}: launch record`, summary: `Recorded live at launch: ${evidence}` };
}

/**
 * The single worst thing the launch record says about a token, as a phrase. Written for the purpose rather than
 * sliced out of a flag sentence, which produced "WOTF — The creator took 79.3% of the entire supply in the first
 * block. Nothin". Shared by the link preview and the verdict so the two can never say different things about the
 * same record — the failure this module exists to prevent.
 */
function manufactureHeadline(t: any, a: Assessment): string | null {
  const gradS = t.graduated_at && t.created_at ? (t.graduated_at - t.created_at) / 1000 : null;
  /**
   * Each phrase is a complete clause carrying its own article, because the caller says "The record shows <phrase>."
   * The prefix used to supply a "the", which read correctly for the creator-share phrases and produced "The record
   * shows the nobody bought its curve." for the rest — on the single most-read line of the most-read page.
   */
  return t.dev_pct >= 50 ? `the creator took ${t.dev_pct.toFixed(0)}% of supply at launch`
    /**
     * These three assert the curve completed, so none may be said until that is confirmed. `a.completed` is decided
     * once in provenance.ts and read here; deriving it again from t.graduated is what let this function label an
     * ordinary dud — no buyers, never graduated — a "Manufactured launch". Not completing a curve is how most tokens
     * die, and it is not evidence of anything.
     */
    : a.completed && a.curveBuyers === 0 ? "nobody bought its curve"
    : a.completed && gradS !== null && gradS <= 60 ? `the curve was taken ${Math.round(gradS)}s after launch`
    : a.completed && a.curveBuyers !== null && a.curveBuyers < 10 ? `only ${a.curveBuyers} outside buyer${a.curveBuyers === 1 ? "" : "s"} bought its curve`
    // A buyout is an observed trade of 40+ SOL, true whether or not the curve went on to complete.
    : a.buyout ? `one wallet bought its curve for ${a.buyout.sol.toFixed(0)} SOL`
    : t.dev_pct >= MAX_DEV_PCT ? `the creator took ${t.dev_pct.toFixed(0)}% of supply at launch`
    : null;
}

/** "OK" is a verdict but never a flag: `Level` in provenance.ts covers only the things that can go wrong. */
export type Verdict = { level: "OK" | "DANGER" | "CAUTION" | "UNKNOWN"; label: string; why: string };

/**
 * The one line a record page exists to deliver.
 *
 * The distinctions are kept narrow on purpose. "Manufactured" is said only when the launch record itself shows the
 * pattern — the creator held the float, or nobody outside bought, or one wallet took the curve. A token that merely
 * fails a threshold is "not certified", and a token we did not watch is "not observed", because neither is evidence
 * of manufacture and saying otherwise would spend the precision that makes the clean verdict worth anything.
 */
export function verdict(t: any, a: Assessment, clean: boolean): Verdict {
  if (!a.watched) return { level: "UNKNOWN", label: "Launch not observed",
    why: "We have no record of this launch, so we cannot say what it was at birth. That is not a clean result. Once the float has been spread, a manufactured launch is indistinguishable from a real one." };
  if (clean) return { level: "OK", label: "Launched clean",
    why: "The launch record shows no sign of manufacture. That is not a prediction and not advice; most tokens lose money regardless." };
  const headline = manufactureHeadline(t, a);
  if (headline) return { level: "DANGER", label: "Manufactured launch", why: `The record shows ${headline}.` };
  if (a.flags.some((f) => f.level === "DANGER")) return { level: "DANGER", label: "Carries a danger flag",
    why: "The launch itself does not show a manufacturing pattern, but something below is serious enough to warn about." };
  return { level: "UNKNOWN", label: "Not certified",
    why: "This launch failed at least one of the tests for a clean record without matching a manufacturing pattern. It is neither endorsed nor accused." };
}

/**
 * The body of a token page. `origin` says how we know what we know, which the reader is entitled to:
 * "observed" — watched live from creation; "rebuilt" — reconstructed completely from chain history.
 */
export function tokenBody(
  t: any, a: Assessment, r: Reading | null, origin: "observed" | "rebuilt", clean: boolean, now: number,
): string {
  const rows = a.watched ? `
    <tr><td class="k">Created</td><td>${when(t.created_at)}</td></tr>
    <tr><td class="k">Creator</td><td class="mono">${esc(t.creator || "unknown")}</td></tr>
    <tr><td class="k">Creator took</td><td><b>${t.dev_pct?.toFixed(1) ?? "?"}%</b> of supply in the first block</td></tr>
    <tr><td class="k">Outside buyers</td><td><b>${a.curveBuyers === null ? "unknown" : fmt(a.curveBuyers)}</b> distinct wallets bought on the bonding curve before it graduated${origin === "observed" ? `: ${fmt(t.snap30_buyers ?? 0)} within the first 30s, ${fmt(t.bundled_buyers ?? 0)} bundled into the creation block.` : "."}</td></tr>
    <tr><td class="k">Graduated</td><td>${t.graduated_at ? `${dur(t.graduated_at - t.created_at)} after launch` : "yes"}</td></tr>
    <tr><td class="k">Creator sold</td><td>${t.dev_sold ? "yes" : origin === "observed" ? "not while we watched" : "no"}</td></tr>`
    : `<tr><td class="k">Launch</td><td>Not observed. ${t.late_discovery ? "Found only after it was already trading." : "The collector was down when it launched."}</td></tr>`;

  const boBlock = a.buyout ? `<h2>Who took the curve</h2>
    <p class="mono"><a href="../w/${esc(a.buyout.wallet)}.html">${esc(a.buyout.wallet)}</a></p>
    <p>Bought <b>${a.buyout.sol.toFixed(0)} SOL</b> of this curve in a single transaction${t.created_at ? `, ${curveAge(a.buyout.ts - t.created_at)}` : ""}.</p>
    ${t.created_at && a.buyout.ts - t.created_at <= 0 ? `<p class="sub">Our launch and trade timestamps are both taken when the events are decoded, so events that arrived together carry the same one. That it was taken at or near launch is on the record; how many seconds after is not.</p>` : ""}` : "";

  const nowBlock = r ? `<h2>Pool</h2><table>
    <tr><td class="k">Liquidity</td><td>${r.sol.toFixed(1)} SOL</td></tr>
    <tr><td class="k">Read from chain</td><td>${when(r.at)}, ${ago(now - r.at)}${r.fresh ? "" : ". Pool balances move; treat an old reading as an old reading."}</td></tr></table>`
    : t.vault_sol != null ? `<h2>Pool</h2><p class="sub">A balance of ${t.vault_sol.toFixed(1)} SOL is on file but we cannot say when it was read, so it is not quoted here.</p>` : "";

  // How the record was obtained is part of the record. A rebuild is the same transactions, read later — but it cannot
  // include what the token claimed to be at launch, because that lives off-chain and the operator can change it.
  const provenance = origin === "rebuilt" ? `<div class="flag UNKNOWN"><span class="tag UNKNOWN">rebuilt</span>
    We did not watch this launch. Its record was reconstructed from the bonding curve's complete transaction history,
    so the figures below are the same on-chain events, read later. What it cannot tell you is what the token
    <i>claimed</i> to be at launch: the name, image and links live off-chain and can be changed since.</div>` : "";

  const v = verdict(t, a, clean);
  return `
    <h1>${esc(t.symbol ?? "unknown")}</h1>
    <div class="verdict"><span class="v ${v.level}">${esc(v.label)}</span><span class="vwhy">${esc(v.why)}</span></div>
    <div class="addr">
      <span class="mono" id="mint">${esc(t.mint)}</span>
      <button type="button" onclick="cp()" id="cpb">Copy</button>
      <a href="https://solscan.io/token/${esc(t.mint)}" rel="noopener nofollow">Solscan</a>
      <a href="https://pump.fun/coin/${esc(t.mint)}" rel="noopener nofollow">pump.fun</a>
    </div>
    <script>function cp(){navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('mint').textContent).then(function(){
      var b=document.getElementById('cpb'),o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1200)})}</script>
    ${provenance}
    ${a.flags.map((f) => `<div class="flag ${f.level}"><span class="tag ${f.level}">${f.level}</span>${esc(f.text)}</div>`).join("")}
    <h2>At launch</h2><table>${rows}</table>${boBlock}${nowBlock}
    <div class="sec"><h2>Check another</h2></div>${SEARCH}`;
}

/**
 * The front page, rendered from data rather than built into a file.
 *
 * It exists here because the page is now produced two ways — `site.ts` writes it during a build, `serve.ts` renders it
 * per request — and a registry whose front page disagrees with itself depending on how you arrived is not a registry.
 * Same rule as the token page: one renderer, two callers.
 *
 * It states two ages, deliberately, because it has two kinds of fact on it. The counts come from an archive the
 * service pulls periodically, so they are current as of when that archive was built. The liquidity readings are
 * refreshed continuously and are minutes old at most. A single "now" covering both would be false about one of them,
 * and the honest version reads better anyway: nobody else can print when their number was taken.
 */
export interface CleanRow { mint: string; symbol: string | null; devPct: number; buyers: number; fillMs: number | null; poolSol: number; readAt: number }
export interface OpRow { wallet: string; taken: number; spent: number; sold: number; bought: number }
export interface Home {
  now: number; builtAt: number | null;
  graduated24h: number; clean24h: number; danger24h: number; onFile: number;
  windowDays: number; gradWindow: number; unchecked: number; unchecked24h: number;
  cleanRows: CleanRow[]; wallets: number; opRows: OpRow[];
  proof: null | { mint: string; symbol: string | null; devPct: number; gradMs: number | null; fundedSol: number; nowSol: number; nowAt: number };
  maxDevPct: number; minBuyers: number; buyoutSol: number; minPoolSol: number;
}

export function homeTitle(h: Home): string {
  return `${fmt(h.clean24h)} of ${fmt(h.graduated24h)} tokens launched clean yesterday`;
}

export function homeBody(h: Home): string {
  const p = h.proof;
  const rows = h.cleanRows.map((r) => `<tr>
    <td><a href="t/${esc(r.mint)}.html">${esc(r.symbol ?? "?")}</a></td><td class="num">${r.devPct.toFixed(1)}%</td>
    <td class="num">${fmt(r.buyers)}</td><td class="num">${r.fillMs === null ? "?" : dur(r.fillMs)}</td>
    <td class="num">${r.poolSol.toFixed(0)} SOL</td><td class="num">${ago(h.now - r.readAt)}</td></tr>`).join("");
  const ops = h.opRows.map((x) => `<tr><td class="mono"><a href="w/${esc(x.wallet)}.html">${esc(x.wallet.slice(0, 12))}…</a></td>
    <td class="num">${x.taken}</td><td class="num">${fmt(x.spent)} SOL</td>
    <td class="num">${fmt(x.sold)} SOL</td><td class="num">${fmt(x.bought)} SOL</td></tr>`).join("");
  return `
  <div class="hero">
    <h1 class="headline">In the last 24 hours ${fmt(h.graduated24h)} tokens finished their bonding curve.
    <b>${fmt(h.clean24h)}</b> of them launched clean.</h1>
    <p class="lede">Most were manufactured. The creator took the supply, or a single wallet bought the whole curve and
    called it demand. That evidence exists for about thirty seconds and is unrecoverable afterwards, so we watch every
    launch on pump.fun and keep the record.</p>
    <p class="lede">Paste any mint. If we hold its launch, you get what happened. If we do not, we rebuild it from the
    chain, and if we cannot do that we say so rather than guess.</p>
    ${SEARCH}
    ${p ? `<p class="sub" style="margin:-18px 0 24px">Nothing to hand? Read <a href="t/${esc(p.mint)}.html">${esc(p.symbol ?? "?")}</a>, a launch this archive holds.</p>` : ""}
    <div style="margin:4px 0 0">
      <div class="stat"><span>graduated, last 24h</span><b class="big">${fmt(h.graduated24h)}</b></div>
      <div class="stat"><span>launched clean</span><b class="big">${fmt(h.clean24h)}</b></div>
      <div class="stat"><span>carrying a danger flag</span><b class="big">${fmt(h.danger24h)}</b></div>
      <div class="stat"><span>launches on file</span><b class="big">${fmt(h.onFile)}</b></div>
    </div>
    <p class="sub" style="margin:6px 0 0">Launch counts as of ${h.builtAt ? `${when(h.builtAt)}, ${ago(h.now - h.builtAt)}` : "an unrecorded time"}, the age of the archive this reads.
    Pool balances are read separately and continuously; each carries its own age below.</p>
  </div>

  ${p ? `<div class="sec"><h2>Why a scanner cannot tell you this</h2></div>
  <p class="lede">One launch from this archive, <a href="t/${esc(p.mint)}.html">${esc(p.symbol ?? "?")}</a>, and several hundred like it. Read left to right.</p>
  <div class="proof">
    <div class="birth">
      <h3>1 · At birth, recorded live</h3>
      <ul>
        <li>Creator took <b>${p.devPct.toFixed(1)}%</b> of supply in the first block</li>
        <li><b>Zero</b> outside wallets bought on the curve</li>
        <li>Curve completed${p.gradMs !== null ? ` in <b>${dur(p.gradMs)}</b>` : ""}, without a market</li>
      </ul>
    </div>
    <div class="now">
      <h3>2 · Then, and this is what a scanner sees</h3>
      <ul>
        <li>Pool funded to <b>${fmt(p.fundedSol)} SOL</b> of real liquidity</li>
        <li>Mint and freeze authority <b>renounced</b></li>
        <li>Supply <b>spread across wallets</b>, no large holder</li>
      </ul>
    </div>
    <div class="birth">
      <h3>3 · Now</h3>
      <ul>
        <li>Pool holds <b>${p.nowSol < 10 ? p.nowSol.toFixed(1) : fmt(p.nowSol)} SOL</b>, read ${ago(h.now - p.nowAt)}</li>
        <li>The SOL that made it look ordinary <b>has been taken back out</b></li>
        <li>Whoever bought during step 2 <b>cannot sell into this</b></li>
      </ul>
    </div>
  </div>
  <p class="verdictline">A checker run at step 2 finds nothing wrong, because at step 2 there is nothing left to find:
  the operator bought the float, then paid for the appearance of a market. A checker run at step 3 reports thin
  liquidity: correctly, and far too late to be worth anything. The launch record was true at every step, and it is
  the only thing here that could not be bought.</p>` : ""}

  <div class="sec"><h2>Launched clean, last ${h.windowDays === 1 ? "24 hours" : `${h.windowDays} days`}</h2><span class="cnt">${fmt(h.cleanRows.length)} of ${fmt(h.gradWindow)} graduations${h.unchecked ? ` · ${fmt(h.unchecked)} unchecked` : ""}</span></div>
  <p class="lede">Creator kept under ${h.maxDevPct}% and has not sold, at least ${h.minBuyers} distinct buyers on the curve,
  the curve took over a minute to fill and was not taken by a single ${h.buyoutSol}+ SOL buy, and at least ${h.minPoolSol} SOL
  in the pool on a reading no older than five minutes. That means <b>not manufactured</b>. It is not a recommendation, and most of these will still lose money.</p>
  <table class="data"><tr><th>Token</th><th class="num">Creator kept</th><th class="num">Buyers</th><th class="num">Time to fill</th><th class="num">Liquidity</th><th class="num">Read</th></tr>${rows}</table>
  <p class="callout">Launch figures are permanent; a pool balance is not. Every balance above carries the moment it was
  taken, and a token whose pool has not been read recently enough is left off rather than carried on an old number.${h.unchecked ? ` <b>${fmt(h.unchecked)}</b> passed every launch test but have no reading fresh enough to certify. Absent here means unchecked, not manufactured.` : ""}</p>

  <div class="sec"><h2>Who takes the curves</h2><span class="cnt">${fmt(h.wallets)} wallets on file</span></div>
  <p class="lede">A single large buy that completes a bonding curve is not demand, it is a purchase of the float. These
  are the wallets doing it, what they spent, and what they did with the tokens afterwards. This is the part no
  contract scanner can produce, because it needs a wallet's history across many tokens rather than one token's state.</p>
  <table class="data"><tr><th>Wallet</th><th class="num">Curves taken</th><th class="num">Spent</th><th class="num">Sold after</th><th class="num">Bought back</th></tr>${ops}</table>`;
}

/** A wallet's record: every curve it bought outright, and what it did with the tokens afterwards. */
export function walletBody(w: string, p: any, line: string | null): string {
  const heavy = p.ammSell > p.ammBuy * 3 && p.ammSell >= 20 ? "DANGER" : "CAUTION";
  const rows = p.buyouts.map((b: any) => `<tr><td>${when(b.ts)}</td><td><a href="../t/${esc(b.mint)}.html">${esc(b.symbol ?? "?")}</a></td>
    <td>${b.sol.toFixed(0)} SOL</td><td>${curveAge(b.dormantH === null ? null : b.dormantH * 3600_000)}</td></tr>`).join("");
  return `
    <h1>Priors</h1><div class="sub mono">${esc(w)}</div>
    <p class="sub">Every bonding curve this wallet has bought outright, and what it did with the tokens afterwards.</p>
    ${line ? `<div class="flag ${heavy}"><span class="tag ${heavy}">record</span>${esc(line)}</div>` : ""}
    <div style="margin:20px 0">
      <div class="stat"><span>curve buyouts</span><b class="big">${p.buyouts.length}</b></div>
      <div class="stat"><span>spent on curves</span><b class="big">${fmt(p.curveSol)}</b> SOL</div>
      <div class="stat"><span>sold on the market</span><b class="big">${fmt(p.ammSell)}</b> SOL</div>
      <div class="stat"><span>bought back</span><b class="big">${fmt(p.ammBuy)}</b> SOL</div>
    </div>
    <h2>Curves taken</h2><table class="data"><tr><th>When</th><th>Token</th><th>Size</th><th>Curve age</th></tr>${rows}</table>
    <div class="sec"><h2>Check a token</h2></div>${SEARCH}`;
}

export { MIN_POOL_SOL };
