/**
 * Every token launch on Solana, without knowing a single launchpad.
 *
 *   npx tsx research/chainlaunches.ts [blocks] [workers]
 *
 * WHY THIS EXISTS. The archive is built on per-venue decoders: pump.fun's event layout, then LaunchLab's, then
 * whatever launches next. That covers 46% of launch mints today and permanently chases the rest. It also makes the
 * findings unciteable as market facts - "of pump.fun launches" is a statement about one company's platform, not
 * about Solana, and a register cannot benchmark a market it only partly observes.
 *
 * The premise being tested is that most of what this archive publishes is not venue-specific at all. A bonding
 * curve is a program's invention, but a creator holding 79% of the supply after the first block is a fact about
 * token balances, and token balances are the chain's own accounting. Measured against 8 pump.fun launches decoded
 * both ways, the balance method reproduced `dev_pct` exactly - 5.10 against 5.10, 3.42 against 3.42 - with no
 * knowledge of the program that created them.
 *
 * WHAT THIS READS, AND WHAT IT REFUSES TO GUESS.
 *   mint          the initializeMint / initializeMint2 instruction, from the SPL token program
 *   creator       the fee payer, which is the wallet that paid to bring the token into existence
 *   supply        minted in this transaction, summed from postTokenBalances
 *   creatorShare  what the fee payer held when the transaction ended, over that supply
 *   holders       every distinct owner holding a balance at the end of the first block - bundling, before anyone
 *                 outside could have seen the token exist
 *   program       the outermost non-infrastructure program, for labelling only, NEVER for identity. Attribution by
 *                 outermost program has produced a wrong answer twice here: the Axiom vanity address in the funder
 *                 tracer, and a terminal router mistaken for LaunchLab's instruction set.
 *
 * Time to complete a curve is deliberately absent. Completion is a program's own concept and there is nothing at
 * chain level that means it; inferring one would be this archive publishing a guess as a reading.
 *
 * THE COST QUESTION THIS MEASURES. A venue feed is a filtered websocket and nearly free. This has to read every
 * block, so the number that decides whether it is viable is blocks per second against the ~2.5 the chain produces.
 * That is printed at the end and is the actual output of this script; the launches are a sanity check on it.
 */
import { rpc, base58Decode } from "../src/rpc-http.ts";

const BLOCKS = Number(process.argv[2] ?? 300);
const WORKERS = Number(process.argv[3] ?? 4);

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
/** Present in nearly every transaction and launching nothing. Labelling only. */
const BORING = new Set([
  ...TOKEN_PROGRAMS,
  "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
]);

/**
 * Does this mint look like a token launch, as opposed to an LP token, a position NFT, a prediction-market outcome
 * or an ephemeral mint that holds nothing?
 *
 * MEASURED, NOT ASSUMED. Over 392 blocks and 433 mints, labelled by the program that created them - pump.fun,
 * LaunchLab and Meteora DBC as launches; Raydium CLMM, Orca, Meteora CP-AMM, PumpSwap, a prediction market and the
 * supply-zero BopTVfs issuer as not:
 *
 *   supply > 0                     keeps 105/109 launches, admits  29/317 non-launches
 *   decimals >= 6                  keeps 101/109 launches, admits 294/317 non-launches
 *   supply > 0 && decimals >= 6    keeps  97/109 launches, admits   6/317 non-launches
 *
 * A CLASSIFIER, NOT A FILTER, and that distinction is the point. It would be easy to drop everything this returns
 * false for at ingest, and it would repeat the mistake `graduated` already cost a correction for: an observation
 * overwritten by a judgement, with no way to tell later that the judgement was wrong. The 12 launches this misses
 * are mostly mints whose tokens are minted in a LATER transaction, which is a real pattern and not a non-launch.
 * So every mint is recorded with the attributes the predicate reads, the predicate is published beside them, and a
 * reader who disagrees with the threshold can recompute from the same file.
 *
 * `false` here means "this does not look like a launch", never "this is not one".
 */
export const looksLikeLaunch = (l: Pick<ChainLaunch, "supply" | "decimals">): boolean =>
  l.supply > 0 && l.decimals >= 6;

export interface ChainLaunch {
  mint: string;
  creator: string;
  /** From the initializeMint instruction. Read rather than assumed: it scales every amount for this mint. */
  decimals: number;
  slot: number;
  blockTime: number | null;
  supply: number;
  creatorShare: number | null;
  holders: number;
  program: string | null;
  signature: string;
}

const isMintInit = (ix: any): boolean => {
  const t = ix?.parsed?.type;
  return (t === "initializeMint" || t === "initializeMint2") && TOKEN_PROGRAMS.has(ix.programId);
};

/** Every launch in one block, decoded from balances rather than from any program's events. */
export function launchesInBlock(b: any, slot: number): ChainLaunch[] {
  const out: ChainLaunch[] = [];
  for (const tx of b?.transactions ?? []) {
    if (tx.meta?.err) continue;
    const ixs = [
      ...(tx.transaction?.message?.instructions ?? []),
      ...(tx.meta?.innerInstructions ?? []).flatMap((g: any) => g.instructions ?? []),
    ];
    const minted = ixs.filter(isMintInit).map((ix: any) => ({
      mint: ix.parsed.info.mint as string, decimals: Number(ix.parsed.info.decimals ?? -1) }));
    if (!minted.length) continue;
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const payer = typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey;
    if (!payer) continue;
    // Label only. See the header: outermost-program attribution catches routers, not venues.
    const program = ixs.map((ix: any) => ix.programId).find((p: string) => p && !BORING.has(p)) ?? null;

    for (const { mint, decimals } of minted) {
      const post = (tx.meta?.postTokenBalances ?? []).filter((x: any) => x.mint === mint);
      const supply = post.reduce((s: number, x: any) => s + Number(x.uiTokenAmount.amount ?? 0), 0);
      const held = post.filter((x: any) => x.owner === payer)
        .reduce((s: number, x: any) => s + Number(x.uiTokenAmount.amount ?? 0), 0);
      const owners = new Set(post.filter((x: any) => Number(x.uiTokenAmount.amount ?? 0) > 0).map((x: any) => x.owner));
      out.push({
        mint, creator: payer, decimals, slot, blockTime: b.blockTime ?? null, supply,
        // Null, not zero. A transaction that minted nothing measurable has no share to report, and a zero here
        // would read as "the creator kept none of it" - a finding rather than a gap.
        creatorShare: supply > 0 ? held / supply : null,
        holders: owners.size, program, signature: tx.transaction?.signatures?.[0] ?? "",
      });
    }
  }
  return out;
}

(async () => {
  const head = Number(await rpc("getSlot", [{ commitment: "confirmed" }]));
  console.log(`scanning ${BLOCKS} blocks back from ${head.toLocaleString()} with ${WORKERS} workers\n`);
  const started = Date.now();
  const all: ChainLaunch[] = [];
  let read = 0, missing = 0, cursor = 0;

  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= BLOCKS) return;
      const slot = head - i;
      const b: any = await rpc("getBlock", [slot, {
        encoding: "jsonParsed", transactionDetails: "full", rewards: false,
        maxSupportedTransactionVersion: 0, commitment: "confirmed",
      }], 30_000).catch(() => null);
      if (!b?.transactions) { missing++; continue; }
      read++;
      all.push(...launchesInBlock(b, slot));
      if (read % 50 === 0) {
        const bps = read / ((Date.now() - started) / 1000);
        process.stdout.write(`  ${read}/${BLOCKS} blocks, ${all.length} launches, ${bps.toFixed(2)} blocks/s\n`);
      }
    }
  }));

  const secs = (Date.now() - started) / 1000;
  const bps = read / secs;
  const byProgram = new Map<string, number>();
  for (const l of all) byProgram.set(l.program ?? "(none)", (byProgram.get(l.program ?? "(none)") ?? 0) + 1);

  console.log(`\n${read} blocks read, ${missing} unavailable, ${all.length} launches, ${secs.toFixed(1)}s\n`);
  console.log(`launching programs seen (label only, not identity):`);
  for (const [p, c] of [...byProgram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(`  ${String(c).padStart(4)}  ${p}`);

  const launches = all.filter(looksLikeLaunch);
  console.log(`\n${launches.length} of ${all.length} mints look like launches (supply > 0 and at least 6 decimals);`);
  console.log(`the rest are recorded too - the predicate is published beside them, not applied as a filter.`);
  const withShare = launches.filter((l) => l.creatorShare !== null);
  const heavy = withShare.filter((l) => l.creatorShare! >= 0.2).length;
  console.log(`\ncreator share was computable for ${withShare.length} of ${launches.length} launches`);
  if (withShare.length)
    console.log(`  ${heavy} of ${withShare.length} (${(100 * heavy / withShare.length).toFixed(1)}%) kept 20% or more of supply in the first block`);
  console.log(`  median distinct holders at end of first block: ${
    launches.length ? launches.map((l) => l.holders).sort((a, b) => a - b)[Math.floor(launches.length / 2)] : 0}`);

  /**
   * The decision this script exists to inform. Solana produces roughly 2.5 blocks a second, so keeping up means
   * sustaining that. Falling behind is not fatal - the archive would lag rather than lose anything, because blocks
   * stay readable - but it decides whether this runs on a free endpoint or needs paid throughput.
   */
  console.log(`\n=== ${bps.toFixed(2)} blocks/s against a chain producing ~2.5/s ` +
    `-> ${bps >= 2.5 ? "KEEPS UP" : `${(2.5 / bps).toFixed(1)}x short, needs ${Math.ceil(WORKERS * 2.5 / bps)} workers or paid throughput`} ===`);
})();
