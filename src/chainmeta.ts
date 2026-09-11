/**
 * Fetch and keep the metadata document for every launch on the chain, not just pump.fun's.
 *
 *   npm run chainmeta                 one pass over launches with a uri and no document yet
 *   npm run chainmeta -- --daemon     keep up
 *
 * WHY THIS IS THE URGENT HALF. Everything else this archive records is on chain and stays there: an archival node
 * will rebuild a creator's supply share next year for whoever pays. The metadata document is the exception. It sits
 * behind a URI the creator controls, and when it is repointed or unpinned the launch's own account of itself is
 * gone for everyone, permanently. `metadata.j7tracker.io` hosted the documents for 30,443 launches and now answers
 * 404 for every single one. So this is the only pipeline here whose cost of not running compounds.
 *
 * Until now it ran against `tokens` only - the pump.fun collector's table - through `backfillmeta.ts`. `chainmints`
 * records launches from every venue on Solana and had no document capture at all, which made the chain-wide layer
 * comprehensive about the recoverable half and blind to the unrecoverable one. Exactly backwards.
 *
 * DELIBERATELY NOT A NEW FETCHER. `fetchMetaResult` and the IPFS gateway rotation in `ipfs.ts` already solve the
 * hard part - ipfs.io answers 429 to us on every request, so the declared host is the one host that will not serve
 * the document, and rotating is asking a different volunteer for the same content-addressed bytes. Reimplementing
 * that here would mean two fetchers ageing apart, and the older one carries measurements this one would lack.
 *
 * THE BYTES ARE STORED, AND THE HASH IS OF THE BYTES. `meta_sha256` is computed from what actually arrived, never
 * copied from anywhere, so a document can never be filed under a name it does not match. A document that arrives
 * and does not parse is HELD, not discarded: `meta_at` says we have the bytes and `meta_error` says they did not
 * parse, and collapsing those two into one field is how a capture becomes indistinguishable from a failure.
 */
import { createHash } from "node:crypto";
import { openDb } from "./db.ts";
import { fetchMetaResult, type MetaResult } from "./tracker.ts";
import { rpc, base58Decode, findProgramAddress } from "./rpc-http.ts";
import { base58 } from "./feed/rpc.ts";

const MPL = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ZERO32 = Buffer.alloc(32);

/** Metaplex metadata account for a mint. Seeds are "metadata", the program id AS BYTES, then the mint. */
const metadataPda = (mint: string) =>
  findProgramAddress([Buffer.from("metadata"), base58Decode(MPL), base58Decode(mint)], MPL)[0];

/**
 * Metaplex MetadataV1, read sequentially rather than at fixed offsets.
 *
 * Every account sampled was "puffed" to fixed capacity - name 32, symbol 10, uri 200, NUL-padded - and the fixed
 * offsets 65/101/115 were correct on all 25. Read sequentially anyway: the fixed offsets would silently emit a
 * wrong URI if an unpuffed account exists, and nobody checked every historical program version. The capacity is
 * enforced as a ceiling, so a length that exceeds it is refused rather than followed into the next field.
 */
export function decodeMplMetadata(d: Buffer, expectMint: string) {
  if (d.length < 119 || d[0] !== 4) return null;                 // key 4 = MetadataV1
  if (base58(d.subarray(33, 65)) !== expectMint) return null;    // wrong account for this mint: refuse
  let o = 65;
  const str = (cap: number): string | null => {
    if (o + 4 > d.length) return null;
    const len = d.readUInt32LE(o);
    if (len > cap || o + 4 + len > d.length) return null;
    const v = d.subarray(o + 4, o + 4 + len).toString("utf8").replace(/\0+$/, "");
    o += 4 + len;
    return v;
  };
  const name = str(32), symbol = str(10), uri = str(200);
  return name === null || symbol === null || uri === null ? null : { name, symbol, uri };
}

/**
 * Token-2022 extensions. Base mint is 82 bytes; a mint with extensions is padded to 165, carries an account-type
 * byte there, and TLV entries follow from 166. Entries appear in ARBITRARY ORDER - the same extension sits at 166
 * on one mint and 202 on another - so this walks and never indexes.
 */
function tlv(d: Buffer): { type: number; value: Buffer }[] {
  const out: { type: number; value: Buffer }[] = [];
  if (d.length <= 165 || d[165] !== 1) return out;               // 1 = Mint, 2 = TokenAccount
  let o = 166;
  while (o + 4 <= d.length) {
    const type = d.readUInt16LE(o), len = d.readUInt16LE(o + 2);
    if (type === 0 && len === 0) break;                          // uninitialised tail
    if (o + 4 + len > d.length) break;                           // truncated: stop rather than guess
    out.push({ type, value: d.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }
  return out;
}

/** TokenMetadata (extension 19). Unpadded Borsh strings - do NOT strip NULs here, unlike Metaplex. */
export function decodeT22Metadata(d: Buffer, expectMint: string) {
  const e = tlv(d).find((x) => x.type === 19);
  if (!e || e.value.length < 76) return null;
  const v = e.value;
  if (base58(v.subarray(32, 64)) !== expectMint) return null;
  let o = 64;
  const str = (): string | null => {
    if (o + 4 > v.length) return null;
    const len = v.readUInt32LE(o);
    if (o + 4 + len > v.length) return null;
    const x = v.subarray(o + 4, o + 4 + len).toString("utf8");
    o += 4 + len;
    return x;
  };
  const name = str(), symbol = str(), uri = str();
  return name === null || symbol === null || uri === null ? null : { name, symbol, uri };
}

/** null = no pointer, "self" = the metadata is in this mint, otherwise the foreign account it points at. */
function pointerTarget(d: Buffer, mint: string): null | "self" | string {
  const e = tlv(d).find((x) => x.type === 18);
  if (!e || e.value.length < 64) return null;
  const a = e.value.subarray(32, 64);
  if (a.equals(ZERO32)) return null;
  const s = base58(a);
  return s === mint ? "self" : s;
}

const arg = (n: string, d = "") => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const BATCH = Number(arg("batch", "60"));
const CONCURRENCY = Number(arg("concurrency", "8"));
const DAEMON = process.argv.includes("--daemon");
/** A document that failed once may be a gateway having a bad minute. A day later is a different question. */
const RETRY_AFTER_MS = Number(arg("retry-hours", "24")) * 3600_000;

const DB = process.env.CHAINMINTS_DB
  ?? (process.env.DB_PATH ? process.env.DB_PATH.replace(/[^/]+$/, "chainmints.db") : "data/chainmints.db");
const db = openDb(DB, { migrate: false });

/**
 * Columns added here rather than in `chainmints.ts` so the scanner keeps writing if this has never run, and so a
 * database built by an older scanner widens on first use instead of failing. Absent is not empty: a NULL `meta_at`
 * means we have not held the bytes, which is different from holding bytes that did not parse.
 */
for (const ddl of [
  "ALTER TABLE chain_mints ADD COLUMN meta_json TEXT",
  "ALTER TABLE chain_mints ADD COLUMN meta_bytes INTEGER",
  "ALTER TABLE chain_mints ADD COLUMN meta_sha256 TEXT",
  "ALTER TABLE chain_mints ADD COLUMN meta_at INTEGER",
  "ALTER TABLE chain_mints ADD COLUMN meta_error TEXT",
  "ALTER TABLE chain_mints ADD COLUMN meta_tried_at INTEGER",
]) { try { db.exec(ddl); } catch { /* already widened */ } }
db.exec("CREATE INDEX IF NOT EXISTS chain_mints_meta_todo ON chain_mints(meta_at, uri)");

/**
 * Newest first, on purpose and against the usual instinct to clear the backlog. A document published an hour ago is
 * far more likely to still be served than one from last week, and every hour a fetch is deferred is a chance the
 * host deletes it. The backlog is the part already most likely lost; the front of the queue is the part still
 * savable.
 */
const pending = db.prepare(`SELECT mint, uri FROM chain_mints
  WHERE meta_at IS NULL AND uri IS NOT NULL AND length(uri) > 0
    AND (meta_tried_at IS NULL OR meta_tried_at < ?)
  ORDER BY slot DESC LIMIT ?`);

const held = db.prepare(`UPDATE chain_mints SET
  meta_json = ?, meta_bytes = ?, meta_sha256 = ?, meta_at = ?, meta_error = ?, meta_tried_at = ?
  WHERE mint = ?`);
const missed = db.prepare("UPDATE chain_mints SET meta_error = ?, meta_tried_at = ? WHERE mint = ?");

for (const ddl of ["ALTER TABLE chain_mints ADD COLUMN uri_at INTEGER", "ALTER TABLE chain_mints ADD COLUMN uri_from TEXT"])
  { try { db.exec(ddl); } catch { /* already widened */ } }

const needUri = db.prepare(`SELECT mint FROM chain_mints
  WHERE uri IS NULL AND looks_like_launch = 1 AND uri_at IS NULL ORDER BY slot DESC LIMIT ?`);
const setUri = db.prepare(`UPDATE chain_mints SET uri = ?, name = COALESCE(name, ?), symbol = COALESCE(symbol, ?),
  uri_at = ?, uri_from = ? WHERE mint = ?`);
const noUri = db.prepare("UPDATE chain_mints SET uri_at = ?, uri_from = ? WHERE mint = ?");

/**
 * Find the metadata URI for launches whose creation transaction did not carry one, which is about eight in nine.
 *
 * ONE RPC CALL for the common case. Reading the mint account answers two questions at once: its owner says which
 * metadata standard applies, and if it is Token-2022 the metadata is already in the bytes just fetched. Only a
 * legacy SPL mint needs a second call, to the Metaplex account derived from the mint.
 *
 * A verification sample of 200 launches from the existing record was 200/200 Token-2022 with the metadata in the
 * mint itself, decoding to exactly the name, symbol and uri already stored. So the second call is the rare path.
 *
 * FETCH PROMPTLY, because these accounts do not all persist: of 68 consecutive mints watched from live blocks, 60
 * were ephemeral and closed within the hour, and `getAccountInfo` returned null for mints read successfully twenty
 * minutes earlier. "The account is gone" is therefore a distinct outcome from "it has no metadata", and both are
 * distinct from "we have not looked" - which is why `uri_at` marks that we looked and `uri_from` records what
 * answered.
 *
 * WHAT IS DELIBERATELY NOT DECODED. A metadata pointer aimed at a third account, rather than at the mint or
 * absent, is recorded as `pointer:<address>` and no name or uri is emitted. Zero examples were found in roughly 740
 * mainnet mints, so the decode of that case is unverified, and guessing a byte layout into a public archive is the
 * one thing this file must not do.
 */
async function resolveUris(limit: number): Promise<{ found: number; none: number }> {
  const rows = needUri.all(limit) as unknown as { mint: string }[];
  if (!rows.length) return { found: 0, none: 0 };
  let found = 0, none = 0, next = 0;
  const writes: [string, { name: string; symbol: string; uri: string } | null, string][] = [];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, 6) }, async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const mint = rows[i].mint;
      try {
        const a: any = await rpc("getAccountInfo", [mint, { encoding: "base64", commitment: "confirmed" }], 15_000);
        if (!a?.value) { writes.push([mint, null, "account gone"]); continue; }
        const owner = a.value.owner as string;
        const data = Buffer.from(a.value.data[0], "base64");
        if (owner === TOKEN_2022) {
          const target = pointerTarget(data, mint);
          if (target && target !== "self") { writes.push([mint, null, `pointer:${target}`]); continue; }
          const m = decodeT22Metadata(data, mint);
          if (m?.uri) { writes.push([mint, m, "token2022"]); continue; }
        }
        // Legacy SPL, or a Token-2022 mint carrying no metadata extension: try the Metaplex account.
        const pda = metadataPda(mint);
        const b: any = await rpc("getAccountInfo", [pda, { encoding: "base64", commitment: "confirmed" }], 15_000)
          .catch(() => null);
        if (b?.value?.owner === MPL) {
          const m = decodeMplMetadata(Buffer.from(b.value.data[0], "base64"), mint);
          if (m?.uri) { writes.push([mint, m, "metaplex"]); continue; }
        }
        writes.push([mint, null, "no metadata on chain"]);
      } catch (e) {
        // Not marked as looked-at: an endpoint that refused is a fact about the endpoint, and retrying is right.
      }
    }
  }));
  const now = Date.now();
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    for (const [mint, m, from] of writes) {
      if (m) { setUri.run(m.uri, m.name || null, m.symbol || null, now, from, mint); found++; }
      else { noUri.run(now, from, mint); none++; }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { found, none };
}

async function pass(): Promise<{ got: number; failed: number; bytes: number }> {
  const rows = pending.all(Date.now() - RETRY_AFTER_MS, BATCH) as unknown as { mint: string; uri: string }[];
  if (!rows.length) return { got: 0, failed: 0, bytes: 0 };

  // Fetched with no transaction open. This database has a writer beside it and its obligation is not to block one.
  const results: { mint: string; r: MetaResult }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let i = next++; i < rows.length; i = next++) {
      let out: MetaResult;
      try { out = await fetchMetaResult(rows[i].uri); }
      catch (e) { out = { meta: null, via: "none", error: `threw: ${(e as Error).message}` }; }
      results.push({ mint: rows[i].mint, r: out });
    }
  }));

  const now = Date.now();
  let got = 0, failed = 0, bytes = 0;
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    for (const { mint, r } of results) {
      if (r.meta?.raw) {
        // Hashed from the bytes that arrived, never from a column. Nothing is filed under a name it does not match.
        const sha = createHash("sha256").update(Buffer.from(r.meta.raw)).digest("hex");
        held.run(r.meta.raw, r.meta.bytes ?? Buffer.byteLength(r.meta.raw), sha, now, r.error ?? null, now, mint);
        got++; bytes += r.meta.bytes ?? 0;
      } else {
        // The cause, not the word "unreachable": a gateway refusing us and a pin that is gone are different facts,
        // and only one of them is worth retrying. meta_at stays NULL because we hold nothing.
        missed.run(r.error ?? "unreachable", now, mint);
        failed++;
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { got, failed, bytes };
}

(async () => {
  console.log(`[chainmeta] ${DB}${DAEMON ? ", daemon" : ""}`);
  do {
    const t0 = Date.now();
    // Resolve first, then fetch: a URI found this cycle is fetched in the same cycle, which matters because the
    // account it came from may not survive the hour.
    const uris = await resolveUris(BATCH);
    const { got, failed, bytes } = await pass();
    const s = db.prepare(`SELECT
        SUM(uri IS NOT NULL) with_uri, SUM(meta_at IS NOT NULL) held,
        SUM(uri IS NOT NULL AND meta_at IS NULL) todo
      FROM chain_mints WHERE looks_like_launch = 1`).get() as any;
    if (uris.found || uris.none) console.log(`[chainmeta] resolved ${uris.found} uris, ${uris.none} had none to find`);
    if (got || failed) {
      console.log(`[chainmeta] +${got} documents (${(bytes / 1024).toFixed(0)} KB), ${failed} unreachable, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s; of launches: ${Number(s.with_uri ?? 0).toLocaleString()} have a uri, ` +
        `${Number(s.held ?? 0).toLocaleString()} documents held, ${Number(s.todo ?? 0).toLocaleString()} still to fetch`);
    } else if (DAEMON) {
      // Nothing to do is worth saying once a cycle: a fetcher that is up and idle looks exactly like one that is up
      // and broken, which is the failure this project has now found five times.
      console.log(`[chainmeta] nothing pending (${Number(s.held ?? 0).toLocaleString()} held, ` +
        `${Number(s.todo ?? 0).toLocaleString()} awaiting retry)`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  } while (DAEMON);
})();
