# The channel archive - what it holds, why, and what has not been decided

`tg_messages` stores every message from the channels in `channels.txt`, whole, as posted. Not the ones that named a
token - all of them. The watcher had been reading them since day one and discarding anything that did not match a
mint, because it was built to trade on them.

**It is never published.** It is not in `servicedb.ts` and must not be added to it. The published record carries what
a *creator* claimed about their *own* launch - the subject's own statement, and often the only surviving evidence of
an impersonation. A channel message is someone else's expression. Most people amplifying a manufactured token were
fooled by it rather than party to it, and printing their words beside a fraud label, in a CC0 file under a DOI that
cannot be withdrawn, would make an accusation this project has no basis to make.

Collect, retain, disclose only on lawful request. That is a dark archive, and it is the standard answer to exactly
this problem.

## What is stored

| column | what it is |
|---|---|
| `channel`, `msg_id` | which channel, and Telegram's own id. Primary key, so a message is stored once |
| `posted_at` | when it was posted, from Telegram |
| `fetched_at` | when we read it. Different question, stored separately, as everywhere else in this schema |
| `sender` | the sender id where Telegram gives one. Channel posts frequently have none |
| `text`, `url` | the message and a link to it |
| `mints`, `cashtags` | our reading of it - derived, and rederivable from `text` |
| `views`, `forwards` | engagement counters. Monotonic: they only ever climb |
| `reply_to`, `edited_at` | thread position, and whether it was edited after posting |

An edit updates `edited_at` and the counters; **it never rewrites the stored text**. What was first posted is the
record. What it was changed to is a second fact about the same message, and conflating them would destroy the only
thing this table is for.

## Why this is worth holding

It is unrecoverable in exactly the way the launch image is. A message exists while it is posted and not afterwards,
there is no archival node that sells it back, and **deletion is itself the event most worth having recorded** - a
promotional channel quietly removing its posts about a token that later collapsed is evidence, and it is evidence
that only exists if someone was watching at the time.

What it is **not** is a classifier. Measured against the 88,133 **X posts** already held (not Telegram messages, of
which this archive has never held more than three - see the note at the end of this file): promoted launches are ~8x more
likely to have graduated, but among graduations the promoted ones are *cleaner* on every launch test - 29.2% had 30+
outside buyers against 12.1% overall, and the average creator share was 8.1% against 19.2%. Promotion tracks
attention, not manufacture. Anyone proposing to build a danger signal on it should read that again first.

## The legal position, which is not settled and is not mine to settle

**This file is not legal advice and nobody here is a lawyer.** It records what has been decided, what has not, and
what a qualified person needs to rule on.

Decided by the owner: collect it, publish none of it, provide it if lawfully asked for.

Not decided, and needing counsel:

1. **Lawful basis.** The likely basis is legitimate interests (GDPR Art 6(1)(f)) - fraud research and archiving - which
   requires a written balancing assessment *before* collection, not after. The public-interest archiving and research
   provisions (Art 89) offer real derogations, but only against documented safeguards: purpose limitation, data
   minimisation, access control. A dark archive fits that shape far better than a published one; it does not exempt
   itself.
2. **Unpublished is not unexposed.** Retained personal data is discoverable and makes us a controller regardless of
   publication. The dark archive removes the irrevocable-DOI problem, which was the sharp one. It does not remove the
   obligation.
3. **Transparency.** Art 14 requires informing people whose data we hold when it was not collected from them, with an
   exemption where that is impossible or disproportionate - an exemption that is read narrowly and expects a public
   notice in its place. We do not have one.
4. **Retention.** `TELEGRAM_RETAIN_DAYS` exists so a decision can be enforced. Unset means keep, which is the
   archival default and the assumption to challenge rather than inherit. Indefinite retention of personal data is the
   hardest position to defend.
5. **Erasure.** There must be a route for someone to ask, and a documented answer - even if the answer is a lawful
   refusal under an archiving derogation.
6. **Jurisdiction.** A US LLC still falls under GDPR where it monitors the behaviour of people in the EU. "We are
   American" is not an answer.

## Operational notes

- **Enabling:** `TELEGRAM_ARCHIVE=1`, plus `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` and a session.
- **A session may run in exactly ONE place.** Running the same string on the laptop and in the cloud produced
  `406: AUTH_KEY_DUPLICATED` on every channel within minutes on 2026-09-09, and Telegram can revoke a duplicated key
  outright - which would kill both copies, not just the second one. The cloud collector holds it; the laptop's
  `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` are commented out for that reason and re-enabling them means unsetting
  `TELEGRAM_SESSION` on the collector first. The failure is visible rather than silent only because a failed poll
  opens a `tg_gaps` row: twenty of them, in one pass, is what surfaced it.
- **The session is an account credential, not an API key.** A gramjs session string is full access to the Telegram
  account that made it. `TELEGRAM_SESSION` sets it as a platform secret so it is never written to disk or baked into
  an image layer; `data/telegram.session` remains the local default that `npm run telegram:login` writes.
- **`channels.txt` and `kols.txt` are gitignored** and stay out of the public repo. They are a watch list, and a
  watch list published is a different document from an archive kept.
- **The X corpus is kept permanently.** Decided by the owner on 2026-09-09: the 88,133 posts already collected are
  never deleted on a timer. `TWEETS_RETAIN_DAYS` exists and is deliberately unset; setting it is a decision to
  destroy the only sample of broad pump.fun X chatter this project holds, which cannot be re-collected at any price.
  Posts cited by `token_promotion_hit` are exempt even when it is set.
- **`LEGAL_HOLD`** suspends every deletion in both pruners - set it to anything and nothing is deleted until it is
  unset. Routine deletion under a documented policy is defensible; deletion that continues after a dispute is
  foreseeable is spoliation. The collector's own pruner destroys millions of rows a day, so the gap between "should
  have stopped" and "stopped" is the thing that gets measured.

## Telegram ingestion is configured and dead, measured 2026-09-11

`TELEGRAM_ARCHIVE=1`, `TELEGRAM_SESSION`, `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are all set on the collector, and
the collector holds **0 tg_messages**. It is not slow or partial. It stopped.

`tg_gaps` holds 21 rows and **all 21 are still open** (`to_at IS NULL`). Twenty are
`406: AUTH_KEY_DUPLICATED (caused by messages.GetHistory)`, every one of them stamped 2026-09-09T14:22Z; the
twenty-first is `cannot resolve: No user has "solanagemschecked"` three minutes earlier. So the duplicate-session
failure this file documents did not end when the laptop went dark. It killed the collector's session at that moment
and nothing has been written since.

Which is the shape this file already warns about and the reason the gap rows exist: a poller that is configured,
running and ingesting nothing looks identical to a quiet week. The rows are the only reason it is knowable, and
nobody had read them in two days.

The X corpus is in the same state on the collector: **0 tweets** there, against 88,133 on the laptop. Whatever is
holding that corpus, it is not the machine that publishes the archive.

## What the recurring boot error is, measured 2026-09-12

`AUTH_KEY_DUPLICATED` returning on every collector boot is **not a second machine holding the session**. It is the
dead credential from 2026-09-09 being presented again, and the distinction matters because the obvious reading —
"something else has the key, go find it and stop it" — sends you looking for a live process that does not exist.

Measured on the collector volume and in the live log:

- `tg_messages` = **0**. `tg_gaps` holds the same **21 rows**, all stamped 2026-09-09, and **no row has been added
  since** — so the per-channel resolve loop in `TelegramWatcher.start()` is never reached. Every channel failing
  would have written 23 gap rows.
- `tgPolls=0` in the status line, indefinitely. `pollAll()` increments that counter once per entry in `entities`,
  so an empty `entities` map is the only state that keeps it at zero while the timer runs.
- Together those place the failure at `await this.client.connect()`, the first line of `start()`, before any
  channel is touched. `src/index.ts` catches it as one `[tg] failed to start:` line and the collector carries on.
- The gramjs client is nonetheless constructed and its transport keeps retrying: `connection closed` →
  `Started reconnecting` → `Connection to 149.154.175.52:80/TCPFull complete!` about every 90 seconds, forever,
  in the one log that gets read during an outage.

The laptop is not the other holder. `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` are still commented out in its `.env`,
the watcher is gated on both being present (`src/index.ts`, the `telegramConfigured(...) && channels.length`
condition), no launchd job runs any `telegram:*` script — `com.pumpmonitor.history` is the chain reconstruction
daemon, not this — and `data/telegram.session` has not been written since 2026-09-09 09:51 local, half an hour
before the key died. Nothing has to be stopped anywhere to free the session.

So the choice is only ever: mint a new session for the collector and collect again, or unset the archiver family and
stop claiming to. There is no third state where the current configuration starts working. Per DEPLOY.md, the two
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` alert variables are a separate family and must stay set either way.
