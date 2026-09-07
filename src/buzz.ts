/**
 * What is X talking about right now, and did launches follow?
 *
 *   npm run buzz -- [--window 30] [--baseline 360] [--top 25]
 *
 * From the stored tweet stream: tickers and hashtags whose mention rate in the last `window` minutes is
 * far above their rate over the prior `baseline` minutes, with distinct authors, follower reach, whether
 * a token with that symbol launched (and how it did), plus the accounts driving each term.
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const windowMin = Number(args.get("window") ?? 30);
const baselineMin = Number(args.get("baseline") ?? 360);
const top = Number(args.get("top") ?? 25);
const db = openDb(config.dbPath);
const now = Date.now();
const since = now - windowMin * 60_000;
const baseSince = since - baselineMin * 60_000;

const rows = db.prepare(`SELECT id, author, followers, created_at, cashtags, hashtags, mints, likes, views, url FROM (SELECT *, 'https://x.com/' || author || '/status/' || id url FROM tweets) WHERE created_at >= ?`).all(baseSince) as any[];
const total = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT author) a, MIN(created_at) first FROM tweets").get() as any;
console.log(`\n=== X buzz — ${rows.filter((r) => r.created_at >= since).length} tweets in the last ${windowMin} min, ${total.n} stored since ${total.first ? new Date(total.first).toISOString().slice(0, 16) : "-"} from ${total.a} accounts ===\n`);

interface Term { term: string; kind: string; recent: any[]; prior: number }
const terms = new Map<string, Term>();
for (const r of rows) {
  const recent = r.created_at >= since;
  for (const [kind, field] of [["$", "cashtags"], ["#", "hashtags"]] as const) {
    for (const t of String(r[field] ?? "").split(" ").filter(Boolean)) {
      const key = kind + t;
      const e = terms.get(key) ?? terms.set(key, { term: t, kind, recent: [], prior: 0 }).get(key)!;
      if (recent) e.recent.push(r);
      else e.prior++;
    }
  }
}
const windows = baselineMin / windowMin;
const scored = [...terms.values()]
  .filter((t) => t.recent.length >= 2)
  .map((t) => {
    const authors = new Map<string, number>();
    for (const r of t.recent) authors.set(r.author, r.followers ?? 0);
    const priorRate = t.prior / windows;
    const lift = priorRate > 0 ? t.recent.length / priorRate : t.recent.length; // brand-new terms: lift = count
    return { ...t, authors: authors.size, reach: [...authors.values()].reduce((a, b) => a + b, 0), priorRate, lift, score: lift * Math.log2(1 + authors.size) };
  })
  .sort((a, b) => b.score - a.score)
  .slice(0, top);

const tokenStmt = db.prepare(`SELECT mint, symbol, created_at, graduated, launch_price, peak_price, last_price FROM tokens WHERE upper(symbol) = ? AND created_at >= ? ORDER BY created_at LIMIT 3`);
const outcome = db.prepare(`SELECT mcap_usd FROM token_outcomes WHERE mint = ?`);
console.log("  term".padEnd(22) + "mentions".padStart(9) + "accounts".padStart(9) + "reach".padStart(10) + "prior/win".padStart(10) + "lift".padStart(7) + "  launches with this symbol (last 24h)");
for (const t of scored) {
  const launches = tokenStmt.all(t.term, now - 24 * 3600_000) as any[];
  const desc = launches.length
    ? launches
        .map((l) => {
          const o = outcome.get(l.mint) as any;
          const x = l.launch_price ? (l.peak_price / l.launch_price).toFixed(1) + "x peak" : "";
          return `${l.symbol} ${new Date(l.created_at).toISOString().slice(11, 16)}Z ${l.graduated ? "GRADUATED" : x}${o?.mcap_usd ? ` $${Math.round(o.mcap_usd / 1000)}k now` : ""}`;
        })
        .join("; ")
    : "-";
  console.log(
    ("  " + t.kind + t.term).slice(0, 21).padEnd(22) +
      String(t.recent.length).padStart(9) +
      String(t.authors).padStart(9) +
      (t.reach >= 1000 ? `${(t.reach / 1000).toFixed(0)}k` : String(t.reach)).padStart(10) +
      t.priorRate.toFixed(1).padStart(10) +
      (t.priorRate > 0 ? `${t.lift.toFixed(1)}x` : "new").padStart(7) +
      "  " + desc,
  );
}

console.log("\nBUZZ EVENTS FIRED (live detector)");
const fired = db.prepare(`SELECT term, kind, authors, mentions, followers, matched_mint, seen_at FROM buzz ORDER BY seen_at DESC LIMIT 15`).all() as any[];
if (!fired.length) console.log("  (none yet)");
for (const b of fired) {
  const l = b.matched_mint ? (db.prepare("SELECT symbol, graduated, launch_price, peak_price FROM tokens WHERE mint=?").get(b.matched_mint) as any) : null;
  console.log(`  ${new Date(b.seen_at).toISOString().slice(5, 16)}  ${b.kind === "cashtag" ? "$" : "#"}${b.term.padEnd(14)} ${String(b.mentions).padStart(3)} mentions / ${String(b.authors).padStart(2)} accounts  ${b.matched_mint ? `→ ${l?.symbol} ${l?.graduated ? "GRADUATED" : l?.launch_price ? (l.peak_price / l.launch_price).toFixed(1) + "x peak" : ""}` : "→ no launch matched"}`);
}

console.log("\nMOST ACTIVE ACCOUNTS in the window (by tweets, with reach)");
const acct = new Map<string, { n: number; followers: number; mints: number }>();
for (const r of rows.filter((r) => r.created_at >= since)) {
  const a = acct.get(r.author) ?? acct.set(r.author, { n: 0, followers: r.followers ?? 0, mints: 0 }).get(r.author)!;
  a.n++;
  if (r.mints) a.mints++;
}
for (const [author, a] of [...acct].sort((x, y) => y[1].n - x[1].n).slice(0, 12)) console.log(`  @${author.padEnd(22)} ${String(a.n).padStart(3)} tweets  ${String(a.mints).padStart(3)} with a mint  ${a.followers.toLocaleString().padStart(10)} followers`);
console.log();
