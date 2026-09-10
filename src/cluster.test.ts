/**
 * A wallet page and the cluster page it links to must count the same curves.
 *
 * They did not. The wallet page read `trades` alone and said "one of 66 wallets, which together took 22 bonding
 * curves"; the page one click away said 27. The difference was the curves recovered from chain history rather than
 * watched live, so neither figure was wrong and no amount of staring at either page could have shown it. The only
 * thing that catches this class of fault is asserting that two renderings of one fact agree.
 */
import { test } from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { profile, clusterProfile, clusterCurveCount, clusterTable } from "./operator.ts";

/** A collector-shaped database holding one cluster: two wallets, one curve seen live, one recovered from history. */
function fixture(withHistory = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE operator_wallets (wallet TEXT PRIMARY KEY, funder TEXT, cluster TEXT, role TEXT,
             seeded_at INTEGER, source_mint TEXT, traced INTEGER, added_at INTEGER);
           CREATE TABLE operator_policy (cluster TEXT PRIMARY KEY, policy TEXT);
           CREATE TABLE tokens (mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, created_at INTEGER, dev_pct REAL,
             curve_buyers INTEGER, graduated_confirmed_by TEXT);
           CREATE TABLE trades (mint TEXT, wallet TEXT, side TEXT, sol REAL, ts INTEGER, venue TEXT, is_dev INTEGER,
             slot INTEGER, sig TEXT);
           CREATE TABLE wallet_flow (wallet TEXT PRIMARY KEY, curve_sol REAL, amm_buy REAL, amm_sell REAL, tokens INTEGER);`);
  if (withHistory) db.exec(`CREATE TABLE hist_trades (mint TEXT, sig TEXT, idx INTEGER, ts INTEGER, slot INTEGER,
    wallet TEXT, side TEXT, sol REAL, tokens REAL, vsol REAL, vtok REAL, is_dev INTEGER)`);

  for (const w of ["WalletOne", "WalletTwo"]) {
    db.prepare(`INSERT INTO operator_wallets (wallet, funder, cluster, role) VALUES (?,?,?,?)`)
      .run(w, "FunderAddress", "Funder", "buyout");
    db.prepare(`INSERT INTO wallet_flow VALUES (?,?,?,?,?)`).run(w, 85, 0, 100, 1);
  }
  const t0 = Date.UTC(2026, 8, 3);
  for (const [mint, at] of [["MintLive", t0], ["MintHist", t0 + 3600_000]] as const)
    db.prepare(`INSERT INTO tokens (mint, symbol, created_at, dev_pct, curve_buyers) VALUES (?,?,?,?,?)`)
      .run(mint, mint, at - 600_000, 5, 12);

  // Watched live: milliseconds, a signature, and a venue.
  db.prepare(`INSERT INTO trades (mint, wallet, side, sol, ts, venue, sig) VALUES (?,?,?,?,?,?,?)`)
    .run("MintLive", "WalletOne", "buy", 85, t0 + 1234, "curve", "SigLive");
  if (withHistory) {
    // Recovered afterwards: seconds, no venue column at all. Invisible to anything that reads `trades` alone.
    db.prepare(`INSERT INTO hist_trades (mint, wallet, side, sol, ts, sig) VALUES (?,?,?,?,?,?)`)
      .run("MintHist", "WalletTwo", "buy", 85, t0 + 3600_000, "SigHist");
    // The same purchase as the live row, as chain history records it: one second of resolution, so it can only be
    // matched on (wallet, mint). If it is matched on time it becomes a second curve.
    db.prepare(`INSERT INTO hist_trades (mint, wallet, side, sol, ts, sig) VALUES (?,?,?,?,?,?)`)
      .run("MintLive", "WalletOne", "buy", 85, t0, "SigLive");
  }
  return db;
}

test("the wallet page and the cluster page report the same number of curves", () => {
  const db = fixture();
  const w = profile(db, "WalletOne");
  const c = clusterProfile(db, "Funder");
  assert.equal(c.curves, 2, "one curve watched live and one recovered from history is two curves");
  assert.equal(w.clusterCurves, c.curves);
  assert.equal(w.clusterWallets, c.wallets.length);
});

test("a purchase recorded in both tables is one purchase", () => {
  const db = fixture();
  const c = clusterProfile(db, "Funder");
  assert.equal(c.events.length, 2, "the duplicate live/history copy of MintLive must not become a third event");
  assert.equal(c.events.filter((e) => e.mint === "MintLive").length, 1);
  // The live row wins, so the event keeps the millisecond timestamp and the signature we captured ourselves.
  assert.equal(c.events.find((e) => e.mint === "MintLive")!.ts % 1000, 234);
});

test("the front-page list agrees with the page each row links to", () => {
  const db = fixture();
  const [row] = clusterTable(db, 10);
  const c = clusterProfile(db, "Funder");
  assert.equal(row.cluster, "Funder");
  assert.equal(row.curves, c.curves);
  assert.equal(row.used, new Set(c.events.map((e) => e.wallet)).size);
  assert.equal(row.funded, c.wallets.length);
});

test("a database with no reconstructed trades still counts, it just counts less", () => {
  // This is the collector's own shape: it has never had a `hist_trades` table. Every one of these must degrade to
  // the live rows rather than throw, or the cluster pages break on exactly the database that serves them.
  const db = fixture(false);
  assert.equal(clusterCurveCount(db, "Funder"), 1);
  assert.equal(clusterProfile(db, "Funder").curves, 1);
  assert.equal(clusterTable(db, 10).length, 0, "one wallet used is a wallet, not a cluster");
  assert.equal(profile(db, "WalletOne").clusterCurves, 1);
});
