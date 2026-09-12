/**
 * Which Solana programs create token launches, and which only look like they do.
 *
 * WHY A LIST EXISTS AT ALL, when the whole point of the chain-wide scanner is that it needs no list. Because the
 * scanner's strength is also its price: with no launchpad knowledge, "is this a launch" stops being the venue's own
 * declaration and becomes our judgement. A published list turns part of that judgement back into something a reader
 * can check - they can take `LanMV9sAd...` from this file, open Raydium's own program-address documentation, and
 * confirm we labelled it correctly. No trust required.
 *
 * WHY IT IS NOT THE ONLY MECHANISM. A list of programs we already know finds only the launchpads we already know,
 * which is the treadmill the chain-wide layer exists to get off. `research/venueshare.ts` refuses to take a
 * candidate list for exactly this reason. So the list and the heuristic answer different questions, and the record
 * carries both separately:
 *
 *   program            which program created this mint          a FACT, recorded on every row
 *   on this list       we have identified that program          a FACT, and this file is the evidence
 *   looks_like_launch  our threshold, published on /method.html  a JUDGEMENT
 *
 * NON-LAUNCH PROGRAMS ARE LISTED TOO, and that is not padding. Most token creations on Solana are LP tokens,
 * position NFTs and prediction-market outcomes; naming them is what stops the same programs being re-investigated
 * every time someone reads the raw ranking and sees an unfamiliar address at the top. `BopTVfs` led one sample at
 * 49.3% and creates nothing but supply-zero mints.
 *
 * EVERY ENTRY CARRIES ITS SOURCE. An entry without one is a rumour, and this archive has already been wrong twice
 * by attributing behaviour to whichever program appeared outermost in a transaction - once on a trading terminal's
 * vanity address, once on a router mistaken for LaunchLab's own instruction set. `note` records how we know, and
 * `confirmed` when. A program we have seen but not identified belongs in neither list until someone checks it.
 */
export type VenueKind =
  /** Users create new tokens on it. The thing this archive is about. */
  | "launchpad"
  /** A shared bonding-curve engine that other front-ends build on, so one entry covers many brands. */
  | "engine"
  /** Creates token mints that are not launches: LP tokens, position NFTs, outcome tokens, ephemera. */
  | "not-a-launch";

export interface KnownProgram {
  program: string;
  name: string;
  kind: VenueKind;
  /** How we know. A primary source, or a measurement of ours stated as such. */
  note: string;
  /** Link a reader can check for themselves, where a public one exists. */
  source?: string;
  /** When we last confirmed it, ISO date. */
  confirmed: string;
}

export const KNOWN_PROGRAMS: readonly KnownProgram[] = [
  {
    program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    name: "pump.fun",
    kind: "launchpad",
    note: "The venue this archive began with. Its events are decoded directly, not inferred, and every launch "
      + "recorded before 2026-09-11 came from it.",
    source: "https://pump.fun",
    confirmed: "2026-09-11",
  },
  {
    program: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    name: "Raydium LaunchLab",
    kind: "engine",
    note: "Named in Raydium's own program-address documentation and shipped as `raydium_launchpad` in their IDL "
      + "repository. Multi-tenant: 2,231 PlatformConfig accounts are registered against it, each a front-end with "
      + "its own brand and fee split, so one entry covers letsbonk.fun, cook.meme, StonkFun and the rest. Those "
      + "names are permissionless self-asserted strings and are deliberately not published as identity - some "
      + "configs claim to be pump.fun, which does not run on this program. boop.fun was named here until "
      + "2026-09-12 and does not belong: it runs its own program, boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4, "
      + "declared as the address in its own IDL repository and verified executable on chain. It launched "
      + "nothing in any window we sampled, so the error cost no coverage - but a front-end attributed to the "
      + "wrong program is a claim about identity, which is the one thing this page exists to get right.",
    source: "https://docs.raydium.io/reference/program-addresses",
    confirmed: "2026-09-11",
  },
  {
    program: "BcyCjbQYxE2m2xTZ5tTZXDEz8Up7avTmPqhzCrASRKiQ",
    name: "time.fun",
    kind: "launchpad",
    // Listed although it is dead, because this page's own rule is that an absence means we have not identified a
    // program - and this one is identified. A register that lists only what is currently worth watching is a
    // register that quietly rewrites itself as the market moves. Its 893 launches are historical and
    // reconstructible; nothing here is a claim about anybody's conduct.
    note: "Its own Anchor program, established on chain rather than from documentation - there is no published IDL "
      + "anywhere, and the on-chain IDL account is absent, checked against pump.fun and Meteora DBC as controls. "
      + "Not a front-end on either engine: it ran its own curve and graduated into a Raydium CPMM pool, and that "
      + "pool's `pool_creator` is time.fun's own admin wallet. Quoted in USDC with a 37,500 USDC curve target, so "
      + "no SOL figure applies to any launch on it. A companion program sits at "
      + "CvejZauwmDWzNqwhPhPDUetP1ZwCPPpSQ5we2KVf6o3e. DEAD: shutdown announced 2025-11-05, no launch after "
      + "2025-11-17, last successful program transaction 2026-03-13, front end no longer resolving as of "
      + "2026-09-12. 893 markets over its life. This archive never watched it, so it holds no launch from it - "
      + "which is what an absence on this list would otherwise have implied the opposite of.",
    confirmed: "2026-09-12",
  },
  {
    program: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    name: "Meteora Dynamic Bonding Curve",
    kind: "engine",
    note: "Declared as the mainnet program id in MeteoraAg's own Anchor.toml. Infrastructure rather than a "
      + "launchpad - Meteora ships no consumer front-end on it - with 494,724 PoolConfig accounts and 574 partner "
      + "records. Emits no `Program data:` logs at all, using Anchor emit_cpi! exclusively, so a log-reading "
      + "collector sees nothing from it.",
    source: "https://github.com/MeteoraAg/dynamic-bonding-curve/blob/main/Anchor.toml",
    confirmed: "2026-09-11",
  },
  {
    program: "BopTVfs428fBBX2vf28FgdAjzX5F8vAhsaG3SrCs4rHm",
    name: "unidentified issuer of supply-zero mints",
    kind: "not-a-launch",
    note: "Led one 596-block sample at 49.3% of all token creations and launches nothing: every mint sampled "
      + "carries supply 0, with Token-2022 permanent-delegate and mint-close-authority extensions, and the "
      + "accounts are closed in the same transactions. We have not identified the product and do not guess.",
    confirmed: "2026-09-11",
  },
  {
    program: "prediCtPZCttYMvm2W3PtxmMxLmT1dtN7riU6Cxh6tM",
    name: "prediction market",
    kind: "not-a-launch",
    note: "Mints outcome tokens, which are positions in a market rather than launched tokens. Every mint sampled "
      + "carried supply 0.",
    confirmed: "2026-09-11",
  },
  {
    program: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    name: "Meteora CP-AMM",
    kind: "not-a-launch",
    note: "Mints liquidity-pool tokens at 0 decimals. A pool is created because a launch graduated into it; the "
      + "pool token is not itself a launch.",
    confirmed: "2026-09-11",
  },
  {
    program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    name: "Raydium CLMM",
    kind: "not-a-launch",
    note: "Mints position NFTs at 0 decimals, one per liquidity position.",
    confirmed: "2026-09-11",
  },
  {
    program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    name: "Orca Whirlpools",
    kind: "not-a-launch",
    note: "Mints position NFTs at 0 decimals, one per liquidity position.",
    confirmed: "2026-09-11",
  },
  {
    program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    name: "PumpSwap AMM",
    kind: "not-a-launch",
    note: "pump.fun's own AMM. Mints pool tokens for launches that have graduated off the curve.",
    confirmed: "2026-09-11",
  },
  {
    program: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
    name: "Metaplex Token Metadata",
    kind: "not-a-launch",
    note: "Not a venue at all. It appears as the outermost program in some creation transactions and is an "
      + "attribution artefact rather than a launchpad - the reason this archive labels the creating program and "
      + "never treats that label as identity.",
    source: "https://developers.metaplex.com/token-metadata",
    confirmed: "2026-09-11",
  },
];

const BY_PROGRAM = new Map(KNOWN_PROGRAMS.map((p) => [p.program, p]));

/** What we know about the program that created a mint, or undefined if we have not identified it. */
export const knownProgram = (program: string | null | undefined): KnownProgram | undefined =>
  program ? BY_PROGRAM.get(program) : undefined;

/**
 * Does this program create launches? `undefined` for a program we have not identified, which is a third answer and
 * must not collapse into `false`: an unidentified program is not a statement that it launches nothing.
 */
export function createsLaunches(program: string | null | undefined): boolean | undefined {
  const k = knownProgram(program);
  return k ? k.kind !== "not-a-launch" : undefined;
}

export const launchPrograms = () => KNOWN_PROGRAMS.filter((p) => p.kind !== "not-a-launch");
export const nonLaunchPrograms = () => KNOWN_PROGRAMS.filter((p) => p.kind === "not-a-launch");
