/**
 * One-time interactive Telegram login. Run it yourself:  npm run telegram:login
 * Needs TELEGRAM_API_ID / TELEGRAM_API_HASH from https://my.telegram.org (API development tools).
 * Saves a session string to data/telegram.session (chmod 600, gitignored).
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "./config.ts";
import { createClient, saveSession, SESSION_FILE } from "./signals/telegram-client.ts";

if (!config.telegramApiId || !config.telegramApiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first (create an app at https://my.telegram.org).");
  process.exit(1);
}
const rl = createInterface({ input: stdin, output: stdout });
const client = createClient(config.telegramApiId, config.telegramApiHash);
await client.start({
  phoneNumber: async () => (await rl.question("Phone number (with country code, e.g. +1555...): ")).trim(),
  password: async () => (await rl.question("Two-factor password (leave blank if none): ")).trim(),
  phoneCode: async () => (await rl.question("Code Telegram just sent you: ")).trim(),
  onError: (e) => console.error("login error:", e.message),
});
saveSession(client.session.save() as unknown as string);
const me: any = await client.getMe();
console.log(`\nLogged in as ${me.username ? "@" + me.username : me.firstName}. Session saved to ${SESSION_FILE}.`);
console.log("Next: add channel usernames to channels.txt, then `npm run telegram:history` to grade them or `npm start` to watch live.");
await client.disconnect();
rl.close();
process.exit(0);
