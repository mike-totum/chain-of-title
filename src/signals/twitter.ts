import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";

/** twitterapi.io free tier allows one request per 5 s; paid tiers are faster. Keep a global gap. */
export const MIN_REQUEST_GAP_MS = Number(process.env.TWITTER_MIN_GAP_MS ?? 5500);
let nextSlot = 0;
/** Serialising throttle: every caller gets its own slot at least MIN_REQUEST_GAP_MS after the previous one. */
export async function throttle(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_REQUEST_GAP_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

export interface Tweet {
  id: string;
  text: string;
  createdAt: number; // ms
  url: string;
  author: string;
  authorFollowers?: number;
  likes?: number;
  retweets?: number;
  views?: number;
  urls: string[]; // expanded urls
}

export interface KolSignal {
  account: string;
  kind: "mint" | "link" | "cashtag";
  mint: string | null;
  symbol: string | null;
  text: string;
  url: string;
  postedAt: number;
}

export interface TweetProvider {
  name: string;
  latest(username: string): Promise<Tweet[]>;
  /** Recent-tweet search. Returns tweets plus a cursor for the next page (null when exhausted). */
  search?(query: string, cursor?: string | null): Promise<{ tweets: Tweet[]; next: string | null }>;
  /**
   * New tweets from a batch of accounts since a unix time (seconds). One request covers many
   * accounts and usually returns 0–2 tweets, so it is far cheaper than polling each timeline.
   */
  searchFrom?(accounts: string[], sinceUnix: number): Promise<Tweet[]>;
}

const mapTwitterApiIoTweet = (t: any, fallbackUser: string): Tweet => ({
  id: String(t.id),
  text: String(t.text ?? ""),
  createdAt: Date.parse(t.createdAt) || Date.now(),
  url: t.url ?? `https://x.com/${t.author?.userName ?? fallbackUser}/status/${t.id}`,
  author: t.author?.userName ?? fallbackUser,
  authorFollowers: typeof t.author?.followers === "number" ? t.author.followers : undefined,
  likes: typeof t.likeCount === "number" ? t.likeCount : undefined,
  retweets: typeof t.retweetCount === "number" ? t.retweetCount : undefined,
  views: typeof t.viewCount === "number" ? t.viewCount : undefined,
  urls: (t.entities?.urls ?? []).map((x: any) => x.expanded_url ?? x.url).filter(Boolean),
});

/** twitterapi.io — pay-as-you-go, no subscription. Header X-API-Key. */
export function twitterApiIoProvider(apiKey: string): TweetProvider {
  return {
    name: "twitterapi.io",
    async latest(username) {
      const u = new URL("https://api.twitterapi.io/twitter/user/last_tweets");
      u.searchParams.set("userName", username);
      await throttle();
      const res = await fetch(u, { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`twitterapi.io ${res.status} for @${username}: ${(await res.text()).slice(0, 200)}`);
      const j: any = await res.json();
      const arr: any[] = j?.tweets ?? j?.data?.tweets ?? (Array.isArray(j?.data) ? j.data : []);
      return arr.map((t) => mapTwitterApiIoTweet(t, username));
    },
    async search(query, cursor) {
      const u = new URL("https://api.twitterapi.io/twitter/tweet/advanced_search");
      u.searchParams.set("query", query);
      u.searchParams.set("queryType", "Latest");
      if (cursor) u.searchParams.set("cursor", cursor);
      await throttle();
      const res = await fetch(u, { headers: { "X-API-Key": apiKey }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`twitterapi.io ${res.status} search: ${(await res.text()).slice(0, 200)}`);
      const j: any = await res.json();
      const arr: any[] = j?.tweets ?? j?.data?.tweets ?? [];
      return { tweets: arr.map((t) => mapTwitterApiIoTweet(t, "unknown")), next: j?.has_next_page ? (j.next_cursor ?? null) : null };
    },
    async searchFrom(accounts, sinceUnix) {
      const q = `(${accounts.map((a) => `from:${a}`).join(" OR ")}) since_time:${sinceUnix}`;
      const out: Tweet[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 3; page++) {
        const r = await this.search!(q, cursor);
        out.push(...r.tweets);
        cursor = r.next;
        if (!cursor || r.tweets.length < 20) break;
      }
      return out;
    },
  };
}

/** Official X API v2 with an app bearer token. Needs a paid tier for meaningful read volume. */
export function xApiProvider(bearer: string): TweetProvider {
  const ids = new Map<string, string>();
  const headers = { Authorization: `Bearer ${bearer}` };
  return {
    name: "x-api",
    async latest(username) {
      let id = ids.get(username);
      if (!id) {
        const r = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`x-api ${r.status} resolving @${username}`);
        id = String(((await r.json()) as any).data.id);
        ids.set(username, id);
      }
      const u = new URL(`https://api.x.com/2/users/${id}/tweets`);
      u.searchParams.set("max_results", "5");
      u.searchParams.set("exclude", "retweets");
      u.searchParams.set("tweet.fields", "created_at,entities");
      const res = await fetch(u, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`x-api ${res.status} timeline @${username}`);
      const j: any = await res.json();
      return (j.data ?? []).map((t: any) => ({
        id: String(t.id),
        text: String(t.text ?? ""),
        createdAt: Date.parse(t.created_at) || Date.now(),
        url: `https://x.com/${username}/status/${t.id}`,
        author: username,
        urls: (t.entities?.urls ?? []).map((x: any) => x.expanded_url ?? x.url).filter(Boolean),
      }));
    },
    async search(query, cursor) {
      const u = new URL("https://api.x.com/2/tweets/search/recent");
      u.searchParams.set("query", query);
      u.searchParams.set("max_results", "100");
      u.searchParams.set("tweet.fields", "created_at,entities,author_id");
      u.searchParams.set("expansions", "author_id");
      u.searchParams.set("user.fields", "username,public_metrics");
      if (cursor) u.searchParams.set("next_token", cursor);
      const res = await fetch(u, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`x-api ${res.status} search`);
      const j: any = await res.json();
      const users = new Map<string, any>((j.includes?.users ?? []).map((x: any) => [x.id, x]));
      const tweets: Tweet[] = (j.data ?? []).map((t: any) => {
        const au = users.get(t.author_id);
        return {
          id: String(t.id),
          text: String(t.text ?? ""),
          createdAt: Date.parse(t.created_at) || Date.now(),
          url: `https://x.com/${au?.username ?? "i"}/status/${t.id}`,
          author: au?.username ?? String(t.author_id),
          authorFollowers: au?.public_metrics?.followers_count,
          urls: (t.entities?.urls ?? []).map((x: any) => x.expanded_url ?? x.url).filter(Boolean),
        };
      });
      return { tweets, next: j.meta?.next_token ?? null };
    },
  };
}

/**
 * Broad listener: polls a search query (default: any tweet linking a pump.fun coin) and emits every
 * mint found, attributed to whoever posted it. This is the "ear on the street": nothing here is
 * trusted, everything is recorded so the outcome tables can rank accounts over time.
 */
export interface StreetListener {
  on(event: "signal", l: (s: KolSignal) => void): this;
  on(event: "tweet", l: (t: Tweet, query: string) => void): this;
  on(event: "status", l: (msg: string) => void): this;
  on(event: "muted", l: (author: string) => void): this;
}
export class StreetListener extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private seen = new Set<string>();
  private since = new Map<string, number>();
  /** flood control: accounts posting more than `muteAfter` tweets in 20 min get excluded from the queries (saves credits, removes spam) */
  private recentByAuthor = new Map<string, number[]>();
  readonly muted = new Set<string>();
  muteAfter = 25;
  readonly stats = { polls: 0, tweets: 0, signals: 0, errors: 0 };
  constructor(
    private provider: TweetProvider,
    private queries: string[],
    private pollSeconds: number,
    private pages = 1,
  ) {
    super();
  }
  start(muted: string[] = []): void {
    if (!this.provider.search || !this.queries.length) return;
    for (const m of muted) this.muted.add(m.toLowerCase());
    const start = Math.floor(Date.now() / 1000) - 60;
    for (const q of this.queries) this.since.set(q, start);
    const perDay = (86400 / this.pollSeconds) * this.queries.length;
    this.emit("status", `street listener: ${this.queries.length} queries every ${this.pollSeconds}s (${this.pages} page${this.pages > 1 ? "s" : ""}) — up to ${Math.round(perDay)} requests/day, worst case ~$${((perDay * this.pages * 20 * 0.15) / 1000).toFixed(0)}/day on twitterapi.io`);
    this.timer = setInterval(() => void this.pollAll(), this.pollSeconds * 1000);
    void this.pollAll();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  private async pollAll(): Promise<void> {
    for (const q of this.queries) await this.poll(q);
    if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-8000));
  }
  private async poll(query: string): Promise<void> {
    this.stats.polls++;
    const since = this.since.get(query)!;
    const next = Math.floor(Date.now() / 1000) - 20;
    let cursor: string | null = null;
    for (let page = 0; page < this.pages; page++) {
      let r;
      try {
        const mutes = [...this.muted].map((m) => ` -from:${m}`).join("");
        r = await this.provider.search!(`${query}${mutes} since_time:${since}`, cursor);
      } catch (e) {
        this.stats.errors++;
        this.emit("status", `street poll error: ${(e as Error).message}`);
        return; // keep since so nothing is skipped
      }
      for (const t of r.tweets) {
        if (this.seen.has(t.id)) continue;
        this.seen.add(t.id);
        if (this.muted.has(t.author.toLowerCase())) continue;
        const times = this.recentByAuthor.get(t.author) ?? [];
        const cutoff = Date.now() - 20 * 60_000;
        const kept = times.filter((x) => x >= cutoff);
        kept.push(Date.now());
        this.recentByAuthor.set(t.author, kept);
        if (kept.length > this.muteAfter && this.muted.size < 15) {
          this.muted.add(t.author.toLowerCase());
          this.emit("status", `muting @${t.author}: ${kept.length} tweets in 20 min`);
          this.emit("muted", t.author);
          continue;
        }
        this.stats.tweets++;
        this.emit("tweet", t, query);
        const { mints } = parseTweet(t);
        for (const m of mints) {
          this.stats.signals++;
          this.emit("signal", { account: t.author, kind: m.kind, mint: m.mint, symbol: null, text: t.text, url: t.url, postedAt: t.createdAt } satisfies KolSignal);
        }
      }
      cursor = r.next;
      if (!cursor || r.tweets.length < 20) break;
    }
    this.since.set(query, next);
  }
}

export function loadKols(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim().replace(/^@/, ""))
    .filter((l) => l && !l.startsWith("#"));
}

const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const CASHTAG = /\$([A-Za-z][A-Za-z0-9_]{1,14})\b/g;
const HASHTAG = /#([A-Za-z][A-Za-z0-9_]{1,30})\b/g;
const STOP_TAGS = new Set(["SOLANA", "SOL", "MEMECOIN", "MEMECOINS", "CRYPTO", "PUMPFUN", "PUMP", "BTC", "ETH", "NFT", "WEB3", "ALTCOIN", "ALTCOINS", "DEFI", "BLOCKCHAIN", "BINANCE", "AIRDROP", "TRADING", "100X", "1000X", "GEM", "GEMS"]);
export function parseTags(text: string): string[] {
  return [...new Set([...text.matchAll(HASHTAG)].map((m) => m[1].toUpperCase()))].filter((t) => !STOP_TAGS.has(t));
}

/** Extract candidate mints / cashtags from a tweet. Mints ending in "pump" are pump.fun tokens. */
export function parseTweet(t: Tweet): { mints: { mint: string; kind: "mint" | "link" }[]; cashtags: string[] } {
  const mints = new Map<string, "mint" | "link">();
  const TOKEN_SITES = /pump\.fun|dexscreener\.com|gmgn\.ai|photon-sol|solscan\.io|bullx\.io|axiom\.trade|birdeye\.so|jup\.ag|trojan|padre\./i;
  for (const u of t.urls) {
    if (!TOKEN_SITES.test(u)) continue;
    for (const m of u.matchAll(BASE58)) if (m[0].endsWith("pump") || m[0].length >= 43) mints.set(m[0], "link");
  }
  for (const m of t.text.matchAll(BASE58)) {
    if (m[0].endsWith("pump") || m[0].length >= 43) if (!mints.has(m[0])) mints.set(m[0], "mint");
  }
  const cashtags = [...new Set([...t.text.matchAll(CASHTAG)].map((m) => m[1].toUpperCase()))].filter(
    (c) => !["SOL", "BTC", "ETH", "USDC", "USDT", "USD"].includes(c),
  );
  return { mints: [...mints].map(([mint, kind]) => ({ mint, kind })), cashtags };
}

export interface KolWatcher {
  on(event: "signal", l: (s: KolSignal) => void): this;
  on(event: "status", l: (msg: string) => void): this;
}

/**
 * Polls each watched account round-robin, spreading requests evenly so that every
 * account is refreshed roughly once per `pollSeconds`. Only tweets newer than the
 * last seen id (and newer than start-up minus 2 min) produce signals.
 */
export class KolWatcher extends EventEmitter {
  private lastId = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private idx = 0;
  private startedAt = 0;
  private seenIds = new Set<string>();
  private sinceUnix = 0;
  readonly stats = { polls: 0, errors: 0, tweets: 0, signals: 0 };

  constructor(
    private provider: TweetProvider,
    private accounts: string[],
    private pollSeconds: number,
  ) {
    super();
  }

  start(): void {
    if (!this.accounts.length) return;
    this.startedAt = Date.now();
    if (this.provider.searchFrom) {
      // Batched mode: one search per poll interval per 20 accounts, returning only new tweets.
      this.sinceUnix = Math.floor(this.startedAt / 1000) - 120;
      const batches = Math.ceil(this.accounts.length / 20);
      this.emit("status", `watching ${this.accounts.length} accounts via ${this.provider.name} batched search (${batches} request${batches > 1 ? "s" : ""} every ${this.pollSeconds}s)`);
      this.timer = setInterval(() => void this.pollBatched(), this.pollSeconds * 1000);
      void this.pollBatched();
      return;
    }
    const gapMs = Math.max(1000, (this.pollSeconds * 1000) / this.accounts.length);
    this.emit("status", `watching ${this.accounts.length} accounts via ${this.provider.name}, one request every ${(gapMs / 1000).toFixed(1)}s`);
    this.timer = setInterval(() => void this.pollNext(), gapMs);
    void this.pollNext();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async pollBatched(): Promise<void> {
    const since = this.sinceUnix;
    const nextSince = Math.floor(Date.now() / 1000) - 30; // small overlap; seenIds dedupes
    for (let i = 0; i < this.accounts.length; i += 20) {
      const batch = this.accounts.slice(i, i + 20);
      this.stats.polls++;
      let tweets: Tweet[];
      try {
        tweets = await this.provider.searchFrom!(batch, since);
      } catch (e) {
        this.stats.errors++;
        this.emit("status", `poll error: ${(e as Error).message}`);
        return; // keep sinceUnix so nothing is missed
      }
      for (const t of tweets) {
        if (this.seenIds.has(t.id)) continue;
        this.seenIds.add(t.id);
        this.stats.tweets++;
        this.handleTweet(t.author, t);
      }
    }
    this.sinceUnix = nextSince;
    if (this.seenIds.size > 5000) this.seenIds = new Set([...this.seenIds].slice(-2000));
  }

  private handleTweet(account: string, t: Tweet): void {
    const { mints, cashtags } = parseTweet(t);
    for (const m of mints) {
      this.stats.signals++;
      this.emit("signal", { account, kind: m.kind, mint: m.mint, symbol: null, text: t.text, url: t.url, postedAt: t.createdAt } satisfies KolSignal);
    }
    if (!mints.length)
      for (const c of cashtags) {
        this.stats.signals++;
        this.emit("signal", { account, kind: "cashtag", mint: null, symbol: c, text: t.text, url: t.url, postedAt: t.createdAt } satisfies KolSignal);
      }
  }

  private async pollNext(): Promise<void> {
    const account = this.accounts[this.idx++ % this.accounts.length];
    this.stats.polls++;
    let tweets: Tweet[];
    try {
      tweets = await this.provider.latest(account);
    } catch (e) {
      this.stats.errors++;
      this.emit("status", `poll error: ${(e as Error).message}`);
      return;
    }
    tweets.sort((a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : 1));
    const prev = this.lastId.get(account);
    for (const t of tweets) {
      if (prev !== undefined && (t.id.length < prev.length || (t.id.length === prev.length && t.id <= prev))) continue;
      if (prev === undefined && t.createdAt < this.startedAt - 120_000) continue;
      this.stats.tweets++;
      this.handleTweet(account, t);
    }
    if (tweets.length) {
      const newest = tweets[tweets.length - 1].id;
      if (prev === undefined || newest.length > prev.length || (newest.length === prev.length && newest > prev)) this.lastId.set(account, newest);
    }
  }
}
