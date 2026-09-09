/**
 * Confirm a recorded graduation against the bonding curve account's own `complete` bit.
 *
 * `graduated_confirmed_by` has always had three documented values — 'pool', 'curve_complete', and NULL — and until
 * now nothing in the codebase ever wrote the second one. Every confirmation in the archive came from pool discovery,
 * so confirmation inherited pool discovery's coverage: it plateaued near 46% of graduations and stayed there. The
 * cost is not cosmetic. `assess()` refuses to state how a curve filled until `completed` is true, so on more than
 * half of all graduations the strongest facts the record holds — zero outside buyers, a sub-minute fill, a creator
 * who bought its own curve — were computed and then withheld.
 *
 * The curve account is the authority pool discovery was standing in for, and it survives graduation: a completed
 * curve reads `complete = 1` with its reserves drained to zero, for as long as the account exists. So a graduation
 * we only inferred can be confirmed later, cheaply, by reading one account. `getMultipleAccounts` takes a hundred
 * addresses per call, which puts the entire standing backlog inside a hundred or so requests.
 *
 * **What this must never do, and the reason the rule is written before the code.** A read that fails, an account
 * that has been closed, and a curve that reads `complete = 0` are three different things and none of them is
 * evidence about a launch. Only `complete = 1` writes to `tokens`. The other outcomes write nothing there, because
 * the alternative is this project's recurring failure with the sign flipped: a missing answer promoted into a
 * finding. Unconfirmed already means we say less. It must never come to mean we say the opposite.
 *
 * `complete = 0` is nonetheless worth knowing about, and it is common — the tracker infers graduation from a decoded
 * trade reaching ~115 vSOL, and curves cross that mark and fall back without ever completing. Those observations go
 * to `curve_checks`, which exists so the sweep does not re-read the same accounts forever. That table is scheduling
 * state and nothing else reads it. A row in it saying `complete = 0` means "we looked at this account at this time",
 * never "this token did not graduate".
 *
 *   npm run confirm                 # sweep the backlog, newest first
 *   npm run confirm -- --dry-run    # read and report, write nothing
 *   npm run confirm -- --limit 500
 *
 * In the collector: `CONFIRM_SWEEP=1`, which runs it in-process on a timer the same way images and platform do.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { bondingCurveAddress, configureEndpoints, decodeCurveAccount, rpc, rpcStats } from "./rpc-http.ts";

export interface ConfirmOpts {
  /** how many candidate mints to read this pass */
  limit?: number;
  /** addresses per getMultipleAccounts call; halved automatically when an endpoint refuses the size */
  batch?: number;
  /** read and report, write nothing — to `tokens` or to `curve_checks` */
  dryRun?: boolean;
  /** ignore the re-check cooldown and read every unconfirmed graduation in the limit */
  all?: boolean;
  /**
   * Which end of the backlog to read.
   *
   * These are two different populations and conflating them wastes the whole budget on the wrong one. At the new end
   * an unconfirmed graduation is usually the tracker's vSOL inference firing on a curve that never completed —
   * measured over the newest 2,000, nine read complete. At the old end it is a curve that really did graduate during
   * the days when pool discovery was nearly blind (8% of 09-02 graduations were ever confirmed), and the answer is
   * still sitting in the account. `oldest` is the backfill; `newest` is what the collector runs continuously.
   */
  order?: "newest" | "oldest";
  log?: (...a: unknown[]) => void;
}

export interface ConfirmStats {
  /** unconfirmed graduations due a read this pass */
  candidates: number;
  /** accounts we actually got an answer about */
  read: number;
  /** curve said complete: written to tokens.graduated_confirmed_by */
  confirmed: number;
  /** curve said not complete: recorded as a check, never as a finding about the launch */
  notComplete: number;
  /** the account no longer exists. Not a finding either — nothing here distinguishes a closed account from one that
   *  was never created, and neither tells us whether the curve filled. */
  missing: number;
  /** decode failed, or the whole call failed after every endpoint. Costs nothing but a later retry. */
  unreadable: number;
}

/**
 * When to look again at a curve that was not complete when we last read it.
 *
 * A curve can complete long after launch — most of the reconstructed million-dollar runners in this archive filled
 * over hours to days, not minutes — so a single `complete = 0` never settles the question. It does not stay open
 * forever either: after three reads on a launch older than a week, the account is not going to change, and asking
 * daily until the heat death of the universe is a cost with no answer at the end of it.
 */
const RECHECK_FRESH_MS = 3600_000;        // under a day old: it may still be filling
const RECHECK_SETTLING_MS = 6 * 3600_000; // under a week old: slow fills happen
const SETTLED_AFTER_MS = 7 * 86400_000;
const SETTLED_AFTER_CHECKS = 3;

export function ensureCurveChecks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS curve_checks (
    mint TEXT PRIMARY KEY,
    checked_at INTEGER NOT NULL,
    checks INTEGER NOT NULL DEFAULT 1,
    complete INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS curve_checks_at ON curve_checks(checked_at)`);
}

/**
 * Take the confirmations that are already sitting in `curve_snapshots` before spending a single RPC call.
 *
 * `curvepoll` has been reading bonding curve accounts directly for 24 hours per launch since long before this sweep
 * existed, and it stores the account's own `complete` bit on every reading. That is the identical evidence this
 * module goes to the network for, already on disk for roughly 3,500 recorded graduations — and it is *better*
 * evidence, because it is repeated. A read today cannot separate "never completed" from "completed and the account
 * has since been closed"; twenty readings across the day a curve was live can.
 *
 * The cross-check those readings support is also the control this whole change needed. Restricted to graduations we
 * had already confirmed by pool discovery, 1,743 of 1,774 carry a complete reading — 98.3%. Pool discovery and the
 * curve's own bit are measuring the same thing, so writing 'curve_complete' beside 'pool' is not introducing a
 * second, looser standard. On the unconfirmed side the same query gives 75 of 1,725, at an average of twenty
 * readings each.
 */
export function seedFromSnapshots(db: DatabaseSync): { confirmed: number; checks: number } {
  const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='curve_snapshots'`).get();
  if (!has) return { confirmed: 0, checks: 0 };   // the record and the web service hold no snapshots; nothing to take
  ensureCurveChecks(db);
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const confirmed = db.prepare(`UPDATE tokens SET graduated_confirmed_by = 'curve_complete'
      WHERE graduated = 1 AND graduated_confirmed_by IS NULL AND pool IS NULL
        AND EXISTS (SELECT 1 FROM curve_snapshots s WHERE s.mint = tokens.mint AND s.complete = 1)`).run();
    // What curvepoll saw, recorded as checks so the sweep does not pay to re-read what has already been watched all
    // day. `complete` here is MAX over the readings: one complete reading settles it, and no complete reading after
    // twenty is the strongest "not complete" the archive can produce.
    const checks = db.prepare(`INSERT INTO curve_checks (mint, checked_at, checks, complete)
      SELECT s.mint, MAX(s.ts), COUNT(*), MAX(s.complete) FROM curve_snapshots s
      JOIN tokens t ON t.mint = s.mint
      WHERE t.graduated = 1 GROUP BY s.mint
      ON CONFLICT(mint) DO UPDATE SET
        checked_at = MAX(curve_checks.checked_at, excluded.checked_at),
        checks = MAX(curve_checks.checks, excluded.checks),
        -- A complete reading is permanent, so 1 always wins. Otherwise take the newer reading and fall back to the
        -- older, and NEVER let COALESCE turn a NULL into a 0: NULL here means the account was gone when we looked,
        -- and 0 means we read the account and it was not complete. Coercing the first into the second publishes
        -- "we could not read this" as "we read this and it had not graduated" — this project's whole failure mode,
        -- in the one table an outside reader is about to be invited to treat as evidence.
        complete = CASE WHEN curve_checks.complete = 1 OR excluded.complete = 1 THEN 1
                        ELSE COALESCE(excluded.complete, curve_checks.complete) END`).run();
    db.prepare("COMMIT").run();
    return { confirmed: Number(confirmed.changes), checks: Number(checks.changes) };
  } catch (e) {
    try { db.prepare("ROLLBACK").run(); } catch {}
    throw e;
  }
}

/**
 * Read the curve account for every graduation we recorded but never confirmed.
 *
 * Candidates exclude anything with a pool, because a pool is already the confirmation (`db.ts` backfills those to
 * 'pool' on open, and `assess()` falls back to it independently). Newest first: a launch someone might look up today
 * is worth more than one from last week, and the backlog is small enough that the whole of it is reached anyway.
 */
export async function confirmGraduations(db: DatabaseSync, opts: ConfirmOpts = {}): Promise<ConfirmStats> {
  const { limit = 2000, dryRun = false, all = false, order = "newest", log = console.log } = opts;
  let batch = Math.max(1, opts.batch ?? 100);
  ensureCurveChecks(db);
  // Free confirmations first. Anything curvepoll already watched need not be paid for again.
  const seeded = dryRun ? { confirmed: 0, checks: 0 } : seedFromSnapshots(db);
  if (seeded.confirmed || seeded.checks)
    log(`[confirm] from curvepoll's own readings: ${seeded.confirmed} confirmed, ${seeded.checks} checks recorded`);
  const st: ConfirmStats = { candidates: 0, read: 0, confirmed: 0, notComplete: 0, missing: 0, unreadable: 0 };
  const now = Date.now();

  const rows = db.prepare(`SELECT t.mint, t.created_at, c.checked_at, c.checks
    FROM tokens t LEFT JOIN curve_checks c ON c.mint = t.mint
    WHERE t.graduated = 1 AND t.graduated_confirmed_by IS NULL AND t.pool IS NULL
    ORDER BY t.created_at ${order === "oldest" ? "ASC" : "DESC"} LIMIT ?`).all(limit * 4) as unknown as
    { mint: string; created_at: number; checked_at: number | null; checks: number | null }[];

  const due = rows.filter((r) => {
    if (all || r.checked_at == null) return true;
    const age = now - r.created_at;
    if (age > SETTLED_AFTER_MS && (r.checks ?? 0) >= SETTLED_AFTER_CHECKS) return false;
    const cooldown = age < 86400_000 ? RECHECK_FRESH_MS : age < SETTLED_AFTER_MS ? RECHECK_SETTLING_MS : 86400_000;
    return now - r.checked_at >= cooldown;
  }).slice(0, limit);
  st.candidates = due.length;
  if (!due.length) return st;

  const setConfirmed = db.prepare(
    `UPDATE tokens SET graduated_confirmed_by = 'curve_complete' WHERE mint = ? AND graduated_confirmed_by IS NULL`);
  const noteCheck = db.prepare(`INSERT INTO curve_checks (mint, checked_at, checks, complete) VALUES (?,?,1,?)
    ON CONFLICT(mint) DO UPDATE SET checked_at = excluded.checked_at, checks = curve_checks.checks + 1, complete = excluded.complete`);

  for (let i = 0; i < due.length; ) {
    const slice = due.slice(i, i + batch);
    let value: any[] | null = null;
    try {
      const curves = slice.map((r) => bondingCurveAddress(r.mint));
      const res = await rpc("getMultipleAccounts", [curves, { encoding: "base64", commitment: "confirmed" }]);
      value = res?.value ?? null;
    } catch (e) {
      // "refused by every endpoint" is usually the batch size, not the request: publicnode caps getMultipleAccounts
      // well below a hundred and answers with a policy error the caller has learned to route around. Halve and retry
      // the same slice rather than skipping it; at batch 1 a failure is a real failure.
      if (batch > 1) { batch = Math.max(1, Math.floor(batch / 2)); log(`[confirm] batch → ${batch} (${(e as Error).message})`); continue; }
      st.unreadable += slice.length;
      log(`[confirm] read failed for ${slice.length}: ${(e as Error).message}`);
      i += slice.length;
      continue;
    }
    if (!Array.isArray(value)) { st.unreadable += slice.length; i += slice.length; continue; }

    /**
     * Decide the whole batch first, then write it in one transaction.
     *
     * The collector is usually running against this same file and its only real obligation is not to drop a launch.
     * A write per account would take the write lock some thousands of times across a sweep; one transaction per
     * batch takes it a few dozen times for a few milliseconds each, which is the difference between competing with
     * ingestion and being invisible to it. The reads already happened over the network with no lock held at all.
     */
    const writes: { mint: string; complete: number | null }[] = [];
    for (let k = 0; k < slice.length; k++) {
      const mint = slice[k].mint;
      const v = value[k];
      if (v === undefined) { st.unreadable++; continue; }
      if (v === null) {
        // The account is gone. We know nothing further about the launch and record only that we looked.
        st.missing++; st.read++;
        writes.push({ mint, complete: null });
        continue;
      }
      const state = decodeCurveAccount(v.data?.[0] ?? "");
      if (!state) { st.unreadable++; continue; }
      st.read++;
      if (state.complete) { st.confirmed++; writes.push({ mint, complete: 1 }); }
      else { st.notComplete++; writes.push({ mint, complete: 0 }); }
    }
    if (!dryRun && writes.length) {
      db.prepare("BEGIN IMMEDIATE").run();
      try {
        for (const w of writes) {
          if (w.complete === 1) setConfirmed.run(w.mint);
          noteCheck.run(w.mint, Date.now(), w.complete);
        }
        db.prepare("COMMIT").run();
      } catch (e) {
        try { db.prepare("ROLLBACK").run(); } catch {}
        throw e;
      }
    }
    i += slice.length;
  }
  return st;
}

// ---------- CLI ----------
// Only when run directly. The collector imports this module, and importing it must not reconfigure the shared RPC
// endpoint list out from under the feeds.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  // Left alone unless CONFIRM_RPC_URLS says otherwise, so this inherits SOLANA_RPC_URLS. That ordering matters:
  // `getMultipleAccounts` at a hundred addresses is the whole reason the backlog is cheap, and the public endpoints
  // cap it far below that — publicnode refused 100, 50, 25 and 12 in turn, and mainnet-beta 429'd its way down to
  // six addresses a call. A keyed endpoint takes the full batch and turns the sweep from hours into a minute.
  const urls = (process.env.CONFIRM_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (urls.length) configureEndpoints(urls);
  const db = openDb(config.dbPath);
  const dryRun = process.argv.includes("--dry-run");

  const before = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE graduated = 1 AND graduated_confirmed_by IS NULL AND pool IS NULL`).get() as any).c;
  const grads = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE graduated = 1`).get() as any).c;
  const conf = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE graduated = 1 AND graduated_confirmed_by IS NOT NULL`).get() as any).c;
  console.log(`${grads.toLocaleString()} recorded graduations, ${conf.toLocaleString()} confirmed (${(100 * conf / grads).toFixed(1)}%), ${before.toLocaleString()} unconfirmed with no pool`);
  if (dryRun) console.log("dry run: reading the chain, writing nothing\n");

  const st = await confirmGraduations(db, {
    limit: Number(arg("--limit", "2000")),
    batch: Number(arg("--batch", "100")),
    all: process.argv.includes("--all"),
    order: process.argv.includes("--oldest") ? "oldest" : "newest",
    dryRun,
  });

  console.log(`\ncandidates due   ${st.candidates.toLocaleString()}`);
  console.log(`accounts read    ${st.read.toLocaleString()}`);
  console.log(`  complete       ${st.confirmed.toLocaleString()}  → graduated_confirmed_by = 'curve_complete'`);
  console.log(`  not complete   ${st.notComplete.toLocaleString()}  → recorded as checked; no claim made either way`);
  console.log(`  account gone   ${st.missing.toLocaleString()}`);
  console.log(`unreadable       ${st.unreadable.toLocaleString()}`);
  if (!dryRun) {
    const after = (db.prepare(`SELECT COUNT(*) c FROM tokens WHERE graduated = 1 AND graduated_confirmed_by IS NOT NULL`).get() as any).c;
    console.log(`\nconfirmed graduations ${conf.toLocaleString()} → ${after.toLocaleString()} (${(100 * after / grads).toFixed(1)}% of recorded graduations)`);
  }
  console.log(rpcStats());
}
