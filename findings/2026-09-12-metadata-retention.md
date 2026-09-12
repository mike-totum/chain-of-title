# Launch metadata is not uniformly durable: one host stops serving after about two days

**Measured 2026-09-12. Method and figures below; everything here is reproducible from the published record.**

A Solana launch's on-chain record carries a `uri` pointing at an off-chain document — the name, symbol,
description, socials and image the launch declared for itself. The chain keeps the pointer. It does not keep what
the pointer returns.

This is a measurement of how long those documents keep being served, taken across every launch in the record
between 2026-09-02 and 2026-09-12.

## What was measured

330 launches whose document this archive already holds, sampled across every day in the record, re-fetched today
and compared by sha256 against the bytes captured at launch. A document either still returns the same bytes, returns
different bytes, or is no longer served.

Because the denominator is documents *known to have existed* — we hold the bytes — this is a survival rate rather
than an estimate.

Two sampling methods were used and the difference matters. The cross-host comparison draws launches ordered by
mint address, which is a keypair and so is arbitrary with respect to both host and date. The per-day table for
`metadata.j7tracker.io` draws **at random within each day**, because that is the table a conclusion rests on.

## Result: the axis is the host, not the age

| | launches in record | sampled | still served, identical |
|---|---|---|---|
| **IPFS** (`/ipfs/` and `ipfs://` URIs) | 211,977 | 202 | **202 (100%)** |
| `meta.uxento.io` | 16,025 | 275 | **275 (100%)** |
| `m.rapidlaunch.io` | 6,194 | 268 | **268 (100%)** |
| `md.sdfgsdfsdf.uk` | 1,900 | 265 | 264 (99.6%) |
| `metadata.j7tracker.io` | **42,902** | 150 | **57 (38%)** — see below |

Content-addressed documents lost nothing over the ten-day window. Neither did three of the four largest
self-hosting domains. A single aggregate "survival rate" across all hosts would describe none of them.

## `metadata.j7tracker.io`, by launch age

Random sample, 25 launches per day, all of them documents this archive holds:

| launch date | age at measurement | still served |
|---|---|---|
| 2026-09-07 | 5 days | **0 of 25** |
| 2026-09-08 | 4 days | **0 of 25** |
| 2026-09-09 | 3 days | **0 of 25** |
| 2026-09-10 | 2 days | 7 of 25 |
| 2026-09-11 | 1 day | 25 of 25 |
| 2026-09-12 | same day | 25 of 25 |

Requests for the older documents return HTTP 404. The host is reachable and answers promptly throughout; it
answers 404 for launches older than roughly two to three days and serves the document for launches newer than
that.

This host accounts for **42,902 launches — 55% of every self-hosted metadata URI in the record.**

(The denominator is 77,999 self-hosted launches. A first draft of this document said 52% against 82,176, which
wrongly counted 4,177 launches whose URI is the empty string — they declare no document and so have no host. The
figure was corrected before publication; it is recorded here rather than quietly amended because the arithmetic is
checkable and a reader should be able to see which number was wrong.)

## What this archive holds, and what is already unavailable

Of the **32,711** launches on this host created before 2026-09-10 — a fixed cutoff, chosen because every sampled
launch older than it returned 404, rather than a rolling "three days ago" that would make this figure drift:

- **8,797** — the document was captured and is held here.
- **23,914** — the document was not captured, and is no longer served at its source.

The second figure is this archive's own gap, stated plainly: those launches' declared names, descriptions and
image URIs were not retrieved while they were being served, and this measurement finds no route to them now.

## What the record does not say

- **Nothing here is a statement about why.** The observation is an HTTP status code against a URL over time. This
  register records what a request returned and when. It does not infer a purpose, a policy, or an intent, and no
  such inference should be read into the table above.
- **It is not established that the documents were deleted.** What is established is that the host returns 404 for
  them. A document that is not served and a document that does not exist are different facts, and only the first
  was observed.
- **A 404 served only to this requester would look identical.** Against that: the same host served 50 of 50
  requests for launches 0–1 days old in the same minutes, from the same machine, so the behaviour varies with the
  age of the launch rather than with who is asking. That is evidence, not proof.
- **The window is 10 days.** Every launch in the record was created between 2026-09-02 and 2026-09-12, so nothing
  here speaks to survival beyond ten days — including for IPFS and the three stable hosts, whose 100% figures mean
  "lost nothing in ten days" and not "durable".
- **Sample sizes are 150–275 per host**, so a per-host rate carries a few points of uncertainty. The 0-of-75
  result for launches 3–5 days old on one host does not.
- **Two documents changed rather than disappeared.** Both were self-hosted, both one day old, and both on small
  domains outside the five rows above (`metadata.pumper.ink`, `dev.khel.guru`): the bytes returned today differ
  from the bytes captured at launch, and both remain reachable. One now points its `image` at a versioned URL and
  the other has a different `website`. Two out of 330 is not a rate, and it is reported because a document that
  changes is a distinct outcome from one that stops being served — not because two is a finding.

## Reproduction

The record is public and the measurement needs nothing else.

```sh
curl -O https://chainoftitle.org/data/record.db

# the population, by host
sqlite3 record.db "
  SELECT CASE WHEN uri LIKE '%/ipfs/%' OR uri LIKE 'ipfs://%' THEN 'ipfs'
              ELSE substr(uri,1,instr(substr(uri,9),'/')+8) END host,
         COUNT(*) launches, SUM(meta_sha256 IS NOT NULL) held
  FROM tokens WHERE uri IS NOT NULL GROUP BY host ORDER BY launches DESC;"

# pick any launch on a host, fetch its uri, and compare
sqlite3 record.db "SELECT mint, uri, meta_sha256, date(created_at/1000,'unixepoch')
  FROM tokens WHERE uri LIKE 'https://metadata.j7tracker.io/%' AND meta_sha256 IS NOT NULL LIMIT 5;"
curl -s <uri> | shasum -a 256
```

A launch on that host created before 2026-09-10 returns `404` today; one created after it returns the document,
and its sha256 matches the `meta_sha256` in the record.

A launch's held document is served at `https://chainoftitle.org/d/{mint}`, and the full corpus at
`/data/documents.ndjson.gz` with its manifest at `/data/documents.json`.

## Why this was measured

Every on-chain fact about a launch can be rebuilt from an archival node later, at a price. The off-chain document
cannot: it lives behind a URI the launch's creator controls, and nothing on chain preserves its contents. Whether
holding a copy is worth anything therefore depends entirely on how long the original keeps being served — and that
had not been measured.

The answer is that for the 211,977 IPFS-addressed launches (73% of those declaring a document) it currently makes little difference, and for one host covering 42,902
launches the document is unavailable at source within about two days of launch.

---

*Chain of Title. The record is CC0. Corrections to published figures are recorded at /corrections.*
