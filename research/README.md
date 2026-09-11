# research/ - the trading thesis, and the code that killed it

Nothing in this directory runs in production. It is kept because it is evidence.

## What this was

This project began as a real-time pump.fun monitor with paper trading. The question was whether launch-time
signals could support a position: enter early, cut losses small, catch the occasional large winner. Ten strategies
were written against that idea and 139 entry/exit rule combinations were swept.

## What it found

It cannot work, and not for want of tuning. Measured over 19,412 bonding-curve positions in September 2026 -
organic launches only, creator share under 50%, at least 30 outside buyers, which is the favourable subset:

| venue | n | reached 2x | reached 5x | avg peak |
|---|---|---|---|---|
| bonding curve, 24 h | 19,412 | 7.6% | **0.0%** | 1.20x |
| post-graduation, 96 h | 116 | 23.3% | 3.4% | 1.79x |

Zero of 19,412 is a proof of impossibility rather than a weak result. Graduation caps the curve near 15x, so any
strategy that pays many small bounded losses to catch one large winner is *required* to fail there. That retro-
explains every negative result in the sweep, all landing at roughly the fee, and it explains why exit tuning never
helped: an average peak of 1.20x against 0.97x realised is the cost of not selling the top, not a fixable leak.

## Why it is still here

The finding is cited on the live site, in the footer of every page. A claim that rests on a measurement should ship
with the instrument that made it, or the claim is just an assertion with a number in it. Deleting this directory
would make the site's own footnote uncheckable.

It is also the reason the project exists in its current form. The instrument built to trade these launches turned
out to be the only thing that could record them, and what it records - the first block, before the float is spread
- is unrecoverable afterwards. The archive is what the failed thesis left behind.

## What runs, and what does not

`strategies/` and `paper.ts` are imported by the collector but produce nothing: `strategies` is an empty array
unless `PAPER=1` is set, and every loop in `PaperBroker` over an empty array is a no-op. They were evaluated on
every launch and every trade inside the ingesting process until 2026-09-11, competing for the one thread whose
only irreplaceable job is ingestion.

Everything else here is a command-line script, run by hand, never on a schedule. `npm run backtest`, `npm run
habits`, `npm run postgrad` and the rest still work and still read the live database.

**None of it places an order, holds a key, or touches a wallet.** There is no execution path in this repository and
never has been: every position in every table here is simulated.
