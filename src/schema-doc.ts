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
import { esc, columnAnchor } from "./render.ts";

/**
 * What a reader actually needs to know about a column is not its type. It is whether they could reproduce it
 * themselves, and whether it is a fact or a snapshot.
 *
 *   live    observed at the creation transaction, as it happened, and not readable from the token's present state
 *           afterwards: once the float is spread, no amount of inspecting the token now recovers it. Most of these
 *           can be reconstructed later from archival chain history, at a cost - see `chain` - so what this file
 *           adds is that they were recorded contemporaneously rather than reassembled afterwards. Said plainly
 *           because the front page said `unrecoverable` for a while and that was wrong. meta_sha256 is the one
 *           genuine exception: it commits to a document the creator can delete, and frequently has.
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
  live: "recorded at the creation transaction; not readable from the token's present state afterwards",
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
    symbol: { kind: "ours", desc: "Ticker the launch declared. Tickers collide constantly and are not an identifier; use the mint." },
    creator: { kind: "live", desc: "Wallet that sent the creation transaction." },
    created_at: { kind: "live", desc: "Creation time, epoch ms." },
    late_discovery: { kind: "ours", desc: "1 when we found the token after it was already trading, so its first block was never observed. A launch with this set is never certified clean." },
    dev_pct: { kind: "live", desc: "Percent of total supply the creator held after the first block. The single most load-bearing number in the file." },
    dev_sold: { kind: "ours", desc: "1 if we saw the creator sell while watching. 0 means we did not see it, which is not the same as it not happening. Recorded only where the venue's trade events name the wallet that traded; NULL where they do not, which is not zero and not a clean result. See venue." },
    unique_buyers: { kind: "ours", desc: "Distinct buyers across the token's whole life, INCLUDING post-graduation market buyers. This is NOT the outside-buyer count that judges a launch; use curve_buyers. Recorded only where the venue's trade events name the wallet that traded; NULL where they do not, which is not zero and not a clean result. See venue." },
    curve_buyers: { kind: "live", desc: "Distinct wallets, not counting the creator, that bought on the bonding curve. NULL means unknown, which never certifies as clean and never accuses. Unknown has three causes and none of them is zero: we did not watch the launch; we watched it on a venue whose trade events carry no wallet; or the launch predates 2026-09-12 and its trade rows had already been sampled at finalize or pruned by retention before anything counted them, so any count over the survivors would be a floor. From 2026-09-12 the collector counts these live as the trades arrive, which no sampling or retention can reach. For earlier launches the rows are counted only where at least as many curve-buy rows survive as the buys counter recorded, which is the test for their being all still present. This is the column an absence hurts most - zero outside buyers is the strongest thing this archive says against a launch - and it was published from the absence of rows we had deleted ourselves: see the curve-buyers-undercounted correction." },
    snap30_buyers: { kind: "live", desc: "Distinct buyers within the first 30 seconds. Meaningful only for an observed launch. NOT a bonding-curve count: like unique_buyers it is taken from the whole buyer set, so for a launch that left the curve inside those 30 seconds, or that we picked up again after it was already trading on a market, it includes market buyers. 366 launches in this archive carry a snap30_buyers above zero and recorded no curve buy at all, which is that case and not a contradiction. Do not use this column to check curve_buyers - two sessions reading this archive did, and read a buyout with market interest afterwards as a curve with hidden buyers. bundled_buyers is curve-only and is the column for that. Recorded only where the venue's trade events name the wallet that traded; NULL where they do not, which is not zero and not a clean result. See venue." },
    bundled_buyers: { kind: "live", desc: "Buyers landing in the creation block itself, bought before anyone outside could have seen the token exist. Recorded only where the venue's trade events name the wallet that traded; NULL where they do not, which is not zero and not a clean result. See venue." },
    graduated: { kind: "ours", desc: "1 if the curve is recorded as having completed: an inference from decoded trade volume, not a reading of the curve. Measured 2026-09-09: of rows where graduated_confirmed_by IS NULL, the curve account was read directly and returned complete=0 on 5,187 of them. Count graduations with graduated_confirmed_by IS NOT NULL; this column alone overstates them by about three quarters." },
    graduated_at: { kind: "ours", desc: "When the curve is recorded as completing, epoch ms. Subject to the same caveat as graduated." },
    pool: { kind: "chain", desc: "The PumpSwap pool address, once discovered. NULL is not evidence a curve did not complete: pool discovery has its own coverage gaps." },
    vault_sol: { kind: "reading", desc: "SOL in the pool at the last successful read. One value, not a history. Always read it with vault_at." },
    vault_at: { kind: "reading", desc: "When vault_sol was read, epoch ms. A balance without its age is not a fact. These two move together or not at all." },
    last_price: { kind: "ours", desc: "Last price we decoded for the token, in SOL per token. Present for research; the site makes no claim from it. NULL where the launch's curve is not quoted in SOL (see quote_mint): a quantity of some other asset published in this column would be read as SOL, and 0 would be read as a token that trades at nothing." },
    rebuilt_at: { kind: "ours", desc: "When we reconstructed this launch from chain history rather than watching it, epoch ms." },
    rebuilt_complete: { kind: "ours", desc: "1 when a rebuild read the curve's entire transaction history. 0 or NULL means signature paging hit its cap or transactions could not be fetched, so the rebuild is partial and its counts are floors." },
    updated_at: { kind: "ours", desc: "Last time any field on this row changed, epoch ms." },
    venue: { kind: "chain", desc: "Which launchpad the token came from, as the collector's own venue id. It decides what else on this row can exist: a venue whose trade events name the trading wallet supplies dev_sold and every buyer count, and one whose events name only a pool supplies none of them, leaving those columns NULL. The creator, the share of supply, the launch's own claim about itself and whether the curve completed are recorded on every venue. Coverage in `runs` is per venue too, so a launch is answered as watched only against windows recorded for its own venue." },
    peak_price: { kind: "live", desc: "The highest price we ever observed for this launch, in SOL per token. A peak only ratchets, so unlike a pool balance it is permanent once true, which is why it is published and last_price, which carries no timestamp, is not. Read it as a floor rather than a measurement: it is what we SAW, so a spike between observations is not here, and a launch we stopped following has a peak that stops with us. Multiply by 1e9 for an implied market cap in SOL, against the roughly 411 SOL at which a pump.fun curve completes." },
    peak_source: { kind: "ours", desc: "Where the peak came from. 'curve' or 'amm' mean we decoded an on-chain transaction that executed at that price. 'external' means a third-party price feed reported it and no trade was witnessed, which is a materially weaker claim and the one that produces peaks this archive cannot corroborate: of the four largest peaks on file, two hold a pool with zero decoded AMM trades and an implied cap over 2.9M SOL, while the two beside them are backed by 122 and 211 trades and reconcile exactly. NULL means we did not record the source, which is every row written before 2026-09-10, and never that the peak was unsourced. Deliberately not backfilled: the source is knowable only when the price arrives, and inferring it later from whichever trade rows survived retention would be manufacturing provenance." },
    peak_at: { kind: "live", desc: "When that highest price was observed, epoch ms. The peak is only a fact with the moment attached, exactly as vault_sol is only a fact with vault_at; the record refuses to publish either half alone." },
    meta_lag_ms: { kind: "ours", desc: "How long after the launch we read its document: meta_at minus created_at, in milliseconds. Derived from the two columns beside it on this row, never copied, so it cannot disagree with them. This is what separates a document captured as the launch happened from one recovered days later. The URI belongs to the creator and what it served on the 10th is not necessarily what it served on the 2nd. The distribution is sharply bimodal and deliberately not thresholded here: 80,448 rows under a minute, 2,174 in the whole span from one minute to a day, and 69,597 over a day. Any cut a reader picks between ten minutes and a day selects the same population, which is why we publish the measurement instead of a boolean built on a threshold we chose." },
    curve_checked_at: { kind: "reading", desc: "When we last read this token's bonding curve account directly, epoch ms. NULL means we have never read it, not that anything was found. Read this column before curve_complete: together they distinguish four states, and only two of them say anything about the token." },
    curve_complete: { kind: "reading", desc: "The curve account's own `complete` bit at curve_checked_at. 1 = we read the account and the curve had completed. 0 = we read it and it had not. NULL WITH a curve_checked_at = the account no longer existed when we looked, which tells you nothing about whether the curve filled. NULL WITH NO curve_checked_at = we never looked. A 0 here is a direct observation and is the basis for the correction against `graduated`; the two NULL cases are our coverage and are never evidence about a launch." },
    create_sig: { kind: "live", desc: "Signature of the transaction this launch was decoded from: the one carrying the creator's initial buy, and therefore the transaction dev_pct is computed from. Fetch it and you can check every launch figure in this row against the chain rather than trusting us. NULL means we did not record one: the launch predates the column (2026-09-09), or we found the token late and never saw its creation, or its trade rows were pruned before the backfill reached them. NULL is never a claim that no creation transaction exists." },
    create_slot: { kind: "live", desc: "The slot create_sig landed in. Present exactly when create_sig is." },
    graduated_confirmed_by: { kind: "ours", desc: "How graduation was confirmed: 'pool' (a PumpSwap pool was found), 'curve_complete' (the venue's own completion state: the bonding curve account's complete bit, or a pool status field the program emits with its trades, which is the same authority), or NULL for an inference from decoded trade volume that nobody ever confirmed. NULL means we say less, never that we say the opposite, but it is not neutral: where the curve account has since been read, the great majority of NULL rows returned complete=0. This column, not graduated, is the graduation flag." },
    curve_rows_dropped: { kind: "ours", desc: "How many of this launch's bonding-curve trade rows THIS PROJECT deleted when the launch was finalized. Finalize keeps the first and last 100-400 curve rows and drops the middle, because trade rows are the bulk of the database and launch-time facts are the scarce material. Until 2026-09-12 that deletion left no trace, so a launch with 40 surviving rows looked identical to a launch that only ever had 40 - a difference that matters most to the reader who matters most, anyone citing the ledger as evidence. 0 means the complete watched ledger is present and is a statement of completeness, not an absence. A positive number means that many rows were sampled away, and which ones is knowable: the middle. NULL means the launch predates the column or was never finalized, never that nothing was dropped. It accounts for the finalize sample ONLY - retention prunes later and independently, so surviving rows can be fewer still; read this beside buys and say so. The trade that completes a curve is the last curve trade, and it was among the rows finalize deleted until 2026-09-12: see the curve-buyers-undercounted correction for what counting over the survivors published." },
    curve_buyers_live: { kind: "live", desc: "The same count as curve_buyers, taken by the collector as the trades arrived rather than recomputed afterwards from stored rows. Exists because the recomputation was being done over a table that finalize samples and retention prunes, which published a floor as a measurement. NULL means the launch predates the column (2026-09-12) or was found after it was already trading, never that nobody bought. Published in the record as curve_buyers; this column is in the collector's database and names the source." },
    curve_account: { kind: "chain", desc: "The account holding this launch's curve state, where the mint does not determine it. NULL is the pump.fun case and means the address is derivable: its bonding curve is a program-derived address computed from the mint, so anyone can recompute it and storing it would add nothing. A venue whose curve address is seeded with more than the mint - Raydium LaunchLab's pool takes the platform config and the quote mint as well - has it written down here, because it is otherwise unrecoverable and the curve could never be re-read. NULL is never 'we could not work it out'." },
    quote_mint: { kind: "chain", desc: "The asset this launch's curve is priced in. NULL means wrapped SOL, which is every pump.fun launch and every row written before this column existed. A Raydium LaunchLab pool names its quote asset per pool and most name something else, in which case no SOL figure is published for the launch at all: last_price is NULL and no trade rows are written, because a quantity of some other token in a column named for SOL is how a 40 SOL rule fires on 40 of something else. The launch, its creator and its share of supply are recorded either way." },
    uri: { kind: "ours", desc: "Metadata URI the launch declared." },
    image: { kind: "ours", desc: "Image URL from that metadata. A NULL here with meta_at set means the launch declared no picture, a different statement from us not fetching one." },
    description: { kind: "ours", desc: "Description the launch declared off-chain, at the time we read it." },
    meta_at: { kind: "ours", desc: "When we read the off-chain metadata, epoch ms. Set with a NULL image means the launch genuinely declared none." },
    image_sha256: { kind: "ours", desc: "sha256 of the image bytes, when we hold them: the proof rather than the picture. NULL means we did not fetch it, which is a disk-budget decision and not a finding about the launch." },
    image_bytes: { kind: "ours", desc: "Size of the fetched image in bytes." },
    image_at: { kind: "ours", desc: "When the image bytes were fetched, epoch ms." },
    image_error: { kind: "ours", desc: "Always NULL here. It records why one of our image fetches failed, which describes us rather than the launch, so the published record does not carry it. The column exists because our own tooling migrates any database it opens to the collector's schema." },
    meta_json: { kind: "ours", desc: "Always NULL here. The collector keeps the metadata document, which is retrievable exactly once, since the URI is the creator's to repoint, but publishing it would add roughly a kilobyte per launch to a file whose whole value is that one person can mirror it. The column exists because our own tooling migrates any database it opens; read meta_bytes to tell 'never fetched' from 'fetched and it exists'." },
    meta_sha256: { kind: "live", desc: "sha256 of the metadata document as we received it at launch: the commitment, not the document. The document itself stays in the collector because publishing it would add tens of megabytes a day to a file whose value is that one person can mirror it. This lets anyone who later obtains that document prove it is the one we read, before the creator could repoint the URI. NULL means we hold no document to commit to." },
    meta_bytes: { kind: "ours", desc: "Size of the metadata document as served, in bytes. The document itself is kept by the collector but is not published here: at roughly a kilobyte a launch it would add tens of megabytes a day to a file whose whole point is that one person can mirror it. This column is what lets you tell 'we never fetched it' from 'we fetched it and it exists'." },
  },
  wallet_flow: {
    wallet: { kind: "chain", desc: "A wallet that has bought at least one bonding curve outright. One row each." },
    curve_sol: { kind: "chain", desc: "SOL this wallet spent buying bonding curves." },
    amm_buy: { kind: "ours", desc: "SOL this wallet spent buying back on the open market, on the curves it took. Sum the market='amm', side='buy' rows in trades for this wallet and you will get this number." },
    amm_sell: { kind: "ours", desc: "SOL this wallet received selling on the open market, on the curves it took: the tokens it bought the float of, not everything it ever traded. Sum the market='amm', side='sell' rows in trades for this wallet and you will get this number. It used to count every token the wallet touched while the pages around it said 'sold after taking the curve'." },
    tokens: { kind: "ours", desc: "Number of curves this wallet took. Count the distinct mints in trades for this wallet and you will get this number." },
  },
  trades: {
    sig: { kind: "chain", desc: "Signature of the transaction this trade was decoded from. Fetch it and you can verify the buyout for yourself: the single fact this record states most seriously about a launch, and the one it should least ask you to take on trust. NULL where retention removed the row before this column existed (2026-09-09); never a claim that no transaction exists." },
    mint: { kind: "chain", desc: "Token traded." },
    wallet: { kind: "chain", desc: "Wallet that traded." },
    side: { kind: "chain", desc: "'buy' or 'sell'." },
    sol: { kind: "chain", desc: "Size of the trade in SOL." },
    ts: { kind: "chain", desc: "When we decoded the trade, epoch ms. Events arriving together carry the same timestamp, so ordering within a batch is not established." },
    /**
     * Both names, because a record file can legitimately carry either for a while.
     *
     * This column was renamed from `venue` to `market` on 2026-09-11. The collector migrates its own database and
     * rebuilds the record; the web service opens that record with `migrate: false` on purpose, so between the two
     * a served record still has the old name while the code documents the new one. The guard above then fires on a
     * column with no description and takes /data.html down with a 500, which is exactly what happened.
     *
     * Documenting both is the honest fix rather than weakening the guard: a reader holding an older copy of the
     * file gets a description of the column it actually has. Drop the `venue` entry once no record older than the
     * rename is in circulation.
     */
    venue: { kind: "chain", desc: "Superseded name for `market`, below. Records built before 2026-09-11 carry this instead; the values and meaning are identical. Renamed because `tokens.venue` means the launchpad and one word cannot mean two things in one schema." },
    market: { kind: "chain", desc: "'curve' for a bonding-curve trade, 'amm' for one on the open market. This table holds two things and nothing else: curve buys large enough to count as a buyout, and the market trades those same wallets made on those same tokens afterwards. The second set is here so wallet_flow can be checked against it rather than believed." },
    is_dev: { kind: "chain", desc: "1 when the trading wallet is the token's creator." },
    slot: { kind: "chain", desc: "Solana slot, where known." },
  },
  hist_trades: {
    mint: { kind: "chain", desc: "Token traded." },
    sig: { kind: "chain", desc: "Transaction signature. Take this to any explorer and check the row yourself." },
    idx: { kind: "chain", desc: "Instruction index within the transaction." },
    ts: { kind: "chain", desc: "Block time, epoch ms. Read from chain history, so unlike trades.ts this is the real block time." },
    slot: { kind: "chain", desc: "Solana slot." },
    wallet: { kind: "chain", desc: "Wallet that traded." },
    side: { kind: "chain", desc: "'buy' or 'sell'." },
    sol: { kind: "chain", desc: "Size in SOL." },
    tokens: { kind: "chain", desc: "Token amount moved." },
    vsol: { kind: "chain", desc: "Virtual SOL reserve after the trade: how full the curve was." },
    vtok: { kind: "chain", desc: "Virtual token reserve after the trade." },
    is_dev: { kind: "chain", desc: "1 when the trading wallet is the token's creator." },
    rebuild_complete: { kind: "ours", desc: "Whether the rebuild this row came from read the WHOLE curve. 1 complete, 0 truncated, NULL not knowable in this file. These rows are reconstructions, and a rebuild that read a fortieth of a curve produces real trades and a false total: measured on the collector, 188 of 2,729 rebuilds were truncated, averaging 38.7% of their own history, and the undercount lands squarely on buyer counts and creator share. NULL is not a quiet 'probably fine' - it means this file was built from a source carrying no completeness metadata at all, which is how 1,072 buyout rows came to be published unqualified. meta.hist_trades_qualified says which of those two a given file is, and correction reconstructions-published-unqualified records the episode." },
  },
  runs: {
    id: { kind: "ours", desc: "Collector run." },
    started_at: { kind: "ours", desc: "When the collector started watching, epoch ms." },
    stopped_at: { kind: "ours", desc: "When it stopped, epoch ms. NULL means still running. Launches outside these windows were not observed; this table is how you check what we were awake for." },
    venue: { kind: "ours", desc: "Which launch venue this window covers. A window says we were observing THIS venue; it says nothing about any other, and a launch on a venue absent from these windows is unwatched rather than clean. Every window recorded before 2026-09-11 is a pump.fun window and carries that value." },
    note: { kind: "ours", desc: "Why the run started or ended, when we recorded it." },
  },
  pool_map: {
    pool: { kind: "chain", desc: "PumpSwap pool address. Primary key." },
    mint: { kind: "chain", desc: "Token that pool trades." },
    created_at: { kind: "ours", desc: "When we first mapped the pool, epoch ms, not when the pool was created." },
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
  operator_funders: {
    funder: { kind: "chain", desc: "An address that has funded wallets we associate with a cluster. The cluster label used across this site is the first six characters of this address: it is a name of ours, not an identity." },
    first_seen: { kind: "chain", desc: "The earliest funding transaction we observed from it, epoch ms." },
    last_seen: { kind: "chain", desc: "The most recent, epoch ms. Not an assertion that it has stopped." },
    txs: { kind: "chain", desc: "Funding transactions observed from this address, within our coverage only." },
    wallets: { kind: "chain", desc: "Distinct wallets it has sent SOL to. A large number is equally consistent with a wallet farm and with a trading terminal serving many customers; see note." },
    seeds: { kind: "chain", desc: "Fundings that opened a wallet with no prior balance, as distinct from topping one up." },
    sampled_at: { kind: "ours", desc: "When we last walked this funder's history, epoch ms. The counts above describe what we had seen at that moment and are floors, never totals." },
    note: { kind: "ours", desc: "Where a funder has been identified as something other than a wallet farm (a trading terminal funding its users, most often), this says so. Read it before drawing anything from the counts: it is the column that withdraws the inference the others invite." },
    parent: { kind: "chain", desc: "The address that funded this funder, where we traced one. NULL means we did not trace one, never that none exists." },
    hops: { kind: "ours", desc: "How many funding steps from the cluster's wallets we walked to reach this address. 0 is the direct funder." },
  },
  corrections: {
    id: { kind: "ours", desc: "Stable slug, so a correction can be cited by name." },
    issued_at: { kind: "ours", desc: "When the correction was published, epoch ms." },
    scope: { kind: "ours", desc: "What it concerns: 'column', 'row' or 'record'." },
    subject: { kind: "ours", desc: "The column name or mint the correction is about; NULL when it applies to the whole record." },
    finding: { kind: "ours", desc: "What was wrong." },
    effect: { kind: "ours", desc: "What a reader who trusted the uncorrected record would have wrongly concluded. This is the field to read if you have already published something derived from an earlier copy of this file." },
    remedy: { kind: "ours", desc: "What was done about it, and what to read instead." },
    supersedes: { kind: "ours", desc: "The id of a correction this one replaces. The table is append-only: corrections are superseded, never edited or deleted." },
  },
  meta: {
    k: { kind: "ours", desc: "Key. The published record carries built_at (when this file was assembled), built_by (which machine and script: 'local' or the cloud service name, never a personal hostname), built_pid, and watermark (how far the incremental copy had reached)." },
    v: { kind: "ours", desc: "Value, as text. Timestamps are epoch ms." },
  },
};

const TABLE_NOTE: Record<string, string> = {
  operator_funders: "One row per funding address behind a cluster. operator_wallets carries the wallet-to-cluster "
    + "edge; this carries the node it points at, which is the half of the attribution that takes continuous "
    + "observation to build. A shared funder is a lead and not a finding, and `note` is where we say so.",
  tokens: "One row per launch. This is the record.",
  wallet_flow: "One row per wallet that has bought a curve outright.",
  trades: "Curve buys large enough to count as a buyout. Not every trade on every token.",
  hist_trades: "Trades read from chain history during a rebuild, each with its transaction signature.",
  runs: "The coverage windows. What we were awake for.",
  pool_map: "Which PumpSwap pool belongs to which token.",
  operator_wallets: "Wallets grouped by who funded them.",
  corrections: "Every correction this project has issued against its own record, so a reader who mirrors this file and never visits the site still learns what was wrong. Append-only: a correction is superseded by a new row naming it, never edited.",
  graduations: "A view, not a table: the launches whose curve completion was actually confirmed. `SELECT * FROM graduations` is the defensible answer to a question `tokens.graduated` overstates.",
  meta: "What built this file, and when. A record that cannot account for its own origin is a strange thing for a provenance project to publish.",
};

/** Columns actually present in the record, in file order. */
const columnsOf = (db: DatabaseSync, table: string): { name: string; type: string }[] => {
  try { return db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(table) as any[]; }
  catch { return []; }
};

/**
 * The schema section. Throws rather than publishing an incomplete one: see the note at the top of this file.
 */
export function renderSchema(db: DatabaseSync): string {
  const missing: string[] = [];
  const sections: string[] = [];

  /**
   * Undocumented TABLES fail the build too, not only undocumented columns.
   *
   * This was one-sided and the asymmetry hid a real omission: a table absent from DOCS was quietly left off the
   * page, so the file could hold something the schema never mentioned. `meta`, the table saying what built the
   * record and when, sat undocumented for exactly that reason, on a page whose whole subject is provenance.
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
      // Addressable, so a record page can send a reader to the entry for the one column it could not fill in.
      // `columnAnchor` is the single spelling of the id; nothing else builds one.
      return `<tr id="${esc(columnAnchor(table, c.name))}"><td class="mono id">${esc(c.name)}</td><td class="mut">${esc(c.type.toLowerCase())}</td>
        <td><span class="kind k-${d.kind}">${d.kind}</span></td><td>${esc(d.desc)}</td></tr>`;
    }).join("");

    sections.push(`<div class="sec"><h2>${esc(table)}</h2><span class="cnt">${cols.length} columns</span></div>
      <p class="lede">${esc(TABLE_NOTE[table] ?? "")}</p>
      <table class="data"><tr><th>Column</th><th>Type</th><th>Kind</th><th>What it is</th></tr>${rows}</table>`);
  }

  if (missing.length) {
    throw new Error(
      `schema-doc: ${missing.length} column(s) in the record have no description: ${missing.join(", ")}.\n` +
      `Add them to DOCS in src/schema-doc.ts. The build fails rather than publishing a schema with holes in it. ` +
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
      row: pick("graduated_confirmed_by IS NOT NULL AND late_discovery=0 AND dev_pct>=50 AND curve_buyers=0") },
    { label: "Clean at birth", note: "small creator share, real spread of buyers",
      row: pick("graduated_confirmed_by IS NOT NULL AND late_discovery=0 AND dev_pct<20 AND curve_buyers>=30") },
    { label: "Not observed", note: "found late; the first block was never seen",
      row: pick("late_discovery=1") },
  ].filter((c) => c.row);
  if (!cases.length) return "";

  const F: [string, (r: any) => string][] = [
    ["symbol", (r) => r.symbol ?? "(none)"],
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
