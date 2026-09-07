import { EventEmitter } from "node:events";
import { parseTags, parseTweet, type Tweet } from "./twitter.ts";

export interface Buzz {
  term: string; // cashtag or hashtag, upper-case
  kind: "cashtag" | "hashtag";
  authors: number;
  mentions: number;
  followers: number; // sum of distinct authors' follower counts
  priorMentionsPerWindow: number; // average mentions per window over the prior baseline period
  sampleUrl: string;
  sampleText: string;
}

export interface BuzzTracker {
  on(event: "buzz", l: (b: Buzz) => void): this;
}

/**
 * Rolling mention counts per $TICKER / #hashtag. A term "buzzes" when, inside the window, it is
 * mentioned by at least `minAuthors` distinct accounts and its rate is >= `minLift` times its
 * baseline over the previous hours. Each term buzzes at most once per cooldown.
 */
export class BuzzTracker extends EventEmitter {
  private events: { ts: number; term: string; kind: "cashtag" | "hashtag"; author: string; followers: number; url: string; text: string }[] = [];
  private lastFired = new Map<string, number>();
  constructor(
    private opts: { windowMs: number; baselineMs: number; minAuthors: number; minLift: number; cooldownMs: number },
  ) {
    super();
  }

  ingest(t: Tweet): void {
    const { cashtags } = parseTweet(t);
    for (const c of cashtags) this.events.push({ ts: t.createdAt, term: c, kind: "cashtag", author: t.author, followers: t.authorFollowers ?? 0, url: t.url, text: t.text });
    for (const h of parseTags(t.text)) this.events.push({ ts: t.createdAt, term: h, kind: "hashtag", author: t.author, followers: t.authorFollowers ?? 0, url: t.url, text: t.text });
  }

  /** Call periodically. */
  evaluate(now: number): Buzz[] {
    const cutoff = now - this.opts.baselineMs - this.opts.windowMs;
    this.events = this.events.filter((e) => e.ts >= cutoff);
    const byTerm = new Map<string, typeof this.events>();
    for (const e of this.events) (byTerm.get(e.term) ?? byTerm.set(e.term, []).get(e.term)!).push(e);
    const out: Buzz[] = [];
    const windows = this.opts.baselineMs / this.opts.windowMs;
    for (const [term, evs] of byTerm) {
      const recent = evs.filter((e) => e.ts >= now - this.opts.windowMs);
      if (!recent.length) continue;
      const authors = new Map<string, number>();
      for (const e of recent) authors.set(e.author, e.followers);
      if (authors.size < this.opts.minAuthors) continue;
      const prior = evs.length - recent.length;
      const priorPerWindow = prior / windows;
      if (priorPerWindow > 0 && recent.length / priorPerWindow < this.opts.minLift) continue;
      if (now - (this.lastFired.get(term) ?? 0) < this.opts.cooldownMs) continue;
      this.lastFired.set(term, now);
      const sample = recent[recent.length - 1];
      out.push({ term, kind: sample.kind, authors: authors.size, mentions: recent.length, followers: [...authors.values()].reduce((a, b) => a + b, 0), priorMentionsPerWindow: priorPerWindow, sampleUrl: sample.url, sampleText: sample.text });
    }
    return out;
  }
}
