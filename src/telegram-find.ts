/**
 * Find and grade candidate Telegram call channels.
 *
 *   npm run telegram:find -- [--top 30] [--days 14] [--limit 300] [--max-mints 30] [--queries "pump fun calls,solana gems"]
 *
 * 1. Searches Telegram's public directory for each query and collects channels.
 * 2. Adds channels your account has already joined.
 * 3. Fetches member counts, keeps the `top` largest not yet graded.
 * 4. Grades each one's recent history against on-chain outcomes and prints a ranked scorecard.
 * Results persist in telegram_channels; re-running skips channels graded in the last 24h.
 */
import { Api } from "telegram";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { createClient, telegramConfigured } from "./signals/telegram-client.ts";
import { ensureOutcomeTable } from "./outcomes.ts";
import { baseGraduationRate, ensureMentionTables, gradeChannel, printScorecard, type ChannelGrade } from "./signals/telegram-grade.ts";
import { writeFileSync } from "node:fs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const top = Number(args.get("top") ?? 30);
const days = Number(args.get("days") ?? 14);
const limit = Number(args.get("limit") ?? 300);
const maxMints = Number(args.get("max-mints") ?? 30);
const queries = (args.get("queries") ??
  "pump fun calls,pumpfun calls,pump.fun alpha,solana calls,solana gem calls,solana memecoin calls,sol gems,memecoin alpha,degen calls,solana alpha,pumpfun gems,solana 100x,meme coin signals solana,solana sniper calls,pump fun early")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!telegramConfigured(config.telegramApiId, config.telegramApiHash)) {
  console.error("Run `npm run telegram:login` first.");
  process.exit(1);
}
const db = openDb(config.dbPath);
ensureOutcomeTable(db);
ensureMentionTables(db);
const client = createClient(config.telegramApiId, config.telegramApiHash);
await client.connect();

interface Cand { username: string; title: string; members: number | null; via: string }
const cands = new Map<string, Cand>();
const add = (chat: any, via: string) => {
  if (!chat?.username || chat.className !== "Channel" || chat.megagroup) return; // broadcast channels only
  const key = String(chat.username).toLowerCase();
  if (!cands.has(key)) cands.set(key, { username: chat.username, title: chat.title ?? "", members: chat.participantsCount ?? null, via });
};

process.stdout.write("searching Telegram directory: ");
for (const q of queries) {
  try {
    const r: any = await client.invoke(new Api.contacts.Search({ q, limit: 50 }));
    for (const c of r.chats ?? []) add(c, `search:${q}`);
    process.stdout.write(".");
  } catch (e) {
    process.stdout.write("x");
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(` ${cands.size} public channels`);

// channels the account already joined
let joined = 0;
for (const d of await client.getDialogs({ limit: 300 })) {
  const e: any = d.entity;
  if (e?.className === "Channel" && !e.megagroup && e.username) {
    add(e, "joined");
    joined++;
  }
}
console.log(`joined channels considered: ${joined}`);

// member counts for ranking (search results rarely include them)
process.stdout.write("fetching member counts: ");
let n = 0;
for (const c of cands.values()) {
  if (c.members !== null) continue;
  try {
    const full: any = await client.invoke(new Api.channels.GetFullChannel({ channel: c.username }));
    c.members = full.fullChat?.participantsCount ?? null;
  } catch {}
  if (++n % 10 === 0) process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 250));
}
console.log(" done");

const recentlyGraded = new Set(
  (db.prepare("SELECT channel FROM telegram_channels WHERE graded_at > ? AND error IS NULL").all(Date.now() - 24 * 3600_000) as any[]).map((r) => String(r.channel).toLowerCase()),
);
const ordered = [...cands.values()].sort((a, b) => (b.members ?? 0) - (a.members ?? 0));
const toGrade = ordered.filter((c) => !recentlyGraded.has(c.username.toLowerCase())).slice(0, top);
console.log(`\ngrading ${toGrade.length} channels (${recentlyGraded.size} already graded in the last 24h), ${days} days / ${limit} msgs / ${maxMints} mints each\n`);

const grades: ChannelGrade[] = [];
for (const c of toGrade) {
  process.stdout.write(`  @${c.username.padEnd(28)} ${(c.members ?? 0).toLocaleString().padStart(9)} members  `);
  const g = await gradeChannel(client, db, c.username, { days, limit, maxMints, members: c.members, foundVia: c.via });
  grades.push(g);
  console.log(g.error ? `error: ${g.error}` : `${g.msgs} msgs, ${g.calls} mints, ${g.graduated}/${g.resolved} graduated`);
}
await client.disconnect();

// include previously graded channels in the final table
const prior = db.prepare("SELECT * FROM telegram_channels WHERE error IS NULL").all() as any[];
const all = new Map<string, ChannelGrade>();
for (const r of prior)
  all.set(String(r.channel).toLowerCase(), {
    channel: r.channel, title: r.title, members: r.members, msgs: r.msgs, calls: r.calls, resolved: r.resolved, graduated: r.graduated, big: r.big, early: r.early,
    leads: r.median_lead_s === null ? [] : Array(Math.max(1, r.resolved)).fill(r.median_lead_s),
  });
for (const g of grades) if (!g.error) all.set(g.channel.toLowerCase(), g);

const base = baseGraduationRate(db);
console.log("\nCHANNEL SCORECARD\n");
printScorecard([...all.values(), ...grades.filter((g) => g.error)], base);

const suggested = [...all.values()].filter((g) => g.resolved >= 5 && g.graduated / g.resolved >= 2 * base).sort((a, b) => b.graduated / b.resolved - a.graduated / a.resolved);
writeFileSync("channels.candidates.txt", suggested.map((g) => `${g.channel}  # ${g.graduated}/${g.resolved} graduated, ${g.members ?? "?"} members`).join("\n") + "\n");
console.log(`\n${suggested.length} channels beat 2x the base graduation rate on 5+ graded calls → written to channels.candidates.txt. Copy the ones you trust into channels.txt.`);
process.exit(0);
