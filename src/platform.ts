/**
 * The launchpad's own record of a launch, kept as it changes.
 *
 *   npm run platform -- [--limit 200] [--recheck 100] [--concurrency 4]
 *
 * pump.fun holds facts about a token that exist nowhere on chain and nowhere in the metadata document: whether the
 * platform has BANNED it, whether it was marked nsfw, whether it ever went live on stream, its all-time-high market
 * cap and when, how many replies it drew. None of that can be rebuilt from an archival node, because none of it was
 * ever on the chain - it is the platform's own judgement about its own listing, and the platform can revise or delete
 * it without notice or trace.
 *
 * `is_banned` is the one that justifies the job on its own. A launchpad banning a token is the closest thing to an
 * admission that exists in this market, it is not announced, and when the listing goes so does the record of it.
 *
 * So this is a versioned capture rather than a field copy. Each fetch is hashed; an unchanged document writes
 * nothing, and a changed one is kept ALONGSIDE its predecessors rather than replacing them. That is the difference
 * between a cache and an archive: a cache answers what pump.fun says now, and this answers what pump.fun said then,
 * which is the only question a record can be asked afterwards.
 *
 * Deliberately aimed, not a firehose. DEPLOY.md already settled this for the X listener - build it aimed at tokens
 * already worth the request, not as a broad sweep - and the same reasoning holds here: ~24,000 launches a day against
 * ~1,400 graduations means the aimed version costs 6% of the requests and holds nearly all of the evidence.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const API = process.env.PUMP_API ?? "https://frontend-api-v3.pump.fun";
const TIMEOUT_MS = 12_000;
/** A launch document is under 2 KB. An order of magnitude of headroom, and anything past it is not what we asked for. */
const MAX_BYTES = 64 * 1024;

export type PlatformStats = { attempted: number; kept: number; unchanged: number; failed: number; changed: number };

/**
 * Fields lifted out of the document for querying. The document itself is stored whole either way - these are an
 * index into it, never a replacement for it, so a field pump.fun adds next month is still captured on the day it
 * appears rather than from the day we notice.
 */
function extract(d: any): { banned: number | null; nsfw: number | null; replies: number | null; ath: number | null; athAt: number | null; live: number | null } {
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const bool = (v: any) => (typeof v === "boolean" ? (v ? 1 : 0) : null);
  return {
    banned: bool(d?.is_banned), nsfw: bool(d?.nsfw), replies: num(d?.reply_count),
    ath: num(d?.ath_market_cap), athAt: num(d?.ath_market_cap_timestamp), live: bool(d?.is_currently_live),
  };
}

async function fetchOne(mint: string): Promise<{ text: string; json: any } | { error: string }> {
  try {
    const res = await fetch(`${API}/coins/${mint}`, {
      headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A 404 is a fact about the listing, not a failed request: pump.fun no longer serves this token. Recorded as an
    // error string rather than silently skipped, because "delisted" is exactly the kind of change this job exists to
    // notice, and a row that simply stops being updated cannot say which of the two happened.
    if (!res.ok) return { error: `http ${res.status}` };
    const text = await res.text();
    if (text.length > MAX_BYTES) return { error: `oversized: ${text.length}` };
    return { text, json: JSON.parse(text) };
  } catch (e: any) {
    return { error: String(e?.name === "TimeoutError" ? "timeout" : e?.message ?? e).slice(0, 120) };
  }
}

/**
 * Capture `limit` launches never seen before, then re-check `recheck` of the ones held longest.
 *
 * The re-check is the half that matters and the half that would be easy to leave out. A single snapshot at graduation
 * cannot show a ban, because the ban comes later; only a second look does, and only if it is kept next to the first.
 */
export async function capturePlatform(
  db: DatabaseSync,
  opts: { limit: number; recheck: number; concurrency: number; log?: (s: string) => void },
): Promise<PlatformStats> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const st: PlatformStats = { attempted: 0, kept: 0, unchanged: 0, failed: 0, changed: 0 };

  // Graduated first: they are the launches anyone looks up, and the population every published claim is about.
  const fresh = db.prepare(`
    SELECT t.mint FROM tokens t
     WHERE t.graduated = 1
       AND NOT EXISTS (SELECT 1 FROM platform_snapshots p WHERE p.mint = t.mint)
     ORDER BY t.graduated_at DESC LIMIT ?`).all(opts.limit) as { mint: string }[];

  const stale = db.prepare(`
    SELECT mint FROM (SELECT mint, MAX(fetched_at) last FROM platform_snapshots GROUP BY mint)
     ORDER BY last ASC LIMIT ?`).all(opts.recheck) as { mint: string }[];

  const targets = [...fresh, ...stale];
  st.attempted = targets.length;
  if (!targets.length) return st;

  const ins = db.prepare(`INSERT OR IGNORE INTO platform_snapshots
    (mint, sha256, json, bytes, fetched_at, is_banned, nsfw, reply_count, ath_market_cap, ath_at, is_live, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const touch = db.prepare("UPDATE platform_snapshots SET fetched_at = ? WHERE mint = ? AND sha256 = ?");
  const priorFor = db.prepare("SELECT sha256 FROM platform_snapshots WHERE mint = ? ORDER BY fetched_at DESC LIMIT 1");

  let cursor = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const mint = targets[i].mint;
      const r = await fetchOne(mint);
      const now = Date.now();
      if ("error" in r) {
        // Errors are versioned like documents are: a delisting is a change worth a row, a timeout is not worth a new
        // one every pass. Same hash rule does both.
        const sha = createHash("sha256").update(`error:${r.error}`).digest("hex");
        const prior = priorFor.get(mint) as { sha256: string } | undefined;
        if (prior?.sha256 === sha) { touch.run(now, mint, sha); st.unchanged++; }
        else { ins.run(mint, sha, null, null, now, null, null, null, null, null, null, r.error); st.failed++; }
        continue;
      }
      const sha = createHash("sha256").update(r.text).digest("hex");
      const prior = priorFor.get(mint) as { sha256: string } | undefined;
      if (prior?.sha256 === sha) {
        // Same document as last time. Move the timestamp so the rotation is fair, and write no new row: an archive of
        // identical copies is not a record of anything.
        touch.run(now, mint, sha);
        st.unchanged++;
        continue;
      }
      const f = extract(r.json);
      ins.run(mint, sha, r.text, r.text.length, now, f.banned, f.nsfw, f.replies, f.ath, f.athAt, f.live, null);
      st.kept++;
      if (prior) st.changed++;
    }
  }));
  if (st.changed) log(`[platform] ${st.changed} launch record(s) changed since we last looked`);
  return st;
}

// ---------- CLI ----------
if (process.argv[1] && process.argv[1].endsWith("platform.ts")) {
  const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const db = openDb(config.dbPath);
  const st = await capturePlatform(db, {
    limit: arg("--limit", 200), recheck: arg("--recheck", 100), concurrency: arg("--concurrency", 4),
  });
  console.log(`attempted ${st.attempted}: ${st.kept} stored (${st.changed} were changes to a launch we already held), ` +
    `${st.unchanged} unchanged, ${st.failed} failed`);
  const held = (db.prepare("SELECT COUNT(DISTINCT mint) c FROM platform_snapshots").get() as any).c;
  const banned = (db.prepare("SELECT COUNT(DISTINCT mint) c FROM platform_snapshots WHERE is_banned = 1").get() as any).c;
  console.log(`holding platform records for ${held.toLocaleString()} launches; ${banned.toLocaleString()} banned by pump.fun`);
}
