// Sends the headline numbers of a daily report file to Telegram.
//
// Moved off the gramjs user-account client onto the bot API on 2026-09-08, for one reason: the old path called
// `telegramConfigured()` and, when the credentials were absent, called `process.exit(0)`. TELEGRAM_API_ID and
// TELEGRAM_API_HASH were empty the whole time, so `daily.sh` reported a successful notification every morning and
// sent nothing. A notifier that exits 0 when it cannot notify is worse than no notifier: it manufactures evidence
// that someone was told. This version exits 1 and says so, and there is now exactly one channel to keep alive rather
// than two half-configured ones.
import { readFileSync } from "node:fs";
import { config } from "../src/config.ts";
const file = process.argv[2];
const text = readFileSync(file, "utf8");
const pick = (re: RegExp) => text.match(re)?.[0]?.replace(/\s+/g, " ").trim();
const lines = [
  `📊 pump-monitor daily — ${file.split("/").pop()}`,
  pick(/launches seen\s+\d+/),
  pick(/graduated \(left bonding curve\)\s+\d+\s+\([\d.]+%\)/),
  ...(text.match(/^\s{2}(baseline-all|early-momentum|strict-momentum|kol-signal|smart-wallet)\s+\d+.*$/gm) ?? []).map((l) => l.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ")),
  pick(/→ \d+ wallets saved to smart_wallets[^\n]*/),
  pick(/"recharge_credits":\d+/)?.replace(/"recharge_credits":(\d+)/, (_, n) => `X credits left: ${Number(n).toLocaleString()} (~$${(Number(n) / 100000).toFixed(2)})`),
  pick(/tweets stored last 24h: \d+/),
  `full report: ${file}`,
].filter(Boolean);
if (!config.telegramBotToken || !config.telegramChatId) {
  console.error("notify-summary: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — NOBODY WAS TOLD. (Check for a duplicate\n" +
    "empty key earlier in .env: config.ts keeps the first occurrence, so an empty one shadows a real one below it.)");
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: config.telegramChatId, text: lines.join("\n"), disable_web_page_preview: true }),
  signal: AbortSignal.timeout(15000),
});
if (!res.ok) {
  console.error(`notify-summary: Telegram returned ${res.status} — NOBODY WAS TOLD.`);
  process.exit(1);
}
process.exit(0);
