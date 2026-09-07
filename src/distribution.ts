/** After a curve buyout, where did the tokens go? Lists outgoing transfers of <mint> from <wallet> (archival RPC) and the recipients,
 *  and adds unknown recipients to operator_wallets as role 'dump' under <cluster>.
 *   npm run distribution -- <mint> <buyout-wallet> <cluster> [hours-after=24] */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { rpc } from "./rpc-http.ts";
const ARCHIVAL = /helius|mainnet-beta|quiknode|quicknode|triton|rpcpool|alchemy/i;
const [mint, wallet, cluster, hoursArg] = process.argv.slice(2);
const hours = Number(hoursArg || 24);
const db = openDb(config.dbPath);
const bt = (db.prepare(`SELECT MIN(ts) t FROM trades WHERE mint = ? AND wallet = ? AND side = 'buy' AND sol >= 40`).get(mint, wallet) as any)?.t
  ?? (db.prepare(`SELECT MIN(ts) t FROM hist_trades WHERE mint = ? AND wallet = ? AND side = 'buy' AND sol >= 40`).get(mint, wallet) as any)?.t;
const since = bt ? bt / 1000 - 600 : Date.now() / 1000 - hours * 3600, until = since + hours * 3600 + 600;
console.log(`buyout ${bt ? new Date(bt).toISOString().slice(0, 16) : "unknown"}; scanning ${wallet.slice(0, 8)} ${new Date(since * 1000).toISOString().slice(0, 16)} → ${new Date(until * 1000).toISOString().slice(0, 16)}`);
const sigs: any[] = [];
let before: string | undefined;
for (let p = 0; p < 30; p++) {
  const r: any[] = await rpc("getSignaturesForAddress", [wallet, { limit: 1000, ...(before ? { before } : {}) }], 30_000, ARCHIVAL);
  sigs.push(...r.filter((s) => !s.err && s.blockTime >= since && s.blockTime <= until));
  if (r.length < 1000 || r[r.length - 1].blockTime < since) break;
  before = r[r.length - 1].signature;
}
console.log(`${sigs.length} transactions in window; decoding token balance changes`);
const out = new Map<string, { tokens: number; at: number }>();
let cursor = 0;
const work = async () => {
  for (;;) {
    const i = cursor++;
    if (i >= sigs.length) return;
    let tx: any = null;
    try { tx = await rpc("getTransaction", [sigs[i].signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 30_000, ARCHIVAL); } catch {}
    if (!tx) continue;
    const pre = new Map<string, number>(), post = new Map<string, number>();
    for (const b of tx.meta?.preTokenBalances ?? []) if (b.mint === mint) pre.set(b.owner, Number(b.uiTokenAmount?.uiAmount ?? 0));
    for (const b of tx.meta?.postTokenBalances ?? []) if (b.mint === mint) post.set(b.owner, Number(b.uiTokenAmount?.uiAmount ?? 0));
    const mine = (post.get(wallet) ?? 0) - (pre.get(wallet) ?? 0);
    if (mine >= 0) continue;
    for (const [owner, p] of post) {
      const d = p - (pre.get(owner) ?? 0);
      if (owner !== wallet && d > 0) { const o = out.get(owner) ?? { tokens: 0, at: tx.blockTime }; o.tokens += d; o.at = Math.min(o.at, tx.blockTime); out.set(owner, o); }
    }
  }
};
await Promise.all(Array.from({ length: 5 }, work));
const known = (w: string) => db.prepare(`SELECT cluster, role FROM operator_wallets WHERE wallet = ?`).get(w) as any;
const rows = [...out].sort((a, b) => b[1].tokens - a[1].tokens);
console.log(`\n${rows.length} recipients of ${mint.slice(0, 6)} tokens from the buyout wallet, ${(rows.reduce((s, r) => s + r[1].tokens, 0) / 1e6).toFixed(1)} M tokens in total`);
console.log("recipient                                     tokens (M)  received          known");
let added = 0;
for (const [w, o] of rows.slice(0, 40)) {
  const k = known(w);
  console.log(`${w}  ${(o.tokens / 1e6).toFixed(1).padStart(9)}  ${new Date(o.at * 1000).toISOString().slice(5, 16)}  ${k ? `${k.cluster} (${k.role})` : "-"}`);
  if (!k && cluster) { db.prepare(`INSERT OR IGNORE INTO operator_wallets (wallet, funder, cluster, role, source_mint, traced, added_at) VALUES (?,?,?,?,?,?,?)`).run(w, null, cluster, "dump", mint, 0, Date.now()); added++; }
}
if (cluster) console.log(`added ${added} recipients to operator_wallets as ${cluster} / dump`);
