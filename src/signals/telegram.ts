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
  on(event: "gap", l: (g: { channel: string; at: number; reason: string }) => void): this;
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
    /**
     * The newest message id already archived for a channel, if any.
     *
     * Without this, start() sets the cursor to whatever is newest RIGHT NOW, so every message posted while the
     * process was down is skipped - silently, permanently, and invisibly, because a message we never fetched leaves
     * nothing behind to notice. For a signal generator that was correct: stale calls are worthless. For an archive it
     * is the whole failure this project keeps finding, since the gap is indistinguishable afterwards from a quiet
     * channel.
     */
    private resumeFrom: (channel: string) => number = () => 0,
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
        const resume = this.resumeFrom(ch);
        if (resume > 0 && latest && latest.id > resume) {
          // Pick up where the archive stops. The catch-up itself runs through the normal poll path below.
          this.lastSeenId.set(ch, resume);
          this.emit("status", `@${ch}: resuming from archived id ${resume}, ${latest.id - resume} message(s) behind`);
        } else if (latest) {
          this.lastSeenId.set(ch, resume > 0 ? resume : latest.id);
          const ageMin = (Date.now() / 1000 - (latest.date ?? 0)) / 60;
          this.emit("status", `@${ch}: last post ${ageMin < 90 ? ageMin.toFixed(0) + " min" : (ageMin / 60).toFixed(1) + " h"} ago`);
        }
      } catch (e) {
        this.emit("status", `cannot resolve channel ${ch}: ${(e as Error).message}`);
        /**
         * A channel we can no longer reach is a fact, and the most perishable one here.
         *
         * @SolanaGemsChecked stopped existing on 2026-09-09 - not renamed as far as we can tell, gone - and because
         * it had never been captured, nothing of what it called survives at any price. Dropping silently out of the
         * watch loop is how that becomes invisible: the channel simply stops appearing, and a year later there is no
         * way to tell a channel that went quiet from one that was deleted from one we stopped asking about.
         *
         * Recorded as an open gap, which is exactly what it is, and it stays open until the channel resolves again.
         */
        this.emit("gap", { channel: ch, at: Date.now(), reason: `cannot resolve: ${(e as Error).message}`.slice(0, 200) });
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
        // Deeper than 10 when catching up: a restart after an outage has a backlog, and a limit tuned for steady
        // state would leave the middle of it unfetched while advancing past it.
        const behind = this.lastSeenId.get(ch) ?? 0;
        const msgs = await this.client.getMessages(ent, { limit: behind ? 100 : 10 });
        const last = this.lastSeenId.get(ch) ?? 0;
        const fresh = msgs.filter((m: any) => m.id > last).sort((a: any, b: any) => a.id - b.id);
        for (const m of fresh) {
          this.lastSeenId.set(ch, m.id);
          this.handle(ch, m);
        }
      } catch (e) {
        this.stats.pollErrors++;
        this.emit("status", `poll error @${ch}: ${(e as Error).message}`);
        // A failed poll is a hole in coverage, and the cursor deliberately does NOT advance - but the failure has to
        // be recorded too, or the hole is indistinguishable from a channel that said nothing.
        this.emit("gap", { channel: ch, at: Date.now(), reason: (e as Error).message.slice(0, 200) });
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
     * Emitted rather than written here so this file stays a reader of Telegram and the storage decision - including
     * the decision not to publish any of it - lives with the process that owns the database.
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
