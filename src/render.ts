/**
 * Page chrome and the token page, shared by the static generator (`site.ts`) and the live service (`serve.ts`).
 *
 * Both must produce byte-identical pages for the same record: the service renders a token the moment its history has
 * been rebuilt, and the generator rewrites the same file on its next run. If the two drifted, a page would change
 * appearance for no reason a reader could account for, on a site whose whole claim is that nothing is asserted without
 * a reason. The clean *criteria* are shared separately in `provenance.ts`; this module only decides how a record reads.
 */
import type { Assessment, ObservationSpan } from "./provenance.ts";
import { reportDate, type Report } from "./reports.ts";
import { MIN_POOL_SOL, MAX_DEV_PCT, NOT_RECORDED } from "./provenance.ts";
import { venuePhrase, venueLink, venueById } from "./venues.ts";

/** In property law, the unbroken documented history of ownership from origin. */
export const BRAND = "Chain of Title";

/**
 * Where the published schema documents one column, so a record can cite the entry for a value it cannot state.
 *
 * A launch page naming `curve_buyers` as unrecorded has room for one clause about why. That column's entry on
 * /data.html runs to a paragraph, because that is what the column deserves and what a reader chasing an absence
 * actually wants; retyping a shortened copy of it onto the record page is how the two come to say different things
 * about the same NULL. So the record page names the column, gives the one cause that applies to the launch in front
 * of it, and links here for the rest.
 *
 * It lives in this module rather than in `schema-doc.ts` only because that file imports this one. The id is built
 * in exactly one place either way, which is the point: an anchor spelled twice is a link that rots silently the
 * first time either spelling changes, and a dead link on the page that says "check us" is worse than no link.
 */
export const columnAnchor = (table: string, column: string) => `c-${table}-${column}`;

/**
 * Two interlocking links. Literal rather than clever, which is the right register for a registry, and it survives
 * being 16 pixels wide in a browser tab - the size at which a mark actually has to work. Inline, so it costs no
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
/**
 * The same moment with its seconds, for the launch timeline and nothing else.
 *
 * `when` drops them on purpose: a pool balance read at 14:07 is not a better fact for being read at 14:07:32, and a
 * minute is the honest resolution for every reading on the site. A launch timeline is the one place the second
 * carries information - four buyers in the creation block and a hundred and fifty by the thirty-second mark is a
 * statement about seconds - so it gets its own formatter rather than a wider one that would quietly add a precision
 * to every date on the site. The receipt-time caveat is printed beside the timeline, where it belongs.
 */
export const whenSec = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
/**
 * How long after the launch, to the second: "+0s", "+41s", "+11m 51s", "+2h 03m 14s", "+3d 04h".
 *
 * `dur` rounds to minutes and then to hours, which is right for a fill time in prose and wrong for an ordering: it
 * renders a creation, a creation-block buy and a thirty-second snapshot as "0 min, 0 min, 1 min". Sorted rows whose
 * offsets all read the same are not a timeline. Negative is possible and is printed as such rather than clamped -
 * our timestamps are receipt times and two events decoded out of order is a thing that happens, and hiding it
 * behind a "+0s" would assert an ordering the clock cannot support.
 */
export const offsetSec = (ms: number) => {
  const sign = ms < 0 ? "-" : "+", s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (d) return `${sign}${d}d ${p(h)}h`;
  if (h) return `${sign}${h}h ${p(m)}m ${p(sec)}s`;
  if (m) return `${sign}${m}m ${p(sec)}s`;
  return `${sign}${sec}s`;
};
export const dur = (ms: number) => ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86400_000).toFixed(1)} days`;
export const ago = (ms: number) => ms < 90_000 ? "just now" : `${dur(ms)} ago`;
/**
 * "2 Sep 2026" from "2026-09-02 12:29 UTC".
 *
 * The status bar runs five facts across one line and was handed full ISO timestamps, which overflowed every cell
 * and ellipsised into "COVERAGE FROM 2026-09-02 12:..." - a date truncated mid-value, which is worse than a
 * coarser date honestly given. A coverage window does not need a minute on it.
 */
export const compactDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2] - 1];
  return `${+m[3]} ${mon} ${m[1]}`;
};

/** Same UTC calendar day, so a headline can say "10:51 UTC today" instead of repeating today's date back at us. */
export const sameUtcDay = (a: number, b: number) =>
  new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);

export const CSS = `
/* Paper, and only paper.
   
   This carried a light palette and a prefers-color-scheme override to near-black, and on a dark-mode machine -
   which is most of them - the site rendered as white-on-black. An archive of record wants to read like a register:
   land registries, gazettes, court records, the papers that cite them. Near-black with grey body text
   reads as terminal, trading desk, crypto-native - the aesthetic of the thing this archive documents, which is the
   one costume it cannot afford to wear. So the dark override is gone and the ground is committed: a warm off-white
   with near-black ink, the accent a printer's red rather than a signal red.
   
   Deliberately a single look. A register that changes colour with the reader's operating system is a preference;
   one that always looks the same is a publication. */
:root{--bg:#fffdf9;--fg:#12110c;--mut:#605d51;--line:#ddd8c8;--hair:#ebe7da;
  --bad:#a32b19;--warn:#7d6218;--ok:#2c6340;--card:#f8f5ed}
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
.watch{margin:-8px 0 26px;font-size:14px}
.watch a{font-weight:600;text-underline-offset:3px}
.watch span{color:var(--mut);font-size:13px;margin-left:8px}
@media(max-width:640px){.watch span{display:block;margin:2px 0 0}}
.wall{border:1px solid var(--line);background:var(--card);min-height:120px}
.wrow{display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:baseline;padding:8px 12px;
 border-bottom:1px solid var(--line);font-size:14px;text-decoration:none;color:inherit;animation:win .45s ease-out}
.wrow:last-child{border-bottom:0}
.wrow:hover{background:var(--bg)}
.wrow .sym{font-weight:600}
.wrow .nm{color:var(--mut);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wrow .dv{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.wrow .dv.hi{color:var(--bad);font-weight:600}
.wrow .ago{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
@keyframes win{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.wrow{animation:none}}
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
/* The swimlane. Unlike the strip it must not be distorted - it draws circles, and preserveAspectRatio:none would
   render every one of them as an ellipse whose eccentricity depends on the reader's window width. So it scales
   proportionally and the height follows the number of lanes. */
.lane{border:1px solid var(--line);background:var(--card);padding:12px 14px 8px;margin:20px 0 4px}
.lane svg{display:block;width:100%;height:auto}
.lane .ln{stroke:var(--line);stroke-width:1}
.lane .gd{stroke:var(--line);stroke-width:1}
.lane .gl{fill:var(--mut);font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.lane .lw{fill:var(--fg);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.lane .lc{fill:var(--mut);font-size:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* The wait between a launch and the buy. Deliberately fainter than the dot: it is context for the event, not the
   event, and at 27 overlapping tails a stronger line reads as a grid. */
.lane .wt{stroke:var(--mut);stroke-width:1.5;opacity:.4}
.dot circle{fill:var(--fg);opacity:.6}
.dot.d circle{fill:var(--bad);opacity:.85}
.dot:hover circle,.dot:focus circle{opacity:1;fill:var(--bad)}
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
/* The nav sits in the masthead band, under the rule that band already draws, so it reads as part of the identity
   rather than as a strip bolted beneath it. Uppercase and small: it is apparatus, and the page's voice is the
   headline below it. The current page is marked by weight and a rule, not by colour - red means a finding here. */
.nav{display:flex;flex-wrap:wrap;gap:0 24px;padding:0 0 11px;margin-top:-4px}
.nav a{font-size:12px;text-transform:uppercase;letter-spacing:.09em;font-weight:600;color:var(--mut);
  text-decoration:none;padding:3px 0;border-bottom:2px solid transparent}
.nav a:hover{color:var(--fg)}
.nav a[aria-current="page"]{color:var(--fg);border-bottom-color:var(--fg)}
@media(max-width:620px){.nav{gap:0 16px}.nav a{font-size:11px;letter-spacing:.07em}}
.hero{padding:6px 0 0}
.headline{font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  font-size:clamp(27px,4.2vw,37px);line-height:1.14;letter-spacing:-.015em;font-weight:600;margin:0 0 14px;text-wrap:balance}
.headline b{font-weight:600;border-bottom:3px solid var(--bad);padding-bottom:1px}
.lede{font-size:16px;line-height:1.62;color:var(--fg);margin:0 0 6px}
/* The second paragraph of a lede is still the argument, not a footnote. It was set in --mut, and so was the
   verdict line under the proof panel, and so is every sub-note and callout - which left most of the page's prose
   deliberately de-emphasised and the whole thing reading dim. Grey now means apparatus: ages, counts, caveats. */
.lede + .lede{margin-top:12px;font-size:14.5px}
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
/* The step headings are numbers in a sequence, not verdicts, and they used to be coloured as verdicts: red on
   steps 1 and 3, green on step 2. Green sat on the one step the whole passage exists to discredit - what a
   present-tense checker reports - so the colour said the opposite of the words beside it. Red now means one thing
   on this site, a finding on the record, and a step label is not one. */
.proof h3{color:var(--mut)}
.proof b{font-variant-numeric:tabular-nums}
.verdictline{margin:0;padding:14px 20px;border:1px solid var(--line);border-top:0;background:var(--card);
  font-size:14px}
/* Three narrow columns stop being readable well before the phone breakpoint. */
@media(max-width:820px){.proof{grid-template-columns:1fr}.proof > div + div{border-left:0;border-top:1px solid var(--line)}}
/* Prose and data do not want the same width. Tables used to buy their extra width with equal negative margins,
   which gave them a left edge 90px outside the prose: two competing alignments on one page, which reads as a
   mistake rather than a decision. Two named tracks instead. Prose stops at a readable measure, tables and panels
   run on to the wide edge, and both start at the same place. */
main.page{flex:1;display:grid;align-content:start;column-gap:60px;padding:38px 28px 0;
  grid-template-columns:[wide-start] minmax(0,700px) [text-end] minmax(0,1fr) [wide-end]}
main.page > *{grid-column:wide-start/text-end;min-width:0}
main.page > .front,main.page > .deck,main.page > .hero,main.page > .band,main.page > .total,main.page > .rel,main.page > .sec,main.page > .proof,main.page > .verdict,
main.page > .verdictline,main.page > table,main.page > .stats,
main.page > .lane{grid-column:wide-start/wide-end}

/* The hero is one column, at a reading measure. It carried two, and the right one ran out of content well before
   the left one ran out of prose - so the block that opens the site ended in a hole beside its own sample records,
   and the seven figures that are the page's only summary were squeezed into a gutter to make it. They are below
   now, across the full width, where a summary belongs.

   The headline alone runs wider than the prose under it. One column at the prose measure left a quarter of a wide
   screen empty from the masthead down to the band, which is the ribbon-on-an-empty-field the rule under the
   masthead was added to prevent - and the top of the page is where it shows most. Display type takes a longer line
   than body text does, so the headline holds the edge and the paragraphs below it stay readable. */
.hero{padding:6px 0 0}
.hero:not(.split) .headline{max-width:900px}
/* A stepped measure, not one ragged column. The headline takes a display line, the prose and the search box take a
   reading one, and the record list takes the whole width - it is a table of three rows, not prose, and at full
   width it sits flush with the findings band directly beneath it instead of leaving a quarter of a wide screen
   empty for the height of the hero. */
.hero:not(.split) > :not(.headline):not(.live){max-width:700px}
.hero:not(.split) > .live{max-width:none}

/* The two-column hero the front page gave up, kept for the pages that still earn it.
   A siblings page, an operator page and the live wall each open with a short lede and three or four counters, and
   there the right-hand column is full for its whole height - which is exactly the condition the front page stopped
   meeting when its ledger grew to seven rows and its left column to six stacked blocks. Scoped to .split rather
   than left on .hero, because .hero now means the single-column one and deleting these rules outright silently
   flattened three working pages. */
.hero.split{display:grid;column-gap:60px;align-items:start;padding-top:2px;
  grid-template-columns:minmax(0,700px) minmax(0,1fr)}
.hero.split .col-a,.hero.split .col-b{min-width:0}
/* A ledger, not a 2x2. The labels are long enough that a grid wraps them unevenly and the figures stop sharing a
   baseline. */
.hero.split .stats{margin:6px 0 0;border:1px solid var(--line);background:var(--card);padding:4px 22px}
.hero.split .stat{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0;
  padding:13px 0;border-bottom:1px solid var(--line)}
.hero.split .stat:last-child{border-bottom:0}
.hero.split .stat span{display:block;margin:0;flex:1;min-width:0;line-height:1.4}
.hero.split .big{font-size:24px;font-variant-numeric:tabular-nums}
.hero.split .col-b .sub{margin:12px 0 0;font-size:12.5px;line-height:1.5}

/* The findings, as a band rather than a rail. Seven numbers on one baseline, each with the finding it counts
   underneath it. Number first and label second on purpose: a label that takes two lines then pushes nothing out of
   line, so the figures stay level however the words fall. Nothing here is coloured - see the note on red below. */
.band{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));
  border-top:1.5px solid var(--fg);margin:28px 0 0}
/* The rule under a row belongs to the cells of that row, not to the cells of the next one. It was drawn by the
   row below (border-top on the cells that wrap), so under a full row of four it ran only as far as the three cells
   beneath it and stopped a quarter short. Every cell carrying its own underline is the same line in the full case
   and correct in every other, and it does not need to know how many findings there are - which varies. The band's
   own bottom border goes, or the last row would carry two. */
.band > div{padding:15px 16px 17px;min-width:0;border-bottom:1px solid var(--line)}
.band > div + div{border-left:1px solid var(--line)}
.band b{display:block;font-size:27px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.05}
.band span{display:block;margin-top:6px;color:var(--mut);font-size:12px;line-height:1.35}
/* Seven across needs about 150px a cell before the labels start breaking badly; below that, four and then two.
   The left rules are reassigned at each step so the first cell of every row has none. */
@media(max-width:1100px){
  .band{grid-template-columns:repeat(4,minmax(0,1fr))}
  .band > div:nth-child(4n+1){border-left:0}
}
@media(max-width:620px){
  .band{grid-template-columns:repeat(2,minmax(0,1fr))}
  .band > div:nth-child(4n+1){border-left:1px solid var(--line)}
  .band > div:nth-child(2n+1){border-left:0}
  .band b{font-size:22px}
}
/* The archive total. A different question from the band above it - every launch ever recorded, against one day -
   so it gets its own rule and its own line. As an eighth cell in that grid a reader would add it to the other
   seven, which is the mistake the old layout had already been corrected for once. */
.total{display:flex;align-items:baseline;gap:14px 22px;flex-wrap:wrap;margin:34px 0 0;padding:17px 0 0;
  border-top:1px solid var(--line)}
.total b{font-size:27px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.total .tl{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)}
.total .tn{flex:1;min-width:280px;color:var(--mut);font-size:12.5px;line-height:1.5}
/* Where a truncated table continues. The front page shows enough rows to establish what a table is; the whole list
   has its own page, because a register that publishes only its top ten is not a register. */
.more{display:inline-block;margin:14px 0 0;font-size:13px;font-weight:600;text-underline-offset:3px}

/* The latest report, on the front page.
   Everything else here is a window that moves and says so. This is the one block that points at something dated and
   fixed, so it is set as a release notice: a rule, a date, a title in the serif the headline uses, and the sentence
   the report itself carries. It is deliberately not a card - a card would file it with the sample records above,
   and it is a different kind of object. */
.rel{margin:38px 0 0;padding:16px 0 0;border-top:1.5px solid var(--fg)}
.rel .relmain{display:block;text-decoration:none}
.rel .relall{display:inline-block;margin:14px 0 0;font-size:13px;font-weight:600;text-underline-offset:3px}
.rel .rh{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:11px;text-transform:uppercase;
  letter-spacing:.09em;font-weight:700;color:var(--mut)}
.rel .rd{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0;font-weight:400}
.rel .rt{display:block;margin:9px 0 0;font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  font-size:23px;font-weight:600;line-height:1.15;max-width:34ch}
.rel .relmain:hover .rt{text-decoration:underline;text-underline-offset:4px}
.rel .rs{display:block;margin:7px 0 0;color:var(--mut);font-size:14.5px;line-height:1.55;max-width:66ch}
.rel .rc{display:block;margin:10px 0 0;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.rel .relmain:hover .rc{color:var(--fg)}

@media(max-width:1000px){
  /* One column, but the line NAMES have to survive: dropping them sent every table and panel into an implicit
     second column and the whole page scrolled sideways. */
  main.page{grid-template-columns:[wide-start] minmax(0,1fr) [text-end wide-end];padding:32px 24px 0}
  .hero.split{grid-template-columns:[wide-start] minmax(0,1fr) [wide-end]}
  .hero.split .col-b{margin-top:26px}
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
/* The live block on the front page.
   The wall reuses .wall/.wrow wholesale - same grid, same fade-in, same colouring of the creator's share - so the
   front page and /live.html cannot drift into two different renderings of one feed. Only the chrome is new. */
.livehead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:10px 14px;
  border:1px solid var(--line);border-bottom:0;background:var(--card);
  font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--mut);font-weight:700}
/* The status, not a rate counter. "3.1 a minute" is a number about how busy the feed is, which is a fairground
   claim; what a reader of an archive needs to know is whether what they are looking at is current, and if it is
   not, that we know it. */
.livehead .lr{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0;
  font-weight:400;font-size:12px;text-transform:none}
.livefoot{display:flex;gap:12px;flex-wrap:wrap;padding:9px 14px;border:1px solid var(--line);border-top:0;
  background:var(--card);color:var(--mut);font-size:12.5px;line-height:1.5}
.livefoot a{font-weight:600;margin-left:auto;white-space:nowrap}
.live{margin:24px 0 0}
/* The fallback the server renders inside the wall: real records, shown until the feed answers, and left alone if
   it never does. An empty box that says "connecting" is worse than three records a reader can open. */
.wall .fb{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:baseline;padding:9px 14px;
  border-bottom:1px solid var(--line);text-decoration:none;font-size:14px}
.wall .fb:last-child{border-bottom:0}
.wall .fb:hover{background:var(--bg)}
.wall .fb .ss{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
  max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wall .fb .sl.DANGER{color:var(--bad)}.wall .fb .sl.OK{color:var(--ok)}
.wall .fb .sl.CAUTION{color:var(--warn)}.wall .fb .sl.UNKNOWN{color:var(--mut)}
.wall .fb .sa{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}

/* Three records to open, for the visitor who has nothing to paste - which is most of them. */
.starts{margin:24px 0 0;border:1px solid var(--line);background:var(--card)}
.starts .sh{display:block;padding:10px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.09em;
  color:var(--mut);font-weight:700;border-bottom:1px solid var(--line)}
.starts a{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:baseline;padding:11px 16px;
  border-bottom:1px solid var(--line);text-decoration:none;font-size:14px}
.starts a:last-child{border-bottom:0}
.starts a:hover{background:var(--bg)}
.starts .sf{display:block;padding:10px 16px;color:var(--mut);font-size:12.5px;line-height:1.5;
  border-top:1px solid var(--line)}
.starts .ss{font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
  max-width:14ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.starts .sl.DANGER{color:var(--bad)}.starts .sl.OK{color:var(--ok)}
.starts .sl.CAUTION{color:var(--warn)}.starts .sl.UNKNOWN{color:var(--mut)}
.starts .sa{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
/* Scope, next to the claim it qualifies rather than in the footer. */
.vscope{margin:9px 0 20px;color:var(--mut);font-size:13px;line-height:1.55;max-width:70ch}
/* A wallet page is identified by its address, so the address is the heading rather than a word about it. */
.addr-h1{font-size:16px;font-weight:600;word-break:break-all;margin:0 0 2px}
/* ============================================================================
   The broadsheet front page, and the chrome it shares with every other page.
   ============================================================================ */

/* --- masthead: wordmark, sections, search, on one line --- */
.band-top{background:var(--bg);border-bottom:0}
.mast{display:flex;align-items:center;gap:26px;padding:17px 0;grid-template-columns:none}
.mast a.brand{font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  font-size:25px;font-weight:700;letter-spacing:-.015em;gap:11px}
.mast .nav{margin-left:auto;display:flex;gap:26px;padding:0;margin-top:0;flex-wrap:nowrap}
.mfind{display:flex;border:1.5px solid var(--fg);flex:none}
.mfind input{width:230px;padding:8px 11px;border:0;background:transparent;
  font:12.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);outline:none;border-radius:0}
.mfind input::placeholder{color:#a5a294}
.mfind input:focus{outline:2px solid var(--fg);outline-offset:-1px}
.mfind button{padding:8px 16px;border:0;border-left:1.5px solid var(--fg);background:var(--fg);color:var(--bg);
  font:600 12px/1.3 inherit;cursor:pointer;white-space:nowrap}

/* --- the status band: what this archive is, on every page --- */
.statusband{border-top:1px solid var(--hair);border-bottom:1px solid var(--fg);background:var(--bg)}
.status{display:flex;font-size:11.5px;text-transform:uppercase;letter-spacing:.11em;color:var(--mut)}
.status div{flex:1;padding:9px 0;text-align:center;border-left:1px solid var(--hair);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.status div:first-child{border-left:0;text-align:left}
.status b{color:var(--fg);font-weight:600;letter-spacing:.03em;font-variant-numeric:tabular-nums}
.status a{text-decoration:none;border-bottom:1px solid var(--line)}
@media(max-width:900px){
  .mast{flex-wrap:wrap;gap:12px 18px}
  .mast .nav{margin-left:0;order:3;width:100%;flex-wrap:wrap;gap:0 18px}
  .mfind{margin-left:auto}
  .mfind input{width:170px}
  .status{flex-wrap:wrap}
  .status div{flex:1 1 46%;text-align:left;border-left:0;padding:5px 0}
}

/* --- the front: editorial lead + standing rail --- */
.front{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:0;border-bottom:3px double var(--fg)}
.front > .lead{padding:34px 40px 36px 0;border-right:1px solid var(--line);min-width:0}
.kicker{font-size:11.5px;text-transform:uppercase;letter-spacing:.17em;font-weight:700;color:var(--bad);margin:0 0 14px}
/* A headline is short. The old one was a forty-word sentence set at 40px, which is a standfirst in a headline's
   clothes - the reader met the subject of the sentence on line three. */
.front h1{margin:0 0 18px;font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif;
  font-size:clamp(34px,4.4vw,56px);line-height:1.04;font-weight:700;letter-spacing:-.026em;max-width:16ch;
  text-wrap:balance}
.front h1 em{font-style:normal;color:var(--bad)}
.stand{margin:0 0 22px;font-size:19px;line-height:1.5;max-width:54ch;
  font-family:ui-serif,Georgia,"Iowan Old Style","Times New Roman",serif}
.stand b{font-weight:600}
/* Two columns of secondary prose, the way a newspaper runs its jump. Only at the measure where it works. */
.twoup{column-count:2;column-gap:36px;margin:0}
.twoup p{margin:0 0 12px;font-size:14.5px;line-height:1.6;color:var(--mut)}
.twoup p strong{color:var(--fg);font-weight:600}
@media(max-width:900px){.twoup{column-count:1}}

/* the figures, as a rule-separated row of typographic events rather than words inside a paragraph */
.figs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin:26px 0 0;border-top:1px solid var(--fg)}
.figs div{padding:15px 14px 15px 0;border-right:1px solid var(--hair);min-width:0}
.figs div:last-child{border-right:0}
.figs b{display:block;font-family:ui-serif,Georgia,"Iowan Old Style",serif;font-size:29px;line-height:1;
  font-weight:600;font-variant-numeric:tabular-nums;color:var(--bad)}
.figs div.cl b{color:var(--fg)}
.figs span{display:block;margin-top:7px;font-size:11.5px;line-height:1.4;color:var(--mut)}
@media(max-width:760px){.figs{grid-template-columns:repeat(2,minmax(0,1fr))}
  .figs div{border-bottom:1px solid var(--hair)}}

/* --- the rail --- */
.rail{padding:34px 0 36px 34px;min-width:0}
/* One line. At 330px "Most recently recorded" plus a status broke over two lines each and the rule under them sat
   four lines down, which read as a heading that had gone wrong rather than a column head. */
.railh{font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;white-space:nowrap;
  padding-bottom:9px;border-bottom:1px solid var(--fg);display:flex;align-items:baseline;gap:8px}
.railh .rs{margin-left:auto;font-weight:400;letter-spacing:.03em;text-transform:none;color:var(--mut);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:12ch}
.rail .rrow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:baseline;
  padding:9px 0;border-bottom:1px solid var(--hair);text-decoration:none;font-size:13.5px;
  animation:win .45s ease-out}
.rail .rrow:hover{background:var(--card)}
.rail .rrow.fb2{grid-template-columns:minmax(0,1fr) auto}
.rail .rs2{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail .rd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-variant-numeric:tabular-nums}
.rail .rd.hi{color:var(--bad);font-weight:700}
.rail .rt{color:var(--mut);font-size:11.5px;font-variant-numeric:tabular-nums;min-width:5.5ch;text-align:right}
.rail .rmore{display:block;margin-top:13px;font-size:12px;font-weight:600;color:var(--mut);text-decoration:none}
.rail .rmore:hover{color:var(--fg)}
.rail .rnote{margin:12px 0 0;font-size:12.5px;line-height:1.55;color:var(--mut)}
@media(max-width:1080px){
  .front{grid-template-columns:minmax(0,1fr)}
  .front > .lead{border-right:0;padding-right:0}
  .rail{padding-left:0;border-top:1px solid var(--line);padding-top:26px}
}

/* --- the deck: three ways in, at the foot of the front --- */
.deck{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--line)}
.deck > div{padding:28px 30px 32px 0;border-right:1px solid var(--line);min-width:0}
.deck > div:last-child{border-right:0;padding-right:0}
.deck > div + div{padding-left:30px}
.deck .k{font-size:11px;text-transform:uppercase;letter-spacing:.15em;font-weight:700;color:var(--bad);margin:0 0 10px}
.deck h3{margin:0 0 10px;font-family:ui-serif,Georgia,"Iowan Old Style",serif;font-size:21px;line-height:1.24;
  font-weight:600}
.deck p{margin:0;font-size:14px;line-height:1.6;color:var(--mut)}
.deck p b{color:var(--fg);font-weight:600}
.deck b.big{display:block;font-family:ui-serif,Georgia,"Iowan Old Style",serif;font-size:42px;line-height:1;
  font-weight:600;margin:0 0 9px;font-variant-numeric:tabular-nums}
.deck a.go{display:inline-block;margin-top:11px;font-size:12.5px;font-weight:600;text-underline-offset:3px}
@media(max-width:900px){
  .deck{grid-template-columns:1fr}
  .deck > div{border-right:0;padding-right:0;border-bottom:1px solid var(--hair)}
  .deck > div + div{padding-left:0}
  .deck > div:last-child{border-bottom:0}
}

/* Attribution. A registry that will not say who keeps it is asking for a trust it has not offered. */
.who{margin-top:14px}
.who b{font-weight:600;color:var(--fg)}
`;

/**
 * The six destinations in the masthead. Order is the order a stranger needs them in: what is happening now, what we
 * have concluded, what we have published, how we decide, and the two ways to take the thing away with you.
 */
/**
 * The front page's address, and it is `/` rather than `/index.html`.
 *
 * Every link home pointed at `index.html`, so clicking the masthead from anywhere on the site put a filename in the
 * reader's address bar - a site that shows its own build artifacts. `serve.ts` already answered `/` by rewriting it
 * to `/index.html` internally, so the good URL worked and nothing ever sent anyone to it; `/index.html` now 301s to
 * `/` so the two addresses collapse into one rather than being two documents to a crawler.
 *
 * Absolute, not relative, because this has to be right from `/t/<mint>.html` and `/reports/<slug>.html` too, and
 * `../` from those lands on `/` only by accident of depth. The cost is an offline copy opened over `file://`, where
 * `/` is the filesystem root - that tree is built to be SERVED, and every page in it already assumes a web root.
 */
export const HOME_HREF = "/";

export const NAV: { href: string; label: string }[] = [
  { href: "live.html", label: "Live" },
  { href: "findings.html", label: "Findings" },
  { href: "reports.html", label: "Reports" },
  { href: "method.html", label: "Method" },
  { href: "venues.html", label: "Programs" },
  { href: "data.html", label: "Data" },
  { href: "api.html", label: "API" },
];

/**
 * Is this nav entry the section the reader is in?
 *
 * Matched on the first path segment rather than the whole path, so /reports/ticker-factories.html marks Reports -
 * a report page is in the Reports section, and a nav that goes blank the moment you follow a link out of its index
 * is worse than no highlight, because it tells the reader they have left the site.
 */
export function navCurrent(href: string, path?: string): boolean {
  const seg = (path ?? "/").replace(/^\//, "").split("/")[0];
  if (!seg) return false;
  const stem = (x: string) => x.replace(/\.html$/, "");
  return stem(href) === stem(seg);
}

/**
 * The facts every page states about the archive itself, in the status bar under the masthead.
 *
 * `onFile` and `builtAt` are new here and were previously reachable only from the front page's body, which meant a
 * reader who landed on a record page - which is how most people arrive, from a pasted link - had no way to tell how
 * large the archive was or how current. Both are properties of the record the process is serving, so they belong
 * with the coverage window rather than with one page's figures.
 */
/**
 * `chain` is a LIVE getter, not a copied number: it is defined on the chrome object as a property backed by the
 * scanner poll, so a page rendered ten minutes after the last record adoption still reports what the scanner holds
 * now. Absent means we could not ask, which is why the band omits the line entirely rather than printing a zero.
 */
export interface Chrome {
  coverageFrom: string; gapMin: number; onFile?: number; builtAt?: number | null;
  /**
   * When each venue's own coverage begins. `coverageFrom` is the earliest across all of them, which is the right
   * answer for "how far back does this archive go" and the wrong one for "since when have you watched THIS venue" -
   * a second venue subscribed today does not inherit the first one's history. venues.ts clause 3, in prose.
   */
  coverageByVenue?: { label: string; from: string }[];
  chain?: { mints: number; launches: number; documents: number; beyondPumpfun: number; ranges: { from: number; to: number }[] } | null;
}

/**
 * A record page is this project's only real distribution. Nobody shares a registry's front page; they paste a link to
 * one record into a group chat to settle an argument. With no metadata every such link rendered as a blank grey box,
 * so the most persuasive thing here - a specific, checkable finding about a specific token - was invisible at exactly
 * the moment someone chose to pass it on. The preview is written from the record, so it is an advertisement that
 * cannot say anything the page does not.
 */
/**
 * The site's one true origin. Every page declares which URL it really lives at, or the same record served from a
 * second hostname - an apex and a www, or the platform's own *.up.railway.app - is two documents to a crawler and two
 * link previews to a chat client, which splits the only distribution this project has.
 *
 * This defaults to the real host rather than to nothing. It was an env var alone, CANONICAL_HOST was never set on the
 * deployed service, and so the tag shipped on no live page at all - a mechanism that exists only in the repository
 * protects nothing. CANONICAL_HOST still overrides, for a staging host that must not claim to be this one.
 */
export const CANONICAL_HOST = (process.env.CANONICAL_HOST ?? "https://chainoftitle.org").replace(/\/+$/, "");

/**
 * Who keeps this. A registry that will not say who stands behind it is asking for a trust it has not offered, and it
 * is the first thing a grant reviewer looks for. The address must be a real mailbox before this ships - a published
 * contact that bounces is worse than none.
 */
export const CONTACT = "hello@chainoftitle.org";
export const KEEPER = "the Chain of Title project";
/**
 * Set this to the public repository URL once the auditable half of the code is pushed - the criteria (`provenance.ts`),
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
<header class="band-top"><div class="shell">
${/*
    One line: wordmark, sections, search.
    
    This was three stacked left-aligned rows - a wordmark, a two-line note on what "chain of title" means in
    property law, then the nav - all small, all grey, all starting at the same x, occupying the left third of a
    wide screen. Three rows of chrome before the page begins, and the one control anybody came to use was not
    among them: search lived on the front page only, so a reader on a record page had nowhere to put the next
    mint. It is in the masthead now, which means it is on every page.
    
    The property-law gloss moved to the footer. It is a good sentence and it is an explanation of the name, which
    a returning visitor has read and a new one reads once.
  */ ""}
<div class="mast">
  <a class="brand serif" href="${HOME_HREF}">${MARK}<span>${BRAND}</span></a>
  <nav class="nav" aria-label="Sections">${NAV.map((n) => `<a href="${root}${n.href}"${navCurrent(n.href, path) ? ` aria-current="page"` : ""}>${n.label}</a>`).join("")}</nav>
  <form class="mfind" action="/lookup" method="get" onsubmit="return look(event)">
    <input id="q" name="mint" placeholder="paste a mint address" spellcheck="false" autocomplete="off"
      pattern="[1-9A-HJ-NP-Za-km-z]{32,44}" required aria-label="Token mint address">
    <button type="submit">Look up</button>
  </form>
</div></div>
${/*
    The status bar: what this archive holds, how current it is, and on what terms.
    
    Every one of these facts was on the site already and none of them were together: the record count sat mid-page
    on the front page only, the coverage window and the licence were in the footer, and how old the data was had
    to be inferred. They are the first questions anybody asks of an archive, so they are answered above the fold,
    on every page, in one line.
  */ ""}
<div class="statusband"><div class="shell"><div class="status">
  ${/*
      ONE number, and it is a real total rather than two figures added carelessly.
      
      It was two cells and then two numbers in one cell, and both were confusing: a reader cannot be expected to
      hold "watched" and "scanned" apart in a status bar, and the second figure invited a comparison against a
      nine-day total that it had been collecting for two hours.
      
      Addable because the overlap is removed at the source. The scanner counts every token creation on the chain
      INCLUDING pump.fun's, which the collector is already counting, so the raw figures cannot be summed. The
      scanner therefore reports `beyondPumpfun` - launches it found that pump.fun did not make - and that is what
      is added here. One token, one count.
      
      The distinction between watched and scanned has not gone away and still governs what the archive CLAIMS: it
      lives on /method.html and in the API, where there is room to state it. A status bar is not that place.
      
      This was two extra cells and it broke the band: seven cells at this width truncate to "270,997 LAUNCHES WA…"
      and "2,144 OF THEM LOOK …", which is worse than not saying it. The band answers the first questions anyone
      asks of an archive and it only works if every cell is readable.
      
      Not summed, and not summable. The collector WATCHED its launches - a subscription held to a venue's program,
      events decoded as they happened. The scanner SCANNED across the whole chain afterwards. They also OVERLAP: a
      pump.fun launch today is in both, so adding them would double-count as well as conflate two different claims.
      The detail - how many of the scanned mints look like launches, and by what test - lives on /method.html where
      there is room to state the test beside the number.
   */ ""}
  <div><b id="rec" data-n="${(c.onFile ?? 0) + (c.chain?.beyondPumpfun ?? 0)}">${
    fmt((c.onFile ?? 0) + (c.chain?.beyondPumpfun ?? 0))}</b> tokens on record</div>
  <div>Coverage from <b>${esc(compactDate(c.coverageFrom))}</b></div>
  <div>Archive read <b id="recnote">${c.builtAt
    ? (sameUtcDay(Date.now(), c.builtAt) ? `${when(c.builtAt).slice(11)} today` : compactDate(when(c.builtAt)))
    : "unrecorded"}</b></div>
  <div>Public domain · <b><a href="${root}data.html">CC0</a></b></div>
  <div>Free · no account</div>
</div></div></div>
${/*
    The counter climbs, because the collector never stops.
    
    It reads the record's own count when the page is rendered and then follows the collector, which is the honest
    pair: the first cell is how many launches the archive HAS, the cell beside it is when the file you can download
    was last built. A snapshot count under a live label would understate the record by thousands by the end of each
    build cycle, which is what it did while this script was missing: the markup carried `id` and `data-n` and
    nothing acted on them, a promise in the HTML with no code behind it.
    
    It only ever displays values the collector actually reported. The animation interpolates between two real
    readings and stops on the second; it never extrapolates forward from a rate, because a number that invents
    launches it has not seen is precisely what this site exists to catch other people doing. If the collector is
    unreachable the figure stays exactly as rendered and nothing pretends to be live.
    
    In page() rather than on the front page, because the status band is on every page now and a counter that ticks
    on one of them and sits frozen on the rest is worse than one that never ticks at all.
  */ ""}
<script>(function(){
  var el=document.getElementById('rec');
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
      if(typeof d.observed!=='number')return;   // collector unreachable or stale: leave the rendered figure alone
      if(d.observed<shown)return;               // an archive never shrinks; refuse a lower number rather than animate down
      to(d.observed);
    }).catch(function(){});
  }
  tick(); setInterval(tick,10000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()});
})()</script></header>
<main class="page shell">
${body}
</main>
<footer class="band-bot"><div class="shell"><div class="note"><a href="${root}live.html">Watch launches live</a> · <a href="${root}clean.html">No markers found</a> · <a href="${root}wallets.html">Curve buyers</a> · <a href="${root}operators.html">Operator groups</a> · <a href="${root}findings.html">What the record shows</a> · <a href="${root}reports.html">Reports</a> · <a href="${root}method.html">How this is decided</a> · <a href="${root}corrections.html">Tell us we are wrong</a> · <a href="${root}data.html">Take the data</a> · <a href="${root}api.html">API</a> · <a href="${root}pledge.html">Pledge</a> · <a href="${HOME_HREF}">${BRAND}</a><br>
In property law, the chain of title is the unbroken documented history of ownership from origin: what you establish
before you believe a claim about what something is. Coverage begins ${c.coverageFrom}${c.gapMin >= 1 ? `, with ${fmt(c.gapMin)} min of recorded downtime` : ", no recorded downtime"}.
Everything here is read from the Solana chain. Where we recorded a launch's creation transaction, its page cites it and you can check every figure yourself; where we did not, the page says so. Where we say no markers were found, we checked the launch against every pattern we record and none was present. That is a statement about what we checked, not a prediction and not advice.
Most launches lose money regardless, and that is a finding this project set out to disprove and could not. The
question was whether a bonding curve could be traded profitably at all; 19,412 entries were simulated against the
recorded trades over 24 hours in September 2026 and none reached 5x - and those were the organic ones, filtered to
launches with a creator share under 50% and at least 30 outside buyers, which is the subset most favourable to the
hypothesis. Nothing was ever traded: the entries were simulated, this archive holds no position in anything it
reports on, and the negative result is why it is an archive rather than a trading system. A dated measurement of a
favourable subset, not a running total over the archive above.
<div class="who">Kept by <b>${esc(KEEPER)}</b> · <a href="mailto:${esc(CONTACT)}">${esc(CONTACT)}</a>${SOURCE_URL ? ` · <a href="${esc(SOURCE_URL)}">Source</a>` : ""}<br>
Free to use, with no account and no wallet connection. The archive is public domain (<a href="${root}data.html">CC0</a>) and
downloadable in full, so nothing here depends on trusting us to keep publishing it. Funded by grants and by the
services that read it, never by the projects it reports on, and never by sending you into a trade.</div></div></div></footer>
</div></body></html>`;
}

/**
 * The search box. On the front page, on every page that could not answer, and - because checking one token is rarely
 * what anyone came to do - at the foot of every record.
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
 * How long after launch a curve was taken - stated only as finely as the record can support.
 *
 * A curve trade's `ts` is `Date.now()` inside the handler that decodes the websocket batch it arrived in, and so is
 * the launch's `created_at`. 1,692 of the 1,736 recorded buyouts have a gap of exactly zero, which is not 1,692
 * measurements of "the same instant": it is one clock reading assigned twice in one batch. The tracker's own bundling
 * heuristic knows this and falls back to a 2 s window when slots are unknown (tracker.ts:313).
 *
 * So "0 min after launch" printed a limit of the collector as a finding about the operator - on 97% of the wallet
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
      summary: `We hold no record of this launch, so we cannot say what it was at birth. That absence is not a finding: once a float has been spread, a launch that was assembled and one that was not look the same on-chain.` };
  const bits: string[] = [];
  if (t.dev_pct != null) bits.push(`the creator took ${t.dev_pct.toFixed(1)}% of supply in the first block`);
  if (a.curveBuyers != null) bits.push(`${fmt(a.curveBuyers)} outside wallet${a.curveBuyers === 1 ? "" : "s"} bought on the bonding curve`);
  if (t.graduated_at && t.created_at) bits.push(`the curve filled in ${dur(t.graduated_at - t.created_at)}`);
  const evidence = bits.join(", ") + ".";
  if (clean) return { title: `${sym}: checked, no markers found`, summary: `Recorded live at launch: ${evidence} We checked this launch against every marker we record and found none, which is a statement about what we checked and not a prediction.` };
  const headline = manufactureHeadline(t, a);
  return { title: headline ? `${sym}: ${headline}` : `${sym}: launch record`, summary: `Recorded live at launch: ${evidence}` };
}

/**
 * The single worst thing the launch record says about a token, as a phrase. Written for the purpose rather than
 * sliced out of a flag sentence, which produced "WOTF - The creator took 79.3% of the entire supply in the first
 * block. Nothin". Shared by the link preview and the verdict so the two can never say different things about the
 * same record - the failure this module exists to prevent.
 */
function manufactureHeadline(t: any, a: Assessment): string | null {
  const gradS = t.graduated_at && t.created_at ? (t.graduated_at - t.created_at) / 1000 : null;
  /**
   * Each phrase is a complete clause carrying its own article, because the caller says "The record shows <phrase>."
   * The prefix used to supply a "the", which read correctly for the creator-share phrases and produced "The record
   * shows the nobody bought its curve." for the rest - on the single most-read line of the most-read page.
   */
  return t.dev_pct >= 50 ? `the creator took ${t.dev_pct.toFixed(0)}% of supply at launch`
    /**
     * These three assert the curve completed, so none may be said until that is confirmed. `a.completed` is decided
     * once in provenance.ts and read here; deriving it again from t.graduated is what let this function label an
     * ordinary dud - no buyers, never graduated - a "Manufactured launch". Not completing a curve is how most tokens
     * die, and it is not evidence of anything.
     */
    : a.completed && a.curveBuyers === 0 ? "nobody bought its curve"
    : a.completed && gradS !== null && gradS <= 60 ? (Math.round(gradS) < 1
        // Below a second the figure is an artifact of how events were batched on the way in, not a measurement.
        // Saying "0s" asserts a precision the timestamps do not carry; `curveAge` states the same fact honestly.
        ? "the curve completed in the same batch of events as the launch"
        : `the curve completed ${Math.round(gradS)}s after launch`)
    : a.completed && a.curveBuyers !== null && a.curveBuyers < 10 ? `only ${a.curveBuyers} outside buyer${a.curveBuyers === 1 ? "" : "s"} bought its curve`
    // A buyout is an observed trade of 40+ SOL, true whether or not the curve went on to complete.
    : a.buyout ? `one wallet bought its curve for ${a.buyout.sol.toFixed(0)} SOL`
    : t.dev_pct >= MAX_DEV_PCT ? `the creator took ${t.dev_pct.toFixed(0)}% of supply at launch`
    : null;
}

/** "OK" is a verdict but never a flag: `Level` in provenance.ts covers only the things that can go wrong. */
export type Verdict = { level: "OK" | "DANGER" | "CAUTION" | "UNKNOWN"; label: string; why: string };

/**
 * The one line a record page exists to deliver, said the way a register says it.
 *
 * This used to render a judgement: "Manufactured launch" over a token whose record showed a creator share, and
 * "Launched clean" over one that cleared four thresholds. Both were conclusions we do not get to draw. Manufacture
 * is a claim about somebody's purpose, and we observe supply shares and buyer counts, not purposes; and a clean
 * result is an endorsement, which is the one shape of claim that hurts a reader who relies on it.
 *
 * So the finding is the headline. `manufactureHeadline` already wrote every phrase as a complete observation - "the
 * creator took 79% of supply at launch", "nobody bought its curve" - and those go straight in the label, where the
 * conclusion used to be. Where there is nothing to report we say what a register says: nothing is recorded here.
 * That is a statement about our record, which we can stand behind, rather than about the token, which we cannot.
 *
 * The four `level` values are kept. They drive colour and ordering, and they are read by the API, so renaming them
 * is a version decision rather than a wording one.
 */
export function verdict(t: any, a: Assessment, clean: boolean): Verdict {
  if (!a.watched) return { level: "UNKNOWN", label: "Launch not observed",
    why: "We hold no record of this launch, so we cannot say what it was at birth. That absence is not a finding about the token. Once a float has been spread, a launch that was assembled and one that was not look the same on-chain." };
  /**
   * A thin pool now is a separate reading with a separate shelf life, and it is reported as a reading rather than
   * as a warning: the age of the measurement is on the page beside it, and what a reader does with it is theirs.
   */
  const thinNow = a.flags.some((f) => f.kind === "liquidity" && f.level === "DANGER");
  if (clean && thinNow) return { level: "CAUTION", label: "Checked, no markers found; pool below threshold when last read",
    /**
     * The figure is deliberately not repeated here. The liquidity flag is set from the pool reading the request
     * made, and this function only has the row - two sources for one number, which is how this line came to read
     * "pool thin" above "the pool held 42 SOL" on a 40 SOL threshold. The flag states the balance and its age; this
     * says what kind of claim it is and leaves the number where it is measured.
     */
    why: "We watched this launch and checked it against every marker we record; none is present. Separately, the pool balance was below our threshold when it was last read - a present-tense measurement with its own age, stated below, and not part of the launch record." };
  if (clean) return { level: "OK", label: "Checked, no markers found",
    why: `We watched this launch and checked it against every marker we record. None of them is present: the creator kept ${t.dev_pct != null ? `${t.dev_pct.toFixed(1)}%` : "an unrecorded share"}, ${a.curveBuyers != null ? `${fmt(a.curveBuyers)} outside wallets bought on the curve` : "the buyer count is unrecorded"}, the curve took longer than a minute to fill, and no single wallet took it. A statement about what we checked, not a judgement about the token.` };
  const headline = manufactureHeadline(t, a);
  // The observation, capitalised, in place of the word we used to put here. The evidence and the headline are now
  // the same sentence, so there is no gap between what we found and what we called it.
  if (headline) return { level: "DANGER", label: headline.charAt(0).toUpperCase() + headline.slice(1),
    why: "Read from the launch record. What it means is the reader's to decide; we record what happened, not why." };
  if (a.flags.some((f) => f.level === "DANGER")) return { level: "DANGER", label: "Findings on record",
    why: "The launch itself matches none of the patterns we record, and something below is on the record against it." };
  return { level: "UNKNOWN", label: "No finding either way",
    why: "We watched this launch. It matches none of the patterns we record, and it does not meet every criterion for a record with no markers. Neither endorsed nor accused." };
}

/**
 * The body of a token page. `origin` says how we know what we know, which the reader is entitled to:
 * "observed" - watched live from creation; "rebuilt" - reconstructed completely from chain history.
 */
/**
 * What else this launch is a copy of.
 *
 * Two facts the record has always been able to answer and never did, both computed by the caller because they are
 * index lookups against the whole archive rather than anything about this row: how many other launches used this
 * exact picture, and what else this creator has launched.
 *
 * They matter more than any single figure on the page. 57% of the launches whose picture we hold use a picture
 * another launch also used - one image is shared by 194 launches all called STONKPUMP - and 81% of all launches come
 * from a wallet that has launched more than one, the busiest having launched 1,994. A reader looking at creator
 * share and buyer counts is being asked to judge a token. A reader told this is the 194th launch of the same picture
 * is being told what it is.
 */
export interface Priors {
  /** other launches using the identical image bytes, by sha256. null when we hold no picture for this launch. */
  sameImage: number | null;
  imageSha: string | null;
  /** other launches by this creator, and how many of those have findings on record */
  byCreator: number;
  creatorFlagged: number;
}

/**
 * What each entry on a record is called.
 *
 * The page printed the severity word itself - DANGER, CAUTION, UNKNOWN - beside every line, which is a rating
 * agency's vocabulary on a register's page. The colour still carries urgency, because a reader scanning a page is
 * entitled to that; the word now says what kind of entry it is. A finding is something we recorded that counts
 * against the launch, a note is a weaker one, and "not established" is the honest name for what we could not
 * settle - it is not a lesser warning, it is an absence.
 */
export const ENTRY_WORD: Record<string, string> = {
  DANGER: "finding", CAUTION: "note", UNKNOWN: "not established", OK: "observation",
};

/**
 * Why this launch has no creation transaction to cite, as the one cause that applies to it.
 *
 * `create_sig` is on 181,474 of 206,018 launches and it is the whole of the "check us" claim: every figure in the
 * launch record, `dev_pct` above all, is decoded out of that one transaction. Where we do not hold it, the reader
 * is owed the reason, and the reason differs by launch - schema-doc.ts names three. This row used to list two of
 * them joined by "or", which reads as a shrug, and omitted the third entirely.
 *
 * The row proves which one applies in two of the three cases and the third is what is left over: a launch found
 * after it was trading never had a creation for us to see, a reconstruction reads history rather than watching it,
 * and everything else is a launch older than the column whose trade rows retention took before the backfill could
 * reach them. Never a claim that no creation transaction exists - one obviously does, on chain, where anyone can
 * find it; we simply did not write down which.
 */
function noCreateSig(t: any, origin: "observed" | "rebuilt"): string {
  const stands = "The figures above stand on our own observation alone, which is weaker than a citation, and we"
    + " would rather say so than leave the gap unmarked.";
  if (t.late_discovery)
    return `Not recorded. We found this token after it was already trading, so we never saw its creation and hold`
      + ` no transaction of ours to cite. ${stands}`;
  if (origin === "rebuilt")
    return `Not recorded. This launch was reconstructed from the bonding curve's transaction history rather than`
      + ` watched, and a reconstruction fills in the figures without ever writing down one creation transaction as`
      + ` the source. The transactions it was read from are published in full in <span class="mono">hist_trades</span>.`;
  return `Not recorded. This launch predates our keeping the creation transaction (2026-09-09), and its trade rows`
    + ` had been pruned by retention before the backfill could recover the signature from them. ${stands}`;
}

/**
 * What this record does not say about this launch, and which cause applies to each.
 *
 * The page could print "unknown" and could not say which unknown, which leaves the two halves of every absence
 * indistinguishable: a count we could never have taken, and one we could have taken and lost. A register that does
 * not separate those is publishing its own coverage as though it were the market's behaviour.
 *
 * Grouped by cause rather than listed column by column, because one cause usually accounts for all of them at once
 * - a venue that does not name traders takes out five columns in a single sentence - and five repetitions of the
 * same clause reads as five problems. Each column name links to its full entry in the published schema, which is
 * the text of record; the clause here is quoted from it (see NOT_RECORDED in provenance.ts).
 *
 * A row rather than a panel. These are blanks in the entry above, so they belong at the foot of the entry and not
 * in a box of their own, and where nothing on the list is blank there is no row at all - the alternative is a
 * standing "nothing missing" line, which would be a completeness claim over the whole row and this only inspects
 * the seven columns the page reasons from.
 *
 * `operator_wallets` and the funder tables are deliberately not here and are not coming. What we hold about a
 * cluster is a claim about a pattern across many launches; printing it on one launch's page, automatically, at this
 * scale, turns a register into an accusation engine. That decision is not a gap to be filled in later.
 */
function absences(t: any, a: Assessment): string {
  const unattributed = venueById(t.venue || "pumpfun")?.tradeAttribution === "none";
  const out: { col: string; cause: string }[] = [];
  const miss = (col: string, cause: string) => out.push({ col, cause });
  if (t.dev_pct == null) miss("dev_pct", NOT_RECORDED.unexplained);
  /*
   * `a.curveBuyers`, not `t.curve_buyers`. The stored column being NULL does not mean the page is showing nothing:
   * `assess` falls back to counting the surviving curve-buy rows, and on a rebuilt launch to the whole-life buyer
   * count. Listing the column as unrecorded while a figure for it sits four rows above is the page contradicting
   * itself, which is worse than either statement alone.
   */
  if (a.curveBuyers === null) miss("curve_buyers", unattributed ? NOT_RECORDED.unattributed : NOT_RECORDED.curveRowsGone);
  if (t.unique_buyers == null) miss("unique_buyers", unattributed ? NOT_RECORDED.unattributed : NOT_RECORDED.unexplained);
  if (t.snap30_buyers == null) miss("snap30_buyers", unattributed ? NOT_RECORDED.unattributed : NOT_RECORDED.noSnapshot);
  if (t.bundled_buyers == null) miss("bundled_buyers", unattributed ? NOT_RECORDED.unattributed : NOT_RECORDED.unexplained);
  // The pair is read together or not at all, exactly as vault_sol and vault_at are, so half of it missing is the
  // whole of it missing. peak_at without peak_price is a state the record build refuses to publish anyway.
  if (t.peak_price == null || t.peak_at == null) miss("peak_price", NOT_RECORDED.noPriceSeen);
  if (!out.length) return "";

  const byCause = new Map<string, string[]>();
  for (const m of out) byCause.set(m.cause, [...(byCause.get(m.cause) ?? []), m.col]);
  const cite = (c: string) =>
    `<a class="mono" href="../data.html#${esc(columnAnchor("tokens", c))}">${esc(c)}</a>`;
  const clauses = [...byCause].map(([cause, cols]) =>
    `${cols.map(cite).join(", ")} &mdash; ${esc(cause)}.`).join(" ");
  return `<tr><td class="k">Not recorded</td><td>${clauses}
    <div class="sub">Each is unknown rather than zero. An unknown never certifies a launch and never counts against
    one; it is the record declining to state something. The column names link to their full entries in the
    published schema, which is where the rest of the reason is written down.</div></td></tr>`;
}

/**
 * The launch in order, to the second, out of the moments the row already holds.
 *
 * Every figure in the table above is a scalar with no time on it, and the record holds five timestamps it has never
 * shown anybody: the creation, the thirty-second snapshot, a creator sale, the curve completing, the highest price
 * we saw. Those are what distinguish a launch that filled over two days from one that filled in the block it was
 * created in - which is the difference the archive exists to record - and they were reachable only by downloading
 * the file.
 *
 * Composed from the row and nothing else: no query, no derivation, no arithmetic beyond the offset from creation.
 * Rows for moments we do not hold are omitted rather than printed as zeroes or as dashes, which is the same rule
 * the sentence in the table above follows and for the same reason - a fabricated zero on a timeline reads as an
 * observed non-event.
 *
 * Sorted by the moment, not by importance, because a sorted list is the only thing that makes it a timeline rather
 * than a second table of the same figures. Ties keep insertion order, which matters: the creation and the buys
 * landing in its own block carry the same timestamp by construction.
 */
function orderOfEvents(t: any, origin: "observed" | "rebuilt", span?: ObservationSpan | null): string {
  if (!t.created_at) return "";
  const rows: { at: number | null; k: string; v: string }[] = [];
  const at = (ms: number) => `<span class="mono">${whenSec(ms)}</span>${ms === t.created_at ? ""
    : ` <span class="sub">${offsetSec(ms - t.created_at)}</span>`}`;

  rows.push({ at: t.created_at, k: "Created", v: `${at(t.created_at)}${t.create_slot
    ? `<div class="sub">Slot ${fmt(t.create_slot)}, which is the chain's own clock for this moment.</div>` : ""}` });

  if (t.bundled_buyers != null)
    rows.push({ at: t.created_at, k: "Creation block", v: t.bundled_buyers > 0
      ? `<b>${fmt(t.bundled_buyers)}</b> wallet${t.bundled_buyers === 1 ? "" : "s"} bought in the block the token was
         created in, before anyone outside could have seen it exist.`
      : `No wallet bought in the block the token was created in.` });

  if (t.snap30_buyers != null)
    rows.push({ at: t.created_at + 30_000, k: "Thirty seconds in", v: `${t.snap30_buyers > 0
      ? `<b>${fmt(t.snap30_buyers)}</b> distinct buyer${t.snap30_buyers === 1 ? "" : "s"}`
      : `<b>No</b> buyer`}${
      // Only where the file carries it: the published record does not, the collector does. See OPTIONAL_TOKEN_COLUMNS.
      typeof t.snap30_buys === "number" ? `, across ${fmt(t.snap30_buys)} buy${t.snap30_buys === 1 ? "" : "s"}` : ""
      }, within the first thirty seconds.<div class="sub">A snapshot taken off a tick at the thirty-second mark, so
      it carries no moment of its own; it is placed here because that is where it happened.</div>` });

  // Present on the collector and not in the published record, so this row appears on an offline build and not on the
  // live site. The boolean is in the table above either way; what is optional here is the moment, never the fact.
  if (typeof t.dev_sold_at === "number")
    rows.push({ at: t.dev_sold_at, k: "Creator sold", v: at(t.dev_sold_at) });

  /*
   * `graduated_confirmed_by` travels with the moment it confirms, in that column's own words. The flag alone
   * overstates graduations by about three quarters, so a completion time printed without saying who confirmed it
   * would be the site's worst-documented number given a new and more authoritative-looking home.
   */
  const confirmed = t.graduated_confirmed_by === "pool"
    ? `Confirmed: a PumpSwap pool was found for it.`
    : t.graduated_confirmed_by === "curve_complete"
      ? `Confirmed against the venue's own completion state.`
      : `Not confirmed. An inference from decoded trade volume that nobody ever confirmed, and where the curve
         account has since been read, the great majority of those returned incomplete.`;
  if (t.graduated_at)
    rows.push({ at: t.graduated_at, k: "Curve completed", v: `${at(t.graduated_at)}<div class="sub">${confirmed}</div>` });
  else if (t.graduated)
    rows.push({ at: null, k: "Curve completed", v: `Recorded as complete; we did not record when.
      <div class="sub">${confirmed}</div>` });

  if (t.peak_price != null && t.peak_at != null)
    rows.push({ at: t.peak_at, k: "Highest price seen", v: `${at(t.peak_at)}
      <div class="sub"><span class="mono">${esc(Number(t.peak_price).toExponential(3))}</span> SOL per token.
      ${t.peak_source === "curve" || t.peak_source === "amm"
        ? `Decoded from an on-chain transaction that executed at that price.`
        : t.peak_source === "external"
          ? `Reported by a third-party price feed with no trade witnessed, which is a materially weaker claim than a
             decoded one.`
          : t.peak_source === "recomputed"
            ? `Recovered from the prices we still held when the launch was finalised, rather than witnessed as it
               happened.`
            : `Source not recorded, which is every row written before 2026-09-10 - never that the peak was
               unsourced.`}
      A peak only ratchets, so read it as a floor: it is what we saw, and a spike between observations is not
      here.</div>` });

  /*
   * Two moments are not a timeline, and a launch that never graduated and never moved a price has exactly one. The
   * section would then be its own creation date restated under a second heading.
   */
  if (rows.length < 2) return "";
  rows.sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity));

  /**
   * The clock, stated once and up front rather than hedged per row.
   *
   * These are receipt times - the moment our collector decoded the event, not the block's own timestamp - and to
   * print seconds without saying so is to assert a precision the column does not carry. Events decoded in one batch
   * share a timestamp, so ordering inside a batch is not established either. `create_slot` is the one figure here
   * that is the chain's own clock, which is why it sits on the creation row.
   */
  const clock = `<p class="sub">Times are receipt times: the moment we decoded the event, not the block's own
    timestamp. Events that arrived in one batch carry one timestamp, so ordering within a batch is not established,
    and a second or two here is our latency rather than the chain's.</p>`;

  return `<h2>Order of events</h2>
    <table>${rows.map((r) => `<tr><td class="k">${r.k}</td><td>${r.v}</td></tr>`).join("")}</table>
    ${clock}${coverageNote(t, origin, span)}`;
}

/**
 * Whether the collector was connected for the whole of what is listed above it.
 *
 * This is the sentence that gives every absence on the page its meaning. "No buyer in the first thirty seconds" and
 * "we were not listening for the first thirty seconds" are opposite statements and, until this line, the record
 * printed the first when it could only support the second. `runs` has held the answer since the beginning and no
 * page has ever read it for a single launch: it was used to decide whether a launch was judgeable at all, which is
 * the coarsest question it can answer.
 *
 * The claim is made only where the window genuinely spans the launch's whole observation, and the other two cases
 * say less rather than saying it more quietly. That asymmetry is deliberate: the failure mode here is a clean
 * result about a token nobody saw, and it cannot be walked back.
 *
 * The window's end is never the present moment. index.ts stamps `runs.stopped_at` with the last launch that
 * actually arrived on that venue, precisely so that a collector which is alive and deaf writes a truthful gap
 * instead of a timer's reassurance - so a window here is proof of ingestion and not proof of uptime, and that is
 * the whole reason it is worth printing.
 */
function coverageNote(t: any, origin: "observed" | "rebuilt", span?: ObservationSpan | null): string {
  if (span === undefined) return "";
  const label = venueById(t.venue || "pumpfun")?.label ?? "launch";
  if (span === null)
    return `<p class="callout">Coverage across this launch is not established: no observation window we recorded
      covers ${whenSec(t.created_at)} on ${esc(label)}.${origin === "rebuilt"
        ? ` This record was read back from chain history rather than watched, which is why.`
        : ""} Nothing above rests on a claim that we were connected, and an absence above may be ours.</p>`;
  const ran = `Our ${esc(label)} feed ran without a recorded break from <span class="mono">${whenSec(span.from)}</span>
    to <span class="mono">${whenSec(span.to)}</span>`;
  if (span.spans)
    return `<p class="callout">Continuously connected across this launch. ${ran}, which contains every moment above.
      The heartbeat behind that window is stamped with the last launch that actually arrived, so a collector that was
      running and deaf records a gap rather than coverage &mdash; which is what makes an absence above an absence in
      what happened rather than a hole in our watching.</p>`;
  return `<p class="callout">Connected at the creation, and not demonstrably throughout. ${ran}, and the last moment
    listed above falls after that. We cannot say we were connected for all of it, so anything not recorded after
    <span class="mono">${whenSec(span.to)}</span> may be ours rather than the launch's.</p>`;
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
    <tr><td class="k">Outside buyers</td><td><b>${a.curveBuyers === null ? "unknown" : fmt(a.curveBuyers)}</b> distinct wallets, not counting the creator, bought on the bonding curve${
      /*
       * Each figure appears only where we have it. `?? 0` stood here and printed a fabricated zero: on a venue whose
       * trade events carry no wallet these columns are NULL, and "0 within the first 30s" beside "unknown" is a
       * measurement the record does not hold, in the sentence a reader reads first. Two nulls, two omissions, and
       * where both are missing the sentence simply ends.
       */
      ""}${origin === "observed" && (t.snap30_buyers != null || t.bundled_buyers != null)
        ? `: ${[t.snap30_buyers != null ? `${fmt(t.snap30_buyers)} within the first 30s` : null,
               t.bundled_buyers != null ? `${fmt(t.bundled_buyers)} bundled into the creation block` : null]
              .filter(Boolean).join(", ")}.`
        : "."}</td></tr>
    <tr><td class="k">Graduated</td><td>${
      /*
       * "yes" was the fallback for a NULL graduated_at, so every watched launch that never completed its curve was
       * told, on its own page, that it graduated. Not an edge case: most launches never graduate, and this row was
       * printing the opposite of the record for all of them. Found by rendering a page rather than by reading the
       * code, which is how every fault of this shape here has been found.
       *
       * Never completing a curve is the ordinary way a token dies and is not evidence of anything, so the negative
       * says what we observed and stops there.
       */
      // curveAge() already ends in "after launch"; the literal beside it printed the phrase twice on every
      // graduated launch's page. The other four callers pass it unadorned, which is what made this visible.
      t.graduated_at ? curveAge(t.graduated_at - t.created_at)
        : t.graduated ? "yes; we did not record when"
        : "not while we were watching"}</td></tr>
    ${/*
        Whether we went and read the curve account ourselves, and what it said.
        
        The feed emits a threshold event; that event is not the curve. We read the account on chain and 5,218 of the
        8,095 curves we have checked turned out to be incomplete: the event fired and the curve had not finished.
        The check was written into the record, published in the bulk file, and exposed in the API as
        `graduationCheck`, and then appeared on no page a human reads. Every consumer that could reach it was a
        machine. That is this codebase's own recurring fault wearing a product's clothes.
        
        Stated as a reading with the moment it was taken, never as a verdict. A launch we have not checked says so:
        an unchecked curve is not a disproved one, and the difference is the whole point of writing it down.
      */ ""}
    <tr><td class="k">Curve, read on chain</td><td>${t.curve_checked_at == null
      /*
       * The unread message asserted "we have the feed's graduation event" on every launch, including the majority
       * that never produced one. The same presupposition as the row above and found in the same pass: this table
       * was written for graduated launches and then shown for all of them. Where there is no graduation on record
       * there is nothing to confirm, and saying so is shorter and true.
       */
      ? (t.graduated_at || t.graduated
        ? `<span class="sub">Not read. We have the feed's graduation event and have not confirmed it against the curve account itself. That is a gap in our checking, not a finding about this launch.</span>`
        : `<span class="sub">Not read. No graduation was recorded for this launch, so there was nothing to confirm against the curve account. Never completing a curve is the ordinary way a token dies, and is not a finding about it.</span>`)
      : t.curve_complete == null
        ? `<b>Read, and the account had gone.</b> We went to the bonding curve account
           ${ago(Date.now() - Number(t.curve_checked_at))} and it no longer existed, so the reading settles nothing
           either way. <span class="sub">Read ${when(Number(t.curve_checked_at))}.</span>`
      : t.curve_complete
        ? `<b>Complete.</b> We read the bonding curve account ${ago(Date.now() - Number(t.curve_checked_at))} and it
           was finished. <span class="sub">Checked ${when(Number(t.curve_checked_at))}.</span>`
        : `<b>Incomplete.</b> We read the bonding curve account ${ago(Date.now() - Number(t.curve_checked_at))} and it
           had <b>not</b> finished, though a graduation event was recorded for it. This launch is not counted as a
           graduation anywhere on this site. <span class="sub">Checked ${when(Number(t.curve_checked_at))}.</span>`}</td></tr>
    <tr><td class="k">Creator sold</td><td>${
      /*
       * NULL is a third answer here and it arrived with the second venue: a venue whose trade events carry no
       * wallet cannot tell a creator's sale from anyone else's, so `dev_sold` is neither 1 nor 0. "Not while we
       * watched" would be a claim we did not observe, in the direction that reassures.
       */
      t.dev_sold == null ? "not recorded - this venue's trades do not name the wallet"
        : t.dev_sold ? "yes" : origin === "observed" ? "not while we watched" : "no"}</td></tr>
    ${/*
        The transaction every figure above was decoded from. Absence is stated as ours, not the launch's: a launch
        that predates this column, or whose trade rows retention took before the backfill reached them, has no
        signature on file and that is a gap in our record rather than anything about the token.
      */ ""}
    <tr><td class="k">Recorded from</td><td>${t.create_sig
      ? `${txLink(t.create_sig)}${t.create_slot ? ` <span class="sub">slot ${fmt(t.create_slot)}</span>` : ""}
         <div class="sub">The transaction this record was decoded from. Every figure above is in it. Fetch it and check us.</div>`
      : `<span class="sub">${noCreateSig(t, origin)}</span>`}</td></tr>${absences(t, a)}`
    : `<tr><td class="k">Launch</td><td>Not observed. ${t.late_discovery ? "Found only after it was already trading." : "The collector was down when it launched."}</td></tr>`;

  const selfBought = !!a.buyout && !!t.creator && a.buyout.wallet === t.creator;
  const boBlock = a.buyout ? `<h2>Who took the curve</h2>
    <p class="mono"><a href="../w/${esc(a.buyout.wallet)}.html">${esc(a.buyout.wallet)}</a>${selfBought
      ? ` <b class="serif">(the creator's own wallet)</b>` : ""}</p>
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

  // How the record was obtained is part of the record. A rebuild is the same transactions, read later - but it cannot
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
        Identical bytes, matched by sha256: not a similar image, the same one.
        <a href="../i/${esc(priors.imageSha)}.html">See them all &rarr;</a></td></tr>`);
    else if (priors.sameImage === 0)
      bits.push(`<tr><td class="k">This picture</td><td>No other launch we hold a picture for used this one.</td></tr>`);
    if (priors.byCreator > 0)
      bits.push(`<tr><td class="k">This creator</td><td><b>Has launched ${fmt(priors.byCreator + 1)} tokens${
        priors.creatorFlagged > 0 ? `, ${fmt(priors.creatorFlagged)} of them with findings on record` : ""}.</b>
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
   * The token above is called "Cobie" - a real person - and until now this page could report that the creator took
   * 79% of supply while never showing the claim that makes the launch worth reporting. The name, the description
   * and the picture are the impersonation; the on-chain figures are only how it was funded.
   *
   * The picture is served from the bytes we captured at launch, addressed by their own sha256, NEVER hot-linked
   * from the URI. The URI is the creator's to repoint, so rendering it live would put whatever they serve today
   * onto a page that says "what this launch claimed at birth" - this site's own besetting error, committed on the
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
          t.meta_bytes ? ` · ${fmt(t.meta_bytes)} bytes` : ""}<br><span class="sub"><a href="../d/${esc(t.mint)}">Read the
          document</a>, the bytes themselves rather than our reading of them. The hash above is what the record commits to,
          so anyone can check the two agree.</span></td></tr>` : ""}
        ${t.image_sha256
          ? `<tr><td class="k">Picture held</td><td><span class="mono">sha256 ${esc(t.image_sha256)}</span>${
              t.image_bytes ? ` · ${fmt(t.image_bytes)} bytes` : ""}</td></tr>`
          : `<tr><td class="k">Picture</td><td>Not captured${t.image ? ", so we cannot show what it published" : ", this launch declared none"}. ${
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
        the reader's scepticism. 24,494 launches carry no creation transaction, because their trade rows were pruned before
        we began keeping it, and telling their readers the figures are checkable, on a page that offers nothing to
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
      ${(() => { const L = venueLink(t.venue, t.mint); return L ? `<a href="${esc(L.href)}" rel="noopener nofollow">${esc(L.label)}</a>` : ""; })()}
    </div>
    <script>function cp(){navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('mint').textContent).then(function(){
      var b=document.getElementById('cpb'),o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1200)})}</script>
    ${provenance}
    ${a.flags.map((f) => `<div class="flag ${f.level}"><span class="tag ${f.level}">${ENTRY_WORD[f.level] ?? "entry"}</span>${esc(f.text)}</div>`).join("")}
    <h2>At launch</h2><table>${rows}</table>${orderOfEvents(t, origin)}${priorsBlock}${boBlock}${nowBlock}${claimed}
    <div class="sec"><h2>Check another</h2></div>${SEARCH}`;
}

/**
 * The front page, rendered from data rather than built into a file.
 *
 * It exists here because the page is now produced two ways - `site.ts` writes it during a build, `serve.ts` renders it
 * per request - and a registry whose front page disagrees with itself depending on how you arrived is not a registry.
 * Same rule as the token page: one renderer, two callers.
 *
 * It states two ages, deliberately, because it has two kinds of fact on it. The counts come from an archive the
 * service pulls periodically, so they are current as of when that archive was built. The liquidity readings are
 * refreshed continuously and are minutes old at most. A single "now" covering both would be false about one of them,
 * and the honest version reads better anyway: nobody else can print when their number was taken.
 */
/**
 * `poolSol` and `readAt` are null when there is no reading fresh enough to quote. That is not a fact about the
 * token - it is a fact about our pool coverage - so the row still appears and says which it is.
 */
export interface CleanRow { mint: string; symbol: string | null; devPct: number; buyers: number; fillMs: number | null; poolSol: number | null; readAt: number | null; liquid: boolean }
export interface OpRow { wallet: string; taken: number; spent: number; sold: number; bought: number }
/** A cluster on the front page. Mirrors ClusterRow in operator.ts, which is where the arithmetic lives. */
export interface HomeCluster { cluster: string; funded: number; used: number; curves: number; sol: number; last: number }
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
  /**
   * The cumulative finding, across the whole archive rather than the window above.
   *
   * Every other count here describes a window and moves hourly, which is right for a front page and useless as a
   * statement about the market. This is the one number that says what the archive has established: of every curve
   * we watched from its creation transaction and confirmed against the curve account, how many completed without a
   * single outside buyer. It is the claim worth being known for, and it was reachable only from a footer link.
   */
  everWatched: number; everNoBuyer: number;
  windowDays: number; gradWindow: number; cleanBirthWindow: number; unchecked: number; unread: number; unchecked24h: number;
  cleanRows: CleanRow[]; wallets: number; opRows: OpRow[]; clusterRows: HomeCluster[];
  /** What we actually found in the window, itemised. Counts overlap: one launch can carry several. */
  findings: { label: string; n: number }[];
  /**
   * The most recent published report, or null before anything is published.
   *
   * The only dated, fixed thing the front page points at. Every other figure here is a window that moves and is
   * labelled with its own age; this one does not move, which is the whole reason it exists and the reason it is
   * worth a block of its own rather than a line in the footer.
   */
  latestReport: { slug: string; title: string; published: string; publishedLong: string; summary: string } | null;
  /** Records to open, for the visitor who has no address to paste. Newest first, uncurated. */
  startHere: { mint: string; symbol: string | null; label: string; level: Verdict["level"]; at: number }[];
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
  return `${fmt(h.danger24h)} of ${fmt(h.graduated24h)} launches have findings on record`;
}

/**
 * How many rows of each table the front page shows before handing off to its own page.
 *
 * It used to show all of them: fifteen wallets, ten operator groups and forty clean launches, sixty-five rows of
 * data in three identically shaped blocks, each preceded by a grey lede and followed by a grey caveat. Length was
 * doing the work that hierarchy should have done, and the longest table on the page - forty rows - belonged to the
 * weakest claim on it. Enough rows to establish what a table holds, then a link to the whole of it.
 */
const HOME_PREVIEW = 6;
const HOME_CLEAN_PREVIEW = 8;

/** One row of the clean list. Shared by the front page's preview and the full list at /clean.html. */
function cleanRowHtml(r: CleanRow, now: number): string {
  return `<tr>
    <td><a href="t/${esc(r.mint)}.html">${esc(r.symbol ?? "?")}</a></td><td class="num">${r.devPct.toFixed(1)}%</td>
    <td class="num">${fmt(r.buyers)}</td><td class="num">${r.fillMs === null ? "?" : dur(r.fillMs)}</td>
    ${r.poolSol !== null && r.readAt !== null
      ? `<td class="num${r.liquid ? "" : " thin"}">${r.poolSol.toFixed(0)} SOL</td><td class="num">${ago(now - r.readAt)}</td>`
      : `<td class="num mut">not read</td><td class="num mut"></td>`}</tr>`;
}
export const CLEAN_HEAD = `<tr><th>Token</th><th class="num">Creator kept</th><th class="num">Buyers</th>
  <th class="num">Time to fill</th><th class="num">Liquidity</th><th class="num">Read</th></tr>`;

/** One row of the wallet list. Shared by the front page's preview and the full list at /wallets.html. */
export function opRowHtml(x: OpRow): string {
  return `<tr><td class="mono"><a href="w/${esc(x.wallet)}.html">${esc(x.wallet.slice(0, 12))}…</a></td>
    <td class="num">${x.taken}</td><td class="num">${fmt(x.spent)} SOL</td>
    <td class="num">${fmt(x.sold)} SOL</td><td class="num">${fmt(x.bought)} SOL</td></tr>`;
}
export const OPS_HEAD = `<tr><th>Wallet</th><th class="num">Curves taken</th><th class="num">Spent</th>
  <th class="num">Sold after</th><th class="num">Bought back</th></tr>`;

/** One row of the operator list. Shared by the front page's preview and the full list at /operators.html. */
export function clusterRowHtml(c: HomeCluster, now: number): string {
  return `<tr>
    <td class="mono"><a href="o/${esc(c.cluster)}.html">${esc(c.cluster)}</a></td>
    <td class="num">${fmt(c.funded)}</td><td class="num">${fmt(c.used)}</td>
    <td class="num">${fmt(c.curves)}</td><td class="num">${fmt(c.sol)} SOL</td>
    <td class="num mut">${ago(now - c.last)}</td></tr>`;
}
export const CLUSTERS_HEAD = `<tr><th>Operator</th><th class="num">Wallets funded</th><th class="num">Wallets used</th>
  <th class="num">Curves taken</th><th class="num">Spent</th><th class="num">Last seen</th></tr>`;

export function homeBody(h: Home): string {
  const p = h.proof;
  const rows = h.cleanRows.slice(0, HOME_CLEAN_PREVIEW).map((r) => cleanRowHtml(r, h.now)).join("");
  const ops = h.opRows.slice(0, HOME_PREVIEW).map(opRowHtml).join("");
  const clusters = h.clusterRows.slice(0, HOME_PREVIEW).map((c) => clusterRowHtml(c, h.now)).join("");
  const between = Math.max(0, h.graduated24h - h.danger24h - h.cleanBirth24h);
  /**
   * The headline names the single most common finding, with its count.
   *
   * It was the whole partition in one forty-word sentence set at 40px - the reader met the subject on line three,
   * and the two numbers that carry the story were buried mid-clause. A headline is short, and this project's own
   * rule is to say WHAT was found rather than that something was found, which rules out "476 carry a finding": it
   * counts a thing the reader has no name for. So the commonest finding leads, by name and by count, and the
   * sentence that was the headline is now the standfirst under it, where a sentence of that length belongs.
   *
   * Generated rather than written, so it stays true as the mix shifts. `findings` is already ordered by frequency.
   */
  const top = h.findings[0];
  const headline = top
    ? `On <em>${fmt(top.n)}</em> of ${fmt(h.graduated24h)} launches, ${esc(top.label)}.`
    : `${fmt(h.graduated24h)} launches finished a bonding curve.`;
  return `
  <div class="front">
    <div class="lead">
      <p class="kicker">${h.windowEnd && h.now - h.windowEnd > 3600_000
        ? `The 24 hours to ${sameUtcDay(h.now, h.windowEnd) ? `${when(h.windowEnd).slice(11)} today` : when(h.windowEnd)}`
        : "The last 24 hours"}</p>
      <h1>${headline}</h1>
      <p class="stand">${fmt(h.graduated24h)} tokens finished their bonding curve. On <b>${fmt(h.danger24h)}</b> the
      creator kept the supply, bought their own curve, or the curve filled in seconds with almost no one outside
      buying.</p>
      <div class="twoup">
        <p>We checked all ${fmt(h.graduated24h)}. ${h.cleanBirth24h === 0
          ? `<strong>Not one was free of all of it.</strong>`
          : `<strong>${fmt(h.cleanBirth24h)} showed none of it.</strong>`} The other ${fmt(between)} fall between:
        nothing recorded against them, and still short of one of our tests: most often the creator sold, or
        fewer than ${h.minBuyers} outside wallets bought the curve. Checked, not unexamined.</p>
        <p>All of it is visible for about thirty seconds, and a check run afterwards cannot see it: once the float
        has been spread across wallets, nothing about the launch can be read from the token's present state. The
        events themselves stay on chain, and a launch nobody watched can be decoded again from an archival node,
        slower and marked as a rebuild rather than an observation. This record was taken as it happened, and says
        so where it was not.</p>
      </div>
      ${/* The findings, as figures. A launch can carry more than one, which the note under the row states. */ ""}
      <div class="figs">
        ${h.findings.slice(0, 4).map((f) => `<div><b>${fmt(f.n)}</b><span>${esc(f.label)}</span></div>`).join("")}
        <div class="cl"><b>${fmt(h.cleanBirth24h)}</b><span>none of these</span></div>
      </div>
      <p class="sub" style="margin:12px 0 0">A launch can carry more than one finding, so these add to more than the
      ${fmt(h.danger24h)} that carry at least one.${h.findings.length > 4
        ? ` ${fmt(h.findings.length - 4)} further ${h.findings.length - 4 === 1 ? "finding is" : "findings are"} recorded and not shown here.`
        : ""} Pool balances are read separately and continuously; each carries its own age below.</p>
    </div>
    ${liveRail(h.startHere, h.now)}
  </div>

  ${/* Three ways in: what we have concluded, what we last published, and how to take the whole thing away. */ ""}
  <div class="deck">
    ${h.everWatched > 0 ? `<div>
      <p class="k">What the record shows</p>
      <b class="big">${(100 * h.everNoBuyer / h.everWatched).toFixed(1)}%</b>
      <p>of the ${fmt(h.everWatched)} bonding curves we watched from the creation transaction and confirmed against
      the curve account itself completed with <b>no outside buyer at all</b>. The creator funded the entire
      graduation.</p>
      <a class="go" href="findings.html">The rest of what the record shows &rarr;</a>
    </div>` : ""}
    ${h.latestReport ? `<div>
      <p class="k">Latest report &middot; ${esc(h.latestReport.publishedLong)}</p>
      <h3>${esc(h.latestReport.title)}</h3>
      <p>${esc(h.latestReport.summary)}</p>
      <a class="go" href="reports/${esc(h.latestReport.slug)}.html">Read the report &rarr;</a>
    </div>` : ""}
    <div>
      <p class="k">Take the whole thing</p>
      <h3>${fmt(h.onFile)} launches, public domain</h3>
      <p>The complete record as a single SQLite file, free and CC0, with a permanent DOI deposit, so nothing
      here depends on trusting us to keep publishing it.</p>
      <a class="go" href="data.html">Take the data &rarr;</a>
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
        <li>Mint and freeze authority <b>renounced</b>, which pump.fun does to every token it creates</li>
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
  what a present-tense check reports, not a measurement of ours, and it finds nothing wrong, because by then there
  is nothing left to find: the operator bought the float, then paid for the appearance of a market. A check run at
  step 3 reports thin liquidity, correctly, and far too late to be worth anything. The launch record was true at
  every step, and it is the only thing here that could not be bought.</p>` : ""}

  <div class="sec"><h2>Who takes the curves</h2><span class="cnt">${fmt(h.wallets)} wallets on file${h.opRows.length > HOME_PREVIEW ? ` · busiest ${HOME_PREVIEW} shown` : ""}</span></div>
  <p class="lede">These wallets each completed a bonding curve with a single buy of ${h.buyoutSol} SOL or more, taking
  the whole remaining float in one transaction. Here is what they spent and what they did with the tokens afterwards.
  It needs a wallet's history across many tokens rather than one token's present state, which is why it is here and
  not in a contract scanner.</p>
  <table class="data">${OPS_HEAD}${ops}</table>
  <a class="more" href="wallets.html">All ${fmt(h.wallets)} wallets on file &rarr;</a>

  ${h.clusterRows.length ? `
  <div class="sec"><h2>And they are not working alone</h2><span class="cnt">${fmt(h.clusterRows.length)} groups traced${h.clusterRows.length > HOME_PREVIEW ? ` · busiest ${HOME_PREVIEW} shown` : ""}</span></div>
  <p class="lede">Where we can trace who paid to open a buying wallet, that same address has often opened dozens
  more. These are the groups that have taken the most curves. Each one has a page: every wallet, every purchase,
  the wait between the launch and the buy, and the transaction behind each of them.</p>
  ${/*
      Said here because of what sits directly above it: the wallet table truncates addresses with an ellipsis, so
      a six-character operator name in the next table reads as one more address with its end cut off. It is not an
      address at all, and on a phone the two tables are a thumb apart.
    */ ""}
  <p class="sub">The name in the first column is ours: the first six characters of the address that funded the
  group, used as a label. It is not a shortened wallet address, and each group's page gives the address in full.</p>
  <table class="data">${CLUSTERS_HEAD}${clusters}</table>
  <a class="more" href="operators.html">Every group we have traced &rarr;</a>
  <p class="callout">A shared funder is a lead, not a finding. Trading terminals fund their users from one address
  the same way a wallet farm funds its own, and we cannot tell those apart from the chain alone. What each page
  shows is what the wallets did, with the transaction for every purchase.</p>` : ""}

  <div class="sec"><h2>Checked, no markers found, last ${h.windowDays === 1 ? "24 hours" : `${h.windowDays} days`}</h2><span class="cnt">${fmt(h.cleanBirthWindow)} of ${fmt(h.gradWindow)} graduations${h.cleanBirthWindow > HOME_CLEAN_PREVIEW ? ` · newest ${HOME_CLEAN_PREVIEW} shown` : ""}</span></div>
  <p class="lede">Creator kept under ${h.maxDevPct}% and has not sold, at least ${h.minBuyers} distinct buyers on the curve,
  and the curve took over a minute to fill and was not taken by a single ${h.buyoutSol}+ SOL buy. That means
  <b>none of the patterns we record</b>. It is a statement about the launch record, not about the price: it is not a recommendation, and
  most of these will still lose money.</p>
  ${h.cleanRows.length ? `<table class="data">${CLEAN_HEAD}${rows}</table>
  <a class="more" href="clean.html">All ${fmt(h.cleanBirthWindow)} over ${h.windowDays === 1 ? "the last 24 hours" : `${h.windowDays} days`} &rarr;</a>`
    : `<p class="callout">No launch in this window passed every test on the launch record. That is a finding about the
    window, not about any particular token.</p>`}
  ${/*
      These were one claim until 2026-09-09 and should not have been. A launch record is permanent and is the thing
      this archive holds that nobody can reconstruct; a pool balance decays by the minute and anyone with an RPC key
      can read it. Requiring both to call a launch clean meant an hour of RPC trouble deleted findings about the
      past: 423 launches passed every birth test over seven days and ten were published. The liquidity column is now
      reported beside the claim rather than gating it, and "not read" says so in the row instead of removing it.
    */ ""}
  <p class="callout">Two different claims, kept apart. <b>No markers found</b> is a fact about the first blocks and does
  not expire. <b>Liquidity</b> is one balance read at one moment, shown with its age. ${h.unread
    ? `<b>${fmt(h.unread)}</b> of these have no reading under ${Math.round(h.maxReadingAgeMs / 60000)} minutes old and say <i>not read</i>: a gap in our pool coverage, never a finding about the token. `
    : `Every row here carries a reading under ${Math.round(h.maxReadingAgeMs / 60000)} minutes old. `}A balance shown in red is one we did read, and it is under ${h.minPoolSol} SOL. We never quote a balance we could not confirm.</p>`;
}

/**
 * The most recently recorded launches, on the front page.
 *
 * An archive's "recently added" shelf, not a ticker. The rows come from the same collector feed /live.html reads
 * and reuse its markup and CSS wholesale, so the two cannot drift into different renderings of one feed - only the
 * framing differs, and deliberately: no rate counter, no "arriving now". A number about how busy the feed is tells
 * a reader nothing they came for; whether what they are reading is current tells them everything, so that is what
 * the header carries.
 *
 * The server renders three real records inside the box before any script runs. A visitor with scripting off, or a
 * collector that never answers, gets those and a line saying so - never an empty panel captioned "connecting",
 * which is the one outcome that makes an archive look broken rather than quiet.
 */
export function liveRail(startHere: Home["startHere"], now: number): string {
  return `<aside class="rail">
  <div class="railh">Most recently recorded<span class="rs" id="hstat">latest held</span></div>
  ${/*
      The server-rendered fallback. These are graduated records with verdicts, not new launches, so they have no
      creator share to put in the middle column - rendering an em dash there produced a column of nothing that read
      as a failed load. Two columns instead, under their own class, replaced wholesale the moment the feed answers.
    */ ""}
  <div id="hwall">${startHere.map((r) => `<a class="rrow fb2" href="t/${esc(r.mint)}.html">
    <span class="rs2">${esc(r.symbol ?? "?")}</span>
    <span class="rt">${ago(now - r.at)}</span></a>`).join("")}</div>
  <a class="rmore" href="live.html">The full feed &rarr;</a>
  <p class="rnote">The creator's share is read from the creation transaction, so it is known at the instant of
  creation. Everything else needs time to happen.</p>
</aside>
${/*
    Upgrades the rail to the live feed, and leaves it alone if it cannot.
    
    Rows are built to the shape /live.html uses. On the first poll that returns launches the server-rendered
    records are cleared and replaced; if the collector never answers, or answers that it is unavailable, the
    records stay and the header says why. It never empties the rail to report a problem: a panel captioned
    "connecting" is the one outcome that makes an archive look broken rather than quiet.
  */ ""}
<script>(function(){
  var wall=document.getElementById('hwall'),st=document.getElementById('hstat');
  if(!wall||!window.fetch)return;
  var since=0,MAX=8,live=false,fails=0,stop=false;
  function esc(x){var d=document.createElement('div');d.textContent=x==null?'':String(x);return d.innerHTML;}
  function row(l){
    var a=document.createElement('a');a.className='rrow';a.href='t/'+encodeURIComponent(l.mint)+'.html';
    var pct=(typeof l.devPct==='number')?l.devPct:0;
    a.innerHTML='<span class="rs2">'+esc(l.symbol||'?')+'</span>'+
      '<span class="rd'+(pct>=20?' hi':'')+'">'+pct.toFixed(1)+'%</span>'+
      '<span class="rt">just now</span>';
    a.setAttribute('data-at',String(l.at));
    return a;
  }
  function age(){
    var now=Date.now(),rows=wall.querySelectorAll('.rrow[data-at]');
    for(var i=0;i<rows.length;i++){
      var s=Math.round((now-Number(rows[i].getAttribute('data-at')))/1000),e=rows[i].querySelector('.rt');
      if(e)e.textContent=s<2?'just now':(s<90?s+'s':Math.round(s/60)+'m');
    }
  }
  function pull(){
    if(stop)return;
    fetch('api/live/recent?since='+since,{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
      fails=0;
      if(d.unavailable){st.textContent='unreachable';return}
      var ls=d.launches||[];
      // The first poll asks since=0 and the collector answers with its whole ring - 120 rows on a normal day. The
      // feed is oldest-first and each row is prepended, so only the tail can survive the trim: taking it up front
      // saves building elements to destroy them. Later polls carry only what is new and are unaffected.
      if(ls.length>MAX)ls=ls.slice(ls.length-MAX);
      if(ls.length){
        if(!live){while(wall.firstChild)wall.removeChild(wall.firstChild);live=true}
        for(var i=0;i<ls.length;i++){
          if(ls[i].at>since)since=ls[i].at;
          wall.insertBefore(row(ls[i]),wall.firstChild);
        }
        while(wall.childElementCount>MAX)wall.removeChild(wall.lastElementChild);
      }
      if(live)st.textContent='live';
      age();
    }).catch(function(){
      // Say it, never fake it: a rail that silently stops updating is indistinguishable from a chain that stopped.
      fails++; if(fails>2)st.textContent='interrupted';
      if(fails>20){stop=true;st.textContent='stopped'}
    });
  }
  pull();setInterval(pull,2500);setInterval(age,1000);
})()</script>`;
}

/** A wallet's record: every curve it bought outright, and what it did with the tokens afterwards. */
/**
 * A wallet's record: every curve it bought outright, and what it did with the tokens afterwards.
 *
 * It used to open with the word "Priors" on every wallet page - a term most readers will not decode, saying nothing
 * about whose priors - and then render its verdict as one flag box among the furniture. A reader arrives here from a
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
   * event read with the same confidence as a habit - the reader could only tell them apart by counting the rows.
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
    <div class="sec"><h2>Operator cluster</h2><span class="cnt"><a href="../o/${esc(p.cluster)}.html">${esc(p.cluster)}</a></span></div>
    <table>
      ${p.funder ? `<tr><td class="k">Funded by</td><td class="mono">${esc(p.funder)}</td></tr>` : ""}
      <tr><td class="k">Group</td><td>One of <b>${fmt(p.clusterWallets)}</b> wallets seeded from that funder, which
        together took <b>${fmt(p.clusterCurves)}</b> bonding curve${p.clusterCurves === 1 ? "" : "s"}.
        <a href="../o/${esc(p.cluster)}.html">See the whole cluster</a>, wallet by wallet and curve by curve.</td></tr>
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

/** One row in a list of launches that share something - a picture, or a creator. */
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
 * Oldest first on purpose: the interesting shape is the cadence - a burst of launches minutes apart, or a picture
 * that returns every few days - and that reads forwards, not backwards.
 */
export function siblingsBody(
  kind: "image" | "creator", key: string, rows: SiblingRow[], stats: SiblingStats, now: number, shownCap: number,
  strip = "",
): string {
  /**
   * Every headline figure is computed over the WHOLE set, never over the rows that happen to be displayed.
   *
   * The first version took the span from the listed rows while the heading counted all of them, so a wallet with
   * 1,994 launches was described as spanning 3.2 hours - the span of the oldest 300. Two numbers side by side drawn
   * from different populations, which is the fault this project spent the day removing from its own front page.
   */
  const { total, flagged, grad, span } = stats;
  const title = kind === "image"
    ? `${fmt(total)} launches used this picture`
    : `${fmt(total)} launches by this wallet`;
  const lede = kind === "image"
    ? `Identical bytes, matched by sha256: the same file, not a similar one. We keep the picture because the creator
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
    <td>${r.danger ? `<span class="tag DANGER">${ENTRY_WORD.DANGER}</span>` : ""}</td></tr>`).join("");

  return `
  <div class="hero split"><div class="col-a">
    <h1 class="headline">${title}</h1>
    <p class="lede">${lede}</p>
    ${strip}
    ${kind === "image" ? `<div class="shot"><img src="../i/${esc(key)}" alt="the picture these launches used" loading="lazy"></div>` : ""}
    <p class="mono sub">${esc(key)}</p>
  </div>
  <div class="col-b"><div class="stats" style="margin:4px 0 0">
    <div class="stat"><span>launches</span><b class="big">${fmt(total)}</b></div>
    <div class="stat"><span>with findings on record</span><b class="big">${fmt(flagged)}</b></div>
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
 * the comb is the finding - you see a launch every three minutes without reading a single row. Cadence is the thing
 * serial reuse actually looks like, and it is invisible in any presentation that sorts rather than *places*.
 *
 * Inline SVG on purpose. The pages are self-contained, mirror-able and carry no external request; a charting library
 * would be the first dependency in a file whose credibility partly rests on not having any. Marks are `<a>` elements
 * with a `<title>`, so hover and click work with no JavaScript at all - the script below only adds a readout, and
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

/** One curve buyout on the swimlane: which wallet, which token, when, how big, and how long it waited. */
export interface LaneEvent {
  wallet: string; mint: string; symbol: string | null;
  ts: number; sol: number; createdAt: number | null; danger: boolean;
}

/** How many wallets the swimlane will draw before it starts leaving some out and saying so. */
export const LANES_MAX = 30;

/**
 * The farm swimlane: one lane per wallet, time across, every buyout a dot.
 *
 * The relaunch strip answers "how often does this repeat"; this answers "who did it, and in what order". A farm
 * rotates addresses so that no one of them looks busy, and the rotation is the fingerprint: on a swimlane it reads
 * as a staircase, each lane going quiet as the next one starts, which is a thing no table of 27 rows will ever
 * show and no single wallet page can contain.
 *
 * Three encodings, each carrying a habit the operators cannot help having:
 *   - horizontal position is when, so cadence and the gaps between working days are visible as gaps;
 *   - the dot's area is the size of the buy, so a machine that spends exactly 85 SOL every time draws a line of
 *     identical dots, and the one 50 SOL buy is visibly the odd one;
 *   - the tail behind each dot is the wait between the launch and the purchase, so buying at the moment of launch
 *     (no tail) is distinguishable at a glance from taking a curve that had sat dormant for a day and a half.
 *
 * Same rules as the strip: inline SVG, no dependency, `<a>` and `<title>` so it works with JavaScript off, and
 * overlapping events are left overlapping. Where two buys are a minute apart the dots merge, and that is what a
 * minute apart looks like.
 */
export function swimlane(events: LaneEvent[], walletCurves: Map<string, number>): string {
  if (events.length < 2) return "";

  /**
   * Lanes are ordered by first appearance, so the reader's eye goes down the page in the order the operator brought
   * wallets into service. Sorting by volume would put the busiest lane on top and destroy the staircase, which is
   * the one thing this chart exists to show.
   */
  const firstSeen = new Map<string, number>();
  for (const e of events) if (!firstSeen.has(e.wallet)) firstSeen.set(e.wallet, e.ts);
  let lanes = [...firstSeen.keys()];
  const dropped = Math.max(0, lanes.length - LANES_MAX);
  if (dropped) {
    // When there are too many lanes to draw, keep the busiest ones - but restore first-seen order afterwards, so
    // the chart is still read the same way. The head says how many were left out; it never silently plots a subset.
    const busiest = new Set([...lanes].sort((a, b) => (walletCurves.get(b) ?? 0) - (walletCurves.get(a) ?? 0)).slice(0, LANES_MAX));
    lanes = lanes.filter((w) => busiest.has(w));
  }
  const lane = new Map(lanes.map((w, i) => [w, i]));
  const shown = events.filter((e) => lane.has(e.wallet));

  const t0 = shown[0].ts, t1 = shown[shown.length - 1].ts;
  const span = Math.max(60_000, t1 - t0);
  const W = 1000, LEFT = 96, RIGHT = 12, ROW = 20, TOP = 22, FOOT = 18;
  const H = TOP + lanes.length * ROW + FOOT;
  const plot = W - LEFT - RIGHT;
  const x = (t: number) => LEFT + ((Math.min(Math.max(t, t0), t1) - t0) / span) * plot;
  const y = (w: string) => TOP + (lane.get(w) ?? 0) * ROW + ROW / 2;
  const maxSol = Math.max(...shown.map((e) => e.sol));

  /**
   * Ticks are chosen so their labels can be read, which a fixed unit cannot promise: one day per tick drew a
   * thirty-three day cluster as "08-0408-0508-06" running the width of the chart, and drew an afternoon with no
   * tick at all. The smallest step from the ladder that keeps the count under a dozen wins, so the axis is as fine
   * as it can be without the labels touching.
   */
  const dayMs = 86400_000, hourMs = 3600_000;
  const ladder = [hourMs, 2 * hourMs, 3 * hourMs, 6 * hourMs, 12 * hourMs, dayMs, 2 * dayMs, 7 * dayMs, 14 * dayMs, 28 * dayMs];
  const step = ladder.find((ms) => span / ms <= 12) ?? span / 6;
  const ticks: string[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const px = x(t).toFixed(1);
    const label = step >= dayMs
      ? new Date(t).toISOString().slice(5, 10)
      : new Date(t).toISOString().slice(11, 16);
    ticks.push(`<line x1="${px}" x2="${px}" y1="${TOP - 6}" y2="${H - FOOT}" class="gd"/>` +
      `<text x="${px}" y="${TOP - 10}" class="gl" text-anchor="middle">${label}</text>`);
  }

  const rows = lanes.map((w, i) => {
    const ly = TOP + i * ROW + ROW / 2;
    const n = walletCurves.get(w) ?? 0;
    return `<line x1="${LEFT}" x2="${W - RIGHT}" y1="${ly}" y2="${ly}" class="ln"/>` +
      `<a href="../w/${esc(w)}.html"><title>${esc(w)}</title>` +
      `<text x="0" y="${ly + 3.5}" class="lw">${esc(w.slice(0, 6))}</text>` +
      `<text x="${LEFT - 12}" y="${ly + 3.5}" class="lc" text-anchor="end">${n}</text></a>`;
  }).join("");

  const dots = shown.map((e) => {
    const cx = x(e.ts), cy = y(e.wallet);
    // Area with the size of the buy, floored so the smallest is still a target worth clicking.
    const r = Math.max(2.6, 6.5 * Math.sqrt(e.sol / maxSol));
    const wait = e.createdAt === null ? "" : ` · bought ${curveAge(e.ts - e.createdAt)}`;
    const label = `${esc(e.symbol ?? "?")} · ${when(e.ts)} · ${e.sol.toFixed(0)} SOL · ${esc(e.wallet.slice(0, 6))}${wait}`;
    // The tail is drawn only when we hold the launch time. Where we do not, there is no tail rather than a tail of
    // length zero, which would read as "bought at launch" - the archive's oldest rule: absence is not a finding.
    const tail = e.createdAt !== null && e.createdAt < e.ts
      ? `<line x1="${x(e.createdAt).toFixed(1)}" x2="${cx.toFixed(1)}" y1="${cy}" y2="${cy}" class="wt"/>` : "";
    return `${tail}<a href="../t/${esc(e.mint)}.html" class="dot${e.danger ? " d" : ""}" data-l="${label}">` +
      `<title>${label}</title><circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r.toFixed(1)}"/></a>`;
  }).join("");

  return `
  <div class="lane">
    <div class="striphead"><b>${fmt(shown.length)}</b> curve buyouts by <b>${fmt(lanes.length)}</b> wallets${
      dropped ? ` · busiest ${LANES_MAX} of ${fmt(lanes.length + dropped)} wallets drawn` : ""}
      <span class="readout" id="ro">hover a dot</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="One row per wallet, time left to right. Each dot is one bonding curve bought outright; the dot's size is what it cost and the line behind it is the wait between the token's launch and the purchase.">
      ${ticks.join("")}${rows}${dots}
    </svg>
    <div class="stripfoot"><span>${when(t0)}</span><span>${dur(span)} wide · dot area is the size of the buy, the tail behind it is the wait since launch</span><span>${when(t1)}</span></div>
  </div>
  <script>(function(){var s=document.currentScript.previousElementSibling,r=s.querySelector('#ro');
    s.addEventListener('mouseover',function(e){var g=e.target.closest('.dot');if(g)r.textContent=g.getAttribute('data-l');});
    s.addEventListener('mouseleave',function(){r.textContent='hover a dot';});})();</script>`;
}

/**
 * An operator cluster: the group, not the wallet.
 *
 * Wallet pages have named the cluster since they were written and there was nowhere to go from it. That is the
 * failure this repo keeps repeating in a different costume - the attribution was computed, stored, published in the
 * record, printed on the page as a bare six-character string, and left as a dead end. The reader who most needs
 * this page is the one who has just been told "one of 66 wallets seeded from one funder" and reasonably asks to
 * see the other sixty-five.
 *
 * What the page will not do is call it fraud. A shared funder is a funder; trading terminals seed their customers
 * from one address exactly as a farm seeds its own wallets, and that caveat sits above the evidence rather than
 * under it, because a reader who stops halfway must not leave with the stronger claim.
 */
export function clusterBody(p: {
  cluster: string; funders: { funder: string; wallets: number }[]; policy: string | null;
  wallets: { wallet: string; role: string | null; curves: number; sol: number }[];
  events: LaneEvent[]; curves: number; sol: number;
  sigs: Map<string, string | null>;
}): string {
  const used = p.wallets.filter((w) => w.curves > 0);
  const span = p.events.length > 1 ? p.events[p.events.length - 1].ts - p.events[0].ts : 0;
  const walletCurves = new Map(p.wallets.map((w) => [w.wallet, w.curves]));

  /**
   * The repeated figure, if there is one. A farm that spends the same amount every time is the clearest single
   * sentence this page can offer, and it is arithmetic rather than judgement: the most common rounded buy size,
   * and how much of the group's activity it accounts for.
   */
  const sizes = new Map<number, number>();
  for (const e of p.events) sizes.set(Math.round(e.sol), (sizes.get(Math.round(e.sol)) ?? 0) + 1);
  const [modeSol, modeN] = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  const habit = modeN >= 3 && modeN / p.events.length >= 0.5
    ? `<p class="vscope">Of ${fmt(p.events.length)} purchases, <b>${fmt(modeN)}</b> were the same size to the nearest
       SOL: <b>${fmt(modeSol)} SOL</b>. Repetition at that precision is a configured amount, not a decision taken
       ${modeN} separate times.</p>`
    : "";

  const atLaunch = p.events.filter((e) => e.createdAt !== null && e.ts - e.createdAt < 15 * 60_000).length;
  const timed = p.events.filter((e) => e.createdAt !== null).length;

  const rows = p.events.slice().reverse().map((e) => {
    const sig = p.sigs.get(`${e.wallet} ${e.mint}`);
    return `<tr><td>${when(e.ts)}</td>
      <td><a href="../t/${esc(e.mint)}.html">${esc(e.symbol ?? "?")}</a></td>
      <td class="mono"><a href="../w/${esc(e.wallet)}.html">${esc(e.wallet.slice(0, 6))}</a></td>
      <td class="num">${e.sol.toFixed(0)} SOL</td>
      <td class="mut">${e.createdAt === null ? "launch time not on record" : curveAge(e.ts - e.createdAt)}</td>
      <td>${sig ? txLink(sig) : `<span class="mut">no signature on record</span>`}</td></tr>`;
  }).join("");

  const walletRows = p.wallets.map((w) => `<tr>
    <td class="mono"><a href="../w/${esc(w.wallet)}.html">${esc(w.wallet)}</a></td>
    <td class="mut">${esc(w.role ?? "unknown")}</td>
    <td class="num">${w.curves || ""}</td>
    <td class="num">${w.curves ? `${fmt(w.sol)} SOL` : ""}</td></tr>`).join("");

  return `
    ${/*
        A short name is fine; a short name that looks like a chopped address is not, and that is what this was.
        `operator_wallets.cluster` holds the first six characters of a funding address, so the heading read as an
        address with the end missing - reported from a phone, where it is the first thing on the screen. It stays
        short, because it is what we call the group and it is what the URL and every link to this page use. The
        line under it says so, and the address itself is in the table below, in full and unabbreviated.
      */ ""}
    <h1>Operator cluster <span class="mono">${esc(p.cluster)}</span></h1>
    <p class="sub"><span class="mono">${esc(p.cluster)}</span> is our name for this group rather than an address:
      the first six characters of the ${p.funders.length > 1 ? "address at the root of its funding chain" : "wallet that funded it"}.</p>
    <p class="lede">${fmt(p.wallets.length)} wallet${p.wallets.length === 1 ? "" : "s"} funded from ${
      p.funders.length > 1 ? `${fmt(p.funders.length)} addresses that trace to one` : "one address"}.
      ${used.length ? `<b>${fmt(used.length)}</b> of them bought <b>${fmt(p.curves)}</b> bonding curve${p.curves === 1 ? "" : "s"}
      outright for <b>${fmt(p.sol)} SOL</b>${span ? `, over ${dur(span)}` : ""}.` : `None of them has bought a bonding curve outright in this archive.`}</p>
    <p class="callout">A shared funder is a lead, not a finding. Trading terminals fund their users from one address
      the same way a wallet farm funds its own, and we cannot tell those apart from the chain alone. What is on this
      page is what the wallets did, with the transaction for each one; who controls them is not something we claim
      to know.</p>
    ${habit}
    <div class="stats" style="margin:20px 0">
      <div class="stat"><span>wallets funded</span><b class="big">${fmt(p.wallets.length)}</b></div>
      <div class="stat"><span>wallets used</span><b class="big">${fmt(used.length)}</b></div>
      <div class="stat"><span>curves taken</span><b class="big">${fmt(p.curves)}</b></div>
      <div class="stat"><span>spent on curves</span><b class="big">${fmt(p.sol)}</b> SOL</div>
    </div>
    ${p.funders.length ? `<table>${p.funders.length === 1
      ? `<tr><td class="k">Funded by</td><td class="mono">${esc(p.funders[0].funder)}</td></tr>`
      : `<tr><td class="k">Funded by</td><td>
        <b>${fmt(p.funders.length)}</b> different addresses, which is why this group is named after the first six
        characters of the one at the root of the chain rather than after an address of its own.
        ${p.funders.map((f) => `<div class="mono">${esc(f.funder)} <span class="mut">· ${fmt(f.wallets)} wallet${f.wallets === 1 ? "" : "s"}</span></div>`).join("")}</td></tr>`}
      ${p.policy ? `<tr><td class="k">Cluster behaviour</td><td>${esc(p.policy)}</td></tr>` : ""}
      ${timed ? `<tr><td class="k">Bought at launch</td><td><b>${fmt(atLaunch)}</b> of ${fmt(timed)} purchases came
        within fifteen minutes of the token being created${timed < p.events.length
          ? `. The remaining ${fmt(p.events.length - timed)} are of tokens launched before this archive began, so their launch time is not on our record` : ""}.</td></tr>` : ""}</table>` : ""}
    ${swimlane(p.events, walletCurves)}
    ${p.events.length ? `<div class="sec"><h2>Every curve this cluster took</h2><span class="cnt">${fmt(p.events.length)} on file</span></div>
    <table class="data"><tr><th>When</th><th>Token</th><th>Wallet</th><th class="num">Size</th><th>Timing</th><th>Transaction</th></tr>${rows}</table>` : ""}
    <div class="sec"><h2>Wallets in the cluster</h2><span class="cnt">${fmt(p.wallets.length)} funded</span></div>
    <table class="data"><tr><th>Wallet</th><th>How it was found</th><th class="num">Curves</th><th class="num">Spent</th></tr>${walletRows}</table>
    <div class="sec"><h2>Check a token</h2></div>${SEARCH}`;
}

/**
 * The live wall: launches arriving as they happen.
 *
 * Everything else on this site is a record - something that already happened, looked up afterwards. This is the only
 * page that shows the instrument working, and it is the clearest possible statement of what the archive is: not a
 * database someone assembled, but a machine that was watching at the time. A visitor who sees a launch appear, and
 * the creator's share appear beside it a second later, understands the whole product without reading a word of it.
 *
 * It is also the honest demonstration of the base rate. Nobody believes "most launches are manufactured" from a
 * statistic; watching them scroll past with the creator holding 79% of supply is a different kind of argument.
 *
 * The page holds no state worth keeping and makes no claim beyond what each row says. Rows link to the record, which
 * is where the evidence and the caveats live - the wall is a window, not a verdict.
 */
/**
 * The three lists in full: every wallet on file, every operator group we have traced, every launch in the window
 * that carries no marker.
 *
 * They existed only as the front page's bottom third, truncated to whatever fitted - and truncated is the wrong
 * shape for a register. Nothing here is a new claim: each page renders the same rows, from the same query, through
 * the same row builder the front page uses, so a figure cannot differ between the preview and the list it
 * previews. What is new is that the rows past the preview are published at all.
 *
 * Every one of them states its own bound. A page that shows the first 250 of 2,401 and does not say so is telling
 * a reader they have seen the register.
 */
function listPage(head: { title: string; count: string; lede: string; back: string }, table: string, foot = ""): string {
  return `<div class="sec"><h2>${esc(head.title)}</h2><span class="cnt">${head.count}</span></div>
  <p class="lede">${head.lede}</p>
  ${table}
  ${foot}
  <a class="more" href="${HOME_HREF}">&larr; ${esc(head.back)}</a>`;
}

export function walletsBody(rows: OpRow[], total: number, shown: number, buyoutSol: number): string {
  return listPage({
    title: "Who takes the curves",
    count: `${fmt(total)} wallets on file${shown < total ? ` · busiest ${fmt(shown)} shown` : ""}`,
    lede: `Every wallet that has completed a bonding curve with a single buy of ${buyoutSol} SOL or more, taking the
      whole remaining float in one transaction, ordered by how much they sold into the market afterwards.
      Each address links to its own record: every curve it took, what it paid, and the transaction behind each buy.`,
    back: "Back to the front page",
  }, `<table class="data">${OPS_HEAD}${rows.map(opRowHtml).join("")}</table>`,
    shown < total
      ? `<p class="callout">The ${fmt(shown)} busiest of ${fmt(total)}. The rest are in the archive and reachable by
         address; this page is bounded so it stays a page rather than a download. The whole table is in
         <a href="data.html">record.db</a>.</p>`
      : "");
}

export function operatorsBody(rows: HomeCluster[], now: number, shown: number, capped: boolean): string {
  return listPage({
    title: "And they are not working alone",
    count: `${fmt(shown)} groups traced`,
    lede: `Where we can trace who paid to open a buying wallet, that same address has often opened dozens more.
      These are the groups, ordered by curves taken. Each one has a page: every wallet, every purchase, the wait
      between the launch and the buy, and the transaction behind each of them. A group of one wallet is a wallet,
      so it is not listed here.`,
    back: "Back to the front page",
  }, `<p class="sub">The name in the first column is ours: the first six characters of the address that funded the
      group, used as a label. It is not a shortened wallet address, and each group's page gives the address in
      full.</p>
    <table class="data">${CLUSTERS_HEAD}${rows.map((c) => clusterRowHtml(c, now)).join("")}</table>`,
    `<p class="callout">A shared funder is a lead, not a finding. Trading terminals fund their users from one
      address the same way a wallet farm funds its own, and we cannot tell those apart from the chain alone. What
      each page shows is what the wallets did, with the transaction for every purchase.${capped
        ? ` This page is bounded; the whole table is in <a href="data.html">record.db</a>.` : ""}</p>`);
}

export function cleanBody(h: Home): string {
  return listPage({
    title: `Checked, no markers found, last ${h.windowDays === 1 ? "24 hours" : `${h.windowDays} days`}`,
    count: `${fmt(h.cleanRows.length)} of ${fmt(h.gradWindow)} graduations`,
    lede: `Creator kept under ${h.maxDevPct}% and has not sold, at least ${h.minBuyers} distinct buyers on the
      curve, and the curve took over a minute to fill and was not taken by a single ${h.buyoutSol}+ SOL buy. That
      means <b>none of the patterns we record</b>. It is a statement about the launch record, not about the price:
      it is not a recommendation, and most of these will still lose money.`,
    back: "Back to the front page",
  }, h.cleanRows.length
    ? `<table class="data">${CLEAN_HEAD}${h.cleanRows.map((r) => cleanRowHtml(r, h.now)).join("")}</table>`
    : `<p class="callout">No launch in this window passed every test on the launch record. That is a finding about
       the window, not about any particular token.</p>`,
    `<p class="callout">Two different claims, kept apart. <b>No markers found</b> is a fact about the first blocks
      and does not expire. <b>Liquidity</b> is one balance read at one moment, shown with its age. ${h.unread
        ? `<b>${fmt(h.unread)}</b> of these have no reading under ${Math.round(h.maxReadingAgeMs / 60000)} minutes
           old and say <i>not read</i>: a gap in our pool coverage, never a finding about the token. `
        : `Every row here carries a reading under ${Math.round(h.maxReadingAgeMs / 60000)} minutes old. `}A balance
      shown in red is one we did read, and it is under ${h.minPoolSol} SOL. We never quote a balance we could not
      confirm.</p>`);
}

/**
 * A published report, rendered from its manifest.
 *
 * Prose and layout live here, in source; every figure comes from the frozen manifest and nothing in this function
 * can reach a database. That split is the point: a typo fix or a stylesheet change reaches every report ever
 * published, and no build can move a number somebody has cited. See src/reports.ts for how it got this way.
 *
 * Returns "" for a slug this file has no template for, which the caller reports rather than rendering an empty
 * page. A manifest without a template is a half-finished report, and a half-finished report should not be live.
 */
export function reportBody(r: Report): string {
  const rev = r.revisions?.length
    ? `<p class="callout"><b>Revised.</b> ${r.revisions.map((v) => `${esc(v.at)}: ${esc(v.what)}`).join(" · ")}
       The publication date above is unchanged, because a revision is this report corrected rather than a new one.</p>`
    : "";
  /**
   * The exclusion sentence is a claim about a report's OWN query and must not be printed over one that does not
   * make it. Both buyer-behaviour reports drop late-discovered and rebuilt rows, because a launch found late shows
   * no outside buyers for a reason that is about us rather than about the launch. A report on which hosts still
   * serve a document has no such bias to correct, and printing the sentence anyway would assert an exclusion that
   * did not happen - on the page whose whole claim is that you can check it.
   */
  const provenance = `<p class="lede">Coverage began <b>${r.coverageFrom ? when(Date.parse(r.coverageFrom)) : "unknown"}</b>
    and the figures were taken from the record built <b>${r.recordBuiltAt ? when(Date.parse(r.recordBuiltAt)) : "unknown"}</b>.
    Launches before then were not watched. ${r.excludes ?? `Rows a detector restored after the fact, and rows rebuilt from chain
    history, are excluded throughout: a launch found late shows no outside buyers because nobody was watching
    it, which would flatter every figure here.`}</p>`;
  /**
   * The query table is always printed; only the prose above it varies. A report whose figures are not all a
   * product of that query supplies its own explanation via `verify` - see the note on `Report.verify` for why
   * printing the generic promise there would be worse than printing nothing.
   */
  const check = `<div class="sec"><h2>Check it yourself</h2></div>
    ${r.verify ?? `<p class="lede">One query against the public-domain file. Run it today and you will get a larger answer than the
    table above, because the archive has grown since publication, and that is the difference between a report and
    a live view, and it is why both exist. Disagreeing with either is the point of publishing them.</p>`}
    <table><tr><td class="mono" style="white-space:pre-wrap">${esc(r.query)}</td>
      <td>the table above, verbatim, as it stood on ${esc(r.published)}. Bulk file:
      <a href="../data.html">record.db</a>; permanent copy at <span class="mono">doi:10.57967/hf/10338</span></td></tr>
    </table>`;
  const head = `<h1 class="headline">${esc(r.title)}</h1>
    <p class="lede"><b>Published ${reportDate(r.published)}.</b> The figures below were computed from the record on
    that date and are not updated afterwards: they are read from a file written when this report was published, not
    recomputed when this page is built. <a href="../findings.html">The live view is here</a>.</p>
    ${rev}`;

  if (r.slug === "graduation-events") {
    const t = r.totals, row = (k: string) => r.rows.find((x) => x.confirmed_by === k) ?? {};
    const pct1 = (n: number, d: number) => d > 0 ? `${(100 * n / d).toFixed(1)}%` : "n/a";
    return `
  ${head}
  <p class="lede">A bonding curve graduating is an event on a feed before it is anything else. We record that event,
  and then, separately, we go and read the curve account on chain. Across ${fmt(t.events ?? 0)} graduation events in
  this archive the two agree for some and disagree for a great many, and which group a launch falls into is knowable
  at the time rather than in hindsight.</p>

  <p class="lede"><b>Where a PumpSwap pool exists, the event holds up.</b> Of the ${fmt(t.poolEvents ?? 0)} events
  backed by a pool, we have re-read the curve for ${fmt(t.poolRead ?? 0)}, and ${fmt(t.poolIncomplete ?? 0)}
  (${pct1(t.poolIncomplete ?? 0, t.poolRead ?? 0)}) read incomplete. Two independent pieces of evidence agreeing is
  what a confirmed graduation looks like.</p>

  <p class="lede"><b>Where no pool exists, mostly nothing happened.</b> ${fmt(t.noneEvents ?? 0)} events have no pool
  behind them. We have read the curve for ${fmt(t.noneRead ?? 0)} of them: ${fmt(t.noneIncomplete ?? 0)}
  (${pct1(t.noneIncomplete ?? 0, t.noneRead ?? 0)}) had not completed, and ${fmt(t.noneComplete ?? 0)} had. A
  threshold crossed on a feed, and no curve behind it.</p>

  <div class="sec"><h2>What the record held</h2><span class="cnt">as published, ${esc(r.published)}</span></div>
  <table class="data">
    <tr><th>Confirmed by</th><th class="num">Feed events</th><th class="num">Read on chain</th>
      <th class="num">Read complete</th><th class="num">Read incomplete</th><th class="num">Account gone</th></tr>
    ${r.rows.map((x) => `<tr>
      <td class="mono">${esc(x.confirmed_by)}</td>
      <td class="num">${fmt(Number(x.feed_events ?? 0))}</td>
      <td class="num">${fmt(Number(x.read_on_chain ?? 0))}</td>
      <td class="num">${fmt(Number(x.read_complete ?? 0))}</td>
      <td class="num${Number(x.read_incomplete ?? 0) > Number(x.read_complete ?? 0) ? " thin" : ""}">${fmt(Number(x.read_incomplete ?? 0))}</td>
      <td class="num mut">${fmt(Number(x.account_gone ?? 0))}</td></tr>`).join("")}
  </table>

  <div class="sec"><h2>The row you must not use</h2></div>
  <p class="lede">The middle group is circular and is printed anyway, because leaving it out would be the more
  misleading choice. <span class="mono">graduated_confirmed_by = 'curve_complete'</span> means the curve read <i>is</i>
  the confirmation: those ${fmt(t.circular ?? 0)} rows are complete by construction and can appear in no rate about
  curve readings without making it say what it was built from. The comparison above is between the pool-confirmed
  group and the unconfirmed one, because a pool existing is evidence the curve read had no part in producing.</p>

  <div class="sec"><h2>What this does not say</h2></div>
  <p class="lede">It does not say these tokens are frauds. A curve that has not completed is a curve that has not
  completed, and launches fail at that stage constantly and innocently. What it says is narrower and more useful: a
  graduation event, taken alone, is not evidence that a curve finished, and roughly two in five of them in this
  archive have nothing else behind them.</p>
  <p class="lede">It is also not a rate over graduations in general. We read the curve for unconfirmed events far
  more often than for confirmed ones, deliberately, which is why the two populations are reported separately and
  never pooled into one figure.</p>
  <p class="lede">A curve can complete long after launch, so a single incomplete reading does not settle a launch
  forever; the readings are retaken on a cooldown and the published columns are rewritten from the collector on every
  build. The counts here are what those columns held on ${esc(r.published)}.</p>
  ${provenance}
  ${check}`;
  }

  /**
   * Two tables with different provenance, and the page has to keep them apart.
   *
   * The population is the record's own; the survival figures are what other people's servers returned on one day.
   * They are printed in separate sections, each labelled with where it came from, because a reader who mistakes
   * the second for a property of the file will draw a conclusion the file cannot support.
   *
   * The prose states the observation - a URL returned 404 on a date - and never why. No claim is made that anything
   * was deleted rather than merely not served, and no purpose is attributed to anyone. See the register stance.
   */
  if (r.slug === "metadata-retention") {
    const t = r.totals;
    const m = r.measurements ?? [];
    const j7 = r.rows.find((x) => String(x.host).includes("j7tracker")) ?? {};
    /**
     * One decimal, and never round a loss up to 100%. `md.sdfgsdfsdf.uk` lost 1 of 265 and printed "100%", which
     * on a page whose subject is what survives is the one rounding error that changes the reader's conclusion.
     */
    const pctOf = (a: number, b: number) => {
      if (b <= 0) return "n/a";
      const v = 100 * a / b;
      return `${a < b && v > 99.9 ? "99.9" : v.toFixed(1)}%`;
    };
    const shortHost = (h: string) => h === "ipfs" ? "IPFS" : h.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `
  ${head}
  <p class="lede">A launch's on-chain record carries a <span class="mono">uri</span> pointing at an off-chain
  document: the name, symbol, description, socials and image the launch declared for itself. The chain keeps the
  pointer. It does not keep what the pointer returns.</p>
  <p class="lede">Across ${fmt(t.launches ?? 0)} launches this archive holds a URI for, the document was re-fetched
  on ${esc(r.published)} and compared byte for byte against what was captured at launch. <b>Documents do not decay
  at a uniform rate, and age is not what separates them - the host is.</b> Content-addressed documents lost nothing.
  Three of the four largest self-hosting domains lost nothing. One did not.</p>

  <p class="lede">A further <b>4,177</b> launches in this record declare an empty URI rather than a missing one.
  They are excluded from the table below, because a launch that declared no document has no host to serve it - not
  because nothing is known about them.</p>

  <div class="sec"><h2>Where the documents live</h2><span class="cnt">from the record, as published ${esc(r.published)}</span></div>
  <table class="data">
    <tr><th>Host</th><th class="num">Launches</th><th class="num">Document held here</th></tr>
    ${r.rows.map((x) => `<tr>
      <td class="mono">${esc(shortHost(String(x.host)))}</td>
      <td class="num">${fmt(Number(x.launches ?? 0))}</td>
      <td class="num">${fmt(Number(x.held ?? 0))}</td></tr>`).join("")}
  </table>

  <div class="sec"><h2>Whether the host still serves it</h2><span class="cnt">measured over the network, ${esc(r.published)}</span></div>
  <p class="lede">Every document sampled below is one this archive <b>holds the bytes of</b>, so each is known to
  have existed. That is what makes this a survival rate rather than an estimate. A document counts as served only
  if the fetch returned the same sha256.</p>
  <table class="data">
    <tr><th>Host</th><th class="num">Sampled</th><th class="num">Still served</th><th class="num">Share</th><th>Sampling</th></tr>
    ${m.map((x) => `<tr>
      <td class="mono">${esc(shortHost(String(x.host)))}</td>
      <td class="num">${fmt(Number(x.sampled ?? 0))}</td>
      <td class="num${Number(x.served ?? 0) < Number(x.sampled ?? 0) ? " thin" : ""}">${fmt(Number(x.served ?? 0))}</td>
      <td class="num">${pctOf(Number(x.served ?? 0), Number(x.sampled ?? 0))}</td>
      <td class="mut">${esc(String(x.method ?? ""))}</td></tr>`).join("")}
  </table>

  <div class="sec"><h2>One host, by the age of the launch</h2></div>
  <p class="lede">Sampling 25 launches at random within each day, all of them documents this archive holds,
  <span class="mono">metadata.j7tracker.io</span> returned the document for every launch under two days old and
  HTTP 404 for every launch over three days old.</p>
  <table class="data">
    <tr><th>Launch date</th><th class="num">Age when measured</th><th class="num">Still served</th></tr>
    <tr><td>2026-09-07</td><td class="num">5 days</td><td class="num thin">0 of 25</td></tr>
    <tr><td>2026-09-08</td><td class="num">4 days</td><td class="num thin">0 of 25</td></tr>
    <tr><td>2026-09-09</td><td class="num">3 days</td><td class="num thin">0 of 25</td></tr>
    <tr><td>2026-09-10</td><td class="num">2 days</td><td class="num">7 of 25</td></tr>
    <tr><td>2026-09-11</td><td class="num">1 day</td><td class="num">25 of 25</td></tr>
    <tr><td>2026-09-12</td><td class="num">same day</td><td class="num">25 of 25</td></tr>
  </table>
  <p class="lede">That host carries <b>${fmt(Number(j7.launches ?? 0))}</b> launches in this record -
  ${pctOf(Number(j7.launches ?? 0), t.selfHosted ?? 0)} of every self-hosted metadata URI in it. This archive holds
  <b>${fmt(Number(j7.held ?? 0))}</b> of their documents.</p>

  <div class="sec"><h2>What this does not say</h2></div>
  <p class="lede"><b>It says nothing about why.</b> The observation is an HTTP status code against a URL over time.
  This register records what a request returned and when. It does not infer a purpose or a policy, and none should
  be read into the tables above.</p>
  <p class="lede"><b>It is not established that anything was deleted.</b> What is established is that the host
  returns 404. A document that is not served and a document that does not exist are different facts, and only the
  first was observed.</p>
  <p class="lede"><b>A 404 served only to us would look identical.</b> Against that: the same host, from the same
  machine and in the same minutes, served every request for launches under two days old. That is evidence and not
  proof.</p>
  <p class="lede"><b>Every figure here has a ten-day ceiling.</b> The archive begins on 2026-09-02, so the
  hosts that lost nothing lost nothing <i>in ten days</i> - which is not the same as durable, and this report should
  not be cited as saying it is.</p>
  ${provenance}
  ${check}`;
  }

  if (r.slug === "ticker-factories") return `
  ${head}
  <p class="lede">Across the launches this archive watched from the creation transaction, ${fmt(r.rows.length)} ticker
  symbols were each used by <b>fifteen or more separate mints</b>, and almost every mint was created by a wallet that
  had never launched anything before and never launched anything again. ${fmt(r.totals.mints ?? 0)} launches,
  ${fmt(r.totals.creators ?? 0)} distinct creator wallets, ${fmt(r.totals.grads ?? 0)} of them completing a bonding
  curve we confirmed against the curve account itself.</p>

  <div class="sec"><h2>What the record held</h2><span class="cnt">as published, ${esc(r.published)}</span></div>
  <table class="data">
    <tr><th>Ticker</th><th class="num">Mints</th><th class="num">Distinct creators</th>
      <th class="num">Confirmed graduations</th><th class="num">Avg creator share</th>
      <th class="num">With no outside buyer</th></tr>
    ${r.rows.map((f) => `<tr>
      <td class="mono">${esc(f.symbol)}</td>
      <td class="num">${fmt(Number(f.mints ?? 0))}</td>
      <td class="num">${fmt(Number(f.creators ?? 0))}</td>
      <td class="num">${fmt(Number(f.grads ?? 0))}</td>
      <td class="num${Number(f.dev ?? 0) >= 50 ? " thin" : ""}">${f.dev == null ? "?" : `${Number(f.dev).toFixed(1)}%`}</td>
      <td class="num${Number(f.zero ?? 0) > Number(f.mints ?? 0) / 2 ? " thin" : ""}">${fmt(Number(f.zero ?? 0))}</td></tr>`).join("")}
  </table>

  <div class="sec"><h2>Why a fresh wallet each time is the whole point</h2></div>
  <p class="lede">Every heuristic that judges a launch by its creator's history fails against a wallet with no
  history. A creator that has launched forty tokens is visible; forty creators that have launched one each are not,
  and they are the same operation. That is why this project validates its own criteria against creator-wallet reuse
  rather than with it, because it is an axis <a href="../method.html">none of the published criteria read</a>, which is
  what makes it usable as an independent check on them.</p>
  <p class="callout">Several of these tickers match the names of well-known companies, films and products. The record
  states what ticker a launch declared for itself and nothing more: it is not evidence that any named business was
  involved, and nothing here should be read as saying so.</p>

  <div class="sec"><h2>What this does not say</h2></div>
  <p class="lede">A shared ticker is not identity. Two launches using the same symbol may be unrelated, and the
  record cannot tell one operator running two hundred mints from two hundred people with the same idea. What it can
  say is what each launch did at birth, and the table above is that and only that.</p>
  ${provenance}
  ${check}`;

  return "";
}

/** The index of published reports. Dates first, because the date is what makes one of these different from a page. */
export function reportsIndexBody(reports: Report[]): string {
  return `
  <h1 class="headline">Reports</h1>
  <p class="lede">Dated pieces of work, computed from the record on the day they were published and left alone
  afterwards. Each states the day it was written, the coverage it had at the time, and the query behind every figure.
  For what is true right now, which changes under you, see <a href="findings.html">what the record shows</a>.</p>
  ${reports.length ? `<table class="data">
    <tr><th>Published</th><th>Report</th><th>What it is about</th></tr>
    ${reports.map((r) => `<tr>
      <td class="num mono">${esc(r.published)}</td>
      <td><a href="reports/${esc(r.slug)}.html">${esc(r.title)}</a>${r.revisions?.length
        ? ` <span class="sub">· revised ${esc(r.revisions[r.revisions.length - 1].at)}</span>` : ""}</td>
      <td>${esc(r.summary)}</td></tr>`).join("")}
  </table>` : `<p class="callout">Nothing published yet. Reports appear here when they are written; this page does
    not generate them, which is why it can be empty.</p>`}
  <p class="callout">Every figure in a report is a query against <a href="data.html">the public-domain record</a>,
  printed beside it so anyone can run it and get the same answer for that date, or a different one, and say so.
  A report is never rewritten by a later build: it is written once, and a correction has to say what it changed.</p>`;
}

export function wallBody(): string {
  return `
  <div class="hero split"><div class="col-a">
    <h1 class="headline">Launches, as they happen</h1>
    <p class="lede">Every launch on ${venuePhrase()}, the moment our collector decodes its creation transaction. The creator's
    share of supply is read from that same transaction, so it appears with the launch rather than after it.</p>
    <p class="lede">This is the archive being written. Click any row for its record.</p>
  </div>
  <div class="col-b"><div class="stats" style="margin:4px 0 0">
    <div class="stat"><span>seen on this page</span><b class="big" id="wc">0</b></div>
    <div class="stat"><span>creator took 20%+</span><b class="big" id="wd">0</b></div>
    <div class="stat"><span>per minute</span><b class="big" id="wr">&hellip;</b></div>
  </div>
  <p class="sub" style="margin:6px 0 0"><span id="wstat">connecting&hellip;</span></p></div></div>

  <div class="sec"><h2>Live</h2><span class="cnt" id="wago">&hellip;</span></div>
  <div class="wall" id="wall"><p class="callout" id="wempty">Waiting for the next launch. At this hour that is
  usually a few seconds.</p></div>
  <p class="callout">A launch appearing here is not a finding about it. The creator's share is the only figure known
  at the instant of creation; buyer counts and everything else need time to happen. Open the record for the rest.</p>
  <script>(function(){
    var wall=document.getElementById('wall'),empty=document.getElementById('wempty');
    var cN=document.getElementById('wc'),cD=document.getElementById('wd'),cR=document.getElementById('wr');
    var st=document.getElementById('wstat'),ago=document.getElementById('wago');
    var since=0,seen=0,heavy=0,t0=Date.now(),MAX=60,stop=false,fails=0;
    function esc(x){var d=document.createElement('div');d.textContent=x==null?'':String(x);return d.innerHTML;}
    function row(l){
      var a=document.createElement('a');a.className='wrow';a.href='t/'+encodeURIComponent(l.mint)+'.html';
      var pct=(typeof l.devPct==='number')?l.devPct:0;
      a.innerHTML='<span class=\"sym\">'+esc(l.symbol||'?')+'</span>'+
        '<span class=\"nm\">'+esc(l.name||'')+'</span>'+
        '<span class=\"dv'+(pct>=20?' hi':'')+'\">'+pct.toFixed(1)+'%</span>'+
        '<span class=\"ago\">just now</span>';
      a.setAttribute('data-at',String(l.at));
      return a;
    }
    function tick(){
      var now=Date.now();
      var rows=wall.querySelectorAll('.wrow');
      for(var i=0;i<rows.length;i++){
        var s=Math.round((now-Number(rows[i].getAttribute('data-at')))/1000);
        var e=rows[i].querySelector('.ago');
        if(e)e.textContent=s<2?'just now':(s<90?s+'s ago':Math.round(s/60)+'m ago');
      }
      var mins=(now-t0)/60000;
      if(mins>0.15)cR.textContent=(seen/mins).toFixed(0);
    }
    function pull(){
      if(stop)return;
      fetch('api/live/recent?since='+since,{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
        fails=0;
        if(d.unavailable){st.textContent=d.unavailable;return;}
        st.textContent='live from the collector';
        var ls=d.launches||[];
        if(ls.length){
          if(empty){empty.remove();empty=null;}
          for(var i=0;i<ls.length;i++){
            var l=ls[i];
            if(l.at>since)since=l.at;
            seen++;if(typeof l.devPct==='number'&&l.devPct>=20)heavy++;
            wall.insertBefore(row(l),wall.firstChild);
          }
          while(wall.childElementCount>MAX)wall.removeChild(wall.lastElementChild);
          cN.textContent=seen.toLocaleString();cD.textContent=heavy.toLocaleString();
          ago.textContent=new Date(d.at).toISOString().slice(11,19)+' UTC';
        }
        tick();
      }).catch(function(){
        // Say it, never fake it: a wall that silently stops is indistinguishable from a market that stopped.
        fails++;st.textContent='feed interrupted, retrying';
        if(fails>20){stop=true;st.textContent='feed stopped. Reload to reconnect.';}
      });
    }
    pull();setInterval(pull,2500);setInterval(tick,1000);
  })();</script>`;
}
