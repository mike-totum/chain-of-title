import { createHash } from "node:crypto";
/**
 * Reaching content-addressed bytes through whichever gateway will actually serve them.
 *
 * WHY THIS EXISTS. Every pump.fun launch declares its metadata at an `ipfs.io` URL, and the collector fetched that
 * URL as declared, once, with a 4-second timeout. Measured 2026-09-08: `ipfs.io` returns 429 to us on every request,
 * in about 50 ms - not a timeout, a refusal. We were asking one public gateway for a thousand documents an hour and
 * it stopped answering. The result was 7,771 launches with metadata out of 28,488 in a day: 27%, with a URI in hand
 * for 99.5% of them.
 *
 * That is the most expensive gap in the archive, and the only one that is not recoverable later. On-chain history can
 * be rebuilt from an archival node whenever someone pays for it. The image and description live behind a URI the
 * creator controls, and when they repoint or unpin it the launch's own account of itself is gone for good. Roughly
 * twenty thousand launches a day were being lost that way while every count on the site stayed correct.
 *
 * WHAT A GATEWAY IS. The CID in the URL is the content address; the hostname is only a way of reaching it. The same
 * CID from a different gateway is the same bytes - that is what content addressing means - so rotating hosts is not
 * a workaround or a way of getting around somebody's limits. It is asking a different volunteer for the same public
 * document, which is how IPFS is designed to be read.
 *
 * MEASURED, not assumed (2026-09-08, same CID through each):
 *   4everland.io           200, 0.15s
 *   ipfs.filebase.io       200, 0.11s
 *   gateway.pinata.cloud   200, 6.06s
 *   ipfs.io                429          the one every launch declares
 *   dweb.link              429          same operator as ipfs.io
 *   nftstorage.link        429
 *   w3s.link               429
 *   cloudflare-ipfs.com    dead
 * Re-run `npm run gateways` before trusting this list again; a gateway that answered today is not a gateway that
 * answers next month, which is the whole reason the list is a list.
 */

/**
 * Gateways in preference order: fastest first, and the declared host last since it is the one refusing us.
 *
 * Re-measured 2026-09-10 against 12 random `bafkrei…` CIDs from the archive, checking the BYTES and not the status
 * code (see `verifyCid` - that distinction is the reason the list changed):
 *
 *   snapshot.4everland.link   12/12 verified   0.12 s/req    added, and put first
 *   ipfs.filebase.io          11/12 verified   0.88 s/req
 *   ipfs.raribleuserdata.com   7/12 verified   4.23 s/req    added as depth, not for speed
 *   4everland.io               3/12 verified   7.59 s/req    demoted; it was second and was costing the most
 *   gw3.io                     0/12 verified   12 MISMATCH   never add: one error page, HTTP 200, for every CID
 *   ipfs.kaleido.art          dead
 *
 * Four gateways with a 60 s cooldown could not carry the backlog: a recovery pass measured 3 rows/s, and 173 of one
 * 252-row batch's failures were our own rate limiter rather than anything wrong with the documents. Depth here is
 * what converts that backlog into captured documents, and verification is what makes adding depth safe - without it
 * a wider pool is a wider surface for `gw3.io` to write a forgery into the archive.
 *
 * Re-run `npm run gateways` before trusting this list again; a gateway that answered today is not a gateway that
 * answers next month, which is the whole reason the list is a list.
 */
const GATEWAYS = [
  "https://snapshot.4everland.link/ipfs/",
  "https://ipfs.filebase.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.raribleuserdata.com/ipfs/",
  "https://4everland.io/ipfs/",
  "https://ipfs.io/ipfs/",
];

/**
 * A gateway that just refused us is not asked again for a while.
 *
 * Without this, a rate-limited host stays first in the rotation and every fetch pays its refusal before falling
 * through - which is fast but wasteful, and worse, it means the busiest host is the one we hammer hardest. The
 * cooldown is per gateway and in memory only: a restart forgets it, which is correct, because whether a gateway is
 * answering is a fact about now and not something to persist.
 */
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 60_000;

/** Round-robin start point, so concurrent fetches do not all queue behind the same host. */
let cursor = 0;

/**
 * The CID and any trailing path, from a URI in whatever shape a launch declared it: `ipfs://<cid>`, any
 * `.../ipfs/<cid>` gateway URL, or a bare CID. Returns null for an ordinary http URL, which is fetched as-is -
 * some launches host their metadata normally and those need no help.
 */
export function ipfsPath(uri: string): string | null {
  if (!uri) return null;
  const m = uri.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i) ?? uri.match(/\/ipfs\/(.+)$/);
  if (m) return m[1];
  // A bare CID: v0 starts Qm and is 46 chars, v1 is base32 and starts with b.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/.test(uri.trim())) return uri.trim();
  return null;
}

/**
 * Check bytes against the content address they were asked for, where the address makes that possible.
 *
 * WHY. `fetchContent` trusts HTTP 200. Measured 2026-09-10 while looking for more gateways: `gw3.io` returned 200
 * and the SAME 132-byte body for four different CIDs - an error page with a success code - and
 * `ipfs.raribleuserdata.com` returned 200 with an empty body for one CID and correct bytes for three others. Either
 * would have been recorded as a launch's own account of itself, permanently, with nothing to distinguish it from a
 * real capture. For an archive whose only claim is that its copy is the true copy, that is the worst available
 * failure: not losing a document, but holding a forgery of one.
 *
 * A CID is a hash of the content - verifying is the whole point of content addressing, and it costs one SHA-256.
 * That turns "which gateways do we trust" into a question we do not have to answer, which is what makes it safe to
 * ask a wider pool of them and recover the backlog faster.
 *
 * WHAT IS AND IS NOT COVERED. `bafkrei…` is CIDv1, raw codec, sha2-256: the digest is of the bytes themselves and
 * this verifies them outright - 64,752 of the archive's URIs, about a third. `Qm…` (CIDv0) and `bafy…` hash a
 * dag-pb block that wraps the bytes rather than the bytes, so a plain digest does not match and reconstructing the
 * wrapper is not worth it here. Those return `"unverifiable"`, which is deliberately not the same answer as `"ok"`.
 * Recording that we could not check is the honest outcome; pretending we did is the thing this project exists not
 * to do.
 */
export type CidCheck = "ok" | "mismatch" | "unverifiable";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, no padding - the multibase `b` prefix used by every CIDv1 in the archive. */
function base32Decode(s: string): Uint8Array | null {
  let bits = 0, value = 0, i = 0;
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  for (const c of s) {
    const idx = B32.indexOf(c);
    if (idx === -1) return null;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out[i++] = (value >>> (bits - 8)) & 0xff; bits -= 8; }
  }
  return out.subarray(0, i);
}

export function verifyCid(cid: string, body: Buffer | Uint8Array): CidCheck {
  // Only the path's first segment is the address; a trailing `/image.png` addresses something inside a directory.
  const id = cid.split("/")[0].split("?")[0];
  if (!/^bafkrei[a-z2-7]+$/.test(id)) return "unverifiable";
  const bytes = base32Decode(id.slice(1));
  // version 0x01, codec 0x55 (raw), multihash 0x12 (sha2-256) length 0x20, then 32 bytes of digest.
  if (!bytes || bytes.length !== 36 || bytes[0] !== 0x01 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 0x20)
    return "unverifiable";
  const want = Buffer.from(bytes.subarray(4));
  const got = createHash("sha256").update(body).digest();
  return want.equals(got) ? "ok" : "mismatch";
}

export interface FetchResult {
  res: Response | null;
  /** Which gateway answered, or the last error seen. Written down so a failure is a recorded fact, not an absence. */
  via: string;
  error?: string;
}

/**
 * Fetch a URI, trying every gateway that is not cooling down before giving up.
 *
 * Never throws. Returns `res: null` with a populated `error`, because the caller's job is to record WHY a launch has
 * no metadata - "we asked four gateways and all refused" and "we never looked" are different facts and this project
 * exists to keep them apart. A 404 or 410 is returned as-is rather than retried elsewhere: content addressing means
 * a CID that one gateway cannot find is genuinely unpinned, not unlucky.
 */
export async function fetchContent(uri: string, timeoutMs = 8000): Promise<FetchResult> {
  const path = ipfsPath(uri);
  if (!path) {
    // An ordinary URL. Still worth one attempt and a recorded reason.
    if (!/^https?:/i.test(uri)) return { res: null, via: "none", error: "not a fetchable uri" };
    try {
      const res = await fetch(uri, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      return res.ok ? { res, via: "direct" } : { res: null, via: "direct", error: `http ${res.status}` };
    } catch (e) { return { res: null, via: "direct", error: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message }; }
  }

  const now = Date.now();
  const order = GATEWAYS.map((_, i) => GATEWAYS[(cursor + i) % GATEWAYS.length]);
  cursor = (cursor + 1) % GATEWAYS.length;
  let lastErr = "no gateway tried";

  for (const gw of order) {
    if ((cooldownUntil.get(gw) ?? 0) > now) { lastErr = `${gw} cooling down`; continue; }
    try {
      const res = await fetch(gw + path, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      if (res.ok) return { res, via: gw };
      if (res.status === 429 || res.status === 503) {
        cooldownUntil.set(gw, Date.now() + COOLDOWN_MS);
        lastErr = `${gw} ${res.status}`;
        continue;
      }
      // Not found anywhere is a property of the CID, not of this host. Report it rather than asking three more.
      if (res.status === 404 || res.status === 410) return { res: null, via: gw, error: `http ${res.status}` };
      lastErr = `${gw} http ${res.status}`;
    } catch (e) {
      lastErr = `${gw} ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`;
    }
  }
  return { res: null, via: "none", error: lastErr };
}

/** Which gateways are currently in cooldown - for `npm run gateways` and the collector's status line. */
export function gatewayHealth(): { gateway: string; cooling: boolean }[] {
  const now = Date.now();
  return GATEWAYS.map((g) => ({ gateway: g, cooling: (cooldownUntil.get(g) ?? 0) > now }));
}

/**
 * Which fetch failures are the DOCUMENT's and which are OURS - the distinction the retry policy turns on.
 *
 * This lives beside `fetchContent` because `fetchContent` is what writes these strings: it returns 404 and 410
 * as-is rather than asking another gateway, on the reasoning that a CID one gateway cannot find is genuinely
 * unpinned rather than unlucky. A classifier kept anywhere else would be a second copy of that judgement, free to
 * drift the moment an error string changes - and the failure would be silent, because a misclassified error just
 * means a document is retried on the wrong clock forever.
 *
 * DEFINITIVE means the host answered and told us the document is not there. Waiting does not help.
 * TRANSIENT means we were refused, timed out, or ran out of gateways - our problem, and worth asking again soon.
 *
 * Measured 2026-09-12: 20,075 launches from `metadata.j7tracker.io` sat in the collector's sweep as permanent
 * 404s, re-requested every six hours ahead of 23,614 recoverable documents, because both were "an error".
 */
export function isDefinitiveError(err: string | null | undefined): boolean {
  if (!err) return false;
  return /http 4(04|10)\b/.test(err) || err === "not a fetchable uri";
}

/**
 * The same test as SQL, for the sweep's row picker. Takes the column name so a caller cannot accidentally point it
 * at the wrong one, and is deliberately the NEGATIVE form the query needs, so no caller has to write the NOT.
 */
export const notDefinitiveSql = (col = "meta_error"): string =>
  `${col} NOT LIKE '%http 404%' AND ${col} NOT LIKE '%http 410%' AND ${col} != 'not a fetchable uri'`;
