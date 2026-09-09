/**
 * The published schema, generated from the file it describes.
 *
 * A reader had to download 75 MB before they could find out whether the archive held what they needed: the tables
 * were named in one sentence of prose and no column was documented anywhere on the site. A CC0 file nobody can
 * evaluate without committing to the download is public in name only.
 *
 * Columns come from `PRAGMA table_info` on the record itself rather than from a list kept here, so the page cannot
 * drift from the file. A column present in the record with no entry in `DOCS` throws and fails the build. That is
 * deliberate: `site.ts` leaves yesterday's pages up when generation fails, so the cost of a missing description is a
 * stale page, and the cost of not failing is a schema that silently rots the first time someone adds a column.
 */
import type { DatabaseSync } from "node:sqlite";
import { esc } from "./render.ts";

/**
 * What a reader actually needs to know about a column is not its type. It is whether they could reproduce it
 * themselves, and whether it is a fact or a snapshot.
 *
 *   live    observed at the creation transaction and unrecoverable afterwards. This is the archive's whole reason to
 *           exist: nobody can go back and measure it, including us.
 *   chain   reproducible from chain history by anyone willing to pay for archival RPC. We are a convenience here,
 *           not a source of truth.
 *   reading one measurement taken at one moment, carrying the moment it was taken. Not a time series. The value was
 *           true when read and says nothing about now.
 *   ours    our own bookkeeping, or an aggregate we computed. Only as good as the process that wrote it.
 *   opaque  derived from data that is NOT in this file, so you cannot check it against the file. Every one of these
 *           is a defect to be fixed or removed, not a category we are comfortable having.
 */
export type Kind = "live" | "chain" | "reading" | "ours" | "opaque";

export const KIND_NOTE: Record<Kind, string> = {
  live: "recorded at the creation transaction; unrecoverable afterwards",
  chain: "reproducible from chain history by anyone",
  reading: "one measurement, carrying the moment it was taken",
  ours: "our own bookkeeping or an aggregate we computed",
  opaque: "computed from data that is not in this file, so you cannot check it here",
};

type Doc = { kind: Kind; desc: string };
const DOCS: Record<string, Record<string, Doc>> = {
  tokens: {
    mint: { kind: "chain", desc: "The token's mint address. Primary key." },
    name: { kind: "ours", desc: "Name the launch declared off-chain. The operator can change it after launch; this is what it said when we read it." },
    symbol: { kind: "ours", desc: "Ticker the launch declared. Tickers collide constantly and are not an identifier — use the mint." },
    creator: { kind: "live", desc: "Wallet that sent the creation transaction." },
    created_at: { kind: "live", desc: "Creation time, epoch ms." },
    late_discovery: { kind: "ours", desc: "1 when we found the token after it was already trading, so its first block was never observed. A launch with this set is never certified clean." },
    dev_pct: { kind: "live", desc: "Percent of total supply the creator held after the first block. The single most load-bearing number in the file." },
    dev_sold: { kind: "ours", desc: "1 if we saw the creator sell while watching. 0 means we did not see it, which is not the same as it not happening." },
    unique_buyers: { kind: "ours", desc: "Distinct buyers across the token's whole life, INCLUDING post-graduation market buyers. This is NOT the outside-buyer count that judges a launch — use curve_buyers." },
    curve_buyers: { kind: "live", desc: "Distinct wallets that bought on the bonding curve before it graduated. NULL means unknown, which never certifies as clean." },
    snap30_buyers: { kind: "live", desc: "Distinct buyers within the first 30 seconds. Meaningful only for an observed launch." },
    bundled_buyers: { kind: "live", desc: "Buyers landing in the creation block itself — bought before anyone outside could have seen the token exist." },
    graduated: { kind: "ours", desc: "1 if the curve is recorded as having completed. Written from two sources this column cannot tell apart; read graduated_confirmed_by before relying on it." },
    graduated_at: { kind: "ours", desc: "When the curve is recorded as completing, epoch ms. Subject to the same caveat as graduated." },
    pool: { kind: "chain", desc: "The PumpSwap pool address, once discovered. NULL is not evidence a curve did not complete: pool discovery has its own coverage gaps." },
    vault_sol: { kind: "reading", desc: "SOL in the pool at the last successful read. One value, not a history. Always read it with vault_at." },
    vault_at: { kind: "reading", desc: "When vault_sol was read, epoch ms. A balance without its age is not a fact. These two move together or not at all." },
    last_price: { kind: "ours", desc: "Last price we decoded for the token. Present for research; the site makes no claim from it." },
    rebuilt_at: { kind: "ours", desc: "When we reconstructed this launch from chain history rather than watching it, epoch ms." },
    rebuilt_complete: { kind: "ours", desc: "1 when a rebuild read the curve's entire transaction history. 0 or NULL means signature paging hit its cap or transactions could not be fetched, so the rebuild is partial and its counts are floors." },
    updated_at: { kind: "ours", desc: "Last time any field on this row changed, epoch ms." },
    venue: { kind: "chain", desc: "Which launchpad the token came from." },
    graduated_confirmed_by: { kind: "ours", desc: "How graduation was confirmed: 'pool' (a PumpSwap pool was found), 'curve_complete' (the curve account's own complete bit), or NULL for an inference from decoded trade volume that nobody ever confirmed. NULL means we say less, never that we say the opposite." },
    uri: { kind: "ours", desc: "Metadata URI the launch declared." },
    image: { kind: "ours", desc: "Image URL from that metadata. A NULL here with meta_at set means the launch declared no picture — a different statement from us not fetching one." },
    description: { kind: "ours", desc: "Description the launch declared off-chain, at the time we read it." },
    meta_at: { kind: "ours", desc: "When we read the off-chain metadata, epoch ms. Set with a NULL image means the launch genuinely declared none." },
    image_sha256: { kind: "ours", desc: "sha256 of the image bytes, when we hold them — the proof rather than the picture. NULL means we did not fetch it, which is a disk-budget decision and not a finding about the launch." },
    image_bytes: { kind: "ours", desc: "Size of the fetched image in bytes." },
    image_at: { kind: "ours", desc: "When the image bytes were fetched, epoch ms." },
    image_error: { kind: "ours", desc: "Always NULL here. It records why one of our image fetches failed, which describes us rather than the launch, so the published record does not carry it. The column exists because our own tooling migrates any database it opens to the collector's schema." },
    meta_json: { kind: "ours", desc: "Always NULL here. The collector keeps the metadata document — it is retrievable exactly once, since the URI is the creator's to repoint — but publishing it would add roughly a kilobyte per launch to a file whose whole value is that one person can mirror it. The column exists because our own tooling migrates any database it opens; read meta_bytes to tell 'never fetched' from 'fetched and it exists'." },
    meta_bytes: { kind: "ours", desc: "Size of the metadata document as served, in bytes. The document itself is kept by the collector but is not published here: at roughly a kilobyte a launch it would add tens of megabytes a day to a file whose whole point is that one person can mirror it. This column is what lets you tell 'we never fetched it' from 'we fetched it and it exists'." },
  },
  wallet_flow: {
    wallet: { kind: "chain", desc: "A wallet that has bought at least one bonding curve outright. One row each." },
    curve_sol: { kind: "chain", desc: "SOL this wallet spent buying bonding curves." },
    amm_buy: { kind: "ours", desc: "SOL this wallet spent buying back on the open market, on the curves it took. Sum the venue='amm', side='buy' rows in trades for this wallet and you will get this number." },
    amm_sell: { kind: "ours", desc: "SOL this wallet received selling on the open market, on the curves it took — the tokens it bought the float of, not everything it ever traded. Sum the venue='amm', side='sell' rows in trades for this wallet and you will get this number. It used to count every token the wallet touched while the pages around it said 'sold after taking the curve'." },
    tokens: { kind: "ours", desc: "Number of curves this wallet took. Count the distinct mints in trades for this wallet and you will get this number." },
  },
  trades: {
    mint: { kind: "chain", desc: "Token traded." },
    wallet: { kind: "chain", desc: "Wallet that traded." },
    side: { kind: "chain", desc: "'buy' or 'sell'." },
    sol: { kind: "chain", desc: "Size of the trade in SOL." },
    ts: { kind: "chain", desc: "When we decoded the trade, epoch ms. Events arriving together carry the same timestamp, so ordering within a batch is not established." },
    venue: { kind: "chain", desc: "'curve' for a bonding-curve trade, 'amm' for one on the open market. This table holds two things and nothing else: curve buys large enough to count as a buyout, and the market trades those same wallets made on those same tokens afterwards. The second set is here so wallet_flow can be checked against it rather than believed." },
    is_dev: { kind: "chain", desc: "1 when the trading wallet is the token's creator." },
    slot: { kind: "chain", desc: "Solana slot, where known." },
  },
  hist_trades: {
    mint: { kind: "chain", desc: "Token traded." },
    sig: { kind: "chain", desc: "Transaction signature — take this to any explorer and check the row yourself." },
    idx: { kind: "chain", desc: "Instruction index within the transaction." },
    ts: { kind: "chain", desc: "Block time, epoch ms. Read from chain history, so unlike trades.ts this is the real block time." },
    slot: { kind: "chain", desc: "Solana slot." },
    wallet: { kind: "chain", desc: "Wallet that traded." },
    side: { kind: "chain", desc: "'buy' or 'sell'." },
    sol: { kind: "chain", desc: "Size in SOL." },
    tokens: { kind: "chain", desc: "Token amount moved." },
    vsol: { kind: "chain", desc: "Virtual SOL reserve after the trade — how full the curve was." },
    vtok: { kind: "chain", desc: "Virtual token reserve after the trade." },
    is_dev: { kind: "chain", desc: "1 when the trading wallet is the token's creator." },
  },
  runs: {
    id: { kind: "ours", desc: "Collector run." },
    started_at: { kind: "ours", desc: "When the collector started watching, epoch ms." },
    stopped_at: { kind: "ours", desc: "When it stopped, epoch ms. NULL means still running. Launches outside these windows were not observed — this table is how you check what we were awake for." },
    note: { kind: "ours", desc: "Why the run started or ended, when we recorded it." },
  },
  pool_map: {
    pool: { kind: "chain", desc: "PumpSwap pool address. Primary key." },
    mint: { kind: "chain", desc: "Token that pool trades." },
    created_at: { kind: "ours", desc: "When we first mapped the pool, epoch ms — not when the pool was created." },
  },
  operator_wallets: {
    wallet: { kind: "chain", desc: "A wallet we associate with an operator cluster." },
    funder: { kind: "chain", desc: "Wallet that funded it. Trading terminals fund users the same way a wallet farm funds its own wallets, so a shared funder is a lead, not a finding." },
    cluster: { kind: "ours", desc: "Our label for the group. Ours, not the chain's." },
    role: { kind: "ours", desc: "What this wallet appears to do within the cluster." },
    seeded_at: { kind: "chain", desc: "When the funder first sent it SOL, epoch ms." },
    source_mint: { kind: "ours", desc: "The launch that first brought this wallet to our attention." },
    added_at: { kind: "ours", desc: "When we added the row, epoch ms." },
  },
  meta: {
    k: { kind: "ours", desc: "Key. The published record carries built_at (when this file was assembled), built_by (which machine and script — 'local' or the cloud service name, never a personal hostname), built_pid, and watermark (how far the incremental copy had reached)." },
    v: { kind: "ours", desc: "Value, as text. Timestamps are epoch ms." },
  },
  operator_policy: {
    cluster: { kind: "ours", desc: "Cluster label, joining to operator_wallets." },
    policy: { kind: "ours", desc: "What the cluster's behaviour looks like across its plays. Our reading of a pattern, not a fact about the chain." },
    hold_plays: { kind: "ours", desc: "Plays where the cluster held rather than distributed." },
    dist_plays: { kind: "ours", desc: "Plays where it distributed into buyers." },
    plays: { kind: "ours", desc: "Total plays observed for the cluster." },
    note: { kind: "ours", desc: "Anything qualifying the reading above." },
    updated_at: { kind: "ours", desc: "When the row was last written, epoch ms." },
  },
};

const TABLE_NOTE: Record<string, string> = {
  tokens: "One row per launch. This is the record.",
  wallet_flow: "One row per wallet that has bought a curve outright.",
  trades: "Curve buys large enough to count as a buyout. Not every trade on every token.",
  hist_trades: "Trades read from chain history during a rebuild, each with its transaction signature.",
  runs: "The coverage windows. What we were awake for.",
  pool_map: "Which PumpSwap pool belongs to which token.",
  operator_wallets: "Wallets grouped by who funded them.",
  operator_policy: "What each cluster's plays look like taken together.",
  meta: "What built this file, and when. A record that cannot account for its own origin is a strange thing for a provenance project to publish.",
};

/** Columns actually present in the record, in file order. */
const columnsOf = (db: DatabaseSync, table: string): { name: string; type: string }[] => {
  try { return db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(table) as any[]; }
  catch { return []; }
};

/**
 * The schema section. Throws rather than publishing an incomplete one — see the note at the top of this file.
 */
export function renderSchema(db: DatabaseSync): string {
  const missing: string[] = [];
  const sections: string[] = [];

  /**
   * Undocumented TABLES fail the build too, not only undocumented columns.
   *
   * This was one-sided and the asymmetry hid a real omission: a table absent from DOCS was quietly left off the
   * page, so the file could hold something the schema never mentioned. `meta` — the table saying what built the
   * record and when — sat undocumented for exactly that reason, on a page whose whole subject is provenance.
   *
   * The same gap had a larger version. Before openDb stopped migrating the record, the published file had
   * accumulated ten of the collector's own tables, all empty; this page would have said nothing about any of them
   * while a reader who opened the download saw all ten.
   */
  const present = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as any[])
    .map((r) => r.name as string);
  const undocumented = present.filter((t) => !DOCS[t]);
  if (undocumented.length) {
    throw new Error(
      `schema-doc: ${undocumented.length} table(s) in the record are not documented: ${undocumented.join(", ")}.\n` +
      `Either describe them in DOCS in src/schema-doc.ts, or stop publishing them in servicedb.ts. A file that ` +
      `holds a table the schema does not mention is a finding aid that understates its own holdings.`);
  }

  for (const [table, docs] of Object.entries(DOCS)) {
    const cols = columnsOf(db, table);
    if (!cols.length) continue;                       // a table absent from this build is not an error
    for (const c of cols) if (!docs[c.name]) missing.push(`${table}.${c.name}`);

    const rows = cols.map((c) => {
      const d = docs[c.name];
      if (!d) return "";
      return `<tr><td class="mono id">${esc(c.name)}</td><td class="mut">${esc(c.type.toLowerCase())}</td>
        <td><span class="kind k-${d.kind}">${d.kind}</span></td><td>${esc(d.desc)}</td></tr>`;
    }).join("");

    sections.push(`<div class="sec"><h2>${esc(table)}</h2><span class="cnt">${cols.length} columns</span></div>
      <p class="lede">${esc(TABLE_NOTE[table] ?? "")}</p>
      <table class="data"><tr><th>Column</th><th>Type</th><th>Kind</th><th>What it is</th></tr>${rows}</table>`);
  }

  if (missing.length) {
    throw new Error(
      `schema-doc: ${missing.length} column(s) in the record have no description: ${missing.join(", ")}.\n` +
      `Add them to DOCS in src/schema-doc.ts. The build fails rather than publishing a schema with holes in it — ` +
      `site.ts leaves the previous pages up, so nothing is served wrong in the meantime.`);
  }

  const anyOpaque = Object.entries(DOCS).some(([t, docs]) =>
    columnsOf(db, t).some((c) => docs[c.name]?.kind === "opaque"));
  const legend = (Object.keys(KIND_NOTE) as Kind[]).map((k) =>
    `<tr><td><span class="kind k-${k}">${k}</span></td><td>${esc(KIND_NOTE[k])}</td></tr>`).join("");

  return `
  <div class="sec"><h2>What is in the file</h2><span class="cnt">generated from the record itself</span></div>
  <p class="lede">Read off the published file at build time, not maintained by hand, so this cannot drift from what
  you download. The <b>kind</b> matters more than the type: it says whether you could reproduce the value yourself,
  and whether it is a fact or a snapshot.</p>
  <table><tr><th>Kind</th><th>Meaning</th></tr>${legend}</table>
  <p class="callout">Anything marked <span class="kind k-opaque">opaque</span> is a defect on our side, not a
  category we are content with: this file is meant to carry its own evidence, and a number you cannot check against
  it does not belong in it. ${anyOpaque
    ? "They are labelled rather than quietly left in."
    : "<b>There are none in this build.</b> Every figure here can be recomputed from rows in the same file."}</p>
  ${sections.join("\n")}`;
}

/**
 * Three real records side by side, on the handful of columns that decide a verdict. A schema is understood far
 * faster next to an actual row, and the contrast is the argument: the same columns say all three things.
 */
export function renderSamples(db: DatabaseSync): string {
  const pick = (where: string) => {
    try { return db.prepare(`SELECT mint, symbol, dev_pct, curve_buyers, graduated, graduated_confirmed_by,
      vault_sol, vault_at, late_discovery, rebuilt_complete FROM tokens WHERE ${where} LIMIT 1`).get() as any; }
    catch { return null; }
  };
  const cases: { label: string; note: string; row: any }[] = [
    { label: "Manufactured", note: "creator took the supply, nobody else bought",
      row: pick("graduated=1 AND late_discovery=0 AND dev_pct>=50 AND curve_buyers=0") },
    { label: "Clean at birth", note: "small creator share, real spread of buyers",
      row: pick("graduated=1 AND late_discovery=0 AND dev_pct<20 AND curve_buyers>=30") },
    { label: "Not observed", note: "found late; the first block was never seen",
      row: pick("late_discovery=1") },
  ].filter((c) => c.row);
  if (!cases.length) return "";

  const F: [string, (r: any) => string][] = [
    ["symbol", (r) => r.symbol ?? "—"],
    ["dev_pct", (r) => r.dev_pct == null ? "NULL" : `${r.dev_pct.toFixed(1)}`],
    ["curve_buyers", (r) => r.curve_buyers == null ? "NULL" : String(r.curve_buyers)],
    ["graduated", (r) => String(r.graduated ?? "NULL")],
    ["graduated_confirmed_by", (r) => r.graduated_confirmed_by ?? "NULL"],
    ["vault_sol", (r) => r.vault_sol == null ? "NULL" : r.vault_sol.toFixed(1)],
    ["late_discovery", (r) => String(r.late_discovery ?? 0)],
    ["rebuilt_complete", (r) => String(r.rebuilt_complete ?? "NULL")],
  ];

  return `
  <div class="sec"><h2>Three real rows</h2><span class="cnt">from this build of the record</span></div>
  <p class="lede">The same columns, saying three different things. Every NULL below is load-bearing: it is the file
  declining to state something rather than a gap someone forgot to fill.</p>
  <table class="data">
    <tr><th>Column</th>${cases.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr>
    ${F.map(([name, fn]) => `<tr><td class="mono id">${esc(name)}</td>${cases.map((c) =>
      `<td class="mono">${esc(fn(c.row))}</td>`).join("")}</tr>`).join("")}
    <tr><td class="mut">what it is</td>${cases.map((c) => `<td class="mut">${esc(c.note)}</td>`).join("")}</tr>
    <tr><td class="mut">read it</td>${cases.map((c) =>
      `<td><a href="t/${esc(c.row.mint)}.html">record</a></td>`).join("")}</tr>
  </table>`;
}
