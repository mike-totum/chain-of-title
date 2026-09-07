/**
 * Entry rules for the backtester. A rule sees the reconstructed token state at the moment of each
 * trade and returns a reason string to enter (once per token) or null.
 */
export interface BtState {
  ageMs: number;
  price: number;
  launchPrice: number;
  buys: number;
  sells: number;
  buyers: Set<string>;
  buyVolSol: number;
  sellVolSol: number;
  /** distinct non-dev buyers whose first buy landed in the creation slot or the next one */
  sameBlockBuyers: number;
  devPct: number;
  devSold: boolean;
  topHolderPct: number;
  /** distinct buyers in the trailing 60 s */
  buyersLast60s: number;
  medianBuySol: number;
  hasSocials: boolean;
  devSol: number;
  metaHost: string;
  /** creator's earlier launches in the dataset: count and how many they sold on */
  creatorPrior: { launches: number; sold: number; graduated: number };
  /** the trade that just happened */
  last: { wallet: string; side: "buy" | "sell"; sol: number; isDev: boolean; smart: boolean };
  smartBuys: number;
  /** most members of any single wallet team seen among buyers so far */
  teamHits: number;
  signalSeen: boolean;
  graduated: boolean;
}

export interface BtRule {
  name: string;
  group: string;
  /** do not consider entries after this age */
  windowS: number;
  enter(s: BtState): string | null;
}

const KILL_HOSTS = new Set(["metadata.j7tracker.io", "meta.uxento.io", "m.rapidlaunch.io", "pump.mypinata.cloud", "metadata.levitatingbananatree.xyz"]);
const isRound = (sol: number) => sol > 0 && Math.abs(sol * 10 - Math.round(sol * 10)) < 0.005;
/** same kill filters as the live strategies (src/strategies/index.ts) */
export const passesKill = (s: BtState) =>
  !KILL_HOSTS.has(s.metaHost) && !isRound(s.devSol) && !(s.devSol >= 0.5 && s.devSol < 5) && !s.devSold && !(s.ageMs >= 30_000 && s.sells >= s.buys && s.buys > 0);

const clean = (s: BtState, maxDev: number, maxBundle: number, requireSocials: boolean) =>
  !s.devSold && s.devPct <= maxDev && s.sameBlockBuyers <= maxBundle && (!requireSocials || s.hasSocials) && !(s.creatorPrior.launches >= 2 && s.creatorPrior.sold >= s.creatorPrior.launches * 0.6);

export const baseRules: BtRule[] = [
  { name: "baseline:at-create", group: "baseline", windowS: 5, enter: () => "every launch" },
  { name: "filtered-all@30s (kill filters only)", group: "filters-only", windowS: 45, enter: (s) => (s.ageMs >= 30_000 && passesKill(s) ? "passes kill filters" : null) },
  { name: "big-dev-buy (>=5 SOL, not round, kill filters)", group: "filters-only", windowS: 45, enter: (s) => (s.ageMs >= 30_000 && s.devSol >= 5 && passesKill(s) ? "big dev buy" : null) },
  { name: "big-dev-buy + creator momentum", group: "filters-only", windowS: 45, enter: (s) => (s.ageMs >= 30_000 && s.devSol >= 5 && passesKill(s) && s.creatorPrior.graduated >= 1 ? "big dev buy, creator graduated before" : null) },
  { name: "team-wallet (2 members in 60s) + kill filters", group: "wallet", windowS: 60, enter: (s) => (s.teamHits >= 2 && passesKill(s) ? "team" : null) },
  {
    name: "clean-launch@30s",
    group: "filters-only",
    windowS: 60,
    enter: (s) => (s.ageMs >= 30_000 && clean(s, 6, 0, true) ? "no bundle, dev<=6%, socials, creator not a serial seller" : null),
  },
  {
    name: "early-momentum",
    group: "momentum",
    windowS: 60,
    enter: (s) => (clean(s, 6, 2, false) && s.buyers.size >= 8 && s.sells * 3 <= s.buys && s.buyVolSol >= 2 && s.topHolderPct <= 8 ? `buyers=${s.buyers.size}` : null),
  },
  {
    name: "strict-momentum",
    group: "momentum",
    windowS: 120,
    enter: (s) => (clean(s, 4, 2, false) && s.buyers.size >= 15 && s.sells * 4 <= s.buys && s.price >= 1.3 * s.launchPrice && s.topHolderPct <= 6 ? `buyers=${s.buyers.size}` : null),
  },
  {
    name: "organic-accumulation@3m",
    group: "organic",
    windowS: 600,
    enter: (s) =>
      s.ageMs >= 180_000 && clean(s, 8, 1, false) && s.buyers.size >= 12 && s.sells <= 0.3 * s.buys && s.medianBuySol >= 0.1 && s.medianBuySol <= 1.5 && s.buyersLast60s >= 3
        ? `buyers=${s.buyers.size} medianBuy=${s.medianBuySol.toFixed(2)}`
        : null,
  },
  { name: "smart-wallet-buy", group: "wallet", windowS: 600, enter: (s) => (s.last.side === "buy" && s.last.smart && !s.devSold && !s.last.isDev ? "smart wallet bought" : null) },
  { name: "smart-wallet-buy+clean", group: "wallet", windowS: 600, enter: (s) => (s.last.side === "buy" && s.last.smart && clean(s, 8, 1, false) ? "smart wallet bought, clean" : null) },
  { name: "kol-signal", group: "social", windowS: 6 * 3600, enter: (s) => (s.signalSeen ? "channel/account posted it" : null) },
  {
    name: "convergence:clean+(smart|kol)",
    group: "convergence",
    windowS: 3600,
    enter: (s) => (clean(s, 8, 1, false) && (s.smartBuys >= 1 || s.signalSeen) && s.buyers.size >= 5 ? `smart=${s.smartBuys} kol=${s.signalSeen}` : null),
  },
];

/** Parameter sweep: momentum-style rules at fixed evaluation ages. */
export function sweepRules(): BtRule[] {
  const out: BtRule[] = [];
  for (const atS of [30, 60, 180, 300])
    for (const minBuyers of [5, 8, 12, 20])
      for (const maxBundle of [0, 2, 99])
        for (const maxDev of [4, 8, 100])
          for (const socials of [false, true]) {
            const name = `sweep:t=${atS}s b>=${minBuyers} bundle<=${maxBundle === 99 ? "any" : maxBundle} dev<=${maxDev === 100 ? "any" : maxDev + "%"}${socials ? " socials" : ""}`;
            out.push({
              name,
              group: "sweep",
              windowS: atS + 30,
              enter: (s) => (s.ageMs >= atS * 1000 && s.buyers.size >= minBuyers && clean(s, maxDev, maxBundle, socials) && s.sells * 2 <= s.buys ? "sweep" : null),
            });
          }
  return out;
}
