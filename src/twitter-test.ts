/** Verify the Twitter provider key works: fetch the latest tweets from one account and try one search. */
import { config } from "./config.ts";
import { twitterApiIoProvider, xApiProvider, parseTweet } from "./signals/twitter.ts";

const account = (process.argv[2] ?? "pumpdotfun").replace(/^@/, "");
const provider =
  config.twitterProvider === "twitterapi" && config.twitterApiIoKey
    ? twitterApiIoProvider(config.twitterApiIoKey)
    : config.twitterProvider === "x" && config.xBearerToken
      ? xApiProvider(config.xBearerToken)
      : null;
if (!provider) {
  console.error("Not configured. In .env set TWITTER_PROVIDER=twitterapi and TWITTERAPI_IO_KEY=<key>");
  process.exit(1);
}
console.log(`provider: ${provider.name}\n`);
const tweets = await provider.latest(account);
console.log(`latest ${tweets.length} tweets from @${account}:`);
for (const t of tweets.slice(0, 5)) {
  const { mints, cashtags } = parseTweet(t);
  console.log(`  ${new Date(t.createdAt).toISOString().slice(0, 16)}  ${t.text.replace(/\s+/g, " ").slice(0, 90)}`);
  if (mints.length || cashtags.length) console.log(`      → mints: ${mints.map((m) => m.mint).join(", ") || "-"}   cashtags: ${cashtags.join(", ") || "-"}`);
}
if (provider.search) {
  const r = await provider.search("pump.fun", null);
  console.log(`\nsearch "pump.fun": ${r.tweets.length} tweets on first page${r.next ? ", more available" : ""}`);
}
console.log("\nOK — key works.");
