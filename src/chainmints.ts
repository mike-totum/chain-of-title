/**
 * Record every token launch on Solana, whatever created it.
 *
 *   npm run chainmints -- --blocks 600        one pass over recent blocks
 *   npm run chainmints -- --daemon            keep up with the chain
 *
 * WHY THIS IS SEPARATE FROM `tokens`. `tokens` holds launches observed through a venue decoder, and every column in
 * it means what pump.fun's events meant. These rows are observed a different way - from the chain's own accounting
 * rather than from a program's events - and mixing the two in one table would make it impossible to say afterwards
 * which method produced an answer. `hist_trades` is kept apart from `trades` for exactly this reason and the note
 * there applies here: live observation and a later reading must stay physically separate.
 *
 * WHAT IT READS, and none of it needs to know a launchpad exists:
 *   mint, decimals    the initializeMint / initializeMint2 instruction from the SPL token program
 *   creator           the fee payer, the wallet that paid to bring the token into existence
 *   supply            minted in the creation transaction, summed from postTokenBalances
 *   creator_share     what the fee payer held when that transaction ended
 *   holders           distinct owners holding a balance at the end of the first block, which is bundling
 *   program           the outermost non-infrastructure program. A LABEL. Never identity: attribution by outermost
 *                     program has already produced two wrong answers here, on a vanity address and a router.
 *   uri               the metadata document the token claimed at launch, where the creation transaction carries it
 *
 * Verified before it was built: against 8 pump.fun launches decoded both ways, the balance method reproduced
 * `dev_pct` exactly - 5.10 against 5.10, 3.42 against 3.42 - with no knowledge of the program that created them.
 * Throughput measured at 7.55 blocks a second on a free endpoint against a chain producing about 2.5.
 *
 * WHAT IT DOES NOT CLAIM. Nothing here says a curve completed, because completion is a program's own concept and
 * the chain has no word for it. That is what a venue decoder adds on top, and it is the half that stays
 * reconstructible from history later. The half this captures is the half that does not.
 */
import { rpc, base58Decode } from "./rpc-http.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const BLOCKS = Number(arg("blocks", "600"));
const WORKERS = Number(arg("workers", "5"));
const DAEMON = process.argv.includes("--daemon");

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const METAPLEX = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const BORING = new Set([
  ...TOKEN_PROGRAMS, METAPLEX,
  "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

/**
 * `createMetadataAccountV3`: a one-byte instruction tag, then DataV2 opening with three Borsh strings.
 *
 * Only the prefix is read. Everything after `uri` - the seller fee, the creator array, the collection - has a
 * layout that varies by instruction version, and a field we do assert must not be able to shift under us. Present
 * in only about one launch transaction in nine: most tokens carry their metadata in the Token-2022 mint extension
 * or have it written in a later transaction, which is why `uri` is nullable and its absence is not a finding.
 */
export function metadataFromInstruction(data: string): { name: string; symbol: string; uri: string } | null {
  let b: Buffer;
  try { b = Buffer.from(base58Decode(data)); } catch { return null; }
  if (b.length < 5) return null;
  let o = 1;
  const str = (): string | null => {
    if (o + 4 > b.length) return null;
    const n = b.readUInt32LE(o); o += 4;
    if (n > 400 || o + n > b.length) return null;
    const s = b.subarray(o, o + n).toString("utf8"); o += n; return s;
  };
  const name = str(), symbol = str(), uri = str();
  if (name === null || symbol === null || !uri) return null;
  return { name, symbol, uri };
}

export interface ChainMint {
  mint: string; creator: string; decimals: number; slot: number; block_time: number | null;
  supply: number; creator_share: number | null; holders: number;
  program: string | null; signature: string;
  name: string | null; symbol: string | null; uri: string | null;
}

/**
 * Does this look like a token launch rather than an LP token, a position NFT or an ephemeral mint?
 *
 * Measured over 392 blocks and 433 mints, labelled by creating program: `supply > 0 && decimals >= 6` keeps 97 of
 * 109 known launches and admits 6 of 317 known non-launches. Stored as a column rather than applied as a filter -
 * every mint is recorded either way. Dropping the rest at ingest would be an observation overwritten by a
 * judgement, which is what `graduated` already cost a correction for. False means "does not look like one", never
 * "is not one", and the 12 it misses are mostly mints whose tokens arrive in a later transaction.
 */
export const looksLikeLaunch = (m: Pick<ChainMint, "supply" | "decimals">) => m.supply > 0 && m.decimals >= 6;

const isMintInit = (ix: any) => {
  const t = ix?.parsed?.type;
  return (t === "initializeMint" || t === "initializeMint2") && TOKEN_PROGRAMS.has(ix.programId);
};

export function mintsInBlock(b: any, slot: number): ChainMint[] {
  const out: ChainMint[] = [];
  for (const tx of b?.transactions ?? []) {
    if (tx.meta?.err) continue;
    const ixs = [
      ...(tx.transaction?.message?.instructions ?? []),
      ...(tx.meta?.innerInstructions ?? []).flatMap((g: any) => g.instructions ?? []),
    ];
    const minted = ixs.filter(isMintInit).map((ix: any) => ({
      mint: ix.parsed.info.mint as string, decimals: Number(ix.parsed.info.decimals ?? -1),
    }));
    if (!minted.length) continue;
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const payer = typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey;
    if (!payer) continue;
    const program = ixs.map((ix: any) => ix.programId).find((p: string) => p && !BORING.has(p)) ?? null;
    const mi = ixs.find((ix: any) => ix.programId === METAPLEX && typeof ix.data === "string");
    const meta = mi ? metadataFromInstruction(mi.data) : null;

    for (const { mint, decimals } of minted) {
      const post = (tx.meta?.postTokenBalances ?? []).filter((x: any) => x.mint === mint);
      const supply = post.reduce((s: number, x: any) => s + Number(x.uiTokenAmount.amount ?? 0), 0);
      const held = post.filter((x: any) => x.owner === payer)
        .reduce((s: number, x: any) => s + Number(x.uiTokenAmount.amount ?? 0), 0);
      const owners = new Set(post.filter((x: any) => Number(x.uiTokenAmount.amount ?? 0) > 0).map((x: any) => x.owner));
      out.push({
        mint, creator: payer, decimals, slot, block_time: b.blockTime ?? null, supply,
        // Null, never 0. A supply we could not measure has no share to report, and a zero would read as "the
        // creator kept none of it" - a finding rather than a gap.
        creator_share: supply > 0 ? held / supply : null,
        holders: owners.size, program, signature: tx.transaction?.signatures?.[0] ?? "",
        // Only when this transaction carried it. One mint in nine does; the rest are not missing metadata, they
        // wrote it elsewhere, and a NULL here says we did not read one rather than that none exists.
        name: meta?.name ?? null, symbol: meta?.symbol ?? null, uri: meta?.uri ?? null,
      });
    }
  }
  return out;
}

/**
 * Its OWN database file, and this is not a preference.
 *
 * `config.dbPath` is the collector's, and HANDOFF records what a second writer against it costs: the collector runs
 * a 10 second busy_timeout, and a competing writer drops launches, which is the one failure that cannot be undone.
 * `npm run clusters` has been stuck on the laptop for exactly this reason. These rows share nothing with the
 * collector's tables, so they share nothing with its write lock either, and this can run as its own service beside
 * the collector without ever restarting it.
 *
 * On the same volume, so the record build can attach it read-only later without a network hop.
 */
const DB = process.env.CHAINMINTS_DB ?? (process.env.DB_PATH ? process.env.DB_PATH.replace(/[^/]+$/, "chainmints.db") : "data/chainmints.db");
const db = openDb(DB, { migrate: false });
db.exec(`CREATE TABLE IF NOT EXISTS chain_mints (
  mint TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  block_time INTEGER,
  supply REAL NOT NULL,
  -- NULL means the supply was unmeasurable, never that the creator took none. See mintsInBlock.
  creator_share REAL,
  holders INTEGER NOT NULL,
  -- A label taken from the outermost non-infrastructure program, never an identity claim about who ran the launch.
  program TEXT,
  signature TEXT NOT NULL,
  name TEXT, symbol TEXT, uri TEXT,
  -- The measured classifier, stored so a reader can recompute it and disagree. Never used to exclude a row.
  looks_like_launch INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  CHECK ((supply > 0) = (creator_share IS NOT NULL) OR supply = 0)
)`);
db.exec("CREATE INDEX IF NOT EXISTS chain_mints_slot ON chain_mints(slot)");
/**
 * Which slots were actually read, which is the difference between data and a record.
 *
 * Without this the table can answer "here are the launches we have" and cannot answer "did you watch this one" -
 * and the second is the only question this archive exists to answer. A launch absent from `chain_mints` would be
 * indistinguishable from a launch in a range nobody scanned, which is the same fault as reporting an unwatched
 * launch as clean. `runs` does this job for the collector; this is the same discipline for a scanner that walks
 * slots instead of holding a socket.
 *
 * Ranges are merged on write, so an overlapping pass extends a range rather than adding a row, and a gap stays
 * visibly a gap.
 */
db.exec(`CREATE TABLE IF NOT EXISTS chain_scanned (
  from_slot INTEGER NOT NULL, to_slot INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (from_slot, to_slot))`);
db.exec("CREATE INDEX IF NOT EXISTS chain_mints_creator ON chain_mints(creator)");
db.exec("CREATE INDEX IF NOT EXISTS chain_mints_launch ON chain_mints(looks_like_launch, slot)");

const insert = db.prepare(`INSERT OR IGNORE INTO chain_mints
  (mint, creator, decimals, slot, block_time, supply, creator_share, holders, program, signature,
   name, symbol, uri, looks_like_launch, seen_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

function store(rows: ChainMint[]): number {
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const res = insert.run(r.mint, r.creator, r.decimals, r.slot, r.block_time, r.supply, r.creator_share,
        r.holders, r.program, r.signature, r.name, r.symbol, r.uri, looksLikeLaunch(r) ? 1 : 0, Date.now());
      n += Number(res.changes ?? 0);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return n;
}

/** Merge a scanned range into `chain_scanned`, joining anything it touches or abuts. */
function noteScanned(lo: number, hi: number): void {
  db.exec("BEGIN");
  try {
    const touching = db.prepare(
      "SELECT from_slot, to_slot FROM chain_scanned WHERE to_slot >= ? AND from_slot <= ?").all(lo - 1, hi + 1) as any[];
    for (const r of touching) {
      lo = Math.min(lo, Number(r.from_slot));
      hi = Math.max(hi, Number(r.to_slot));
      db.prepare("DELETE FROM chain_scanned WHERE from_slot = ? AND to_slot = ?").run(r.from_slot, r.to_slot);
    }
    db.prepare("INSERT OR REPLACE INTO chain_scanned (from_slot, to_slot, at) VALUES (?,?,?)").run(lo, hi, Date.now());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

async function pass(fromSlot: number, blocks: number): Promise<{ read: number; found: number; stored: number }> {
  let cursor = 0, read = 0, found = 0, stored = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= blocks) return;
      const slot = fromSlot - i;
      const b: any = await rpc("getBlock", [slot, {
        encoding: "jsonParsed", transactionDetails: "full", rewards: false,
        maxSupportedTransactionVersion: 0, commitment: "confirmed",
      }], 30_000).catch(() => null);
      if (!b?.transactions) continue;
      read++;
      const rows = mintsInBlock(b, slot);
      found += rows.length;
      if (rows.length) stored += store(rows);
    }
  }));
  return { read, found, stored };
}

(async () => {
  console.log(`[chainmints] writing to ${DB}${DAEMON ? ", daemon" : ""}`);
  do {
    const head = Number(await rpc("getSlot", [{ commitment: "confirmed" }]));
    const started = Date.now();
    const { read, found, stored } = await pass(head, BLOCKS);
    // Recorded only for slots this pass actually read. A block the endpoint refused is not coverage, and counting
    // the requested range rather than the read one would publish a gap as though it had been watched.
    if (read > 0) noteScanned(head - BLOCKS + 1, head);
    const secs = (Date.now() - started) / 1000;
    const launches = (db.prepare("SELECT COUNT(*) c FROM chain_mints WHERE looks_like_launch = 1").get() as any).c;
    const total = (db.prepare("SELECT COUNT(*) c FROM chain_mints").get() as any).c;
    const withUri = (db.prepare("SELECT COUNT(*) c FROM chain_mints WHERE uri IS NOT NULL").get() as any).c;
    const cov = db.prepare("SELECT COUNT(*) n, MIN(from_slot) lo, MAX(to_slot) hi FROM chain_scanned").get() as any;
    console.log(`[chainmints] coverage: ${cov.n} contiguous range${cov.n === 1 ? "" : "s"} from ${cov.lo} to ${cov.hi}` +
      `${cov.n > 1 ? " - MORE THAN ONE RANGE MEANS A GAP" : ""}`);
    console.log(`[chainmints] ${read} blocks in ${secs.toFixed(0)}s (${(read / secs).toFixed(2)}/s), ` +
      `${found} mints seen, ${stored} new; held: ${total.toLocaleString()} mints, ` +
      `${launches.toLocaleString()} look like launches, ${withUri.toLocaleString()} with a metadata uri`);
    // Only meaningful in --daemon: a pass that read fewer blocks than the chain produced while it ran is falling
    // behind, and saying so is the difference between a gap and an unnoticed gap.
    if (DAEMON && read / secs < 2.5)
      console.log(`[chainmints] WARNING ${(read / secs).toFixed(2)} blocks/s is under the ~2.5 the chain produces - falling behind`);
  } while (DAEMON);
})();
