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
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
a{color:inherit}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:32px 0 10px;font-weight:600}
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
.lede{font-size:16px;line-height:1.62;color:var(--fg);max-width:62ch;margin:0 0 6px}
.lede + .lede{margin-top:12px;color:var(--mut);font-size:14.5px}
.sec{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:44px 0 6px;
  padding-bottom:8px;border-bottom:1.5px solid var(--fg)}
.sec h2{margin:0;border:0;padding:0}
.sec .cnt{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--mut)}
/* the contrast that is the whole argument: what is measurable now, against what was true at birth */
.proof{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--line);background:var(--card);margin:22px 0 0}
.proof > div{padding:18px 20px}
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
@media(max-width:620px){.proof{grid-template-columns:1fr}.proof > div + div{border-left:0;border-top:1px solid var(--line)}}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:var(--card)}
.callout{border-left:3px solid var(--fg);padding:2px 0 2px 16px;margin:18px 0 0;font-size:14.5px;color:var(--mut)}
`;

export interface Chrome { coverageFrom: string; gapMin: number }

/**
 * A record page is this project's only real distribution. Nobody shares a registry's front page; they paste a link to
 * one record into a group chat to settle an argument. With no metadata every such link rendered as a blank grey box,
 * so the most persuasive thing here — a specific, checkable finding about a specific token — was invisible at exactly
 * the moment someone chose to pass it on. The preview is written from the record, so it is an advertisement that
 * cannot say anything the page does not.
 */
export function page(title: string, body: string, c: Chrome, depth = 0, summary?: string): string {
  const root = depth ? "../" : "";
  const desc = summary ?? "The documented history of a Solana token from its first block: who created it, what they took, and who actually bought.";
  const head = [
    `<title>${esc(title)} — ${BRAND}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    `<meta property="og:site_name" content="${BRAND}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
  ].join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
${head}<style>${CSS}</style></head>
<body><div class="wrap">
<div class="mast"><a class="brand serif" href="${root}index.html">${MARK}<span>${BRAND}</span></a><span class="tag2">Solana launch records</span><span class="what">In property law, the chain of title is the unbroken documented history of ownership from origin — what you establish before you believe a claim about what something is.</span></div>
${body}
<div class="note"><b>${BRAND}</b> — the documented history of a token from its first block. Coverage begins ${c.coverageFrom}${c.gapMin >= 1 ? `, with ${fmt(c.gapMin)} min of recorded downtime` : ", no recorded downtime"}.
Everything here is read from the Solana chain and can be checked against it. A clean record means a launch was <b>not manufactured</b> — it is not a prediction and not advice.
Most tokens lose money regardless: of 19,412 bonding-curve positions measured, none reached 5x.</div>
</div></body></html>`;
}

/** The search box. Present on the front page and on every page that could not answer. */
export const SEARCH = `
  <form class="find" onsubmit="return look(event)">
    <input id="q" placeholder="paste a token mint address" spellcheck="false" autocomplete="off" aria-label="Token mint address">
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

export type Reading = { sol: number; at: number; fresh: boolean };

/**
 * The one-line finding a shared link should carry, and the title it should carry it under. Built from the record
 * only: if we cannot say what happened, the preview says that instead of implying anything.
 */
export function tokenPreview(t: any, a: Assessment, clean: boolean): { title: string; summary: string } {
  const sym = t.symbol ?? "This token";
  if (!a.watched)
    return { title: `${sym} — launch not observed`,
      summary: `We have no record of this launch, so we cannot tell you what it was at birth. That is not a clean result: once a token's float has been spread, a manufactured launch is indistinguishable from a real one.` };
  const bits: string[] = [];
  if (t.dev_pct != null) bits.push(`the creator took ${t.dev_pct.toFixed(1)}% of supply in the first block`);
  if (a.curveBuyers != null) bits.push(`${fmt(a.curveBuyers)} outside wallet${a.curveBuyers === 1 ? "" : "s"} bought on the bonding curve`);
  if (t.graduated_at && t.created_at) bits.push(`the curve filled in ${dur(t.graduated_at - t.created_at)}`);
  const evidence = bits.join(", ") + ".";
  if (clean) return { title: `${sym} — launched clean`, summary: `Recorded live at launch: ${evidence} Not manufactured — which is not a prediction, and most tokens lose money regardless.` };
  // A headline written for the purpose, not a flag sentence chopped to length: slicing one produced
  // "WOTF — The creator took 79.3% of the entire supply in the first block. Nothin".
  const gradS = t.graduated_at && t.created_at ? (t.graduated_at - t.created_at) / 1000 : null;
  const headline =
    t.dev_pct >= 50 ? `creator took ${t.dev_pct.toFixed(0)}% of supply at launch`
    : a.curveBuyers === 0 ? "nobody bought its curve"
    : a.buyout ? `one wallet bought its curve for ${a.buyout.sol.toFixed(0)} SOL`
    : gradS !== null && gradS <= 60 ? `curve taken ${Math.round(gradS)}s after launch`
    : a.curveBuyers !== null && a.curveBuyers < 10 ? `only ${a.curveBuyers} outside buyer${a.curveBuyers === 1 ? "" : "s"}`
    : t.dev_pct >= MAX_DEV_PCT ? `creator took ${t.dev_pct.toFixed(0)}% of supply at launch`
    : null;
  return { title: headline ? `${sym} — ${headline}` : `${sym} — launch record`, summary: `Recorded live at launch: ${evidence}` };
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
    <tr><td class="k">Outside buyers</td><td><b>${a.curveBuyers === null ? "unknown" : fmt(a.curveBuyers)}</b> distinct wallets bought on the bonding curve before it graduated${origin === "observed" ? ` — ${fmt(t.snap30_buyers ?? 0)} within the first 30s, ${fmt(t.bundled_buyers ?? 0)} bundled into the creation block.` : "."}</td></tr>
    <tr><td class="k">Graduated</td><td>${t.graduated_at ? `${dur(t.graduated_at - t.created_at)} after launch` : "yes"}</td></tr>
    <tr><td class="k">Creator sold</td><td>${t.dev_sold ? "yes" : origin === "observed" ? "not while we watched" : "no"}</td></tr>`
    : `<tr><td class="k">Launch</td><td>Not observed. ${t.late_discovery ? "Found only after it was already trading." : "The collector was down when it launched."}</td></tr>`;

  const boBlock = a.buyout ? `<h2>Who took the curve</h2>
    <p class="mono"><a href="../w/${esc(a.buyout.wallet)}.html">${esc(a.buyout.wallet)}</a></p>
    <p>Bought <b>${a.buyout.sol.toFixed(0)} SOL</b> of this curve in a single transaction${t.created_at ? `, ${dur(a.buyout.ts - t.created_at)} after launch` : ""}.</p>` : "";

  const nowBlock = r ? `<h2>Pool</h2><table>
    <tr><td class="k">Liquidity</td><td>${r.sol.toFixed(1)} SOL</td></tr>
    <tr><td class="k">Read from chain</td><td>${when(r.at)} — ${ago(now - r.at)}${r.fresh ? "" : ". Pool balances move; treat an old reading as an old reading."}</td></tr></table>`
    : t.vault_sol != null ? `<h2>Pool</h2><p class="sub">A balance of ${t.vault_sol.toFixed(1)} SOL is on file but we cannot say when it was read, so it is not quoted here.</p>` : "";

  // How the record was obtained is part of the record. A rebuild is the same transactions, read later — but it cannot
  // include what the token claimed to be at launch, because that lives off-chain and the operator can change it.
  const provenance = origin === "rebuilt" ? `<div class="flag UNKNOWN"><span class="tag UNKNOWN">rebuilt</span>
    We did not watch this launch. Its record was reconstructed from the bonding curve's complete transaction history,
    so the figures below are the same on-chain events, read later. What it cannot tell you is what the token
    <i>claimed</i> to be at launch — the name, image and links live off-chain and can be changed since.</div>` : "";

  return `
    <h1>${esc(t.symbol ?? "unknown")}</h1><div class="sub mono">${esc(t.mint)}</div>
    ${clean ? '<div class="flag OK"><span class="tag OK">clean</span>Launched with no creator supply, real buyers, and measurable liquidity. This says it was not manufactured. It is not a prediction.</div>' : ""}
    ${provenance}
    ${a.flags.map((f) => `<div class="flag ${f.level}"><span class="tag ${f.level}">${f.level}</span>${esc(f.text)}</div>`).join("")}
    <h2>At launch</h2><table>${rows}</table>${boBlock}${nowBlock}`;
}

/** A wallet's record: every curve it bought outright, and what it did with the tokens afterwards. */
export function walletBody(w: string, p: any, line: string | null): string {
  const heavy = p.ammSell > p.ammBuy * 3 && p.ammSell >= 20 ? "DANGER" : "CAUTION";
  const rows = p.buyouts.map((b: any) => `<tr><td>${when(b.ts)}</td><td><a href="../t/${esc(b.mint)}.html">${esc(b.symbol ?? "?")}</a></td>
    <td>${b.sol.toFixed(0)} SOL</td><td>${b.dormantH === null ? "unknown" : dur(b.dormantH * 3600_000)} after launch</td></tr>`).join("");
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
    <h2>Curves taken</h2><table><tr><th>When</th><th>Token</th><th>Size</th><th>Curve age</th></tr>${rows}</table>`;
}

export { MIN_POOL_SOL };
