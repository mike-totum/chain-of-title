import { EventEmitter } from "node:events";
import type { TelegramClient } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { parseTweet, type KolSignal, type Tweet } from "./twitter.ts";

/** Pull text, entity URLs and inline-button URLs out of a gramjs message. */
export function messageToTweet(msg: any, channel: string): Tweet {
  const urls: string[] = [];
  for (const e of msg.entities ?? []) if (typeof e.url === "string") urls.push(e.url);
  for (const row of msg.replyMarkup?.rows ?? []) for (const b of row.buttons ?? []) if (typeof b.url === "string") urls.push(b.url);
  return {
    id: String(msg.id),
    text: String(msg.message ?? ""),
    createdAt: (msg.date ?? 0) * 1000,
    url: `https://t.me/${channel}/${msg.id}`,
    author: channel,
    urls,
  };
}

/**
 * One channel message, as read. Separate from KolSignal because they answer different questions: a signal is our
 * reading of a message (it named this mint), and this is the message. The reading is derived and can be redone; the
 * message cannot be re-read once it is deleted.
 */
export interface TelegramMessage {
  channel: string;
  id: number;
  postedAt: number;
  sender: string | null;
  text: string;
  url: string;
  mints: string[];
  cashtags: string[];
  views: number | null;
  forwards: number | null;
  replyTo: number | null;
  editedAt: number | null;
}

export interface TelegramWatcher {
  on(event: "signal", l: (s: KolSignal) => void): this;
  on(event: "status", l: (msg: string) => void): this;
  on(event: "message", l: (m: TelegramMessage) => void): this;
}

/** Listens to new messages in the configured channels and emits KOL-style signals. */
export class TelegramWatcher extends EventEmitter {
  private idToChannel = new Map<string, string>();
  private entities = new Map<string, any>();
  private lastSeenId = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  readonly stats = { messages: 0, signals: 0, allEvents: 0, polls: 0, pollErrors: 0 };
  private unmatchedLogged = 0;

  constructor(
    private client: TelegramClient,
    private channels: string[],
  ) {
    super();
  }

  async start(): Promise<void> {
    await this.client.connect();
    for (const ch of this.channels) {
      try {
        const ent: any = await this.client.getEntity(ch);
        this.idToChannel.set(String(ent.id), ch);
        this.entities.set(ch, ent);
        // remember the newest message id so polling only reports what arrives from now on
        const [latest] = await this.client.getMessages(ent, { limit: 1 });
        if (latest) {
          this.lastSeenId.set(ch, latest.id);
          const ageMin = (Date.now() / 1000 - (latest.date ?? 0)) / 60;
          this.emit("status", `@${ch}: last post ${ageMin < 90 ? ageMin.toFixed(0) + " min" : (ageMin / 60).toFixed(1) + " h"} ago`);
        }
      } catch (e) {
        this.emit("status", `cannot resolve channel ${ch}: ${(e as Error).message}`);
      }
    }
    // Polling fallback: push updates for channels are not always delivered to a fresh session.
    this.pollTimer = setInterval(() => void this.pollAll(), 60_000);
    // Loading dialogs once makes sure channel updates are delivered to this session.
    try {
      await this.client.getDialogs({ limit: 100 });
    } catch {}
    this.emit("status", `watching ${this.idToChannel.size}/${this.channels.length} Telegram channels: ${[...this.idToChannel.values()].join(", ")}`);
    this.client.addEventHandler((ev: NewMessageEvent) => this.onMessage(ev), new NewMessage({}));
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  /** Send a note to your own Saved Messages. Fire-and-forget. */
  sendSelf(text: string): void {
    this.client.sendMessage("me", { message: text, linkPreview: false }).catch(() => {});
  }

  private async pollAll(): Promise<void> {
    for (const [ch, ent] of this.entities) {
      this.stats.polls++;
      try {
        const msgs = await this.client.getMessages(ent, { limit: 10 });
        const last = this.lastSeenId.get(ch) ?? 0;
        const fresh = msgs.filter((m: any) => m.id > last).sort((a: any, b: any) => a.id - b.id);
        for (const m of fresh) {
          this.lastSeenId.set(ch, m.id);
          this.handle(ch, m);
        }
      } catch (e) {
        this.stats.pollErrors++;
        this.emit("status", `poll error @${ch}: ${(e as Error).message}`);
      }
    }
  }

  private handle(channel: string, msg: any): void {
    this.stats.messages++;
    const t = messageToTweet(msg, channel);
    const { mints, cashtags } = parseTweet(t);
    /**
     * Every message, not only the ones naming a token.
     *
     * This class was written to generate trading signals, so it kept what matched a mint and dropped the rest. The
     * rest is the record: what was said about a launch before anyone knew how it ended, by whom, and when. It is
     * unrecoverable once deleted, and a deletion is the event most worth having recorded.
     *
     * Emitted rather than written here so this file stays a reader of Telegram and the storage decision — including
     * the decision not to publish any of it — lives with the process that owns the database.
     */
    this.emit("message", {
      channel,
      id: Number(msg?.id ?? 0),
      postedAt: t.createdAt,
      sender: msg?.senderId ? String(msg.senderId) : msg?.fromId?.userId ? String(msg.fromId.userId) : null,
      text: t.text,
      url: t.url,
      mints: mints.map((m) => m.mint),
      cashtags,
      views: typeof msg?.views === "number" ? msg.views : null,
      forwards: typeof msg?.forwards === "number" ? msg.forwards : null,
      replyTo: msg?.replyTo?.replyToMsgId ? Number(msg.replyTo.replyToMsgId) : null,
      editedAt: msg?.editDate ? Number(msg.editDate) * 1000 : null,
    });
    for (const m of mints) {
      this.stats.signals++;
      this.emit("signal", { account: `tg:${channel}`, kind: m.kind, mint: m.mint, symbol: null, text: t.text, url: t.url, postedAt: t.createdAt } satisfies KolSignal);
    }
    if (!mints.length)
      for (const c of cashtags) {
        this.stats.signals++;
        this.emit("signal", { account: `tg:${channel}`, kind: "cashtag", mint: null, symbol: c, text: t.text, url: t.url, postedAt: t.createdAt } satisfies KolSignal);
      }
  }

  private onMessage(ev: NewMessageEvent): void {
    this.stats.allEvents++;
    const peer: any = ev.message?.peerId;
    const rawId = ev.chatId ? String(ev.chatId) : peer?.channelId ? String(peer.channelId) : "";
    const chatId = rawId.replace(/^-100/, "").replace(/^-/, "");
    const channel = this.idToChannel.get(chatId);
    if (!channel) {
      if (this.unmatchedLogged < 5 && peer?.channelId) {
        this.unmatchedLogged++;
        this.emit("status", `message from unwatched channel id ${chatId}`);
      }
      return;
    }
    const id = Number(ev.message?.id ?? 0);
    if (id && id <= (this.lastSeenId.get(channel) ?? 0)) return; // already handled by polling
    if (id) this.lastSeenId.set(channel, id);
    this.handle(channel, ev.message);
  }
}
