import { readFileSync, existsSync } from "node:fs";

// Minimal .env loader (no dependency). Real env vars win over the file.
if (existsSync(".env")) {
  // FIRST OCCURRENCE WINS, and that is worth stating out loud rather than leaving to be inferred from the condition
  // below. A key repeated later in the file is ignored, so an EMPTY earlier line silently defeats a correct value
  // further down: `TELEGRAM_BOT_TOKEN=` on line 26 beat a real token on line 44, and every consumer - the collector's
  // alerts, the daily report, the freshness probe - read it as unconfigured and reported success at telling nobody.
  //
  // The warning below is the whole fix, and it is deliberately not a silent correction. Which duplicate is the
  // intended one is a question only the author can answer: preferring the last would quietly change behaviour for
  // anyone relying on the current rule, and preferring the non-empty one guesses. So the rule stays, and the
  // collision stops being invisible. Absence must not read as configuration.
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (!m) continue;
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.add(m[1]);
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (dupes.length)
    console.warn(`[config] .env defines ${[...new Set(dupes)].join(", ")} more than once. The FIRST value is used and the rest are ignored - ` +
      `if one of them is empty and appears first, the setting is empty. Remove the duplicates.`);
}

const num = (k: string, d: number) => {
  const v = process.env[k];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (k: string, d = "") => process.env[k] ?? d;

export const config = {
  buySol: num("BUY_SOL", 0.1),
  prioFeeSol: num("PRIO_FEE_SOL", 0.001),
  fillLatencyMs: num("FILL_LATENCY_MS", 1500),
  watchMinutes: num("WATCH_MINUTES", 60),
  /** unsubscribe from a token with no trades for this long and no open position */
  deadAfterSeconds: num("DEAD_AFTER_SECONDS", 240),
  dbPath: str("DB_PATH", "data/pump.db"),

  /** "rpc" decodes pump.fun program logs from a Solana websocket (free); "pumpportal" needs a funded PumpPortal API key for trades */
  tradeSource: str("TRADE_SOURCE", "rpc") as "rpc" | "pumpportal",
  solanaWsUrl: str("SOLANA_WS_URL", "wss://api.mainnet-beta.solana.com"),
  pumpportalApiKey: str("PUMPPORTAL_API_KEY"),

  twitterProvider: str("TWITTER_PROVIDER") as "" | "x" | "twitterapi",
  xBearerToken: str("X_BEARER_TOKEN"),
  twitterApiIoKey: str("TWITTERAPI_IO_KEY"),
  kolFile: str("KOL_FILE", "kols.txt"),
  kolPollSeconds: num("KOL_POLL_SECONDS", 60),
  /** broad X searches ("ear on the street"), separated by "|" ; empty disables. Each poll of each query costs ~15–300 credits on twitterapi.io */
  xListenQueries: str(
    "X_LISTEN_QUERIES",
    [
      "(pump.fun OR pumpfun OR #pumpfun) -filter:retweets",
      '(memecoin OR #memecoin OR "meme coin") (solana OR $SOL OR #solana) -filter:retweets',
      '("stealth launch" OR "launching soon" OR "CA soon" OR "CA drop" OR "dev doxxed" OR "fair launch") (solana OR pump OR $SOL) -filter:retweets',
      '(trenches OR trenching OR "the trenches") -filter:retweets',
      '("bonding curve" OR "king of the hill" OR "about to graduate" OR "migrating to" OR "graduated to raydium") -filter:retweets',
      '(#solana OR $SOL) (100x OR gem OR runner OR "next runner" OR "send it") -filter:retweets',
    ].join("|"),
  )
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean),
  xListenSeconds: num("X_LISTEN_SECONDS", 120),
  xListenPages: num("X_LISTEN_PAGES", 1),
  /** buzz detection: distinct authors mentioning a $TICKER/#tag within 10 min, at >= 3x its baseline rate */
  buzzMinAuthors: num("BUZZ_MIN_AUTHORS", 5),
  buzzMinLift: num("BUZZ_MIN_LIFT", 3),
  /** PumpSwap (post-graduation) trade stream; empty disables. Its own websocket - use a private RPC if the public one drops. */
  pumpswapWsUrl: str("PUMPSWAP_WS_URL", process.env.SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com"),
  /** kol-signal will not enter tokens above this market cap (SOL) - calls on already-huge coins are not our game */
  kolMaxMcapSol: num("KOL_MAX_MCAP_SOL", 3000),
  /** DexScreener price polling for graduated / externally-called tokens */
  extPriceSeconds: num("EXT_PRICE_SECONDS", 20),

  /** Telegram user-account watcher (gramjs). Create an app at https://my.telegram.org */
  telegramApiId: num("TELEGRAM_API_ID", 0),
  telegramApiHash: str("TELEGRAM_API_HASH"),
  telegramChannelsFile: str("TELEGRAM_CHANNELS_FILE", "channels.txt"),
  /** keep tracking an active token past WATCH_MINUTES, up to this many minutes */
  watchMaxMinutes: num("WATCH_MAX_MINUTES", 360),

  telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
  telegramChatId: str("TELEGRAM_CHAT_ID"),
  /**
   * Send a Telegram message for every per-token signal - operator clusters, buyouts, movements, KOL posts, buzz,
   * paper trades. Off by default, and the default is the point.
   *
   * These alerts were written when this was a trading bot. That thesis is dead (0 of 19,412 curve positions ever
   * reached 5x), so a per-token signal is now research output, not something anyone needs to act on within seconds.
   * At ~1,300 launches an hour they arrive faster than they can be read, and an alert channel that is mostly noise
   * is one nobody looks at - which silently disarms the system alerts sharing it. The channel's job is now: is the
   * collector ingesting, and is the archive still being published.
   */
  alertSignals: str("ALERT_SIGNALS") === "1",
};
