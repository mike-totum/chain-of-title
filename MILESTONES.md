# Milestones

What this project has committed to build, in order, with a test for each that someone
outside it can run. Every acceptance criterion below is checkable against the public site,
the public API, or this repository. Nothing here is satisfied by a status update.

Durations are working time for one maintainer. Dates are omitted deliberately: the sequence
is fixed, the calendar is not, and a milestone list with invented dates is worth less than
one with honest dependencies.

**Status as of 2026-09-07.**

---

## M0. The record, and the discipline around it

**Done.** This is the baseline everything else is built on, and it is already public.

- A collector decoding pump.fun program events and recording, for every launch: creator,
  creator share of supply in the creation transaction, distinct outside wallets buying on the
  bonding curve, time to fill, single-buy curve buyouts, and whether the creator sold.
- ~143,000 launches recorded from creation. 20,000 to 34,000 arriving per day.
- Criteria in one place (`src/provenance.ts`), executed by the site, the API and the validator
  alike, so no consumer can quietly disagree with another.
- A labelled-set validator (`npm run labels`) built on creator-wallet reuse, an axis none of
  the criteria read. Two-sided: it fails on a false clean, and it also fails if the criteria
  certify nobody.
- Coverage published as data. A launch outside a recorded run interval is reported as
  unobserved, never as clean.

**Verify:** clone, `npm install`, `npm run labels`. It exits non-zero on any known-manufactured
token certified clean.

---

## M1. Say only what is confirmed, and publish a route to be told otherwise

**In progress.** Roughly one week.

Provenance claims must be traceable to an observation, and a project that publishes adverse
findings needs a working way to be contradicted before it publishes more of them.

- Every completion claim gated on confirmation from the curve account or a market, never on a
  threshold crossed in our own feed. `graduated_confirmed_by` records which. **Done.**
- Coverage measured by ingestion rather than process liveness, so a collector that is running
  and receiving nothing writes a truthful gap. **Done.**
- A published corrections policy: an address, a stated turnaround, an append-only amendment
  note, and a right of reply for any wallet controller who signs a message from that address.
- A published funding pledge: the record stays free and CC0; no revenue ever depends on routing
  a reader into a trade; no subject of a record is ever a customer.
- The clean criteria published with their sensitivity, so a reader can see what moves the
  threshold and what does not.

**Verify:** `/corrections` and `/pledge` resolve; a token whose graduation is unconfirmed shows
no claim about how its curve filled.

---

## M2. Coverage back to the beginning

**Not started.** Roughly two weeks. Depends on archival RPC.

Live coverage begins 2026-09-02. Every launch older than that currently answers "unobserved",
which is honest and not useful. A bonding curve's whole transaction history is bounded and
readable on an archival endpoint, so the record can be rebuilt for any launch of any age.

- On-demand reconstruction as a persisted, cached path rather than a command: a mint nobody
  has asked about before is rebuilt, stored, and served.
- Reconstruction marked as reconstruction. A rebuilt record is never presented as a watched
  one, and an incomplete rebuild certifies nothing.
- Batched transaction fetching, so a rebuild is bounded by RPC throughput rather than by a
  per-request pace.

**Verify:** request a pump.fun mint that launched before 2026-09-02 and receive a complete
launch record, labelled as reconstructed, with the counts it was built from.

---

## M3. Make the archive citable and hard to lose

**Partly done.** The deposit and identifier are live; the API work remains. Roughly half a week left.

The record currently exists in two places. A public good that can be lost with one laptop is
not yet public infrastructure.

- Versioned releases of the record database, deposited with a persistent identifier, mirrored
  independently of any infrastructure this project controls. **Done 2026-09-07:** `doi:10.57967/hf/10338`,
  resolving to https://huggingface.co/datasets/chainoftitle/chain-of-title. Permanent by construction:
  the deposit cannot be renamed, withdrawn or made private.
- A data dictionary and a stated schema, so the file is usable without reading the code.
- A public API with a batch endpoint, keyless and rate-limited rather than gated, so a wallet
  or an explorer can check many mints in one call.
- A published build hash for each release, so a reader can tell which version produced a
  figure they are quoting.

**Verify:** the dataset resolves from its DOI, downloads from a mirror this project does not
run, and the API answers a batch of 100 mints in one request.

---

## M4. A second venue, and the operator record

**Not started.** Roughly two weeks.

The record format is already venue-neutral (`tokens.venue`, published in the API). A second
Solana launchpad proves that and turns a tool into an index. The operator record is sequenced
last on purpose: naming wallets is the highest-liability thing here and it should ship only
after the corrections route from M1 has been running.

- A second Solana launch venue indexed end to end, using the same record and the same criteria.
- Operator pages describing observed conduct only: what a wallet did, with the transactions.
  Never an assertion of intent, never a claim about who controls an address.
- Cluster attribution published with its method described and its thresholds withheld, since
  attribution is defeated by a single fresh funding wallet in a way that criteria are not.

**Verify:** a launch on the second venue returns a record in the same shape as a pump.fun one,
and every sentence on an operator page names a transaction.

---

## What is deliberately not on this list

**Charging readers.** The record is free and CC0 permanently. See the pledge.

**Any revenue that depends on a reader transacting.** No affiliate links, no referral
kickbacks, no order flow, no buy button. This is the largest revenue line available to a site
in this category and it is refused in writing so that accepting it later would be a visible
breach rather than a quiet change.

**Predictions.** This project records what a token was at birth. It does not say what one will
be worth, and "launched clean" is not a recommendation to buy anything.

**Chains beyond Solana.** A plausible direction and not a commitment. It will appear here when
there is code behind it.
