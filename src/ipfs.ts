/**
 * Reaching content-addressed bytes through whichever gateway will actually serve them.
 *
 * WHY THIS EXISTS. Every pump.fun launch declares its metadata at an `ipfs.io` URL, and the collector fetched that
 * URL as declared, once, with a 4-second timeout. Measured 2026-09-08: `ipfs.io` returns 429 to us on every request,
 * in about 50 ms — not a timeout, a refusal. We were asking one public gateway for a thousand documents an hour and
 * it stopped answering. The result was 7,771 launches with metadata out of 28,488 in a day: 27%, with a URI in hand
 * for 99.5% of them.
 *
 * That is the most expensive gap in the archive, and the only one that is not recoverable later. On-chain history can
 * be rebuilt from an archival node whenever someone pays for it. The image and description live behind a URI the
 * creator controls, and when they repoint or unpin it the launch's own account of itself is gone for good. Roughly
 * twenty thousand launches a day were being lost that way while every count on the site stayed correct.
 *
 * WHAT A GATEWAY IS. The CID in the URL is the content address; the hostname is only a way of reaching it. The same
 * CID from a different gateway is the same bytes — that is what content addressing means — so rotating hosts is not
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

/** Gateways in preference order: fastest first, and the declared host last since it is the one refusing us. */
const GATEWAYS = [
  "https://ipfs.filebase.io/ipfs/",
  "https://4everland.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
];

/**
 * A gateway that just refused us is not asked again for a while.
 *
 * Without this, a rate-limited host stays first in the rotation and every fetch pays its refusal before falling
 * through — which is fast but wasteful, and worse, it means the busiest host is the one we hammer hardest. The
 * cooldown is per gateway and in memory only: a restart forgets it, which is correct, because whether a gateway is
 * answering is a fact about now and not something to persist.
 */
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 60_000;

/** Round-robin start point, so concurrent fetches do not all queue behind the same host. */
let cursor = 0;

/**
 * The CID and any trailing path, from a URI in whatever shape a launch declared it: `ipfs://<cid>`, any
 * `.../ipfs/<cid>` gateway URL, or a bare CID. Returns null for an ordinary http URL, which is fetched as-is —
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
 * no metadata — "we asked four gateways and all refused" and "we never looked" are different facts and this project
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

/** Which gateways are currently in cooldown — for `npm run gateways` and the collector's status line. */
export function gatewayHealth(): { gateway: string; cooling: boolean }[] {
  const now = Date.now();
  return GATEWAYS.map((g) => ({ gateway: g, cooling: (cooldownUntil.get(g) ?? 0) > now }));
}
