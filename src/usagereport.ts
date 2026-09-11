/**
 * What the archive's readership actually looks like.
 *
 *   npm run usage            last 14 days
 *   npm run usage -- 60      last 60 days
 *
 * Reads the private counter written by `src/usage.ts`. Human and automated traffic are reported separately and
 * never summed into a single "requests" figure, because a public archive with a sitemap is crawled far more than it
 * is read and a combined number would be the kind of claim this project publishes corrections about.
 *
 * "Human" here means "did not look automated", which is a coarse user-agent test and an upper bound. Treat a small
 * human number as real and a large one with suspicion.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";

const DAYS = Number(process.argv[2] ?? 14);
const path = process.env.USAGE_PATH ?? join(dirname(config.dbPath) || ".", "usage.db");

if (!existsSync(path)) {
  console.log(`No usage database at ${path}.`);
  console.log(`Nothing has been counted yet. That is not the same as no readers: the counter starts with the web`);
  console.log(`service, so a file that does not exist means it has not run here since counting was added.`);
  process.exit(0);
}

const db = new DatabaseSync(path, { readOnly: true });
const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

const rows = db.prepare(
  `SELECT kind, automated, SUM(n) n FROM usage WHERE day >= ? GROUP BY kind, automated`).all(since) as any[];

if (rows.length === 0) {
  console.log(`The counter exists but holds nothing since ${since}.`);
  process.exit(0);
}

const fmt = (n: number) => n.toLocaleString();
const byKind = new Map<string, { human: number; bot: number }>();
for (const r of rows) {
  const e = byKind.get(r.kind) ?? { human: 0, bot: 0 };
  if (r.automated) e.bot += Number(r.n); else e.human += Number(r.n);
  byKind.set(r.kind, e);
}

const ranked = [...byKind.entries()].sort((a, b) => (b[1].human - a[1].human) || (b[1].bot - a[1].bot));
const totH = ranked.reduce((a, [, v]) => a + v.human, 0);
const totB = ranked.reduce((a, [, v]) => a + v.bot, 0);

console.log(`\nUsage since ${since} (${DAYS} days), from ${path}\n`);
console.log(`${"route class".padEnd(18)}${"human".padStart(12)}${"automated".padStart(12)}`);
console.log("-".repeat(42));
for (const [k, v] of ranked) {
  console.log(`${k.padEnd(18)}${fmt(v.human).padStart(12)}${fmt(v.bot).padStart(12)}`);
}
console.log("-".repeat(42));
console.log(`${"total".padEnd(18)}${fmt(totH).padStart(12)}${fmt(totB).padStart(12)}`);

/**
 * The two questions this was built to answer, stated rather than left to be eyeballed. Both are about whether
 * anything depends on the archive, which is a different question from whether anything visits it.
 */
const dep = (k: string) => (byKind.get(k)?.human ?? 0) + (byKind.get(k)?.bot ?? 0);
const integrations = dep("api_token") + dep("api_wallet") + dep("api_other");
const bulk = dep("bulk_record") + dep("bulk_documents");
console.log(`\nDepends on us:  ${fmt(integrations)} record/wallet API calls, ${fmt(bulk)} bulk downloads.`);
console.log(`Reads us:       ${fmt(byKind.get("record")?.human ?? 0)} human record pages, ` +
  `${fmt(byKind.get("home")?.human ?? 0)} front page, ${fmt(byKind.get("report")?.human ?? 0)} reports.`);

const errors = db.prepare(
  `SELECT status, SUM(n) n FROM usage WHERE day >= ? AND status >= 400 GROUP BY status ORDER BY n DESC`).all(since) as any[];
if (errors.length) {
  console.log(`\nRefusals and errors: ${errors.map((e) => `${e.status} x${fmt(Number(e.n))}`).join(", ")}`);
  console.log(`A 404 here is usually a mint we hold no record for, which is an honest answer and also a demand signal.`);
}
console.log();
