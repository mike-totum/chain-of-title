# Scope of a working file

**The decision, 2026-09-12.** An engagement opens a **scoped workspace at creation** — this mint, these parties,
this window — and material outside that scope never enters it. We do not research the whole archive and filter on
the way out.

This is litigation-readiness item 3. It is written down rather than left to practice because the protection is
worthless if it depends on whoever is drafting remembering to apply it, and because a working file can be
discovered: what protects it is not what the final document omits, it is what was never in the file.

Implemented in `src/engagement.ts`, guarded by `src/engagement.test.ts`, run with `npm run engagement`.

---

## Why, in three leaks that actually happened

The two specimen reports were written the way research is written. All three of these were in the adverse
specimen, and none of them is about its subject:

1. **"Top three candidates"** named two other launches with their adverse particulars, and recorded that we ranked
   launches and chose this one. In a client's hands that is a document about how a subject was selected for being
   the most damning — and the other two are third parties who are nobody's subject.
2. **"The same cluster's other launches"** tabulated 29 further mints with symbols, wallet counts and confirmation
   sources.
3. **`operator_policy.note`** for cluster `FC9BqG` reads *"holds through the flat window; Kshama 660x, Simba 46x"* —
   two more launches named, in prose, inside a free-text field this project hand-wrote for its own watching.

**Leak 3 settles the architecture.** It is not a row a predicate could have excluded, and not a base58 identifier a
scanner could have spotted: it is an English sentence, authored by us, naming other people's launches by symbol, in
a column whose name gives no hint. Nothing written afterwards finds that reliably. The only thing that works is
never copying the column.

So a workspace is a **separate SQLite file** holding only in-scope rows, and the report pipeline is pointed at that
file. Out-of-scope material is not withheld from the report — it is absent from the workspace, so no query can
reach it and no author can quote it by accident. `servicedb.ts` already establishes the shape in this repo: the
published record is a derived database carrying only what belongs on the serving path. This is the same move made
for one matter.

---

## What a scope is

| Field | Rule |
|---|---|
| `matter` | The engagement's own id. Travels inside the file. |
| `subject` | The launches the matter is about. **Declared by the client. Never derived from a search.** |
| `from` / `to` | Bounds on every trade, reading and message carried. **Required**, never defaulted to fit the data. |
| `parties` | **Derived, not declared:** wallets that traded a subject mint inside the window, plus its creator. |
| `funders` | The direct funder of a party. One relation out, and no further. |

Two refusals are enforced at creation and are worth stating plainly:

- **The subject is declared, never searched for.** There is deliberately no discovery function. A workspace that
  could rank launches by how adverse they look would recreate leak 1 on every engagement. If candidate selection is
  ever wanted, it is a different activity under its own scope.
- **The window must contain the launch.** A window that excludes the subject's creation would leave the file's
  central fact outside its own scope. `openEngagement` refuses it rather than quietly widening.

---

## What may cross, by column

Every column is classified. A column with no classification **does not travel**, and is reported.

| Class | Treatment |
|---|---|
| `measured` | An observation, or a value of the subject's own. Copied. |
| `identifier` | Base58 naming the subject, a party, or their accounts. Copied, and added to the in-scope set. |
| `foreign` | Names a launch or address outside the subject. Copied **only if the value is itself in scope**, else NULL. |
| `document` | Verbatim third-party text — the launch's metadata JSON, the venue's own record, a tweet. Copied whole. |
| `internal` | Collector bookkeeping with no meaning outside it. Dropped deliberately. |
| `label` | **Free text we authored about someone. Never copied, whatever it says.** |

**On `foreign`:** the row survives, the pointer does not. `operator_wallets.source_mint` naming another launch
arrives NULL while `funder` and `seeded_at` arrive intact — because "when was this wallet funded, relative to the
launch" is the most probative fact in the cluster section, and dropping the whole row to kill one column would be
scoping by amputation.

**On `document`:** we do not edit primary sources. A tweet about the subject may name anything; a source edited to
suit our scope has stopped being evidence. Identifiers found inside one are **disclosed in the manifest**, not
removed. Bulk social material (`tweets`, `tg_messages`, `mentions`) is opt-in per engagement — `--documents` — so
the default workspace is clean with no exceptions to argue about.

**On `label`:** this is the register stance applied to client work. These are not observations, they are our own
working annotations, and the register does not offer opinion. A column of ours describing a third party has no
honest place in a file about someone else, so the classification refuses it rather than trying to sanitise it.

---

## What never enters, and why

Refusals are listed by name in `NEVER`, each with its reason, so that a refusal stays a decision on the record
rather than an omission someone later reads as an oversight and "fixes".

- `operator_policy` — our hand-set label on a cluster. Leak 3.
- `positions`, `signals` — this project's own paper trades. The clean-launch draft found simulated orders
  interleaved into the subject's real timeline, where they read as market activity on the launch.
- `smart_wallets`, `wallet_teams`, `buzz`, `telegram_channels` — scores and clusters we computed across the whole
  archive. Every figure in them is about other launches, and the grade is ours.
- `tg_gaps`, `legal_holds`, `meta`, `corrections` — our own bookkeeping, or published material cited by reference.

---

## Two instruments, because neither is sufficient alone

1. **`CARRY`** — a whitelist with the per-column classification above. Stops structured leaks. A **whitelist, not a
   blacklist**, because the failure being guarded is a table nobody thought about: `db.ts` gains tables, and a
   blacklist would let each new one flow into every working file silently.
2. **`residue()`** — re-reads the finished file and reports every base58 identifier the scope does not cover.
   Catches the leak nobody classified.

`residue()` **never imports `CARRY`**. It opens the output file, walks whatever it finds, and checks against the
manifest the file carries — so it would fail identically if `CARRY` were deleted. This is rule 6 from 2026-09-12:
an instrument sharing a code path with the thing it checks is not a second instrument.

The audit runs on the way out of `npm run engagement` and **a leak exits non-zero**, so a workspace that is not
clean cannot be produced quietly and then used by someone who assumed it had been checked.

### What residue() does not catch, stated rather than discovered later

- **Prose.** It looks for identifiers, not symbols. "Kshama 660x" is invisible to it — which is why leak 3 is
  handled by the `label` classification instead, and why free text we authored is refused outright.
- **An address concatenated to more base58 with no separator** matches as one over-length run and is skipped.
  `CARRY` is the defence against that.
- Two false-positive classes are excluded deliberately, both found by running it against the real archive rather
  than by reasoning: an **IPFS CIDv0** is 46 base58 characters and is not an address, and a **hex digest** is
  base58 apart from its zeros. Judged by length and alphabet, not by special-casing `Qm`.

---

## Opening one

```
npm run engagement -- --matter M-2026-001 --subject <mint> \
                      --from 2026-09-09 --to 2026-09-16 \
                      --out data/engagements/M-2026-001.db [--documents]
```

It prints the row count of every table carried, everything dropped and why, any table nobody has classified, the
disclosures inside quoted documents, and the residue verdict. The manifest is written **inside the file** as the
`scope` table: a working file that cannot state its own scope is one whose scope is whatever a reader later
assumes, and that is the first question anyone will ask of it.

`openDb()` **refuses to migrate a workspace** (`src/db.ts`). Migrating one would create the very tables the scope
refuses — empty, so nothing leaks, but the file would then carry tables named after the material we promised was
not in it, and nobody could tell an empty table from a purged one.

---

## What this does not settle

- **Aggregates over the archive.** A report legitimately cites base rates — "428 outside buyers, 14.3x the
  threshold" needs a threshold, and section 6 needs population figures. Those name nobody and are not in a
  workspace today; they have to arrive as frozen scalars with a stated cohort floor, because an aggregate over a
  cohort of one is a particular wearing a disguise. **Not built. The next piece of this.**
- **Section 4 reducing to aggregates first.** The clean-launch draft is unpublishable as drafted because a named
  wallet's other activity, measured after the fact, functions as an accusation on a page whose conclusion is that
  nothing fired. Scoping the file does not by itself decide what a *section* may say about a party in scope.
- **Retention and legal hold for client work** — item 4, which has the `LEGAL_HOLD` machinery but no written
  procedure for who sets it, on what trigger, and who releases it.
- **Reproducibility.** A workspace is a copy taken at a moment. It records `opened_at`, but nothing yet ties it to
  the collector build that produced it — the deploy-provenance gap, which is open separately.

See also: `ASSUMPTIONS.md`, `DATA.md`, and the method page. The through-line is that we ask nobody to trust us —
the record is downloadable, the method is published, and the bespoke layer stays thin.
