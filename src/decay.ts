/**
 * Measure how fast the launch metadata layer disappears, and how much of it is still recoverable today.
 *
 * WHY THIS EXISTS. Everything else this archive holds is on-chain and can be rebuilt from signature history by
 * anyone willing to pay for archival RPC. The metadata document cannot: it is what the launch *claimed to be*, it
 * lives behind a URI the creator controls, and when they repoint it or the pin lapses it is gone at any price. That
 * makes the rate it vanishes the single most important number about this project, because it is the rate at which
 * being the holder of a copy becomes worth something - and nobody had measured it.
 *
 * It could not be measured. `fetchMeta` discarded the reason a fetch failed and `backfillmeta` wrote the word
 * "unreachable" for all of them: 121,832 rows, one distinct value between them, while the image path beside it
 * recorded twenty. A gateway refusing us and a pin that is gone are opposite facts - one is our rate limiter, the
 * other is permanent loss - and they were filed identically.
 *
 * TWO ARMS, because they answer different questions and only one of them is a decay rate:
 *
 *   SURVIVAL  Sample documents we already hold. We know these were alive at `meta_at` because we have the bytes.
 *             Re-fetch each one now. The share that still answers, against age, IS the decay curve - the denominator
 *             is known-alive, which is what makes it a rate rather than a guess.
 *
 *   RECOVERY  Sample the rows that failed. Fetch them. What comes back was never lost, only refused, and it sizes
 *             the backlog worth spending gateway budget on today. What returns 404 from a gateway that answered is
 *             the permanent loss, and counting it is the first honest estimate of how much is already gone.
 *
 * BOTH ARMS REPORT BY HOST, because the first run (2026-09-10) showed that is the axis that matters and age is not.
 * Over an eight-day window IPFS lost nothing - 50 of 50 held documents re-served - and `meta.uxento.io` lost nothing.
 * `metadata.j7tracker.io` had deleted 22 of 50 documents we had already fetched, while still answering every request
 * with a polite 404. Aggregate the two and you get a gentle "93% survival" that describes no host in the archive and
 * hides the only one that is actually losing. A per-day curve reads as ageing when what it is really showing is
 * which days happened to carry more launches from the host that deletes.
 *
 * Read-only by design. It writes nothing to `tokens` - a measurement that mutates the thing it measures cannot be
 * re-run and compared, and the documents it touches are re-fetched and kept minutes later by `npm run backfillmeta`
 * anyway. Sampling is random within each cohort, not newest-first, because newest-first is exactly the bias that
 * would flatter the answer.
 *
 *   npm run decay                                  both arms, 400 per cohort
 *   npm run decay -- --sample 1000 --arm survival
 *   npm run decay -- --json > data/decay-2026-09-10.json
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { fetchMetaResult } from "./tracker.ts";
import { ipfsPath } from "./ipfs.ts";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "400"));
const CONCURRENCY = Number(arg("--concurrency", "12"));
const ARM = arg("--arm", "both");
const JSON_OUT = process.argv.includes("--json");

const db = openDb(config.dbPath);
const say = (...a: unknown[]) => { if (!JSON_OUT) console.log(...a); };

/**
 * What happened when we asked, in classes that mean different things for the archive.
 *
 * The distinction that matters is `gone` versus `refused`. A gateway that answered and said 404 is telling us the
 * content address resolves to nothing - under content addressing that is a property of the CID, not of the host, so
 * no other gateway and no later pass will do better. A 429 or a timeout is our own throughput problem and the
 * document is still there. Filing the second as the first is how a fixable backlog gets written off as a loss.
 */
type Verdict = "alive" | "unparseable" | "gone" | "refused" | "host-dead" | "no-uri";

function classify(error: string | undefined, hasMeta: boolean): Verdict {
  if (hasMeta && !error) return "alive";
  if (error === "served but not json") return "unparseable";
  const e = (error ?? "").toLowerCase();
  if (/http (404|410)/.test(e)) return "gone";
  if (/http (429|503)|cooling down|timeout/.test(e)) return "refused";
  if (/enotfound|getaddrinfo|dns|econnrefused|certificate|altnames/.test(e)) return "host-dead";
  if (/not a fetchable uri/.test(e)) return "no-uri";
  return "refused";
}

/**
 * Whether the URI is genuinely content-addressed, decided by `ipfsPath` - the same reading the fetcher uses.
 *
 * Not a substring test. `https://ipfs.launchblitz.ai/async/<mint>.json` contains "ipfs" in its HOSTNAME and is an
 * ordinary private server with a marketing domain: no CID, no second copy anywhere, and it fails the way j7tracker
 * fails rather than the way a pin fails. Counting it as IPFS would fold the risky population into the safe one and
 * report the archive as less exposed than it is, which is the only direction this measurement must never err in.
 */
const isIpfs = (uri: string) => ipfsPath(uri) !== null;

/** The registrable host, so `metadata.j7tracker.io` and `md.sdfgsdfsdf.uk` can be counted as the risks they are. */
function host(uri: string): string {
  try { return new URL(uri).host; } catch { return "?"; }
}

interface Row { mint: string; uri: string; created_at: number; meta_at: number | null }
interface Outcome extends Row { verdict: Verdict; error?: string; via: string }

async function probe(rows: Row[]): Promise<Outcome[]> {
  const out: Outcome[] = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const r = rows[i];
      let res;
      try { res = await fetchMetaResult(r.uri); }
      catch (e) { res = { meta: null, via: "none", error: `threw: ${(e as Error).message}` }; }
      out.push({ ...r, verdict: classify(res.error, !!res.meta), error: res.error, via: res.via });
      if (++done % 100 === 0) say(`    ${done}/${rows.length}`);
    }
  }));
  return out;
}

/** Counts by verdict, plus the two shares worth reading aloud. */
function tally(rows: Outcome[]) {
  const by: Record<string, number> = {};
  for (const r of rows) by[r.verdict] = (by[r.verdict] ?? 0) + 1;
  const n = rows.length;
  const held = (by.alive ?? 0) + (by.unparseable ?? 0);
  /**
   * Answered = we got a definite answer about the content, whether or not it was there. Excluding `refused` from the
   * denominator is the whole point: a run that was rate-limited half the time would otherwise report half the
   * documents as gone, which is the error this file exists to stop making.
   */
  const answered = held + (by.gone ?? 0) + (by["host-dead"] ?? 0);
  return { n, by, held, answered, aliveOfAnswered: answered ? held / answered : null };
}

const days = (ms: number) => ms / 86_400_000;

const results: Record<string, unknown> = { at: Date.now(), sample: SAMPLE };

// ── SURVIVAL ────────────────────────────────────────────────────────────────────────────────────────────────────
if (ARM === "both" || ARM === "survival") {
  say("\nSURVIVAL - documents we hold, re-asked for now. Denominator is known-alive.\n");
  const rows = db.prepare(`SELECT mint, uri, created_at, meta_at FROM tokens
    WHERE meta_at IS NOT NULL AND uri IS NOT NULL AND uri != ''
    ORDER BY RANDOM() LIMIT ?`).all(SAMPLE) as unknown as Row[];
  say(`  ${rows.length} sampled of ${(db.prepare(`SELECT COUNT(*) c FROM tokens WHERE meta_at IS NOT NULL`).get() as any).c.toLocaleString()} held`);
  const out = await probe(rows);

  const byHost = new Map<string, Outcome[]>();
  for (const r of out) {
    const k = isIpfs(r.uri) ? "(ipfs)" : host(r.uri);
    (byHost.get(k) ?? byHost.set(k, []).get(k)!).push(r);
  }
  say("\n  host                          held   still alive   now 404   oldest held");
  const hosts: unknown[] = [];
  for (const [k, rows_] of [...byHost.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const t = tally(rows_);
    const oldest = Math.max(...rows_.map((r) => days(Date.now() - r.created_at)));
    const pct = t.aliveOfAnswered === null ? " n/a" : `${(t.aliveOfAnswered * 100).toFixed(0)}%`;
    say(`  ${k.padEnd(28)} ${String(t.n).padStart(5)}   ${pct.padStart(9)}   ${String(t.by.gone ?? 0).padStart(7)}   ${oldest.toFixed(1)}d`);
    hosts.push({ host: k, oldestHeldDays: +oldest.toFixed(2), ...t });
  }
  const all = tally(out);
  say(`\n  overall ${all.held}/${all.answered} of answered still alive` +
      (all.aliveOfAnswered !== null ? ` (${(all.aliveOfAnswered * 100).toFixed(1)}%)` : "") +
      `; ${all.by.refused ?? 0} refused and not counted either way.`);
  /**
   * Said out loud because the aggregate is the misleading number and it is the one a reader's eye lands on. A host
   * that is deleting is not averaged away by hosts that are not; it is the whole finding.
   */
  const losing = hosts.filter((h: any) => (h.by.gone ?? 0) > 0) as any[];
  if (losing.length) {
    say("\n  Losing right now - documents we hold that the host no longer serves:");
    for (const h of losing) say(`    ${h.host}: ${h.by.gone}/${h.answered} of what we re-asked for is already 404.`);
    say("  For those, this archive is the copy. That is not a projection; it is true today.");
  } else say("\n  No host in the sample has deleted a document we hold.");
  results.survival = { hosts, overall: all };
}

// ── RECOVERY ────────────────────────────────────────────────────────────────────────────────────────────────────
if (ARM === "both" || ARM === "recovery") {
  say("\nRECOVERY - rows that failed before. How much was never lost, only refused.\n");
  const pool = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE meta_at IS NULL AND meta_error IS NOT NULL`).get() as any).c;
  const rows = db.prepare(`SELECT mint, uri, created_at, meta_at FROM tokens
    WHERE meta_at IS NULL AND meta_error IS NOT NULL AND uri IS NOT NULL AND uri != ''
    ORDER BY RANDOM() LIMIT ?`).all(SAMPLE) as unknown as Row[];
  say(`  ${rows.length} sampled of ${pool.toLocaleString()} previously failed`);
  const out = await probe(rows);
  const t = tally(out);

  say("\n  verdict        n     share");
  for (const [k, v] of Object.entries(t.by).sort((a, b) => b[1] - a[1]))
    say(`  ${k.padEnd(12)} ${String(v).padStart(4)}   ${((v / t.n) * 100).toFixed(1)}%`);

  const recoverable = Math.round((t.held / t.n) * pool);
  say(`\n  ${((t.held / t.n) * 100).toFixed(1)}% came back on the first ask.`);
  say(`  Projected over ${pool.toLocaleString()} failed rows: about ${recoverable.toLocaleString()} documents are still there today.`);
  if (t.by.gone) say(`  ${(((t.by.gone ?? 0) / t.n) * 100).toFixed(1)}% answered 404 - about ${Math.round(((t.by.gone ?? 0) / t.n) * pool).toLocaleString()} are already gone for good.`);

  // Where the risk is concentrated. A private host is one lapsed registration from taking every launch behind it.
  const byHost = new Map<string, { n: number; alive: number }>();
  for (const r of out) {
    const h = isIpfs(r.uri) ? "(ipfs)" : host(r.uri);
    const e = byHost.get(h) ?? { n: 0, alive: 0 };
    e.n++; if (r.verdict === "alive" || r.verdict === "unparseable") e.alive++;
    byHost.set(h, e);
  }
  say("\n  host                          sampled   alive");
  for (const [h, e] of [...byHost.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8))
    say(`  ${h.padEnd(28)} ${String(e.n).padStart(7)}   ${((e.alive / e.n) * 100).toFixed(0)}%`);

  results.recovery = { pool, ...t, projectedRecoverable: recoverable,
    byHost: [...byHost.entries()].map(([h, e]) => ({ host: h, ...e })) };
}

if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
else console.log("\nRe-run this monthly. A survival share that falls is the archive becoming the only copy;\n" +
                 "one that holds is the pins outliving us, and the urgency was overstated.\n");
