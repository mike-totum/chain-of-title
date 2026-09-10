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
/* Prose and tables share one left edge; only the right edge differs. See the grid below. The .wrap element no
   longer lays anything out - it is kept so page() stays one string, and dissolves into the body flex column. */
.wrap{display:contents}
.shell{width:100%;max-width:1200px;margin:0 auto;padding:0 28px}
a{color:inherit}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:32px 0 10px;font-weight:600}
/* Keyboard users could see the focus ring on the search input and nowhere else. */
a:focus-visible,button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
.sub{color:var(--mut);font-size:13px;margin-bottom:24px}
td.mut{color:var(--mut)}
.strip{border:1px solid var(--line);background:var(--card);padding:12px 14px 8px;margin:20px 0 4px}
.strip svg{display:block;width:100%;height:66px}
.striphead{font-size:12.5px;color:var(--mut);margin-bottom:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.striphead b{color:var(--fg);font-size:14px}
.readout{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--fg)}
.stripfoot{display:flex;justify-content:space-between;font-size:11.5px;color:var(--mut);margin-top:2px}
.mk rect{fill:var(--fg);opacity:.55}
.mk.d rect{fill:var(--bad);opacity:.85}
.mk:hover rect,.mk:focus rect{opacity:1;fill:var(--bad)}
.strip .ax{stroke:var(--line);stroke-width:1}
.strip .tk{stroke:var(--mut);stroke-width:1;opacity:.5}
.shot{margin:14px 0;max-width:220px;border:1px solid var(--line);background:var(--card);padding:6px}
.shot img{display:block;width:100%;height:auto;image-rendering:auto}
td.thin{color:var(--bad)}
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
/* The page needs edges before restraint reads as restraint. The rule under the masthead used to sit on .mast
   itself, which stopped at the measure, so on a wide screen the content was a ribbon on an empty field with nothing
   establishing where the page was. Both bands now span the viewport and the rule spans with them. */
body{min-height:100vh;display:flex;flex-direction:column}
.band-top{background:var(--card);border-bottom:1.5px solid var(--fg)}
.band-bot{background:var(--card);border-top:1px solid var(--line);margin-top:72px}
.band-bot .note{border-top:0;margin:0;padding:30px 0 44px}
.mast{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:baseline;gap:0 12px;padding:16px 0 14px}
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
.mast .what{color:var(--mut);font-size:12.5px;grid-column:1/-1;max-width:78ch;margin-top:3px}
.hero{padding:6px 0 0}
.headline{font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  font-size:clamp(27px,4.2vw,37px);line-height:1.14;letter-spacing:-.015em;font-weight:600;margin:0 0 14px;text-wrap:balance}
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
/* Prose and data do not want the same width. Tables used to buy their extra width with equal negative margins,
   which gave them a left edge 90px outside the prose: two competing alignments on one page, which reads as a
   mistake rather than a decision. Two named tracks instead. Prose stops at a readable measure, tables and panels
   run on to the wide edge, and both start at the same place. */
main.page{flex:1;display:grid;align-content:start;column-gap:60px;padding:38px 28px 0;
  grid-template-columns:[wide-start] minmax(0,700px) [text-end] minmax(0,1fr) [wide-end]}
main.page > *{grid-column:wide-start/text-end;min-width:0}
main.page > .hero,main.page > .sec,main.page > .proof,main.page > .verdict,
main.page > .verdictline,main.page > table,main.page > .stats{grid-column:wide-start/wide-end}

/* The hero is the one block that earns two columns: the argument on the left, the figures on the right. */
.hero{display:grid;column-gap:60px;align-items:start;padding-top:2px;
  grid-template-columns:minmax(0,700px) minmax(0,1fr)}
.hero .col-a,.hero .col-b{min-width:0}
/* A ledger, not a 2x2. The labels ("graduated, 24h to 2026-09-08 20:50 UTC") are long enough that a grid wraps them
   unevenly and the figures stop sharing a baseline. */
.hero .stats{margin:6px 0 0;border:1px solid var(--line);background:var(--card);padding:4px 22px}
.hero .stat{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0;
  padding:13px 0;border-bottom:1px solid var(--line)}
.hero .stat:last-child{border-bottom:0}
.hero .stat span{display:block;margin:0;flex:1;min-width:0;line-height:1.4}
.hero .big{font-size:24px;font-variant-numeric:tabular-nums}
.hero .col-b .sub{margin:12px 0 0;font-size:12.5px;line-height:1.5}

@media(max-width:1000px){
  /* One column, but the line NAMES have to survive: dropping them sent every table and panel into an implicit
     second column and the whole page scrolled sideways. */
  main.page{grid-template-columns:[wide-start] minmax(0,1fr) [text-end wide-end];padding:32px 24px 0}
  .hero{grid-template-columns:[wide-start] minmax(0,1fr) [wide-end]}
  .hero .col-b{margin-top:26px}
  .mast{grid-template-columns:auto minmax(0,1fr)}
  .shell{padding:0 24px}
}
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
.headline b.q{border-bottom:0}
/* What the launch said it was, next to the picture it published. The image is deliberately small and unstyled:
   it is evidence on a record page, not decoration, and it must not read as this site endorsing the thing. */
.claim{display:flex;gap:20px;align-items:flex-start;margin:10px 0 0}
.claim table{flex:1;min-width:0}
.claim .shot{flex:none;display:block;border:1px solid var(--line);background:var(--card);padding:5px;line-height:0}
.claim .shot img{width:132px;height:132px;object-fit:contain;display:block}
.claim .sub{display:block;margin:3px 0 0}
@media(max-width:620px){.claim{flex-direction:column}}
/* The published schema. The kind pill is the column that matters: it says whether a reader could reproduce the
   value themselves. "live" is the irreplaceable half of this archive, so it reads as emphasis rather than as a
   warning; "opaque" is a defect we are admitting to, so it reads as one. */
td.mut,.mut{color:var(--mut)}
/* .mono breaks anywhere, which is right for a 44-character mint and wrong for a column name: the schema table was
   rendering "late_discove / ry". Identifiers wrap at the underscore or not at all. */
.data td.mono.id{word-break:normal;overflow-wrap:anywhere}
.kind{display:inline-block;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;
  padding:2px 7px;border:1px solid currentColor;white-space:nowrap}
.k-live{color:var(--fg)}
.k-chain{color:var(--ok)}
.k-reading{color:var(--warn)}
.k-ours{color:var(--mut)}
.k-opaque{color:var(--bad)}
/* A sample of the actual output. A visitor who has never seen a record cannot tell what pasting a mint will get
   them, and a description of a verdict is not a verdict. */
.sample{display:block;margin:22px 0 0;padding:16px 18px;border:1px solid var(--line);background:var(--card);
  text-decoration:none;border-left:3px solid var(--mut)}
.sample:hover{border-color:var(--fg);border-left-color:var(--fg)}
.sample .slab{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--mut);font-weight:700}
.sample .sv{display:block;margin:7px 0 4px;font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  font-size:21px;font-weight:600;line-height:1.15}
.sample .sv.DANGER{color:var(--bad)}.sample .sv.OK{color:var(--ok)}
.sample .sv.CAUTION{color:var(--warn)}.sample .sv.UNKNOWN{color:var(--mut)}
.sample .swhy{display:block;color:var(--mut);font-size:13.5px;line-height:1.5}
.sample .scta{display:block;margin-top:9px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.sample:hover .scta{color:var(--fg)}
/* Scope, next to the claim it qualifies rather than in the footer. */
.vscope{margin:9px 0 20px;color:var(--mut);font-size:13px;line-height:1.55;max-width:70ch}
/* A wallet page is identified by its address, so the address is the heading rather than a word about it. */
.addr-h1{font-size:16px;font-weight:600;word-break:break-all;margin:0 0 2px}
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
<header class="band-top"><div class="shell"><div class="mast"><a class="brand serif" href="${root}index.html">${MARK}<span>${BRAND}</span></a><span class="tag2">Solana launch records</span><span class="what">In property law, the chain of title is the unbroken documented history of ownership from origin: what you establish before you believe a claim about what something is.</span></div></div></header>
<main class="page shell">
${body}
</main>
<footer class="band-bot"><div class="shell"><div class="note"><a href="${root}method.html">How this is decided</a> · <a href="${root}corrections.html">Tell us we are wrong</a> · <a href="${root}data.html">Take the data</a> · <a href="${root}api.html">API</a> · <a href="${root}pledge.html">Pledge</a> · <a href="${root}index.html">${BRAND}</a><br>
The documented history of a token from its first block. Coverage begins ${c.coverageFrom}${c.gapMin >= 1 ? `, with ${fmt(c.gapMin)} min of recorded downtime` : ", no recorded downtime"}.
Everything here is read from the Solana chain. Where we recorded a launch's creation transaction, its page cites it and you can check every figure yourself; where we did not, the page says so. A clean record means a launch was <b>not manufactured</b>. It is not a prediction and not advice.
Most tokens lose money regardless: of 19,412 bonding-curve positions measured, none reached 5x.
<div class="who">Kept by <b>${esc(KEEPER)}</b> · <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>${SOURCE_URL ? ` · <a href="${esc(SOURCE_URL)}">Source</a>` : ""}<br>
Free to use, with no account and no wallet connection. The archive is public domain (<a href="${root}data.html">CC0</a>) and
downloadable in full, so nothing here depends on trusting us to keep publishing it. Funded by grants and by the
services that read it, never by the projects it reports on, and never by sending you into a trade.</div></div></div></footer>
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
/**
 * A transaction, as a link a reader can actually follow.
 *
 * The record page has always ended every claim at our own assertion: it said the creator took 79.3% of supply and
 * offered nothing to check that against, under a footer promising the figures "can be checked against it". A
 * signature with an explorer link is what closes that gap, and it is the cheapest credibility this project can buy.
 */
const txLink = (sig: string) =>
  `<a class="mono" href="https://solscan.io/tx/${esc(sig)}" rel="noopener">${esc(sig.slice(0, 22))}…</a>`;

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
  // The "not a prediction" half of this moved to `.vscope`, which every verdict now carries.
  /**
   * A claim about the first blocks, and it says so. It is no longer conditioned on present liquidity — that is a
   * different question with a different shelf life — but a thin pool right now is still a warning a reader needs,
   * and a green all-clear printed above "a position cannot be sold" would be true in the letter and false in the
   * effect. So a clean launch whose pool is currently thin keeps the finding and loses the green: one line, both
   * facts, neither one deleting the other.
   */
  const thinNow = a.flags.some((f) => f.kind === "liquidity" && f.level === "DANGER");
  if (clean && thinNow) return { level: "CAUTION", label: "Launched clean, thin pool now",
    why: "The launch record shows no sign of manufacture — that part is settled and does not change. But the pool was nearly empty when we last read it, so whatever this was at birth, you may not be able to sell it now." };
  if (clean) return { level: "OK", label: "Launched clean",
    why: "The launch record shows no sign of manufacture. That is a fact about how this token was created, not about what it is worth or whether you could sell it now." };
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
/**
 * What else this launch is a copy of.
 *
 * Two facts the record has always been able to answer and never did, both computed by the caller because they are
 * index lookups against the whole archive rather than anything about this row: how many other launches used this
 * exact picture, and what else this creator has launched.
 *
 * They matter more than any single figure on the page. 57% of the launches whose picture we hold use a picture
 * another launch also used — one image is shared by 194 launches all called STONKPUMP — and 81% of all launches come
 * from a wallet that has launched more than one, the busiest having launched 1,994. A reader looking at creator
 * share and buyer counts is being asked to judge a token. A reader told this is the 194th launch of the same picture
 * is being told what it is.
 */
export interface Priors {
  /** other launches using the identical image bytes, by sha256. null when we hold no picture for this launch. */
  sameImage: number | null;
  imageSha: string | null;
  /** other launches by this creator, and how many of those carry a danger flag */
  byCreator: number;
  creatorFlagged: number;
}

export function tokenBody(
  t: any, a: Assessment, r: Reading | null, origin: "observed" | "rebuilt", clean: boolean, now: number,
  priors?: Priors,
): string {
  const rows = a.watched ? `
    <tr><td class="k">Created</td><td>${when(t.created_at)}</td></tr>
    <tr><td class="k">Creator</td><td class="mono">${t.creator
      ? `<a href="../w/${esc(t.creator)}.html">${esc(t.creator)}</a>` : "unknown"}</td></tr>
    <tr><td class="k">Creator took</td><td><b>${t.dev_pct?.toFixed(1) ?? "?"}%</b> of supply in the first block</td></tr>
    <tr><td class="k">Outside buyers</td><td><b>${a.curveBuyers === null ? "unknown" : fmt(a.curveBuyers)}</b> distinct wallets, not counting the creator, bought on the bonding curve before it graduated${origin === "observed" ? `: ${fmt(t.snap30_buyers ?? 0)} within the first 30s, ${fmt(t.bundled_buyers ?? 0)} bundled into the creation block.` : "."}</td></tr>
    <tr><td class="k">Graduated</td><td>${t.graduated_at ? `${curveAge(t.graduated_at - t.created_at)} after launch` : "yes"}</td></tr>
    <tr><td class="k">Creator sold</td><td>${t.dev_sold ? "yes" : origin === "observed" ? "not while we watched" : "no"}</td></tr>
    ${/*
        The transaction every figure above was decoded from. Absence is stated as ours, not the launch's: a launch
        that predates this column, or whose trade rows retention took before the backfill reached them, has no
        signature on file and that is a gap in our record rather than anything about the token.
      */ ""}
    <tr><td class="k">Recorded from</td><td>${t.create_sig
      ? `${txLink(t.create_sig)}${t.create_slot ? ` <span class="sub">slot ${fmt(t.create_slot)}</span>` : ""}
         <div class="sub">The transaction this record was decoded from. Every figure above is in it — fetch it and check us.</div>`
      : `<span class="sub">Not recorded. This launch predates our keeping the creation transaction, or its trade rows were pruned before we backfilled it. The figures above stand on our contemporaneous observation alone, which is weaker, and we would rather say so.</span>`}</td></tr>`
    : `<tr><td class="k">Launch</td><td>Not observed. ${t.late_discovery ? "Found only after it was already trading." : "The collector was down when it launched."}</td></tr>`;

  const selfBought = !!a.buyout && !!t.creator && a.buyout.wallet === t.creator;
  const boBlock = a.buyout ? `<h2>Who took the curve</h2>
    <p class="mono"><a href="../w/${esc(a.buyout.wallet)}.html">${esc(a.buyout.wallet)}</a>${selfBought
      ? ` <b class="serif">— the creator's own wallet</b>` : ""}</p>
    <p>Bought <b>${a.buyout.sol.toFixed(0)} SOL</b> of this curve in a single transaction${t.created_at ? `, ${curveAge(a.buyout.ts - t.created_at)}` : ""}.${
      a.buyout.sig ? ` ${txLink(a.buyout.sig)}` : ""}</p>
    ${a.buyout.sig && t.create_sig === a.buyout.sig ? `<p class="sub">That is the same transaction the token was created in: the launch and the purchase of its float are one signature.</p>` : ""}
    ${t.created_at && a.buyout.ts - t.created_at <= 0 ? `<p class="sub">Our launch and trade timestamps are both taken when the events are decoded, so events that arrived together carry the same one. That it was taken at or near launch is on the record; how many seconds after is not.</p>` : ""}` : "";

  /**
   * The pool, always stated separately from the verdict above and always carrying the age of the reading.
   *
   * The third branch is new and is the point of the split: a launch can be clean and its pool unread, and the page
   * has to be able to say both things at once without one silently cancelling the other.
   */
  const nowBlock = r ? `<h2>Pool</h2><table>
    <tr><td class="k">Liquidity</td><td>${r.sol.toFixed(1)} SOL</td></tr>
    <tr><td class="k">Read from chain</td><td>${when(r.at)}, ${ago(now - r.at)}${r.fresh ? "" : ". Pool balances move; treat an old reading as an old reading."}</td></tr></table>`
    : t.vault_sol != null ? `<h2>Pool</h2><p class="sub">A balance of ${t.vault_sol.toFixed(1)} SOL is on file but we cannot say when it was read, so it is not quoted here.</p>`
    : a.watched ? `<h2>Pool</h2><p class="sub">We have no pool balance for this token that we can date, so none is quoted. That is a gap in our reading coverage and says nothing about the launch record above, which does not depend on it.</p>` : "";

  // How the record was obtained is part of the record. A rebuild is the same transactions, read later — but it cannot
  // include what the token claimed to be at launch, because that lives off-chain and the operator can change it.
  /**
   * Stated as counts with a route to the evidence, never as a conclusion. "Used by 193 other launches" is a fact
   * about our archive; "this is a scam factory" is a claim about people, and the second is not ours to make on the
   * strength of the first. The reader who follows the link sees the launches and decides.
   */
  const priorsBlock = !priors ? "" : (() => {
    const bits: string[] = [];
    if (priors.sameImage !== null && priors.sameImage > 0 && priors.imageSha)
      bits.push(`<tr><td class="k">This picture</td><td><b>Used by ${fmt(priors.sameImage)} other launch${priors.sameImage === 1 ? "" : "es"}.</b>
        Identical bytes, matched by sha256 — not a similar image, the same one.
        <a href="../i/${esc(priors.imageSha)}.html">See them all &rarr;</a></td></tr>`);
    else if (priors.sameImage === 0)
      bits.push(`<tr><td class="k">This picture</td><td>No other launch we hold a picture for used this one.</td></tr>`);
    if (priors.byCreator > 0)
      bits.push(`<tr><td class="k">This creator</td><td><b>Has launched ${fmt(priors.byCreator + 1)} tokens${
        priors.creatorFlagged > 0 ? `, ${fmt(priors.creatorFlagged)} of them carrying a danger flag` : ""}.</b>
        <a href="../c/${esc(t.creator)}.html">See the others &rarr;</a></td></tr>`);
    return bits.length ? `<h2>Seen before</h2><table>${bits.join("")}</table>` : "";
  })();

  const provenance = origin === "rebuilt" ? `<div class="flag UNKNOWN"><span class="tag UNKNOWN">rebuilt</span>
    We did not watch this launch. Its record was reconstructed from the bonding curve's complete transaction history,
    so the figures below are the same on-chain events, read later. What it cannot tell you is what the token
    <i>claimed</i> to be at launch: the name, image and links live off-chain and can be changed since.</div>` : "";

  /**
   * What the launch said it was.
   *
   * The token above is called "Cobie" — a real person — and until now this page could report that the creator took
   * 79% of supply while never showing the claim that makes the launch worth reporting. The name, the description
   * and the picture are the impersonation; the on-chain figures are only how it was funded.
   *
   * The picture is served from the bytes we captured at launch, addressed by their own sha256, NEVER hot-linked
   * from the URI. The URI is the creator's to repoint, so rendering it live would put whatever they serve today
   * onto a page that says "what this launch claimed at birth" — this site's own besetting error, committed on the
   * page that exists to point it out. If we did not capture the bytes we say so and show nothing.
   */
  const claimed = (t.name || t.description || t.image_sha256 || t.uri) ? `
    <div class="sec"><h2>What this launch claimed to be</h2></div>
    <div class="claim">
      ${t.image_sha256 ? `<a class="shot" href="../i/${esc(t.image_sha256)}"><img src="../i/${esc(t.image_sha256)}"
        alt="The picture this launch published at birth" loading="lazy" width="132" height="132"></a>` : ""}
      <table>
        ${t.name ? `<tr><td class="k">Name</td><td>${esc(t.name)}</td></tr>` : ""}
        ${t.description ? `<tr><td class="k">Description</td><td>${esc(t.description)}</td></tr>` : ""}
        ${t.meta_sha256 ? `<tr><td class="k">Metadata held</td><td><span class="mono">sha256 ${esc(t.meta_sha256)}</span>${
          t.meta_bytes ? ` · ${fmt(t.meta_bytes)} bytes` : ""}<br><span class="sub">The document is kept but not
          published; this hash lets anyone who obtains it prove it is the one we read.</span></td></tr>` : ""}
        ${t.image_sha256
          ? `<tr><td class="k">Picture held</td><td><span class="mono">sha256 ${esc(t.image_sha256)}</span>${
              t.image_bytes ? ` · ${fmt(t.image_bytes)} bytes` : ""}</td></tr>`
          : `<tr><td class="k">Picture</td><td>Not captured${t.image ? ", so we cannot show what it published" : " — this launch declared none"}. ${
              t.image ? "That is our storage budget, not a finding about the launch." : ""}</td></tr>`}
      </table>
    </div>
    <p class="callout">Off-chain and mutable. This is what the launch served when we read it${t.meta_at
      ? ` at ${when(t.meta_at)}` : ""}; the creator can change or unpin any of it at any time, and a launch record is
    the only place it survives.</p>` : "";

  const v = verdict(t, a, clean);
  return `
    <h1>${esc(t.symbol ?? "unknown")}</h1>
    <div class="verdict"><span class="v ${v.level}">${esc(v.label)}</span><span class="vwhy">${esc(v.why)}</span></div>
    ${/*
        This sentence does the liability work, and it used to sit in the footer, roughly 1,300px below the verdict it
        qualifies, on a page whose entire job is to deliver one verdict. Scope belongs with the claim.
      */ ""}
    ${/*
        Conditional, because the page knows the answer and a blanket promise is false on the launches that most need
        the reader's scepticism. 24,494 launches carry no creation transaction — their trade rows were pruned before
        we began keeping it — and telling their readers the figures are checkable, on a page that offers nothing to
        check them with, is the same overclaim this project exists to report in other people.
      */ ""}
    <p class="vscope">A record of what this launch was at birth, read from the Solana chain. ${t.create_sig
      ? `The transaction it was decoded from is cited below: every figure here can be checked against the chain without trusting us.`
      : `We did not record its creation transaction, so these figures rest on our observation at the time rather than on a citation you can follow.`}
    Not a prediction and not advice: most tokens lose money regardless.</p>
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
    <h2>At launch</h2><table>${rows}</table>${priorsBlock}${boBlock}${nowBlock}${claimed}
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
/**
 * `poolSol` and `readAt` are null when there is no reading fresh enough to quote. That is not a fact about the
 * token — it is a fact about our pool coverage — so the row still appears and says which it is.
 */
export interface CleanRow { mint: string; symbol: string | null; devPct: number; buyers: number; fillMs: number | null; poolSol: number | null; readAt: number | null; liquid: boolean }
export interface OpRow { wallet: string; taken: number; spent: number; sold: number; bought: number }
export interface Home {
  now: number; builtAt: number | null;
  /** end of the 24h window: the archive's own build time, not the request clock. See `inDay` in serve.ts. */
  windowEnd?: number | null;
  graduated24h: number;
  /** launches in the window whose birth record shows no sign of manufacture. Permanent; this is the archive's claim. */
  cleanBirth24h: number;
  /** the subset of those we have also just read a healthy pool for. Perishable; this is a courtesy, not the finding. */
  clean24h: number;
  danger24h: number; onFile: number;
  windowDays: number; gradWindow: number; cleanBirthWindow: number; unchecked: number; unread: number; unchecked24h: number;
  cleanRows: CleanRow[]; wallets: number; opRows: OpRow[];
  proof: null | { mint: string; symbol: string | null; devPct: number; gradMs: number | null;
    nowSol: number; nowAt: number; verdict: Verdict };
  maxDevPct: number; minBuyers: number; buyoutSol: number; minPoolSol: number; maxReadingAgeMs: number;
}

/**
 * Both base rates, the actionable one first. This used to say "8 of 1,539 launched clean" - 0.5%, and 0.16% over the
 * seven-day window. A tool that reports almost nothing as clean teaches a reader that its clean bar is broken rather
 * than that the market is, because from outside the two are indistinguishable. The danger rate is the same evidence
 * stated at a threshold a reader can act on, and the clean count still follows it.
 */
export function homeTitle(h: Home): string {
  return `${fmt(h.danger24h)} of ${fmt(h.graduated24h)} launches carry a danger flag`;
}

export function homeBody(h: Home): string {
  const p = h.proof;
  const rows = h.cleanRows.map((r) => `<tr>
    <td><a href="t/${esc(r.mint)}.html">${esc(r.symbol ?? "?")}</a></td><td class="num">${r.devPct.toFixed(1)}%</td>
    <td class="num">${fmt(r.buyers)}</td><td class="num">${r.fillMs === null ? "?" : dur(r.fillMs)}</td>
    ${r.poolSol !== null && r.readAt !== null
      ? `<td class="num${r.liquid ? "" : " thin"}">${r.poolSol.toFixed(0)} SOL</td><td class="num">${ago(h.now - r.readAt)}</td>`
      : `<td class="num mut">not read</td><td class="num mut">&mdash;</td>`}</tr>`).join("");
  const ops = h.opRows.map((x) => `<tr><td class="mono"><a href="w/${esc(x.wallet)}.html">${esc(x.wallet.slice(0, 12))}…</a></td>
    <td class="num">${x.taken}</td><td class="num">${fmt(x.spent)} SOL</td>
    <td class="num">${fmt(x.sold)} SOL</td><td class="num">${fmt(x.bought)} SOL</td></tr>`).join("");
  return `
  <div class="hero">
    <div class="col-a">
    <h1 class="headline">${h.windowEnd && h.now - h.windowEnd > 3600_000 ? `In the 24 hours to ${when(h.windowEnd)}` : "In the last 24 hours"} ${fmt(h.graduated24h)} tokens finished their bonding curve.
    <b>${fmt(h.danger24h)}</b> carry a danger flag. ${h.cleanBirth24h === 0 ? `<b class="q">None</b> launched clean.` : `Only <b class="q">${fmt(h.cleanBirth24h)}</b> launched clean.`}</h1>
    <p class="lede">Most were manufactured. The creator took the supply, or a single wallet bought the whole curve and
    called it demand. That evidence exists for about thirty seconds and is unrecoverable afterwards, so we watch every
    launch on pump.fun and keep the record.</p>
    <p class="lede">Paste any mint. If we hold its launch, you get what happened. If we do not, we rebuild it from the
    chain, and if we cannot do that we say so rather than guess.</p>
    ${SEARCH}
    ${/*
        A visitor who has never seen a record has no idea what pasting a mint gets them, and the page used to
        describe the output at length without once showing it. This is a real verdict on a real launch, rendered by
        the same `verdict()` the record page calls, so it cannot promise something a record does not deliver.
      */ ""}
    ${p ? `<a class="sample" href="t/${esc(p.mint)}.html">
      <span class="slab">What a record says</span>
      <span class="sv ${p.verdict.level}">${esc(p.verdict.label)}</span>
      <span class="swhy">${esc(p.verdict.why)}</span>
      <span class="scta">${esc(p.symbol ?? "?")} · read the record &rarr;</span>
    </a>` : ""}
    </div>
    <div class="col-b">
    <div class="stats" style="margin:4px 0 0">
      <div class="stat"><span>graduated, 24h to ${h.windowEnd ? when(h.windowEnd) : "now"}</span><b class="big">${fmt(h.graduated24h)}</b></div>
      <div class="stat"><span>launched clean</span><b class="big">${fmt(h.cleanBirth24h)}</b></div>
      <div class="stat"><span>carrying a danger flag</span><b class="big">${fmt(h.danger24h)}</b></div>
      <div class="stat"><span>launches recorded</span><b class="big" id="rec" data-n="${h.onFile}">${fmt(h.onFile)}</b></div>
    </div>
    <p class="sub" style="margin:6px 0 0"><span id="recnote">Launch counts as of ${h.builtAt ? `${when(h.builtAt)}, ${ago(h.now - h.builtAt)}` : "an unrecorded time"}, the age of the archive this reads.</span>
    Pool balances are read separately and continuously; each carries its own age below.</p>
    <!--
      The counter climbs because the collector never stops, and this is the one number on the page that is a claim
      about the archive rather than about the published file. It was read out of the snapshot, so it sat frozen for
      six hours at a time and understated the record by thousands by the end of each cycle.

      It only ever displays values the collector actually reported. The animation interpolates between two real
      readings and stops on the second; it never extrapolates forward from a rate, because a number that invents
      launches it has not seen is precisely the thing this site exists to catch other people doing. If the collector
      is unreachable or its answer is stale the figure stays exactly as rendered, still labelled with the archive's
      age, and nothing pretends to be live.
    -->
    <script>(function(){
      var el=document.getElementById('rec'),note=document.getElementById('recnote');
      if(!el||!window.fetch)return;
      var shown=+el.getAttribute('data-n')||0,anim=null;
      function paint(n){el.textContent=n.toLocaleString()}
      function to(target){
        if(target===shown)return; if(anim)cancelAnimationFrame(anim);
        var from=shown,d=target-from,t0=null,ms=Math.min(1200,Math.max(300,Math.abs(d)*12));
        function step(t){ if(t0===null)t0=t; var k=Math.min(1,(t-t0)/ms);
          paint(Math.round(from+d*(1-Math.pow(1-k,3))));
          if(k<1){anim=requestAnimationFrame(step)}else{shown=target;paint(target)} }
        anim=requestAnimationFrame(step);
      }
      function tick(){
        fetch('/api/v1/live',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
          if(typeof d.observed!=='number')return;           // collector unreachable or stale: leave the rendered figure
          if(d.observed<shown)return;                        // an archive never shrinks; refuse a lower number rather than animate down
          to(d.observed);
          if(note)note.textContent='Recorded live by the collector. The published file holds '+(d.published||0).toLocaleString()+', rebuilt periodically.';
        }).catch(function(){});
      }
      tick(); setInterval(tick,10000);
      document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()});
    })()</script>
    </div>
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
      <h3>2 · Then, what a checker reports</h3>
      <ul>
        <li>Mint and freeze authority <b>renounced</b> — pump.fun does that to every token it creates</li>
        <li>The creator's ${p.devPct.toFixed(1)}% <b>no longer visible</b>, the float spread across wallets</li>
        <li>A pool, a price and a chart, and <b>every one of them real</b></li>
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
  <p class="verdictline">Steps 1 and 3 are readings we took and kept, each with the moment it was taken. Step 2 is
  what a present-tense check reports, not a measurement of ours — and it finds nothing wrong, because by then there
  is nothing left to find: the operator bought the float, then paid for the appearance of a market. A check run at
  step 3 reports thin liquidity, correctly, and far too late to be worth anything. The launch record was true at
  every step, and it is the only thing here that could not be bought.</p>` : ""}

  <div class="sec"><h2>Who takes the curves</h2><span class="cnt">${fmt(h.wallets)} wallets on file</span></div>
  <p class="lede">A single large buy that completes a bonding curve is not demand, it is a purchase of the float. These
  are the wallets doing it, what they spent, and what they did with the tokens afterwards. This is the part no
  contract scanner can produce, because it needs a wallet's history across many tokens rather than one token's state.</p>
  <table class="data"><tr><th>Wallet</th><th class="num">Curves taken</th><th class="num">Spent</th><th class="num">Sold after</th><th class="num">Bought back</th></tr>${ops}</table>

  <div class="sec"><h2>Launched clean, last ${h.windowDays === 1 ? "24 hours" : `${h.windowDays} days`}</h2><span class="cnt">${fmt(h.cleanBirthWindow)} of ${fmt(h.gradWindow)} graduations${h.cleanRows.length < h.cleanBirthWindow ? ` · newest ${fmt(h.cleanRows.length)} shown` : ""}</span></div>
  <p class="lede">Creator kept under ${h.maxDevPct}% and has not sold, at least ${h.minBuyers} distinct buyers on the curve,
  and the curve took over a minute to fill and was not taken by a single ${h.buyoutSol}+ SOL buy. That means
  <b>not manufactured</b>. It is a statement about the launch, not about the price: it is not a recommendation, and
  most of these will still lose money.</p>
  ${h.cleanRows.length ? `<table class="data"><tr><th>Token</th><th class="num">Creator kept</th><th class="num">Buyers</th><th class="num">Time to fill</th><th class="num">Liquidity</th><th class="num">Read</th></tr>${rows}</table>`
    : `<p class="callout">No launch in this window passed every test on the launch record. That is a finding about the
    window, not about any particular token.</p>`}
  ${/*
      These were one claim until 2026-09-09 and should not have been. A launch record is permanent and is the thing
      this archive holds that nobody can reconstruct; a pool balance decays by the minute and anyone with an RPC key
      can read it. Requiring both to call a launch clean meant an hour of RPC trouble deleted findings about the
      past: 423 launches passed every birth test over seven days and ten were published. The liquidity column is now
      reported beside the claim rather than gating it, and "not read" says so in the row instead of removing it.
    */ ""}
  <p class="callout">Two different claims, kept apart. <b>Launched clean</b> is a fact about the first blocks and does
  not expire. <b>Liquidity</b> is one balance read at one moment, shown with its age. ${h.unread
    ? `<b>${fmt(h.unread)}</b> of these have no reading under ${Math.round(h.maxReadingAgeMs / 60000)} minutes old and say <i>not read</i> — a gap in our pool coverage, never a finding about the token. `
    : `Every row here carries a reading under ${Math.round(h.maxReadingAgeMs / 60000)} minutes old. `}A balance shown in red is one we did read, and it is under ${h.minPoolSol} SOL. We never quote a balance we could not confirm.</p>`;
}

/** A wallet's record: every curve it bought outright, and what it did with the tokens afterwards. */
/**
 * A wallet's record: every curve it bought outright, and what it did with the tokens afterwards.
 *
 * It used to open with the word "Priors" on every wallet page — a term most readers will not decode, saying nothing
 * about whose priors — and then render its verdict as one flag box among the furniture. A reader arrives here from a
 * token page having just read that this wallet bought the whole curve, and the question in their head is who this is
 * and whether they do it often. So: the address is the heading, the verdict is the verdict, and the size of the
 * evidence behind it is stated rather than left for the reader to infer from the length of a table.
 */
export function walletBody(w: string, p: any, v: { label: string; why: string } | null, from?: { mint: string; symbol: string | null }): string {
  const heavy = p.ammSell > p.ammBuy * 3 && p.ammSell >= 20 ? "DANGER" : "CAUTION";
  const rows = p.buyouts.map((b: any) => `<tr><td>${when(b.ts)}</td><td><a href="../t/${esc(b.mint)}.html">${esc(b.symbol ?? "?")}</a></td>
    <td class="num">${b.sol.toFixed(0)} SOL</td><td>${curveAge(b.dormantH === null ? null : b.dormantH * 3600_000)}</td></tr>`).join("");
  const n = p.buyouts.length;

  /**
   * How much evidence the sentence above rests on. One buyout and thirty produced identical prose, so a single
   * event read with the same confidence as a habit — the reader could only tell them apart by counting the rows.
   */
  const basis = n === 0 ? "" : n === 1
    ? `Based on <b>one</b> curve. A record of one event is not yet a pattern.`
    : `Based on <b>${fmt(n)}</b> curves taken${p.ammSell > 0 ? " and the market trades on those same tokens" : ""}.`;

  /**
   * The cluster. This is the part no contract scanner can produce, and it was computed, published in the record and
   * then never shown: 7,628 of the 10,243 wallets on file carry a funder. Where we do not hold one the section is
   * absent rather than hedged, on the same rule as every other silence here.
   */
  const cluster = p.cluster && p.clusterWallets > 1 ? `
    <div class="sec"><h2>Operator cluster</h2><span class="cnt">${esc(p.cluster)}</span></div>
    <table>
      ${p.funder ? `<tr><td class="k">Funded by</td><td class="mono">${esc(p.funder)}</td></tr>` : ""}
      <tr><td class="k">Group</td><td>One of <b>${fmt(p.clusterWallets)}</b> wallets seeded from that funder, which
        together took <b>${fmt(p.clusterCurves)}</b> bonding curve${p.clusterCurves === 1 ? "" : "s"}.</td></tr>
      ${p.policy ? `<tr><td class="k">Cluster behaviour</td><td>${esc(p.policy)}</td></tr>` : ""}
    </table>
    <p class="callout">A shared funder is a lead, not a finding. Trading terminals fund their users from one address
    the same way a wallet farm funds its own, and we cannot tell those apart from the chain alone.</p>` : "";

  return `
    <h1 class="mono addr-h1">${esc(w)}</h1>
    ${v ? `<div class="verdict"><span class="v ${heavy}">${esc(v.label)}</span>
      <span class="vwhy">${esc(v.why)}</span></div>
      <p class="vscope">${basis} Every figure below is the wallet's own on-chain activity, and can be recomputed from
      the published archive. Not a claim about who controls this address.</p>`
      : `<p class="sub">Every bonding curve this wallet has bought outright, and what it did with the tokens afterwards.</p>`}
    ${from ? `<p class="sub">You arrived from <a href="../t/${esc(from.mint)}.html">${esc(from.symbol ?? "that launch")}</a>.</p>` : ""}
    <div class="stats" style="margin:20px 0">
      <div class="stat"><span>curve buyouts</span><b class="big">${fmt(n)}</b></div>
      <div class="stat"><span>spent on curves</span><b class="big">${fmt(p.curveSol)}</b> SOL</div>
      <div class="stat"><span>sold on the market</span><b class="big">${fmt(p.ammSell)}</b> SOL</div>
      <div class="stat"><span>bought back</span><b class="big">${fmt(p.ammBuy)}</b> SOL</div>
    </div>
    <p class="callout">Sold and bought back cover the curves this wallet took, not everything it has ever traded, and
    the trades behind them are in the published archive so the figures can be checked rather than believed.</p>
    ${cluster}
    <div class="sec"><h2>Curves taken</h2><span class="cnt">${fmt(n)} on file</span></div>
    <table class="data"><tr><th>When</th><th>Token</th><th class="num">Size</th><th>Curve age</th></tr>${rows}</table>
    <div class="sec"><h2>Check a token</h2></div>${SEARCH}`;
}

export { MIN_POOL_SOL };

/** One row in a list of launches that share something — a picture, or a creator. */
/** Aggregates over the entire matching set, not over the page of rows shown. */
export interface SiblingStats { total: number; flagged: number; grad: number; span: number }

export interface SiblingRow {
  mint: string; symbol: string | null; name: string | null; createdAt: number;
  devPct: number | null; curveBuyers: number | null; graduated: boolean; danger: boolean;
}

/**
 * Every launch that used one picture, or came from one creator, oldest first.
 *
 * This is the view the archive was always able to produce and never showed. A single token page can tell you the
 * creator took 79% of supply; only this can tell you they have done it 1,994 times, or that the identical image has
 * been launched 194 times under the same ticker. Serial reuse is not visible in any one launch, which is precisely
 * why a scanner reading present state cannot see it at all.
 *
 * Oldest first on purpose: the interesting shape is the cadence — a burst of launches minutes apart, or a picture
 * that returns every few days — and that reads forwards, not backwards.
 */
export function siblingsBody(
  kind: "image" | "creator", key: string, rows: SiblingRow[], stats: SiblingStats, now: number, shownCap: number,
  strip = "",
): string {
  /**
   * Every headline figure is computed over the WHOLE set, never over the rows that happen to be displayed.
   *
   * The first version took the span from the listed rows while the heading counted all of them, so a wallet with
   * 1,994 launches was described as spanning 3.2 hours — the span of the oldest 300. Two numbers side by side drawn
   * from different populations, which is the fault this project spent the day removing from its own front page.
   */
  const { total, flagged, grad, span } = stats;
  const title = kind === "image"
    ? `${fmt(total)} launches used this picture`
    : `${fmt(total)} launches by this wallet`;
  const lede = kind === "image"
    ? `Identical bytes, matched by sha256 — the same file, not a similar one. We keep the picture because the creator
       controls the URI it came from and can repoint or unpin it at any time; once that happens this is the only
       place the launch's own image survives.`
    : `Every launch we hold from this creator wallet. A creator address is on-chain and permanent, so this list is as
       complete as our coverage of the days it launched on.`;

  const body = rows.map((r) => `<tr>
    <td><a href="../t/${esc(r.mint)}.html">${esc(r.symbol ?? "?")}</a>${
      r.name && r.name !== r.symbol ? `<br><span class="sub">${esc(String(r.name).slice(0, 40))}</span>` : ""}</td>
    <td class="num">${when(r.createdAt)}</td>
    <td class="num">${r.devPct === null ? "?" : `${r.devPct.toFixed(1)}%`}</td>
    <td class="num">${r.curveBuyers === null ? "?" : fmt(r.curveBuyers)}</td>
    <td class="num">${r.graduated ? "yes" : "no"}</td>
    <td>${r.danger ? `<span class="tag DANGER">danger</span>` : ""}</td></tr>`).join("");

  return `
  <div class="hero"><div class="col-a">
    <h1 class="headline">${title}</h1>
    <p class="lede">${lede}</p>
    ${strip}
    ${kind === "image" ? `<div class="shot"><img src="../i/${esc(key)}" alt="the picture these launches used" loading="lazy"></div>` : ""}
    <p class="mono sub">${esc(key)}</p>
  </div>
  <div class="col-b"><div class="stats" style="margin:4px 0 0">
    <div class="stat"><span>launches</span><b class="big">${fmt(total)}</b></div>
    <div class="stat"><span>carrying a danger flag</span><b class="big">${fmt(flagged)}</b></div>
    <div class="stat"><span>finished the curve</span><b class="big">${fmt(grad)}</b></div>
    ${span > 0 ? `<div class="stat"><span>across</span><b class="big">${dur(span)}</b></div>` : ""}
  </div>
  <p class="sub" style="margin:6px 0 0">Counts are over the launches this archive holds. Flags are the same
  criteria every record page applies.</p></div></div>

  <div class="sec"><h2>${kind === "image" ? "Launches using this picture" : "Launches by this wallet"}</h2>
    <span class="cnt">${rows.length < total ? `oldest ${fmt(rows.length)} of ${fmt(total)}` : `${fmt(rows.length)}`}</span></div>
  ${rows.length ? `<table class="data"><tr><th>Token</th><th class="num">Launched</th><th class="num">Creator kept</th>
    <th class="num">Buyers</th><th class="num">Graduated</th><th></th></tr>${body}</table>`
    : `<p class="callout">We hold no other launch for this ${kind === "image" ? "picture" : "wallet"}.</p>`}
  ${rows.length < total ? `<p class="callout">${fmt(total - rows.length)} more are held and not listed; the page shows
    the oldest ${fmt(shownCap)} so the sequence reads from the beginning.</p>` : ""}
  <p class="callout">A repeated picture or a repeated creator is a fact about the record, not an accusation about a
  person. What each launch did is on its own page, with the transaction it was read from.</p>`;
}

/** One launch on the timeline. `danger` colours it; `mint` makes it clickable. */
export interface StripMark { t: number; mint: string; symbol: string | null; danger: boolean }

/**
 * The relaunch strip: every launch as a mark on a real time axis.
 *
 * A table of 194 timestamps is a table. The same 194 launches as marks on nine hours of wall clock is a comb, and
 * the comb is the finding — you see a launch every three minutes without reading a single row. Cadence is the thing
 * serial reuse actually looks like, and it is invisible in any presentation that sorts rather than *places*.
 *
 * Inline SVG on purpose. The pages are self-contained, mirror-able and carry no external request; a charting library
 * would be the first dependency in a file whose credibility partly rests on not having any. Marks are `<a>` elements
 * with a `<title>`, so hover and click work with no JavaScript at all — the script below only adds a readout, and
 * the strip is fully usable when it does not run.
 *
 * Density is not smoothed away. Where launches overlap, the marks overlap; a solid black band means exactly what it
 * looks like, and thinning it to make a prettier chart would be editing the evidence.
 */
export function relaunchStrip(marks: StripMark[], capped: number): string {
  if (marks.length < 2) return "";
  const a = marks[0].t, b = marks[marks.length - 1].t;
  const span = Math.max(1, b - a);
  const W = 1000, H = 66, PAD = 2;
  const x = (t: number) => PAD + ((t - a) / span) * (W - PAD * 2);

  const bars = marks.map((m) => {
    const px = x(m.t).toFixed(2);
    const label = `${esc(m.symbol ?? "?")} · ${when(m.t)}`;
    return `<a href="../t/${esc(m.mint)}.html" class="mk${m.danger ? " d" : ""}" data-l="${label}">` +
      `<title>${label}</title><rect x="${px}" y="8" width="1.6" height="${H - 22}" /></a>`;
  }).join("");

  /**
   * Ticks are days when the span is long enough for days to mean something, and hours otherwise. A fixed unit would
   * render "9.8 hours" with a single tick or "7.2 days" with a hundred.
   */
  const dayMs = 86400_000;
  const stepMs = span > 6 * dayMs ? dayMs : span > 12 * 3600_000 ? 6 * 3600_000 : 3600_000;
  const ticks: string[] = [];
  for (let t = Math.ceil(a / stepMs) * stepMs; t <= b; t += stepMs) {
    const px = x(t).toFixed(2);
    ticks.push(`<line x1="${px}" x2="${px}" y1="${H - 13}" y2="${H - 8}" class="tk"/>`);
  }

  return `
  <div class="strip">
    <div class="striphead"><b>${fmt(marks.length)}</b> launches on a real time axis${
      capped > marks.length ? ` · newest ${fmt(marks.length)} of ${fmt(capped)} plotted` : ""}
      <span class="readout" id="ro">hover a mark</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
         aria-label="Each vertical mark is one launch, positioned by the time it happened.">
      <line x1="${PAD}" x2="${W - PAD}" y1="${H - 8}" y2="${H - 8}" class="ax"/>
      ${ticks.join("")}${bars}
    </svg>
    <div class="stripfoot"><span>${when(a)}</span><span>${dur(span)} wide</span><span>${when(b)}</span></div>
  </div>
  <script>(function(){var s=document.currentScript.previousElementSibling,r=s.querySelector('#ro');
    s.addEventListener('mouseover',function(e){var g=e.target.closest('.mk');if(g)r.textContent=g.getAttribute('data-l');});
    s.addEventListener('mouseleave',function(){r.textContent='hover a mark';});})();</script>`;
}
