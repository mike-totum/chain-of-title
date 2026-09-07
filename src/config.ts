import { readFileSync, existsSync } from "node:fs";

// Minimal .env loader (no dependency). Real env vars win over the file.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
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
  /** PumpSwap (post-graduation) trade stream; empty disables. Its own websocket — use a private RPC if the public one drops. */
  pumpswapWsUrl: str("PUMPSWAP_WS_URL", process.env.SOLANA_WS_URL || "wss://api.mainnet-beta.solana.com"),
  /** kol-signal will not enter tokens above this market cap (SOL) — calls on already-huge coins are not our game */
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
};
