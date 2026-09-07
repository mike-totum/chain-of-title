/** who sold a PumpSwap pool down: decode the pool's transactions over a window (archival RPC) and list the largest sellers, flagging operator wallets.
 *   npm run poolsells -- <mint> <pool> [hours=12]                       # the last N hours
 *   npm run poolsells -- <mint> <pool> 2026-09-04T00:00 2026-09-04T03:00  # an explicit UTC window */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { decodeAmmTrade } from "./feed/pumpswap.ts";
import { rpc } from "./rpc-http.ts";
const ARCHIVAL = /helius|mainnet-beta|quiknode|quicknode|triton|rpcpool|alchemy/i;
const [mint, pool, a3, a4] = process.argv.slice(2);
const db = openDb(config.dbPath);
const isIso = (x?: string) => !!x && /^\d{4}-\d{2}-\d{2}/.test(x);
const until = isIso(a4) ? Date.parse(a4 + (a4.length <= 16 ? ":00Z" : "")) / 1000 : Date.now() / 1000;
const since = isIso(a3) ? Date.parse(a3 + (a3.length <= 16 ? ":00Z" : "")) / 1000 : until - Number(a3 || 12) * 3600;
const hours = (until - since) / 3600;
const sigs: any[] = [];
let before: string | undefined;
for (let p = 0; p < 40; p++) {
  const r: any[] = await rpc("getSignaturesForAddress", [pool, { limit: 1000, ...(before ? { before } : {}) }], 30_000, ARCHIVAL);
  sigs.push(...r.filter((s) => !s.err && s.blockTime >= since && s.blockTime <= until));
  if (r.length < 1000 || r[r.length - 1].blockTime < since) break;
  before = r[r.length - 1].signature;
}
console.log(`${sigs.length} successful pool txs in ${hours.toFixed(1)} h (${new Date(since * 1000).toISOString().slice(0, 16)} → ${new Date(until * 1000).toISOString().slice(0, 16)}); decoding`);
const byWallet = new Map<string, { buy: number; sell: number; firstSell: number | null; lastSell: number | null }>();
const hourly = new Map<string, { buy: number; sell: number; px: number }>();
let cursor = 0, done = 0;
const work = async () => {
  for (;;) {
    const i = cursor++;
    if (i >= sigs.length) return;
    let tx: any = null;
    try { tx = await rpc("getTransaction", [sigs[i].signature, { encoding: "json", maxSupportedTransactionVersion: 0 }], 30_000, ARCHIVAL); } catch {}
    if (++done % 1000 === 0) console.log(`  ${done}/${sigs.length}`);
    for (const l of tx?.meta?.logMessages ?? []) {
      if (!l.startsWith("Program data: ")) continue;
      const t = decodeAmmTrade(Buffer.from(l.slice(14), "base64"));
      if (!t || t.pool !== pool || !(t.quoteSol > 0 && t.quoteSol < 5000)) continue;
      const w = byWallet.get(t.user) ?? { buy: 0, sell: 0, firstSell: null, lastSell: null };
      if (t.side === "buy") w.buy += t.quoteSol; else { w.sell += t.quoteSol; w.firstSell = Math.min(w.firstSell ?? tx.blockTime, tx.blockTime); w.lastSell = Math.max(w.lastSell ?? tx.blockTime, tx.blockTime); }
      byWallet.set(t.user, w);
      const h = new Date(tx.blockTime * 1000).toISOString().slice(5, 13);
      const a = hourly.get(h) ?? { buy: 0, sell: 0, px: t.price };
      if (t.side === "buy") a.buy += t.quoteSol; else a.sell += t.quoteSol;
      a.px = t.price; hourly.set(h, a);
    }
  }
};
await Promise.all(Array.from({ length: 5 }, work));
const known = (w: string) => (db.prepare(`SELECT cluster FROM operator_wallets WHERE wallet = ?`).get(w) as any)?.cluster ?? null;
console.log("\nhour        buy SOL   sell SOL  last price");
for (const [h, a] of [...hourly].sort()) console.log(`${h}  ${a.buy.toFixed(0).padStart(8)}  ${a.sell.toFixed(0).padStart(8)}  ${a.px.toExponential(2)}`);
const sellers = [...byWallet].filter(([, w]) => w.sell >= 5).sort((a, b) => b[1].sell - a[1].sell).slice(0, 25);
console.log("\ntop sellers (>= 5 SOL)              sold    bought  first sell        last sell         cluster");
for (const [w, x] of sellers) console.log(`${w}  ${x.sell.toFixed(1).padStart(7)}  ${x.buy.toFixed(1).padStart(7)}  ${new Date(x.firstSell! * 1000).toISOString().slice(5, 16)}  ${new Date(x.lastSell! * 1000).toISOString().slice(5, 16)}  ${known(w) ?? "-"}`);
const opSold = [...byWallet].filter(([w]) => known(w)).reduce((s, [, w]) => s + w.sell, 0), opBought = [...byWallet].filter(([w]) => known(w)).reduce((s, [, w]) => s + w.buy, 0);
const allSold = [...byWallet.values()].reduce((s, w) => s + w.sell, 0);
console.log(`\noperator wallets: bought ${opBought.toFixed(0)} SOL, sold ${opSold.toFixed(0)} SOL of ${allSold.toFixed(0)} SOL total sold (${(100 * opSold / Math.max(allSold, 1)).toFixed(0)} %)`);
