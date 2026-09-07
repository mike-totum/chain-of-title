/**
 * Labelled-set validator for the clean criteria.
 *
 *   npm run labels -- --build    rebuild data/labels.json from independent evidence
 *   npm run labels               check the criteria against it (exit 1 on any false clean)
 *
 * The claim this project makes is "this launch was not manufactured". Precision is the whole game: a missed warning
 * costs nothing, a wrong all-clear costs everything. So the gate is one-sided — a manufactured token certified clean
 * is a build failure; a manufactured token we merely fail to flag is reported and tolerated.
 *
 * **Independence.** A labelled set derived from the rules under test proves nothing. The label here comes from an axis
 * no rule in provenance.ts looks at — creator-wallet reuse. A factory relaunches one ticker under a *fresh* wallet
 * every time, because burning the creator identity is the point. Creator share, curve buyer counts, graduation speed
 * and pool balances — every input the criteria actually use — play no part in assigning the label.
 *
 * The first version of this rule looked only at the ticker and mislabelled 5 tokens, which is how the two-sided test
 * below came about. Symbols like "?" and "AMC" recur too, but their creators average 34-57 launches each: those are
 * serial launchers reusing a generic name, not an operation burning identities. A family therefore has to show
 * identity-burning at both levels — across the family, and for the individual token being labelled.
 *
 * The four tokens verified by hand (WOFI, PONST, PSHROOM, Squads) are pinned in as well and must never come back clean.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { assess, cleanAtBirth, coverageWindows, TOKEN_COLUMNS } from "./provenance.ts";

const BUILD = process.argv.includes("--build");
const PATH = "data/labels.json";
const MIN_FAMILY = 15;      // graduated mints sharing a ticker
const MIN_BURN = 0.9;       // distinct creators per mint: ~1.0 means a fresh wallet every launch
const MAX_CREATOR_LAUNCHES = 2; // a burnt identity launches once, maybe twice — never dozens of times

const db = openDb(config.dbPath);
db.exec("PRAGMA query_only = 1");
const win = coverageWindows(db);
const covered = (ts: number) => win.some((w) => ts >= w.a && ts <= w.b);

type Label = { mint: string; symbol: string | null; label: "manufactured"; why: string };

/** Hand-verified, from the project notes. These are the regression tests: if any of them ever reads clean, stop. */
const PINNED: Record<string, string> = {
  WOFI: "hand-verified: 79.3% creator supply and zero outside buyers, then the pool was funded with real SOL and the float spread",
  PONST: "hand-verified: dormant 9.5 h, then one 85 SOL buy took the whole curve in a single transaction",
  PSHROOM: "hand-verified operator launch",
  SQUADS: "hand-verified: first-hour flurry round-tripped to zero, then a single 85 SOL buy graduated the curve",
};

function build(): void {
  // launches per creator wallet, over every launch we have seen — not just the graduated ones.
  const CREATOR_LAUNCHES = "creator_launches AS (SELECT creator, COUNT(*) n FROM tokens GROUP BY creator)";
  const fams = db.prepare(`WITH ${CREATOR_LAUNCHES}
    SELECT t.symbol, COUNT(*) mints, COUNT(DISTINCT t.creator) creators, AVG(c.n) avg_launches
    FROM tokens t JOIN creator_launches c ON c.creator = t.creator
    WHERE t.graduated = 1 AND t.late_discovery = 0 AND t.symbol IS NOT NULL
    GROUP BY t.symbol
    HAVING mints >= ? AND 1.0 * COUNT(DISTINCT t.creator) / COUNT(*) >= ? AND avg_launches <= ?`)
    .all(MIN_FAMILY, MIN_BURN, MAX_CREATOR_LAUNCHES) as any[];
  const out: Label[] = [];
  const seen = new Set<string>();
  for (const f of fams) {
    // and the individual token's own creator must be a burnt identity, not a serial launcher who reused the name.
    const rows = db.prepare(`WITH ${CREATOR_LAUNCHES}
      SELECT t.mint, t.symbol FROM tokens t JOIN creator_launches c ON c.creator = t.creator
      WHERE t.symbol = ? AND t.graduated = 1 AND t.late_discovery = 0 AND c.n <= ?`).all(f.symbol, MAX_CREATOR_LAUNCHES) as any[];
    for (const r of rows) {
      if (seen.has(r.mint)) continue;
      seen.add(r.mint);
      out.push({ mint: r.mint, symbol: r.symbol, label: "manufactured", why: `ticker family "${f.symbol}": ${f.mints} graduated mints from ${f.creators} distinct creator wallets, each averaging ${f.avg_launches.toFixed(2)} launches` });
    }
  }
  for (const [sym, why] of Object.entries(PINNED)) {
    const rows = db.prepare("SELECT mint, symbol FROM tokens WHERE UPPER(symbol) = ? AND graduated = 1").all(sym) as any[];
    for (const r of rows) {
      if (seen.has(r.mint)) continue;
      seen.add(r.mint);
      out.push({ mint: r.mint, symbol: r.symbol, label: "manufactured", why });
    }
  }
  writeFileSync(PATH, JSON.stringify({
    builtAt: Date.now(),
    method: `ticker families with >= ${MIN_FAMILY} graduated mints, >= ${MIN_BURN} distinct creators per mint, and <= ${MAX_CREATOR_LAUNCHES} launches per creator wallet (identity burning at both the family and the token level), plus hand-verified tokens. Derived from creator-wallet reuse only — independent of every input the clean criteria read.`,
    families: fams.map((f: any) => ({ symbol: f.symbol, mints: f.mints, creators: f.creators, avgCreatorLaunches: Number(f.avg_launches.toFixed(2)) })),
    labels: out,
  }, null, 2));
  console.log(`built ${PATH}: ${out.length} labelled tokens across ${fams.length} ticker families`);
}

if (BUILD) { build(); process.exit(0); }
if (!existsSync(PATH)) { console.error(`no ${PATH} — run: npm run labels -- --build`); process.exit(1); }

const set = JSON.parse(readFileSync(PATH, "utf8")) as { labels: Label[]; families: any[]; method: string };
const stmt = db.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE mint = ?`);

let checked = 0, flaggedDanger = 0, quiet = 0, falseClean = 0, missing = 0;
const failures: { mint: string; symbol: string | null; why: string }[] = [];
const silent: { mint: string; symbol: string | null }[] = [];

for (const l of set.labels) {
  const t = stmt.get(l.mint) as any;
  if (!t) { missing++; continue; }
  checked++;
  const a = assess(db, t, covered);
  if (cleanAtBirth(t, a)) { falseClean++; failures.push({ mint: l.mint, symbol: l.symbol, why: l.why }); continue; }
  if (a.flags.some((f) => f.level === "DANGER")) flaggedDanger++;
  else { quiet++; silent.push({ mint: l.mint, symbol: l.symbol }); }
}

const pct = (n: number) => `${(100 * n / Math.max(checked, 1)).toFixed(1)}%`;
console.log(`\nlabelled set: ${set.labels.length} tokens across ${set.families.length} ticker families`);
console.log(`method: ${set.method}\n`);
console.log(`checked        ${checked}${missing ? `  (${missing} not in this database)` : ""}`);
console.log(`flagged DANGER ${flaggedDanger}  ${pct(flaggedDanger)}`);
console.log(`not flagged    ${quiet}  ${pct(quiet)}   — no warning raised, but not certified either`);
console.log(`CERTIFIED CLEAN ${falseClean}  ${pct(falseClean)}  <- must be zero\n`);

if (silent.length) {
  console.log(`known-manufactured tokens that raise no danger flag (first 15 of ${silent.length}):`);
  for (const s of silent.slice(0, 15)) console.log(`  ${(s.symbol ?? "?").padEnd(12)} ${s.mint}`);
  console.log(`  These are recall gaps, not correctness failures — we stay silent rather than certify.\n`);
}

if (falseClean) {
  console.error(`FAIL: ${falseClean} known-manufactured token(s) pass the clean criteria.\n`);
  for (const f of failures.slice(0, 25)) console.error(`  ${(f.symbol ?? "?").padEnd(12)} ${f.mint}\n    ${f.why}`);
  process.exit(1);
}
console.log("PASS: no known-manufactured token is certified clean.");
