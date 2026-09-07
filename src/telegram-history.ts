/**
 * Grade the channels listed in channels.txt on their past calls.
 *
 *   npm run telegram:history -- [--days 30] [--limit 500] [--max-mints 80] [--channel name]
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { createClient, loadChannels, telegramConfigured } from "./signals/telegram-client.ts";
import { ensureOutcomeTable } from "./outcomes.ts";
import { baseGraduationRate, ensureMentionTables, gradeChannel, printScorecard, type ChannelGrade } from "./signals/telegram-grade.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") || process.argv[i + 1] === undefined ? "true" : process.argv[++i]);
}
const days = Number(args.get("days") ?? 30);
const limit = Number(args.get("limit") ?? 500);
const maxMints = Number(args.get("max-mints") ?? 80);
const only = args.get("channel");

if (!telegramConfigured(config.telegramApiId, config.telegramApiHash)) {
  console.error("Telegram not configured. Set TELEGRAM_API_ID / TELEGRAM_API_HASH in .env and run `npm run telegram:login`.");
  process.exit(1);
}
const channels = loadChannels(config.telegramChannelsFile).filter((c) => !only || c.toLowerCase() === only.toLowerCase());
if (!channels.length) {
  console.error(`No channels in ${config.telegramChannelsFile}. Use \`npm run telegram:find\` to discover some.`);
  process.exit(1);
}
const db = openDb(config.dbPath);
ensureOutcomeTable(db);
ensureMentionTables(db);
const client = createClient(config.telegramApiId, config.telegramApiHash);
await client.connect();
const grades: ChannelGrade[] = [];
for (const ch of channels) {
  process.stdout.write(`@${ch}: `);
  const g = await gradeChannel(client, db, ch, { days, limit, maxMints, foundVia: "channels.txt", onProgress: () => process.stdout.write(".") });
  console.log(g.error ? ` error: ${g.error}` : ` ${g.msgs} msgs, ${g.calls} mints, ${g.graduated}/${g.resolved} graduated`);
  grades.push(g);
}
await client.disconnect();
console.log(`\nCHANNEL SCORECARD (last ${days} days)\n`);
printScorecard(grades, baseGraduationRate(db));
process.exit(0);
