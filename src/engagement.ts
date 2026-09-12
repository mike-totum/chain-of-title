/**
 * A scoped working file for client work: the workspace is bounded AT CREATION, not filtered at delivery.
 *
 * WHY THIS EXISTS, AND WHY IT IS A DATABASE RATHER THAN A FILTER
 *
 * The two specimen reports were written the way research is written: query the whole archive, learn everything
 * interesting, then decide on the way out what is fit to publish. That is backwards for anything that can be
 * discovered. A working file is not protected by what the final document omits - it is protected by what never
 * entered it. Three leaks in the adverse specimen, each of which a delivery-time filter would have had to catch
 * by someone remembering:
 *
 *   1. "Top three candidates" named two OTHER launches with their adverse particulars, and recorded that we
 *      ranked launches and picked this one. In a client's hands that is a document about how the subject was
 *      selected for being the most damning - and the other two are third parties who are nobody's subject.
 *   2. "The same cluster's other launches" tabulated 29 further mints with symbols, wallet counts and
 *      confirmation sources. None of them is the subject.
 *   3. `operator_policy.note` for cluster FC9BqG reads "holds through the flat window; Kshama 660x, Simba 46x" -
 *      two more launches named, inside a free-text field this project hand-wrote for its own watching.
 *
 * Leak 3 is the one that settles the architecture. It is not a row that a predicate could have excluded and not a
 * base58 identifier that a scanner could have spotted: it is an English sentence, authored by us, naming other
 * people's launches by symbol, sitting in a column whose name gives no hint. No filter written afterwards finds
 * that reliably. The only thing that does is never copying the column.
 *
 * So an engagement opens a NEW SQLITE FILE holding only in-scope rows, and the report pipeline is pointed at that
 * file. Out-of-scope material is not withheld from the report; it is absent from the workspace, so no query can
 * reach it and no author can quote it by accident. `servicedb.ts` already establishes this shape in this repo -
 * the published record is a derived database carrying only what belongs on the serving path - and this is the
 * same move made for one matter instead of for the public.
 *
 * THE SUBJECT IS DECLARED, NEVER SEARCHED FOR
 *
 * There is deliberately no discovery function here, and `openEngagement` will not accept a predicate in place of
 * a mint. Leak 1 exists because a specimen had to choose its own subject; a client names theirs. A workspace that
 * could rank launches by how adverse they look would recreate that document on every engagement, and it is the
 * single worst thing to find in a working file. If candidate selection is ever wanted it is a different activity
 * under its own scope, not a query this file offers.
 *
 * TWO INSTRUMENTS, BECAUSE NEITHER IS SUFFICIENT ALONE
 *
 * `CARRY` is a whitelist with a per-column classification: it stops structured leaks (leak 2's table, leak 3's
 * column, `operator_wallets.source_mint`, which names the launch a wallet's funding came from). `residue()` then
 * re-reads the finished file and hunts base58 identifiers that are not in scope: it stops the leak nobody
 * classified, including in a table added to `db.ts` next month. Rule 6 from 2026-09-12 - an instrument sharing a
 * code path with the thing it checks is not a second instrument - so residue() reads the OUTPUT file and knows
 * nothing about CARRY, and would fail identically if CARRY were deleted entirely.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VENUES } from "./venues.ts";
import { openDb } from "./db.ts";
import { config } from "./config.ts";

/**
 * What an engagement is allowed to look at, fixed before any row is read.
 *
 * `from`/`to` bound the trade ledger. They are REQUIRED and not defaulted to the subject's lifetime: a window that
 * silently grows to fit the data is not a scope, and "we looked at everything and then decided" is the practice
 * this file exists to end. `openEngagement` checks that each subject's creation falls inside the window, because a
 * window that does not contain the launch would produce a workspace whose central fact is out of its own scope.
 */
export interface Scope {
  /** The matter this file belongs to. Appears in the manifest; it is how a file on disk names its engagement. */
  readonly matter: string;
  /** The launches this engagement is about. Declared by the client, never derived from a search. */
  readonly subject: readonly string[];
  /** Inclusive epoch-ms bounds on every trade, message and snapshot carried. */
  readonly from: number;
  readonly to: number;
  /**
   * Carry third-party documents that reference a subject mint - tweets, Telegram posts, the launchpad's own
   * record. OFF by default, and the default is the point: these are quoted verbatim from sources we did not write,
   * so they can legitimately name anything, and residue() cannot tell a leak from a primary source inside one.
   * With this off a workspace is residue-clean with no exceptions to argue about. With it on, every foreign
   * identifier found inside a quoted document is listed in the manifest as a disclosure rather than suppressed -
   * redacting a primary source destroys the thing that makes it evidence.
   */
  readonly includeQuotedDocuments?: boolean;
}

/** How a column may cross into a workspace. The classification is the decision; the copy just obeys it. */
type Carry =
  /** An observation or a value of the subject's own. Copied. */
  | "measured"
  /** Base58 naming a party, the subject, or one of their accounts. Copied, and added to the in-scope set. */
  | "identifier"
  /** Names a launch or address outside the subject. Copied ONLY when the value is itself in scope, else NULL. */
  | "foreign"
  /**
   * A document we did not write, quoted verbatim: the launch's own metadata JSON, its description, the
   * launchpad's record of it, a tweet's text. Copied, because these are the most probative things the archive
   * holds and the least reconstructible. An identifier found inside one is a DISCLOSURE, not a leak - the author
   * put it there, and a primary source that has been edited to suit our scope has stopped being evidence. The
   * manifest lists them so the report writer knows what is in the document before quoting from it.
   */
  | "document"
  /**
   * Source-internal bookkeeping with no meaning outside the collector - an autoincrement rowid, a retry counter.
   * Dropped deliberately, and named so, so that `dropped` stays a list of decisions rather than a list that mixes
   * decisions with things nobody has looked at yet.
   */
  | "internal"
  /**
   * Free text this project authored about someone. NEVER copied, whatever it says.
   *
   * These are not observations - they are our own working annotations, and the register does not offer opinion
   * (see the register-not-rating-agency stance). They are also unscannable: `operator_policy.note` leaked two
   * launches in prose. A column of ours that describes a third party has no honest place in a file about someone
   * else, so the classification refuses it rather than trying to sanitise it.
   */
  | "label";

interface TableRule {
  /** SQL predicate over the source table, with `$subject` expanded to the subject mint list. Rows failing it never load. */
  readonly where: string;
  readonly columns: Readonly<Record<string, Carry>>;
  /** Quoted third-party material: carried only when `includeQuotedDocuments` is set. */
  readonly quoted?: boolean;
}

/**
 * Every table that may enter a workspace, and on what terms. A table absent from here is NOT copied.
 *
 * Whitelist, not blacklist, because the failure this guards is a table nobody thought about. `db.ts` gains tables;
 * a blacklist would let each new one flow into every engagement's working file silently, and the first anyone
 * would know is opposing counsel reading it. `unlisted()` reports what the source holds that this does not name,
 * so a new table is a decision somebody makes rather than a default somebody inherits.
 */
export const CARRY: Readonly<Record<string, TableRule>> = {
  tokens: {
    where: "mint IN ($subject)",
    columns: {
      mint: "identifier", creator: "identifier", pool: "identifier", curve_account: "identifier",
      quote_mint: "identifier", create_sig: "identifier",
      name: "measured", symbol: "measured", uri: "measured", created_at: "measured", late_discovery: "measured",
      launch_price: "measured", last_price: "measured", peak_price: "measured", peak_at: "measured",
      peak_source: "measured", dev_pct: "measured", dev_sold: "measured", dev_sold_at: "measured",
      create_slot: "measured", buys: "measured", sells: "measured", buy_vol_sol: "measured",
      sell_vol_sol: "measured", unique_buyers: "measured", unique_sellers: "measured", bundled_buyers: "measured",
      snap30_buyers: "measured", snap30_buys: "measured", snap30_sells: "measured", snap30_vol: "measured",
      graduated: "measured", graduated_at: "measured", last_seen_at: "measured", p_1m: "measured",
      p_5m: "measured", p_15m: "measured", p_60m: "measured", twitter: "measured", telegram: "measured",
      website: "measured", kol_signals: "measured", amm_trusted: "measured", vault_sol: "measured",
      vault_at: "measured", finalized: "measured", updated_at: "measured", venue: "measured",
      graduated_confirmed_by: "measured", curve_buyers_live: "measured", curve_rows_dropped: "measured",
      /**
       * The captured document and its hashes. These are the reason a report can say the metadata was on file
       * 1.364 s after the creation transaction with a sha256 that re-derives - the most perishable evidence the
       * archive holds and the part a third party cannot rebuild later. `meta_json` and `description` are the
       * creator's own words about their own launch: carried whole, classified `document`, never edited to fit.
       */
      meta_json: "document", description: "document", image: "document",
      meta_at: "measured", meta_sha256: "measured", meta_bytes: "measured", meta_error: "measured",
      image_sha256: "measured", image_bytes: "measured", image_at: "measured", image_error: "measured",
      curve_buyers: "measured", rebuilt_at: "measured", rebuilt_complete: "measured",
    },
  },
  trades: {
    where: "mint IN ($subject) AND ts BETWEEN $from AND $to",
    columns: {
      mint: "identifier", wallet: "identifier", sig: "identifier",
      side: "measured", sol: "measured", tokens: "measured", price: "measured", ts: "measured",
      slot: "measured", age_ms: "measured", buyer_rank: "measured", is_dev: "measured", market: "measured",
      id: "internal",
    },
  },
  wallet_token_stats: {
    where: "mint IN ($subject)",
    columns: {
      mint: "identifier", wallet: "identifier",
      first_buy_at: "measured", first_buy_age_s: "measured", first_buy_rank: "measured",
      first_buy_slot_delta: "measured", buys: "measured", sells: "measured", sol_in: "measured",
      sol_out: "measured", tokens_net: "measured", realized_pnl_sol: "measured", unrealized_sol: "measured",
      last_trade_at: "measured", hold_s: "measured", is_dev: "measured", token_graduated: "measured",
      token_peak_x: "measured", token_created_at: "measured",
    },
  },
  /**
   * Only the rows for wallets that actually traded this subject, and `source_mint` nulled unless it is a subject.
   *
   * The worklist calls "when was this wallet funded, relative to the launch" the most probative fact in the
   * cluster section, so `seeded_at` and `funder` have to come across. `source_mint` is the launch whose buyout
   * first exposed the wallet to the tracer - a different launch, usually someone else's, named in a column that
   * looks like plumbing. `funder` and `cluster` are one relation out from a party and are declared in scope; the
   * funder's OWN funder is two hops out and is dropped, because two hops from the subject is not the subject.
   */
  operator_wallets: {
    where: "wallet IN ($parties)",
    columns: {
      wallet: "identifier", funder: "identifier", cluster: "identifier",
      source_mint: "foreign",
      role: "measured", seeded_at: "measured", traced: "measured", added_at: "measured",
    },
  },
  operator_funders: {
    where: "funder IN ($funders)",
    columns: {
      funder: "identifier",
      parent: "foreign",
      note: "label",
      first_seen: "measured", last_seen: "measured", txs: "measured", wallets: "measured",
      seeds: "measured", sampled_at: "measured", hops: "measured",
    },
  },
  pool_map: {
    where: "mint IN ($subject)",
    columns: { pool: "identifier", mint: "identifier", created_at: "measured" },
  },
  /**
   * Carried whole and deliberately. `runs` is custody evidence - when the collector was observing - and section 2
   * of a report cannot state coverage without it. It names no launch and no address, so there is nothing in it to
   * scope; an interval is not about anybody.
   */
  runs: {
    where: "1=1",
    /** `venue` is load-bearing, not decoration: venues.ts clause 3 - coverage is per venue or it is a lie. */
    columns: {
      id: "measured", started_at: "measured", stopped_at: "measured", note: "measured", venue: "measured",
    },
  },
  platform_snapshots: {
    where: "mint IN ($subject) AND fetched_at BETWEEN $from AND $to",
    /**
     * The launchpad's own record of the subject, versioned. `is_banned` is, per db.ts, the closest thing to an
     * admission this market produces, and it is never announced - so it travels, and so does the rest of the
     * venue's own account of the launch it hosted.
     */
    columns: {
      mint: "identifier", sha256: "measured", fetched_at: "measured", json: "document", bytes: "measured",
      is_banned: "measured", nsfw: "measured", reply_count: "measured", ath_market_cap: "measured",
      ath_at: "measured", is_live: "measured", error: "measured",
    },
  },
  tweets: {
    where: "mints LIKE $like AND created_at BETWEEN $from AND $to",
    quoted: true,
    columns: {
      id: "measured", author: "measured", followers: "measured", created_at: "measured", text: "document",
      urls: "document", query: "internal", mints: "document", cashtags: "document", hashtags: "document",
      likes: "measured", retweets: "measured", views: "measured", fetched_at: "measured",
    },
  },
  tg_messages: {
    where: "mints LIKE $like AND posted_at BETWEEN $from AND $to",
    quoted: true,
    columns: {
      channel: "measured", msg_id: "measured", posted_at: "measured", text: "document", mints: "document",
      views: "measured", forwards: "measured", fetched_at: "measured", sender: "measured",
      url: "document", cashtags: "document", reply_to: "measured", edited_at: "measured",
    },
  },
  /**
   * The curve readings and the chain reconstruction: mint-keyed throughout, and the most repeatable evidence the
   * archive holds about a single launch. `curve_snapshots` is the one the worklist calls out as missing on
   * confirmed graduations - exactly the launches a report would present as best-evidenced - so when it is filled
   * it has to be able to reach a working file.
   */
  curve_checks: {
    where: "mint IN ($subject)",
    columns: { mint: "identifier", checked_at: "measured", checks: "measured", complete: "measured" },
  },
  curve_poll: {
    where: "mint IN ($subject)",
    columns: {
      mint: "identifier", curve: "identifier",
      created_at: "measured", next_at: "measured", last_vsol: "measured", last_rsol: "measured",
      unchanged: "measured", polls: "measured", done: "measured", done_reason: "measured",
    },
  },
  curve_snapshots: {
    where: "mint IN ($subject) AND ts BETWEEN $from AND $to",
    columns: {
      mint: "identifier", ts: "measured", vsol: "measured", vtok: "measured", rsol: "measured",
      complete: "measured",
    },
  },
  hist_tokens: {
    where: "mint IN ($subject)",
    columns: {
      mint: "identifier", creator: "identifier", curve: "identifier",
      name: "measured", symbol: "measured", created_at: "measured", complete: "measured",
      mcap_sol: "measured", mcap_usd: "measured", ath_usd: "measured", ath_at: "measured",
      sol_usd: "measured", source: "measured", status: "measured", sigs: "measured",
      sigs_failed: "measured", sigs_capped: "measured", txs_fetched: "measured", trades: "measured",
      buyers: "measured", dev_pct: "measured", first_ts: "measured", last_ts: "measured",
      grad_ts: "measured", graduated_min: "measured", peak_x: "measured", error: "measured",
      updated_at: "measured", dev_buy_pct: "measured",
    },
  },
  hist_trades: {
    where: "mint IN ($subject) AND ts BETWEEN $from AND $to",
    columns: {
      mint: "identifier", sig: "identifier", wallet: "identifier",
      idx: "measured", ts: "measured", slot: "measured", side: "measured", sol: "measured",
      tokens: "measured", vsol: "measured", vtok: "measured", is_dev: "measured",
    },
  },
  hist_activity: {
    where: "mint IN ($subject)",
    columns: {
      mint: "identifier", hour: "measured", txs: "measured", failed: "measured", trades: "measured",
      buyers: "measured", buy_sol: "measured", sell_sol: "measured", vsol_end: "measured",
    },
  },
  token_outcomes: {
    where: "mint IN ($subject)",
    columns: {
      mint: "identifier", pool: "identifier",
      name: "measured", symbol: "measured", created_at: "measured", graduated: "measured",
      mcap_usd: "measured", source: "measured", fetched_at: "measured", mcap_sol: "measured",
      pool_sol: "measured", verified: "measured",
    },
  },
  outcome_snapshots: {
    where: "mint IN ($subject) AND ts BETWEEN $from AND $to",
    columns: { mint: "identifier", ts: "measured", mcap_sol: "measured", pool_sol: "measured" },
  },
  /**
   * Coverage of the off-chain search, which is what lets section 6 say we LOOKED and found nothing rather than
   * that we have nothing on file - the distinction the register stance turns on. The counts travel by default;
   * the tweets they counted are quoted material and do not.
   */
  mention_scans: {
    where: "mint IN ($subject)",
    columns: { mint: "identifier", scanned_at: "measured", tweets: "measured" },
  },
  token_promotion: {
    where: "mint IN ($subject)",
    columns: {
      mint: "identifier", searched_at: "measured", provider: "measured", found: "measured",
      authors: "measured", error: "measured", query: "internal",
    },
  },
  mentions: {
    where: "mint IN ($subject) AND posted_at BETWEEN $from AND $to",
    quoted: true,
    columns: {
      mint: "identifier", tweet_id: "measured", account: "measured", followers: "measured",
      posted_at: "measured", text: "document", url: "document", fetched_at: "measured", source: "measured",
    },
  },
  token_promotion_hit: {
    where: "mint IN ($subject)",
    quoted: true,
    columns: { mint: "identifier", tweet_id: "measured", searched_at: "measured" },
  },
};


/**
 * Tables that exist in the collector and are refused by name, with the reason, so the refusal is a decision on
 * the record rather than an omission someone later reads as an oversight and "fixes".
 */
export const NEVER: Readonly<Record<string, string>> = {
  operator_policy:
    "this project's own hand-set label on a cluster: policy, play counts, and a free-text note that leaked two " +
    "third-party launches by symbol in the adverse specimen. It is opinion we authored, not an observation, and " +
    "the register does not offer opinion.",
  positions:
    "this project's own paper trades. The clean-launch draft found them interleaved into the subject's own " +
    "timeline, where they read as market activity on the launch. They are our simulation and were never orders.",
  signals: "the trading side's own decisions. Same reason as positions.",
  smart_wallets: "a score this project computed over wallets, most of them nobody's party. A rating, and ours.",
  wallet_teams: "co-occurrence clusters computed across the whole archive; every row is about other launches.",
  buzz: "term-level social aggregates across the archive, matched to mints that are not the subject.",
  tg_gaps: "collection bookkeeping for the Telegram archiver. Says nothing about any launch.",
  legal_holds: "our own retention state. Belongs to the firm, not to a matter's working file.",
  meta: "build stamps of the published record. A workspace records its own provenance in its manifest.",
  telegram_channels:
    "this project's grading of a broadcast channel - how often its calls graduated, its median lead time - " +
    "computed across the whole archive. Every figure in it is about other launches, and the grade is ours.",
  corrections: "the public corrections table - published, and cited by reference rather than copied.",
};

/** Any base58 run that could be an account or a signature. Length is judged after matching, by `isAccountish`. */
const B58 = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;

/**
 * Is this base58 run the right length to BE a Solana account or signature?
 *
 * A 32-byte account encodes to 32-44 base58 characters and a 64-byte signature to 86-88. Nothing legitimate lands
 * between. This matters because the first run of `residue()` against a real workspace reported one leak, and it
 * was `tokens.uri` holding `QmNmKKKCHSzK1NWZzyrD8DcffSLJHSeGKtbkk69DUBR3Qz` - an IPFS CIDv0, 46 characters, which
 * is base58 and is not an address. It is the subject's OWN document hash, so it was not a leak at all.
 *
 * Judging by length rather than by an `if (startsWith("Qm"))` keeps this about what a Solana identifier is, so
 * the next content hash in some other encoding does not need a second special case. KNOWN LIMIT, stated rather
 * than papered over: an out-of-scope address concatenated to more base58 with no separator would match as one
 * over-length run and be skipped here. `CARRY` is the defence against that; this is the second instrument, not
 * the only one.
 */
const isAccountish = (s: string) => (s.length >= 32 && s.length <= 44) || (s.length >= 86 && s.length <= 88);

/**
 * Hex digests are not addresses, and they match the base58 class by accident.
 *
 * Base58 omits `0`, `O`, `I` and `l`; hex uses `0-9a-f`. So a sha256 digest is base58-legal apart from its zeros,
 * and `B58` matched a 34-character RUN out of the middle of `tokens.image_sha256` - the second false positive the
 * first real runs produced, after the IPFS CID. Both halves are needed: the whole-cell test catches a bare digest
 * in a hash column, the per-run test catches one embedded in a JSON document.
 *
 * A genuine Solana address drawn only from `[1-9a-f]` is possible in principle at roughly (15/58)^43, which is
 * not a risk anyone needs to carry a special case for.
 */
const isHexDigest = (s: string) => /^[0-9a-f]+$/i.test(s) && s.length >= 32;

/**
 * Public infrastructure that is not a party: program ids, the wrapped-SOL mint, the system program.
 *
 * Derived from the venue registry rather than typed out, so onboarding a third venue does not make every
 * workspace built afterwards report that venue's program id as an out-of-scope address. Same discipline as
 * `cannotAttributeSql()`: the registry is the one place a venue declares itself.
 */
export const INFRASTRUCTURE = new Set<string>([
  ...VENUES.map((v) => v.program),
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
]);

const q = <T = any>(db: DatabaseSync, sql: string, ...p: unknown[]) =>
  db.prepare(sql).all(...(p as any[])) as T[];

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: Iterable<string>) => {
  const a = [...xs];
  return a.length ? a.map(quote).join(",") : "''";
};

const hasTable = (db: DatabaseSync, t: string) =>
  q(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t).length > 0;

const columnsOf = (db: DatabaseSync, t: string) =>
  q<{ name: string }>(db, `PRAGMA table_info(${t})`).map((r) => r.name);

/** Column name -> declared type, so the workspace keeps the source's affinity instead of a guess from the name. */
const typesOf = (db: DatabaseSync, t: string) =>
  new Map(q<{ name: string; type: string }>(db, `PRAGMA table_info(${t})`).map((r) => [r.name, r.type || ""]));

/** Values of one column of a workspace table, tolerating the table not having been carried at all. */
const colValues = (db: DatabaseSync, table: string, col: string): string[] => {
  try {
    return q<{ v: unknown }>(db, `SELECT DISTINCT ${col} v FROM ws.${table} WHERE ${col} IS NOT NULL`)
      .map((r) => r.v).filter((v): v is string => typeof v === "string");
  } catch { return []; }
};

/**
 * What the source database holds that `CARRY` and `NEVER` do not mention.
 *
 * The whole point of a whitelist is that a table nobody classified does not travel, and the whole risk is that
 * nobody notices there was one. This is how a new table announces itself.
 */
export function unlisted(db: DatabaseSync): string[] {
  return q<{ name: string }>(
    db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name).filter((t) => !(t in CARRY) && !(t in NEVER));
}

export interface Manifest {
  readonly matter: string;
  readonly subject: readonly string[];
  readonly from: number;
  readonly to: number;
  readonly opened_at: number;
  readonly parties: readonly string[];
  readonly funders: readonly string[];
  readonly inScope: readonly string[];
  readonly tables: Readonly<Record<string, number>>;
  readonly dropped: readonly string[];
  readonly unlisted: readonly string[];
  /**
   * `table.column` pairs holding verbatim third-party text. Written into the file so `residue()` can tell a
   * disclosure from a leak WITHOUT importing `CARRY` - the file states its own shape, and the auditor reads the
   * file. See rule 6: an instrument sharing a code path with the thing it checks is not a second instrument.
   */
  readonly documentColumns: readonly string[];
}

/**
 * The wallets an engagement may hold rows about, derived from the subject alone.
 *
 * Derived, never declared, and derived only from trades ON the subject inside the window: a party is someone who
 * touched this launch. Taking the list from anywhere else - a cluster, a funder tree, a wallet's other activity -
 * is how a file about one launch acquires a population assembled from other launches, which is leak 2.
 */
export function deriveParties(db: DatabaseSync, scope: Scope): string[] {
  const subj = list(scope.subject);
  const rows = q<{ wallet: string }>(
    db,
    `SELECT DISTINCT wallet FROM trades WHERE mint IN (${subj}) AND ts BETWEEN ? AND ?
     UNION SELECT creator FROM tokens WHERE mint IN (${subj}) AND creator IS NOT NULL`,
    scope.from, scope.to,
  );
  const out = new Set(rows.map((r) => r.wallet).filter(Boolean));
  /**
   * The chain reconstruction counts too, and forgetting it was caught by the residue audit rather than by
   * reasoning: `hist_trades` is a fuller rebuild of the SUBJECT's own trading, pulled from signature history, so
   * it holds wallets that the live feed never saw. Those wallets are parties - they traded this launch, we just
   * learned it later - and leaving them out made the audit report every one of them as an out-of-scope address.
   *
   * This is also the honest boundary: a party is someone who touched the subject, by whichever instrument
   * recorded it. It is not everyone a party has ever traded beside.
   */
  if (hasTable(db, "hist_trades")) {
    for (const r of q<{ wallet: string }>(
      db, `SELECT DISTINCT wallet FROM hist_trades WHERE mint IN (${subj}) AND ts BETWEEN ? AND ? AND wallet IS NOT NULL`,
      scope.from, scope.to,
    )) out.add(r.wallet);
  }
  if (hasTable(db, "hist_tokens")) {
    for (const r of q<{ wallet: string }>(
      db, `SELECT DISTINCT creator wallet FROM hist_tokens WHERE mint IN (${subj}) AND creator IS NOT NULL`,
    )) out.add(r.wallet);
  }
  return [...out].sort();
}

/**
 * Build the workspace. Returns the manifest; the file at `out` holds nothing the manifest does not account for.
 */
export function openEngagement(source: DatabaseSync, scope: Scope, out: string): Manifest {
  if (!scope.subject.length) throw new Error("an engagement needs a declared subject; there is no search here");
  if (!(scope.from < scope.to)) throw new Error(`window is empty or inverted: ${scope.from}..${scope.to}`);
  for (const m of scope.subject) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) throw new Error(`subject is not a mint address: ${m}`);
  }

  /**
   * The window has to contain every subject's creation, or the workspace's central fact sits outside its own
   * scope - and a report drawing on a launch the scope excludes is the delivery-time filtering this file replaces.
   */
  const born = q<{ mint: string; created_at: number }>(
    source, `SELECT mint, created_at FROM tokens WHERE mint IN (${list(scope.subject)})`,
  );
  for (const m of scope.subject) {
    const row = born.find((b) => b.mint === m);
    if (!row) throw new Error(`subject ${m} is not in this archive; a workspace cannot be opened on it`);
    if (row.created_at < scope.from || row.created_at > scope.to)
      throw new Error(`subject ${m} was created at ${row.created_at}, outside the declared window ` +
        `${scope.from}..${scope.to}. Widen the window deliberately or correct it.`);
  }

  const parties = deriveParties(source, scope);
  const funders = hasTable(source, "operator_wallets")
    ? q<{ funder: string }>(source, `SELECT DISTINCT funder FROM operator_wallets WHERE wallet IN (${list(parties)}) AND funder IS NOT NULL`)
        .map((r) => r.funder).sort()
    : [];

  mkdirSync(dirname(out), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(out + suffix)) rmSync(out + suffix);

  source.exec(`ATTACH DATABASE ${quote(out)} AS ws`);
  const tables: Record<string, number> = {};
  const dropped: string[] = [];
  const documentColumns: string[] = [];
  try {
    for (const [table, rule] of Object.entries(CARRY)) {
      if (!hasTable(source, table)) continue;
      if (rule.quoted && !scope.includeQuotedDocuments) { dropped.push(`${table} (quoted documents not requested)`); continue; }

      /**
       * Only columns that exist in BOTH the rule and the source travel, and the SELECT names them one by one.
       * Never `SELECT *`: a column added to `db.ts` would then arrive unclassified in every workspace built
       * afterwards, which is the silent-inheritance failure the whitelist exists to prevent. A source column with
       * no classification is dropped and said so.
       */
      const present = columnsOf(source, table);
      const take: string[] = [];
      const exprs: string[] = [];
      for (const col of present) {
        const kind = rule.columns[col];
        if (!kind) { dropped.push(`${table}.${col} (UNCLASSIFIED - nobody has decided about this column)`); continue; }
        if (kind === "label") { dropped.push(`${table}.${col} (label: authored by us about someone)`); continue; }
        if (kind === "internal") { dropped.push(`${table}.${col} (internal: no meaning outside the collector)`); continue; }
        if (kind === "document") documentColumns.push(`${table}.${col}`);
        take.push(col);
        if (kind === "foreign") {
          /**
           * A foreign key survives only when it points inside the scope. `operator_wallets.source_mint` naming
           * another launch becomes NULL - which is honest, because the report then states the field as absent
           * rather than reciting somebody else's mint, and `residue()` has nothing to find.
           */
          exprs.push(`CASE WHEN ${col} IN (${list([...scope.subject, ...parties, ...funders])}) THEN ${col} END AS ${col}`);
        } else exprs.push(col);
      }
      if (!take.length) continue;

      const where = rule.where
        .replace("$subject", list(scope.subject))
        .replace("$parties", list(parties))
        .replace("$funders", list(funders));
      const srcTypes = typesOf(source, table);
      const ddl = take.map((c) => `${c} ${srcTypes.get(c) ?? ""}`.trim()).join(", ");
      source.exec(`CREATE TABLE ws.${table} (${ddl})`);

      let n = 0;
      /**
       * The window is substituted on BOTH branches. It was originally applied only to the non-LIKE one, which
       * meant `tweets` and `tg_messages` - the tables whose whole content is somebody else's writing - carried
       * every matching row ever posted, ignoring the scope's own dates. A window that governs the trade ledger
       * and not the quoted material is not a window.
       */
      const bounded = where.replaceAll("$from", String(scope.from)).replaceAll("$to", String(scope.to));
      if (bounded.includes("$like")) {
        // One statement per subject: LIKE cannot take a list, and the mints column is a delimited string.
        for (const m of scope.subject) {
          source.exec(`INSERT INTO ws.${table} (${take.join(",")}) SELECT ${exprs.join(",")} FROM main.${table} ` +
            `WHERE ${bounded.replace("$like", quote(`%${m}%`))}`);
        }
      } else {
        source.exec(`INSERT INTO ws.${table} (${take.join(",")}) SELECT ${exprs.join(",")} FROM main.${table} WHERE ${bounded}`);
      }
      n = (source.prepare(`SELECT COUNT(*) c FROM ws.${table}`).get() as any).c as number;
      tables[table] = n;
    }

    /**
     * The in-scope identifier set, read back off the WORKSPACE rather than assembled from intent.
     *
     * Every `identifier` column the copy actually wrote contributes, so the set describes the file as built. The
     * subject's own accounts (pool, curve account, quote mint) and its trade signatures are in scope because they
     * ARE the subject; a cluster label is in scope because it is derived from a funder that is.
     */
    const inScope = [...new Set([
      ...scope.subject, ...parties, ...funders,
      ...colValues(source, "trades", "sig"),
      ...colValues(source, "tokens", "pool"),
      ...colValues(source, "tokens", "curve_account"),
      ...colValues(source, "tokens", "quote_mint"),
      ...colValues(source, "tokens", "create_sig"),
      ...colValues(source, "pool_map", "pool"),
      ...colValues(source, "operator_wallets", "cluster"),
      ...colValues(source, "curve_poll", "curve"),
      ...colValues(source, "hist_tokens", "curve"),
      ...colValues(source, "hist_trades", "sig"),
      ...colValues(source, "token_outcomes", "pool"),
    ])].sort();

    const manifest: Manifest = {
      matter: scope.matter, subject: [...scope.subject], from: scope.from, to: scope.to,
      opened_at: Date.now(), parties, funders, inScope,
      tables, dropped, unlisted: unlisted(source), documentColumns,
    };

    /**
     * The manifest travels INSIDE the file. A working file that cannot state its own scope is one whose scope is
     * whatever a reader later assumes, and the first question asked of it will be what it was allowed to contain.
     */
    source.exec(`CREATE TABLE ws.scope (k TEXT PRIMARY KEY, v TEXT)`);
    const put = source.prepare(`INSERT INTO ws.scope (k, v) VALUES (?, ?)`);
    for (const [k, v] of Object.entries(manifest)) put.run(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    return manifest;
  } finally {
    try { source.exec("DETACH DATABASE ws"); } catch {}
  }
}

export interface Residue {
  readonly table: string;
  readonly column: string;
  readonly value: string;
  readonly quoted: boolean;
}

/**
 * Re-read a finished workspace and report every base58 identifier in it that the scope does not cover.
 *
 * The second instrument, and it knows nothing about `CARRY` on purpose: it opens the output file, walks whatever
 * tables and columns it finds there, and checks values against the manifest the file carries. Delete CARRY
 * entirely and this still fails - which is what makes it a check rather than a restatement of the copy it is
 * meant to audit.
 *
 * `quoted` marks a hit inside third-party material we did not write. Those are disclosures, not defects: a tweet
 * about the subject may name anything, and redacting a primary source is how a document stops being evidence.
 * A hit with `quoted` false is a leak.
 */
export function residue(path: string): Residue[] {
  const db = new DatabaseSync(path);
  try {
    const scope = Object.fromEntries(
      q<{ k: string; v: string }>(db, "SELECT k, v FROM scope").map((r) => [r.k, r.v]),
    );
    const allow = new Set<string>([...JSON.parse(scope.inScope ?? "[]"), ...INFRASTRUCTURE]);
    const docs = new Set<string>(JSON.parse(scope.documentColumns ?? "[]"));
    const out: Residue[] = [];
    const tables = q<{ name: string }>(
      db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'scope'",
    ).map((r) => r.name);

    for (const t of tables) {
      for (const col of columnsOf(db, t)) {
        const quoted = docs.has(`${t}.${col}`);
        for (const row of q<Record<string, unknown>>(db, `SELECT DISTINCT ${col} v FROM ${t} WHERE ${col} IS NOT NULL`)) {
          const v = row.v;
          if (typeof v !== "string" || isHexDigest(v)) continue;
          for (const hit of v.match(B58) ?? []) {
            if (isHexDigest(hit) || !isAccountish(hit) || allow.has(hit)) continue;
            out.push({ table: t, column: col, value: hit, quoted });
          }
        }
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** Leaks only - the hits that are not explained by a quoted third-party document. */
export const leaks = (r: Residue[]): Residue[] => r.filter((x) => !x.quoted);

/**
 * Open a working file from the command line.
 *
 *   npm run engagement -- --matter M-2026-001 --subject <mint> --from 2026-09-09 --to 2026-09-16 \
 *                         --out data/engagements/M-2026-001.db [--documents]
 *
 * Dates are read as UTC days; `--to` runs to the end of its day. The residue audit runs on the way out and a leak
 * makes this exit non-zero, so a workspace that is not clean cannot be produced quietly and then used by someone
 * who assumed it had been checked.
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const day = (s: string | undefined, endOfDay = false) => {
    if (!s) return undefined;
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
    if (!Number.isFinite(t)) throw new Error(`unreadable date: ${s}`);
    return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s) ? t + 86_399_999 : t;
  };
  const matter = arg("matter");
  const subject = process.argv.flatMap((a, i) => (a === "--subject" ? [process.argv[i + 1]] : []));
  const from = day(arg("from"));
  const to = day(arg("to"), true);
  const out = arg("out");
  if (!matter || !subject.length || from === undefined || to === undefined || !out) {
    console.error("usage: --matter <id> --subject <mint> [--subject <mint>...] --from <YYYY-MM-DD> --to <YYYY-MM-DD> --out <path> [--documents]");
    process.exit(2);
  }
  const source = openDb(config.dbPath, { migrate: false });
  const m = openEngagement(source, {
    matter, subject, from, to, includeQuotedDocuments: process.argv.includes("--documents"),
  }, out!);
  source.close();

  console.log(`\nmatter ${m.matter} -> ${out}`);
  console.log(`  subject   ${m.subject.join(", ")}`);
  console.log(`  window    ${new Date(m.from).toISOString()} .. ${new Date(m.to).toISOString()}`);
  console.log(`  parties   ${m.parties.length} (derived from trades on the subject)`);
  console.log(`  funders   ${m.funders.length}`);
  for (const [t, n] of Object.entries(m.tables)) console.log(`  ${t.padEnd(20)} ${n.toLocaleString()} rows`);
  if (m.dropped.length) { console.log("\n  not carried:"); for (const d of m.dropped) console.log(`    ${d}`); }
  if (m.unlisted.length) {
    console.log(`\n  TABLES NOBODY HAS CLASSIFIED (not carried, and that is the safe default - but decide about them):`);
    for (const t of m.unlisted) console.log(`    ${t}`);
  }

  const r = residue(out!);
  const bad = leaks(r);
  const disclosed = r.filter((x) => x.quoted);
  if (disclosed.length) {
    console.log(`\n  ${disclosed.length} identifier(s) inside quoted third-party documents - disclosed, not removed:`);
    for (const d of disclosed.slice(0, 20)) console.log(`    ${d.table}.${d.column}  ${d.value}`);
  }
  if (bad.length) {
    console.error(`\n  RESIDUE: ${bad.length} out-of-scope identifier(s) in the working file. This file is not deliverable.`);
    for (const b of bad.slice(0, 40)) console.error(`    ${b.table}.${b.column}  ${b.value}`);
    process.exit(1);
  }
  console.log(`\n  residue audit clean: nothing in the file names anything outside the scope.`);
}
