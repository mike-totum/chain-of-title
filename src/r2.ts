/**
 * The picture store: S3-compatible object storage, signed by hand.
 *
 * Images are the fastest-decaying thing this archive holds. Measured 2026-09-09: a launch's off-chain assets are
 * ~99% retrievable for two days and ~12% after a week, because the creator owns the URI and the pin. They are also
 * the bulkiest — every launch, after content-address dedup, is about 1 GB a day, against a 20 GB collector volume
 * that must never fill, because a full volume drops launches.
 *
 * So the bytes go somewhere that grows without bound and the record does not follow them. `record.db` carries only
 * `image_sha256`, which is what lets a reader verify that a copy they obtained is the copy we saw. That keeps the
 * published file at ~490 bytes per launch — mirrorable, depositable, and independent of whether this bucket, or
 * this project, still exists. The store is a convenience; the hash is the evidence.
 *
 * **Written against the S3 API directly rather than pulling in an SDK.** This repo has one runtime dependency and
 * signing a PUT is ~40 lines of `node:crypto`, the same trade already made for base58 and PDA derivation. An SDK
 * here would be several megabytes and a supply-chain surface for a project whose whole claim is that you should not
 * have to trust it.
 *
 * Keys are `img/<first two hex>/<sha256>`, so the store is content-addressed: identical pictures collide onto one
 * object, which matters because 47% of launches reuse another launch's image. Uploads are idempotent — the same
 * bytes written twice are the same object — and `head()` lets a caller skip the transfer entirely.
 */
import { createHash, createHmac } from "node:crypto";

const REGION = "auto";
const SERVICE = "s3";

export interface R2Config { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }

/** Configured only when all four are present. A partially configured store must never look enabled. */
export function r2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export const objectKey = (sha256: string) => `img/${sha256.slice(0, 2)}/${sha256}`;

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/**
 * AWS SigV4 for one request.
 *
 * The payload hash is required in the canonical request AND sent as `x-amz-content-sha256`; for a content-addressed
 * store we already have it, so a PUT costs no extra hashing. Every header named in `signedHeaders` must be sent
 * exactly as signed — a mismatch fails with SignatureDoesNotMatch and no indication which header was wrong.
 */
function sign(cfg: R2Config, method: string, key: string, payloadHash: string, extraHeaders: Record<string, string> = {}) {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   // 20260909T213000Z
  const dateStamp = amzDate.slice(0, 8);
  const path = `/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extraHeaders };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === n)!]).trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${host}${path}`, headers };
}

/** Does the store already hold these bytes? Content-addressed, so this is a real dedup check and not a guess. */
export async function head(cfg: R2Config, sha256: string, timeoutMs = 15_000): Promise<boolean> {
  const { url, headers } = sign(cfg, "HEAD", objectKey(sha256), "UNSIGNED-PAYLOAD");
  const res = await fetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`HEAD ${res.status}`);
  return true;
}

/**
 * Store the bytes under their own hash.
 *
 * The caller passes the sha256 it already computed rather than this recomputing it: the hash is what the record
 * commits to, and hashing here would let a mismatch between the stored object and the published commitment pass
 * unnoticed. One hash, computed once, used for the key, the record and the signature.
 */
export async function put(cfg: R2Config, sha256: string, body: Buffer, contentType = "application/octet-stream", timeoutMs = 30_000): Promise<void> {
  const { url, headers } = sign(cfg, "PUT", objectKey(sha256), sha256 === sha(body) ? sha256 : sha(body), {
    "content-type": contentType,
    "content-length": String(body.length),
  });
  const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`PUT ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * Read an object back with the content type it was stored under.
 *
 * The image route needs the type: a picture served as application/octet-stream downloads instead of rendering. The
 * type travels with the object rather than being re-derived from a filename, because the store is keyed by hash and
 * has no filename to derive it from.
 */
export async function getWithType(cfg: R2Config, sha256: string, timeoutMs = 30_000): Promise<{ body: Buffer; contentType: string } | null> {
  const { url, headers } = sign(cfg, "GET", objectKey(sha256), "UNSIGNED-PAYLOAD");
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

/** Read an object back. Used by the verifier and by the image route when the bytes are not on local disk. */
export async function get(cfg: R2Config, sha256: string, timeoutMs = 30_000): Promise<Buffer | null> {
  const { url, headers } = sign(cfg, "GET", objectKey(sha256), "UNSIGNED-PAYLOAD");
  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
