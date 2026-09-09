import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SESSION_FILE = process.env.TELEGRAM_SESSION_FILE || "data/telegram.session";

/**
 * The session, from the environment first and the file second.
 *
 * A gramjs session string is full access to the Telegram account that created it — not a scoped API key. Baking one
 * into a container image puts an account credential in every layer of every build and in whatever caches those
 * layers reach. TELEGRAM_SESSION lets it be a platform secret instead, set once, never written to disk, and absent
 * from the image entirely. The file stays the default because that is what `npm run telegram:login` writes locally.
 */
export function loadSession(): string {
  const fromEnv = (process.env.TELEGRAM_SESSION ?? "").trim();
  if (fromEnv) return fromEnv;
  return existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, "utf8").trim() : "";
}

export function saveSession(s: string): void {
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, s, { mode: 0o600 });
}

export function telegramConfigured(apiId: number, apiHash: string): boolean {
  return apiId > 0 && !!apiHash && !!loadSession();
}

export function createClient(apiId: number, apiHash: string): TelegramClient {
  return new TelegramClient(new StringSession(loadSession()), apiId, apiHash, { connectionRetries: 5, useWSS: false });
}

export function loadChannels(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//, ""))
    .filter((l) => l && !l.startsWith("#"));
}
