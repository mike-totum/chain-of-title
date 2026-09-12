/**
 * That a working file cannot contain what its scope does not cover - checked by putting the leak in the source
 * and watching it fail to arrive.
 *
 * Every case here is built from a leak that actually happened in the adverse specimen (see `engagement.ts`), and
 * every one is written the way `offload.test.ts` writes them: reintroduce one half of the guard at a time and
 * watch the failure, rather than asserting that a correct build is correct. A test that only ever sees a clean
 * workspace would pass just as happily with `CARRY` deleted.
 *
 * The source database is built by `openDb()` on a temp path rather than hand-rolled, so these run against the
 * REAL schema. A hand-written CREATE TABLE here would keep passing after `db.ts` gained a column, which is the
 * exact failure `dropped` exists to surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { openEngagement, residue, leaks, unlisted, deriveParties, CARRY, NEVER, type Scope } from "./engagement.ts";

const SUBJECT = "5cxJmwtoXqozSCBHcn9QoPhuedM1bv1sB45S5Eb1pump";
const OTHER = "74PPR8nKCoTMvjmsCWjq6QqowisXhyawzsqu5SBHpump";
const PARTY = "HyrRnniSnNkaw9TJPS19DoFSvkL525bRLtvKbuqZfDyM";
const STRANGER = "9zQr4TnMbXkvWpLeAcFgHdJsNyRuBtCxVmEwKiPoZaSd";
/** A well-formed mint that this archive has never seen - a different refusal from a malformed one. */
const ABSENT = "8pLkWnQr4TnMbXkvWpLeAcFgHdJsNyRuBtCxVmEwKiPo";
/**
 * An address with no relation to the subject at all - not a party, not a funder of one.
 *
 * Written as a separate constant after the first run of these tests failed: STRANGER had been used here, and
 * STRANGER funds the party, so it IS in scope and residue was right not to flag it. The failure was the test
 * asserting the wrong thing, and it is worth keeping the distinction visible - one relation out from a party is
 * in scope by decision, and everything past that is not.
 */
const OUTSIDER = "7mNbXkvWpLeAcFgHdJsNyRuBtCxVmEwKiPoZaSdQr4Tn";
const BORN = 1788948909805;

const scope = (over: Partial<Scope> = {}): Scope => ({
  matter: "TEST-001", subject: [SUBJECT], from: BORN - 1000, to: BORN + 86400_000, ...over,
});

/** A source archive holding the subject, one unrelated launch, and the cluster labels that leaked. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "engagement-"));
  const db = openDb(join(dir, "src.db"));
  const tok = (mint: string, symbol: string, at: number, creator: string) =>
    db.prepare("INSERT INTO tokens (mint, symbol, creator, created_at, venue, uri) VALUES (?,?,?,?,'pumpfun',?)")
      .run(mint, symbol, creator, at, "https://ipfs.io/ipfs/QmNmKKKCHSzK1NWZzyrD8DcffSLJHSeGKtbkk69DUBR3Qz");
  tok(SUBJECT, "ULTRA", BORN, PARTY);
  tok(OTHER, "Kshama", BORN - 500_000, STRANGER);
  db.prepare("INSERT INTO trades (mint, wallet, side, sol, ts, market, sig) VALUES (?,?,?,?,?,?,?)")
    .run(SUBJECT, PARTY, "buy", 8.03, BORN + 5_000, "curve", "5".repeat(87));
  db.prepare("INSERT INTO trades (mint, wallet, side, sol, ts, market, sig) VALUES (?,?,?,?,?,?,?)")
    .run(OTHER, STRANGER, "buy", 1.0, BORN - 400_000, "curve", "4".repeat(87));
  // The party is a registered operator wallet whose funding was first seen on SOMEBODY ELSE'S launch.
  db.prepare("INSERT INTO operator_wallets (wallet, funder, cluster, role, seeded_at, source_mint, added_at) VALUES (?,?,?,?,?,?,?)")
    .run(PARTY, STRANGER, "FC9BqG", "buyout", BORN - 900_000, OTHER, BORN - 800_000);
  db.prepare("INSERT INTO operator_funders (funder, first_seen, wallets, note) VALUES (?,?,?,?)")
    .run(STRANGER, BORN - 900_000, 23, "seeded the Kshama farm");
  db.prepare("INSERT INTO operator_policy (cluster, policy, plays, manual, note, updated_at) VALUES (?,?,?,?,?,?)")
    .run("FC9BqG", "follow", 10, 1, "holds through the flat window; Kshama 660x, Simba 46x", BORN);
  db.prepare("INSERT INTO positions (mint, strategy, decided_at, sol_in) VALUES (?,?,?,?)")
    .run(SUBJECT, "curve-follow", BORN + 6_000, 0.05);
  // Two posts naming the subject: one inside the declared window, one a month after it.
  db.prepare("INSERT INTO tweets (id, author, created_at, text, mints) VALUES (?,?,?,?,?)")
    .run("t-inside", "someone", BORN + 60_000, "ULTRA just launched", SUBJECT);
  db.prepare("INSERT INTO tweets (id, author, created_at, text, mints) VALUES (?,?,?,?,?)")
    .run("t-after", "someone", BORN + 30 * 86400_000, "still thinking about ULTRA", SUBJECT);
  return { dir, db, out: join(dir, "ws.db"), close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the cluster label this project authored never enters a working file", () => {
  const f = fixture();
  try {
    /**
     * Leak 3, and the reason the architecture is a whitelist rather than a scrubber. The note names two further
     * launches in prose - no predicate could have excluded the row on the strength of the word "Kshama", and the
     * base58 scanner cannot see a symbol. The only thing that works is not copying the table.
     */
    const note = (f.db.prepare("SELECT note FROM operator_policy WHERE cluster='FC9BqG'").get() as any).note;
    assert.match(note, /Kshama/, "fixture must actually contain the leak, or this test proves nothing");

    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    const present = ws.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operator_policy'").get();
    assert.equal(present, undefined, "operator_policy travelled; the authored-label leak is back");
    ws.close();
    assert.ok(NEVER.operator_policy, "and the refusal must stay a stated decision, not a silent omission");
  } finally { f.close(); }
});

test("a foreign key naming somebody else's launch arrives NULL, not omitted and not copied", () => {
  const f = fixture();
  try {
    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    const row = ws.prepare("SELECT wallet, funder, source_mint, seeded_at FROM operator_wallets").get() as any;
    assert.equal(row.wallet, PARTY);
    assert.equal(row.source_mint, null, `source_mint carried ${row.source_mint}, which is another launch`);
    /**
     * The row itself must survive with its funding intact: the worklist calls "when was this wallet funded,
     * relative to the launch" the most probative fact in the cluster section. Dropping the whole row to kill one
     * column would be scoping by amputation, and the report would lose the fact it most needs.
     */
    assert.equal(row.funder, STRANGER, "the party's own funder is one relation out and is in scope");
    assert.equal(row.seeded_at, BORN - 900_000);
    ws.close();
  } finally { f.close(); }
});

test("a foreign key pointing INSIDE the scope survives - the rule is scope, not blanket nulling", () => {
  const f = fixture();
  try {
    // Same wallet, but its funding was first seen on the subject itself. Nothing about that is out of scope.
    f.db.prepare("UPDATE operator_wallets SET source_mint = ? WHERE wallet = ?").run(SUBJECT, PARTY);
    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    assert.equal((ws.prepare("SELECT source_mint FROM operator_wallets").get() as any).source_mint, SUBJECT,
      "nulling every foreign key regardless of where it points would destroy in-scope evidence");
    ws.close();
  } finally { f.close(); }
});

test("another launch in the archive does not travel, however it is reached", () => {
  const f = fixture();
  try {
    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    assert.equal((ws.prepare("SELECT COUNT(*) c FROM tokens WHERE mint = ?").get(OTHER) as any).c, 0,
      "leak 1: a launch that is not the subject is in the working file");
    assert.equal((ws.prepare("SELECT COUNT(*) c FROM trades WHERE mint = ?").get(OTHER) as any).c, 0);
    assert.equal((ws.prepare("SELECT COUNT(*) c FROM tokens").get() as any).c, 1);
    ws.close();
  } finally { f.close(); }
});

test("this project's own paper positions never reach the subject's timeline", () => {
  const f = fixture();
  try {
    assert.ok((f.db.prepare("SELECT COUNT(*) c FROM positions").get() as any).c > 0, "fixture needs a position");
    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    assert.equal(ws.prepare("SELECT name FROM sqlite_master WHERE name='positions'").get(), undefined,
      "the clean-launch draft found simulated orders interleaved with real trades on the subject's own timeline");
    ws.close();
  } finally { f.close(); }
});

test("residue() catches a leak CARRY let through, and does not consult CARRY to do it", () => {
  const f = fixture();
  try {
    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    assert.equal(leaks(residue(f.out)).length, 0, "the clean build must be clean first");

    /**
     * Now forge the failure the whitelist cannot catch: a stranger's address written into a column that IS
     * classified and IS carried. This is what a future `CARRY` mistake looks like from the outside, and the
     * second instrument has to find it by reading the file - it never sees the classification that let it in.
     */
    ws.prepare("UPDATE tokens SET peak_source = ?").run(`pool ${OUTSIDER}`);
    ws.close();
    const found = leaks(residue(f.out));
    assert.equal(found.length, 1, "residue missed an out-of-scope address in a carried column");
    assert.equal(found[0].value, OUTSIDER);
    assert.equal(found[0].table, "tokens");
    assert.equal(found[0].column, "peak_source");
  } finally { f.close(); }
});

test("residue() does not cry leak at an IPFS CID or a hex digest", () => {
  const f = fixture();
  try {
    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    /**
     * Both of these were reported as leaks by the first two real runs against the archive. A CIDv0 is 46 base58
     * characters and a sha256 is hex, which is base58 apart from its zeros - neither is a Solana account, and an
     * auditor that cannot tell will be switched off by whoever has to read its output.
     */
    ws.prepare("UPDATE tokens SET meta_sha256 = ?, image_sha256 = ?")
      .run("f767477b1f1412f46af67e27b78646b18a01d4e5c8a9b3f2e7d6c5b4a3928170", "f767477b1f1412f46af67e27b78646b18a");
    ws.close();
    const r = residue(f.out);
    assert.deepEqual(leaks(r), [], `false positives: ${JSON.stringify(leaks(r))}`);
  } finally { f.close(); }
});

test("an identifier inside a quoted document is a disclosure, not a leak", () => {
  const f = fixture();
  try {
    openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    // The creator's own metadata document naming another address. We did not write it and must not edit it.
    ws.prepare("UPDATE tokens SET meta_json = ?").run(`{"name":"ULTRA","partner":"${OUTSIDER}"}`);
    ws.close();
    const r = residue(f.out);
    assert.equal(r.length, 1, "the scanner must still SEE it");
    assert.equal(r[0].quoted, true, "and must classify it as quoted third-party material");
    assert.deepEqual(leaks(r), [], "a primary source edited to suit our scope has stopped being evidence");
  } finally { f.close(); }
});

test("an unclassified column does not travel, and says so", () => {
  const f = fixture();
  try {
    /**
     * The failure this catches is a column added to `db.ts` months from now. `SELECT *` would carry it into every
     * workspace built afterwards with nobody having decided anything about it; the copy names its columns one by
     * one and reports the rest. This is not hypothetical - it caught `meta_json`, `is_banned` and eight other
     * columns missing from the first draft of CARRY, on the first run against the real archive.
     */
    f.db.exec("ALTER TABLE tokens ADD COLUMN internal_suspicion TEXT");
    f.db.prepare("UPDATE tokens SET internal_suspicion = ? WHERE mint = ?").run("looks coordinated", SUBJECT);
    const m = openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    const cols = (ws.prepare("PRAGMA table_info(tokens)").all() as any[]).map((c) => c.name);
    assert.ok(!cols.includes("internal_suspicion"), "an unclassified column reached the working file");
    assert.ok(m.dropped.some((d) => d.includes("internal_suspicion") && d.includes("UNCLASSIFIED")),
      "and the manifest must name it, or the drop is indistinguishable from a decision nobody made");
    ws.close();
  } finally { f.close(); }
});

test("a table in neither list is reported rather than silently ignored", () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TABLE adverse_candidates (mint TEXT, rank INTEGER)");
    assert.ok(unlisted(f.db).includes("adverse_candidates"),
      "a new table must announce itself; a whitelist nobody is told about is a blacklist");
    const m = openEngagement(f.db, scope(), f.out);
    assert.ok(m.unlisted.includes("adverse_candidates"), "and the manifest must carry the warning into the file");
    const ws = new DatabaseSync(f.out);
    assert.equal(ws.prepare("SELECT name FROM sqlite_master WHERE name='adverse_candidates'").get(), undefined);
    ws.close();
  } finally { f.close(); }
});

test("parties come only from trades on the subject", () => {
  const f = fixture();
  try {
    const p = deriveParties(f.db, scope());
    assert.deepEqual(p.sort(), [PARTY], "a stranger who traded another launch is not a party to this one");
    // And widening the window must not pull in wallets from a launch that is not the subject.
    assert.deepEqual(deriveParties(f.db, scope({ from: 0, to: BORN + 86400_000 })).sort(), [PARTY]);
  } finally { f.close(); }
});

test("the subject is declared, and the window must contain it", () => {
  const f = fixture();
  try {
    assert.throws(() => openEngagement(f.db, scope({ subject: [] }), f.out), /declared subject/,
      "an engagement with no subject is a research sweep wearing a matter number");
    assert.throws(() => openEngagement(f.db, scope({ from: BORN + 10_000 }), f.out), /outside the declared window/,
      "a window that excludes the launch makes the file's central fact out of its own scope");
    assert.throws(() => openEngagement(f.db, scope({ subject: ["not-a-mint"] }), f.out), /not a mint address/);
    assert.throws(() => openEngagement(f.db, scope({ subject: [ABSENT] }), f.out), /not in this archive/);
  } finally { f.close(); }
});

test("the file states its own scope", () => {
  const f = fixture();
  try {
    const m = openEngagement(f.db, scope(), f.out);
    const ws = new DatabaseSync(f.out);
    const got = Object.fromEntries((ws.prepare("SELECT k, v FROM scope").all() as any[]).map((r) => [r.k, r.v]));
    assert.equal(got.matter, "TEST-001");
    assert.deepEqual(JSON.parse(got.subject), [SUBJECT]);
    assert.deepEqual(JSON.parse(got.parties), [PARTY]);
    assert.ok(Number(got.opened_at) > 0, "a working file with no opening date cannot be dated in evidence");
    assert.equal(m.tables.trades, 1, "one trade on the subject, not the two in the archive");
    ws.close();
  } finally { f.close(); }
});

test("every NEVER entry carries its reason, and no table is in both lists", () => {
  for (const [t, why] of Object.entries(NEVER)) {
    assert.ok(why.length > 40, `${t} is refused without a reason anyone can act on`);
    assert.ok(!(t in CARRY), `${t} is in both CARRY and NEVER`);
  }
});

test("openDb refuses to migrate a workspace, and still migrates a collector database", () => {
  const f = fixture();
  try {
    openEngagement(f.db, scope(), f.out);
    /**
     * Watched failing in all three directions, because a guard verified only where it passes is the failure this
     * repo keeps producing. Migrating a workspace would CREATE `operator_policy` and `positions` inside a client
     * working file - empty, so nothing leaks, but the file would then carry tables named after the material its
     * scope refuses, and nobody could tell an empty table from a purged one.
     */
    assert.throws(() => openDb(f.out), /scoped engagement workspace/);
    const ws = openDb(f.out, { migrate: false });
    assert.equal((ws.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name IN ('operator_policy','positions')").get() as any).c, 0,
      "the refused tables must still be absent after the guard ran");
    ws.close();
    // And the guard must not fire on the thing it is not about.
    assert.ok(f.db.prepare("SELECT name FROM sqlite_master WHERE name='tokens'").get(),
      "a collector database must still migrate normally");
  } finally { f.close(); }
});

test("the window bounds quoted material too, not only the trade ledger", () => {
  const f = fixture();
  try {
    /**
     * This is a hole the suite had: the window was substituted into the row predicate on one branch of the copy
     * and not on the branch that handles `LIKE`, so `tweets` and `tg_messages` - the tables that are entirely
     * somebody else's writing - carried every matching post ever made, whatever the scope said. Thirteen tests
     * passed over it, because none of them had a document outside the window to carry.
     */
    const m = openEngagement(f.db, scope({ includeQuotedDocuments: true }), f.out);
    assert.equal(m.tables.tweets, 1, "a post a month after the declared window is outside the scope");
    const ws = new DatabaseSync(f.out);
    assert.equal((ws.prepare("SELECT id FROM tweets").get() as any).id, "t-inside");
    ws.close();
  } finally { f.close(); }
});

test("quoted material stays out entirely unless the engagement asks for it", () => {
  const f = fixture();
  try {
    const m = openEngagement(f.db, scope(), f.out);
    assert.equal(m.tables.tweets, undefined, "bulk social material is opt-in per engagement");
    assert.ok(m.dropped.some((d) => d.startsWith("tweets (")));
  } finally { f.close(); }
});
