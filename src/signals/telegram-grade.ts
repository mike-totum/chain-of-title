import type { TelegramClient } from "telegram";
import type { DatabaseSync } from "node:sqlite";
import { messageToTweet } from "./telegram.ts";
import { parseTweet } from "./twitter.ts";
import { getOutcome } from "../outcomes.ts";

export interface ChannelGrade {
  channel: string;
  title: string;
  members: number | null;
  msgs: number;
  calls: number; // distinct mints
  resolved: number;
  graduated: number;
  big: number; // mcap >= $100k now
  early: number; // called <= 10 min after launch (or before)
  leads: number[]; // seconds, call time - creation time
  error?: string;
}

export const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
export const fmtLead = (s: number) =>
  Number.isNaN(s) ? "-" : s < 0 ? `${(-s / 60).toFixed(0)}m BEFORE` : s < 3600 ? `${(s / 60).toFixed(1)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");

/** Graduation rate of all launches, for comparison (from our own monitor data, else 3.5%). */
export function baseGraduationRate(db: DatabaseSync): number {
  const r = db.prepare("SELECT COUNT(*) n, SUM(graduated) g FROM tokens WHERE late_discovery=0 AND finalized=1").get() as any;
  return r?.n > 200 ? r.g / r.n : 0.035;
}

export function ensureMentionTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mentions (
    tweet_id TEXT PRIMARY KEY, account TEXT, followers INTEGER, mint TEXT, posted_at INTEGER, text TEXT, url TEXT, fetched_at INTEGER
  )`);
  try {
    db.exec(`ALTER TABLE mentions ADD COLUMN source TEXT`);
  } catch {}
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_channels (
    channel TEXT PRIMARY KEY, title TEXT, members INTEGER, found_via TEXT, msgs INTEGER, calls INTEGER, resolved INTEGER,
    graduated INTEGER, big INTEGER, early INTEGER, median_lead_s REAL, graded_at INTEGER, error TEXT
  )`);
}

/**
 * Pull up to `limit` recent messages (within `days`) from a channel, extract mints, resolve outcomes
 * for up to `maxMints` of them, and return the grade. Mentions/outcomes are persisted.
 */
export async function gradeChannel(
  client: TelegramClient,
  db: DatabaseSync,
  channel: string,
  opts: { days: number; limit: number; maxMints: number; members?: number | null; foundVia?: string; onProgress?: (s: string) => void },
): Promise<ChannelGrade> {
  const g: ChannelGrade = { channel, title: channel, members: opts.members ?? null, msgs: 0, calls: 0, resolved: 0, graduated: 0, big: 0, early: 0, leads: [] };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO mentions (tweet_id, account, followers, mint, posted_at, text, url, fetched_at, source) VALUES (?,?,?,?,?,?,?,?,'telegram')`,
  );
  let entity: any;
  try {
    entity = await client.getEntity(channel);
    g.title = entity.title ?? channel;
  } catch (e) {
    g.error = `cannot resolve: ${(e as Error).message}`;
    persist(db, g, opts.foundVia);
    return g;
  }
  const sinceUnix = Math.floor(Date.now() / 1000) - opts.days * 86400;
  const firstSeen = new Map<string, { at: number; msgId: number; text: string }>();
  try {
    for await (const msg of client.iterMessages(entity, { limit: opts.limit })) {
      if (!msg.date || msg.date < sinceUnix) break;
      g.msgs++;
      const t = messageToTweet(msg, channel);
      for (const m of parseTweet(t).mints) {
        const prev = firstSeen.get(m.mint);
        if (!prev || t.createdAt < prev.at) firstSeen.set(m.mint, { at: t.createdAt, msgId: msg.id, text: t.text });
      }
    }
  } catch (e) {
    g.error = `history: ${(e as Error).message}`;
  }
  g.calls = firstSeen.size;
  // grade the most recent calls first (fresh outcomes are the most relevant)
  const entries = [...firstSeen].sort((a, b) => b[1].at - a[1].at).slice(0, opts.maxMints);
  let i = 0;
  for (const [mint, first] of entries) {
    insert.run(`tg:${channel}:${first.msgId}:${mint}`, `tg:${channel}`, null, mint, first.at, first.text.slice(0, 500), `https://t.me/${channel}/${first.msgId}`, Date.now());
    const o = await getOutcome(db, mint);
    if (++i % 10 === 0) opts.onProgress?.(`${i}/${entries.length}`);
    if (!o) continue;
    g.resolved++;
    if (o.graduated) g.graduated++;
    if ((o.mcapUsd ?? 0) >= 100_000) g.big++;
    if (o.createdAt) {
      const lead = (first.at - o.createdAt) / 1000;
      g.leads.push(lead);
      if (lead <= 600) g.early++;
    }
  }
  persist(db, g, opts.foundVia);
  return g;
}

function persist(db: DatabaseSync, g: ChannelGrade, foundVia?: string): void {
  db.prepare(
    `INSERT INTO telegram_channels (channel, title, members, found_via, msgs, calls, resolved, graduated, big, early, median_lead_s, graded_at, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(channel) DO UPDATE SET title=excluded.title, members=COALESCE(excluded.members, telegram_channels.members),
       found_via=COALESCE(telegram_channels.found_via, excluded.found_via), msgs=excluded.msgs, calls=excluded.calls, resolved=excluded.resolved,
       graduated=excluded.graduated, big=excluded.big, early=excluded.early, median_lead_s=excluded.median_lead_s, graded_at=excluded.graded_at, error=excluded.error`,
  ).run(g.channel, g.title, g.members, foundVia ?? null, g.msgs, g.calls, g.resolved, g.graduated, g.big, g.early, Number.isNaN(median(g.leads)) ? null : median(g.leads), Date.now(), g.error ?? null);
}

/** Score: graduation rate above base, weighted by sample size, with a bonus for early calls. */
export function score(g: ChannelGrade, base: number): number {
  if (g.resolved < 3) return -1;
  const gradRate = g.graduated / g.resolved;
  const lift = gradRate / base;
  const earlyShare = g.leads.length ? g.early / g.leads.length : 0;
  const confidence = Math.min(1, g.resolved / 20);
  return lift * (0.5 + earlyShare) * confidence;
}

export function printScorecard(grades: ChannelGrade[], base: number): void {
  const rows = grades.filter((g) => !g.error).sort((a, b) => score(b, base) - score(a, base));
  console.log(
    "  channel".padEnd(30) + "members".padStart(8) + "msgs".padStart(6) + "calls".padStart(6) + "graded".padStart(7) + "graduated".padStart(12) + ">100k now".padStart(11) + "early<=10m".padStart(12) + "  median lead".padEnd(16) + "  score",
  );
  for (const g of rows) {
    console.log(
      ("  @" + g.channel).slice(0, 29).padEnd(30) +
        (g.members === null ? "-" : g.members >= 1000 ? `${(g.members / 1000).toFixed(1)}k` : String(g.members)).padStart(8) +
        String(g.msgs).padStart(6) +
        String(g.calls).padStart(6) +
        String(g.resolved).padStart(7) +
        `${g.graduated} (${pct(g.graduated, g.resolved)})`.padStart(12) +
        `${g.big} (${pct(g.big, g.resolved)})`.padStart(11) +
        `${g.early} (${pct(g.early, g.leads.length)})`.padStart(12) +
        ("  " + fmtLead(median(g.leads))).padEnd(16) +
        "  " + (score(g, base) < 0 ? "n/a" : score(g, base).toFixed(2)),
    );
  }
  const errs = grades.filter((g) => g.error);
  if (errs.length) console.log(`\n  ${errs.length} channel(s) could not be read: ` + errs.map((g) => `@${g.channel} (${g.error})`).join("; "));
  console.log(`\n  base graduation rate of all launches: ${(base * 100).toFixed(1)}%. score = (graduation rate / base) × (0.5 + early share) × confidence(n/20). n/a = fewer than 3 graded calls.`);
  console.log("  Caution: an 'early' channel with a high graduation rate may be the operator running the bundle. Check what they post before trusting it.");
}
