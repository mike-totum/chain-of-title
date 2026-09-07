// Sends the headline numbers of a daily report file to Telegram Saved Messages.
import { readFileSync } from "node:fs";
import { config } from "../src/config.ts";
import { createClient, telegramConfigured } from "../src/signals/telegram-client.ts";
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
if (!telegramConfigured(config.telegramApiId, config.telegramApiHash)) process.exit(0);
const client = createClient(config.telegramApiId, config.telegramApiHash);
await client.connect();
await client.sendMessage("me", { message: lines.join("\n"), linkPreview: false });
await client.disconnect();
process.exit(0);
