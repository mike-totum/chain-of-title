/**
 * Which programs are actually launching tokens on Solana right now, ranked by volume.
 *
 * The second venue is the most consequential open decision in this project and it was about to be made from an
 * assistant's stale recall of launchpad market share. Launchpad share moves in months; the answer has to come from
 * this week. This measures it.
 *
 * HOW, AND WHY THIS WAY. It samples recent blocks, finds every transaction that initialises an SPL token mint, and
 * attributes it to the outermost non-system program in that transaction - which is the launchpad, because a mint
 * created through a launchpad is created by its program via CPI. No candidate list is supplied, deliberately: a
 * list of programs I already know would find only the launchpads I already know, and the entire point is to
 * discover the ones I do not.
 *
 * WHAT IT IS NOT. A sample of a few hundred blocks over a few minutes is a rate, not a census, and Solana launch
 * activity is bursty and diurnal. Two runs hours apart will disagree at the margin. It is decisive about the shape
 * - one dominant challenger, or a long tail - which is the thing the venue decision actually turns on, because it
 * decides whether "a bunch" means one decoder or several.
 *
 * WHAT IT COUNTS, WHICH IS NOT QUITE WHAT YOU WANT. Every SPL mint initialisation, and a great many of those are
 * not launches: prediction markets mint outcome tokens, AMMs mint LP tokens, NFT programs mint editions. The
 * ranking is therefore an upper bound per program and the non-launchpads have to be recognised and discounted by
 * hand. Filtering to "launchpad-shaped" programs would need a list of launchpads, which is the thing being
 * discovered, so the filtering is left to the reader on purpose.
 *
 * FIRST RUN, 2026-09-11, 400 blocks and 94 mints. The result was not what anyone expected and is the reason this
 * file exists: pump.fun was 8.5%. BopTVfs428fBBX2vf28FgdAjzX5F8vAhsaG3SrCs4rHm was 44.7%, dbcij3LWUppWqq96dh6gJW
 * wBifmcGfLSB5D4DuSMaqN 16.0%, LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj 7.4%. The repo's standing note that
 * pump.fun runs 62-80% of Solana launches is from an earlier period and should not be relied on again without a
 * fresh run. Re-run before any venue decision.
 *
 *   npx tsx research/venueshare.ts [blocks]
 */
import { rpc, base58Decode } from "../src/rpc-http.ts";

const BLOCKS = Number(process.argv[2] ?? 60);

/** Programs that appear in almost every transaction and launch nothing. */
const BORING = new Set([
  "11111111111111111111111111111111",                     // System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",          // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",          // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",         // Associated Token
  "ComputeBudget111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

const isMintInit = (ix: any, keys: string[]) => {
  const p = keys[ix.programIdIndex];
  if (p !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && p !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") return false;
  // InitializeMint = 0, InitializeMint2 = 20. Base58 data, first byte is the discriminator.
  // base58Decode is the repo's own, so this adds no dependency to a research script.
  try {
    const b = base58Decode(ix.data as string);
    return b.length > 0 && (b[0] === 0 || b[0] === 20);
  } catch { return false; }
};

(async () => {
  const slot = Number(await rpc("getSlot", [{ commitment: "confirmed" }]));
  console.log(`sampling ${BLOCKS} blocks back from slot ${slot.toLocaleString()}\n`);

  const counts = new Map<string, number>();
  let mints = 0, scanned = 0, failed = 0;

  for (let i = 0; i < BLOCKS; i++) {
    let b: any;
    try {
      b = await rpc("getBlock", [slot - i, {
        encoding: "json", transactionDetails: "full", rewards: false,
        maxSupportedTransactionVersion: 0, commitment: "confirmed",
      }]);
    } catch { failed++; continue; }
    if (!b?.transactions) { failed++; continue; }
    scanned++;

    for (const tx of b.transactions) {
      if (tx.meta?.err) continue;
      /**
       * Static keys FIRST, then the lookup-table addresses, in that order. This is not a detail.
       *
       * A v0 transaction resolves an instruction's programIdIndex against the static `accountKeys` followed by
       * `meta.loadedAddresses.writable` then `.readonly`. Reading only the static half made `keys[programIdIndex]`
       * undefined for every index past it, so `isMintInit` compared undefined against the token program, returned
       * false, and the whole transaction was skipped in silence.
       *
       * Measured: 12 of 12 recent pump.fun creations use a lookup table, none carries the token program in its
       * static keys, and each has 14 to 31 instruction indices past the end of that array. So this script saw 8
       * pump.fun launches in a window where the collector's own record holds 302 - it was reading 2.6% of them, and
       * only the rare legacy-format transactions. The bias is not noise: venues whose launches are built by bots and
       * terminals use lookup tables and were near-invisible, while programs issuing plain legacy mints were counted
       * in full and rose to the top. The first run's 44.7% leader is one of those, and it is not a launchpad.
       */
      const la = tx.meta?.loadedAddresses;
      const keys: string[] = [
        ...(tx.transaction?.message?.accountKeys ?? []),
        ...(la?.writable ?? []),
        ...(la?.readonly ?? []),
      ];
      const ixs: any[] = tx.transaction?.message?.instructions ?? [];
      const inner = (tx.meta?.innerInstructions ?? []).flatMap((g: any) => g.instructions ?? []);
      if (![...ixs, ...inner].some((ix) => isMintInit(ix, keys))) continue;
      mints++;
      // The launchpad is the outermost program that is not infrastructure. A mint created directly by a wallet
      // through the token program has none, and is counted as such rather than attributed to anything.
      const outer = ixs.map((ix) => keys[ix.programIdIndex]).filter((p) => p && !BORING.has(p));
      const who = outer[0] ?? "(no program: direct mint)";
      counts.set(who, (counts.get(who) ?? 0) + 1);
    }
    if (i % 20 === 19) process.stdout.write(`  ${i + 1}/${BLOCKS} blocks, ${mints} mints so far\n`);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((a, [, n]) => a + n, 0) || 1;
  console.log(`\n${scanned} blocks read (${failed} unavailable), ${mints} token mints found\n`);
  console.log("program                                        mints    share");
  for (const [p, n] of ranked.slice(0, 12)) {
    console.log(`${p.padEnd(46)} ${String(n).padStart(5)}   ${(100 * n / total).toFixed(1)}%`);
  }
  console.log(`\nThe shape matters more than the ranking: one dominant challenger means one decoder,`);
  console.log(`a long tail means the second venue buys less coverage than it looks like it should.`);
})();
