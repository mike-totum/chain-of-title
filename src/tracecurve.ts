/**
 * Who bought out this curve? Decodes the last trades on a token's bonding curve from chain history (archival RPC), names the
 * wallet behind any buy >= 40 SOL, checks it against operator_wallets, and traces its funder (payer of its first incoming SOL).
 *
 *   npm run tracecurve -- <mint> [<mint> ...]
 */
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { decodeTrade } from "./feed/rpc.ts";
import { bondingCurveAddress, rpc } from "./rpc-http.ts";

const ARCHIVAL = /helius|mainnet-beta|quiknode|quicknode|triton|rpcpool|alchemy/i;
const db = openDb(config.dbPath);
const iso = (s: number) => new Date(s * 1000).toISOString().slice(5, 16).replace("T", " ");

async function funderOf(wallet: string): Promise<{ funder: string | null; at: string | null; txs: number } | null> {
  let before: string | undefined, last: any[] = [], total = 0;
  for (let p = 0; p < 15; p++) {
    const r: any[] = await rpc("getSignaturesForAddress", [wallet, { limit: 1000, ...(before ? { before } : {}) }], 30_000, ARCHIVAL);
    total += r.length;
    if (r.length) last = r;
    if (r.length < 1000) break;
    before = r[r.length - 1].signature;
    if (p === 14) return { funder: null, at: null, txs: total };
  }
  for (const s of last.filter((x) => !x.err).reverse().slice(0, 3)) {
    const t: any = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], 30_000, ARCHIVAL);
    if (!t) continue;
    const keys: string[] = t.transaction.message.accountKeys.map((k: any) => k.pubkey);
    const i = keys.indexOf(wallet);
    const mine = i >= 0 ? (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9 : 0;
    if (mine > 0 && keys[0] !== wallet) return { funder: keys[0], at: iso(t.blockTime), txs: total };
  }
  return { funder: null, at: null, txs: total };
}

for (const mint of process.argv.slice(2)) {
  const curve = bondingCurveAddress(mint);
  const row = db.prepare(`SELECT symbol, name, datetime(created_at/1000,'unixepoch') created, dev_pct, unique_buyers FROM tokens WHERE mint = ?`).get(mint) as any;
  console.log(`\n${row?.symbol ?? "?"} ${mint} (${row?.name ?? "not in tokens"}; created ${row?.created ?? "?"}, dev ${row?.dev_pct?.toFixed?.(1) ?? "?"} %, ${row?.unique_buyers ?? "?"} curve buyers seen)`);
  const sigs: any[] = await rpc("getSignaturesForAddress", [curve, { limit: 300 }], 30_000, ARCHIVAL);
  const ok = sigs.filter((s) => !s.err);
  console.log(`  curve ${curve}: ${sigs.length} recent txs (${sigs.length - ok.length} failed)`);
  const big: { wallet: string; sol: number; when: string; vSol: number }[] = [];
  let shown = 0;
  for (const s of ok.slice(0, 40)) {
    const tx: any = await rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0 }], 30_000, ARCHIVAL);
    for (const l of tx?.meta?.logMessages ?? []) {
      if (!l.startsWith("Program data: ")) continue;
      const t = decodeTrade(Buffer.from(l.slice(14), "base64"));
      if (!t || t.mint !== mint) continue;
      if (shown++ < 8) console.log(`  ${iso(tx.blockTime)} ${t.isBuy ? "BUY " : "SELL"} ${t.solAmount.toFixed(2).padStart(7)} SOL  ${t.user}  vSol→${t.vSol.toFixed(1)}`);
      if (t.isBuy && t.solAmount >= 40) big.push({ wallet: t.user, sol: t.solAmount, when: iso(tx.blockTime), vSol: t.vSol });
    }
    if (big.length && shown >= 8) break;
  }
  for (const b of big) {
    const known = db.prepare(`SELECT cluster, role, funder FROM operator_wallets WHERE wallet = ?`).get(b.wallet) as any;
    console.log(`  BUYOUT ${b.sol.toFixed(1)} SOL at ${b.when} by ${b.wallet} → ${known ? `KNOWN cluster ${known.cluster} (${known.role})` : "not in operator_wallets"}`);
    if (!known) {
      const f = await funderOf(b.wallet);
      if (f) {
        const kf = f.funder ? (db.prepare(`SELECT funder, parent FROM operator_funders WHERE funder = ?`).get(f.funder) as any) : null;
        console.log(`  wallet has ${f.txs}${f.txs >= 15000 ? "+" : ""} txs; funder ${f.funder ?? "unknown"}${f.at ? ` (seeded ${f.at})` : ""} → ${kf ? "KNOWN funder" : "new funder"}`);
        db.prepare(`INSERT OR IGNORE INTO operator_wallets (wallet, funder, cluster, role, source_mint, traced, added_at) VALUES (?,?,?,?,?,?,?)`).run(b.wallet, f.funder, f.funder ? f.funder.slice(0, 6) : null, "buyout", mint, f.funder ? 1 : 0, Date.now());
        if (f.funder) db.prepare(`INSERT OR IGNORE INTO operator_funders (funder, note) VALUES (?, ?)`).run(f.funder, `tracecurve ${row?.symbol ?? mint.slice(0, 6)}`);
        console.log(`  → added as a buyout seed; the next \`npm run clusters\` enumerates its farm`);
      }
    }
  }
  if (!big.length) console.log("  no buy >= 40 SOL in the last 40 successful curve transactions");
}
