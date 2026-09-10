#!/usr/bin/env python3
"""Re-deposit the published record to the DOI mirror, so the citable copy is the record rather than a memory of it.

WHY THIS EXISTS. `doi:10.57967/hf/10338` is the strongest promise this project makes. The pledge says the launch
record stays free and public in perpetuity, and a DOI deposit is what turns that from an assurance about our future
behaviour into a property of the artefact: it cannot be renamed, withdrawn or made private. It is what the grant
applications cite.

Measured 2026-09-08: the mirror held 51,359,744 bytes against a published 72,982,528 — roughly fifty thousand
launches behind, about thirty percent of the archive, because depositing was a thing someone did by hand twice and
then stopped doing. Meanwhile the data page told every reader "held independently of anything this project runs. If
this site is gone, the record is not." That sentence was false by fifty thousand launches, on the page whose whole
job is to hand the archive over, in front of the readers who matter most.

A deposit that drifts is worse than no deposit, because it looks like insurance and is not. So this runs in the
publish loop, next to the thing that builds the record, rather than living in someone's memory.

WHAT IT DEPOSITS. `record.db` itself, plus a README stating what that specific file holds and when it was built, so
the mirror describes its own contents rather than inheriting a claim from the site. Row counts are read from the file
being uploaded — never from the collector's database, which is always ahead and would make the README a description
of a different object. That distinction is the same one the site had wrong all morning.

  python3 scripts/deposit.py [--record data/record.db] [--dry-run]

Needs HF_TOKEN in .env. Exits non-zero on failure and says why: a deposit that quietly does nothing is exactly the
failure it exists to prevent.
"""
import os, re, sqlite3, sys, datetime, pathlib, json, gzip, hashlib

REPO = "chainoftitle/chain-of-title"
ROOT = pathlib.Path(__file__).resolve().parent.parent

def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

DRY = "--dry-run" in sys.argv
REC = pathlib.Path(arg("--record", str(ROOT / "data/record.db")))
DOCS = pathlib.Path(arg("--documents", str(ROOT / "data/documents.ndjson.gz")))
DOCS_MANIFEST = pathlib.Path(arg("--documents-manifest", str(ROOT / "data/documents.json")))

def token():
    if os.environ.get("HF_TOKEN"):
        return os.environ["HF_TOKEN"]
    env = ROOT / ".env"
    if env.exists():
        # First occurrence wins, matching config.ts — an empty earlier line shadows a real one below it, which is
        # exactly how the Telegram token appeared unset for a day. If this says missing and you can see one, look
        # for a duplicate key.
        for line in env.read_text().splitlines():
            m = re.match(r"^HF_TOKEN\s*=\s*(.*?)\s*$", line)
            if m and m.group(1):
                return m.group(1).strip("\"'")
    return None

def counts(path):
    """What this file holds, read from this file. Never from the live database, which is always further ahead."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    q = lambda s: db.execute(s).fetchone()[0]
    out = {
        "launches": q("SELECT COUNT(*) FROM tokens WHERE COALESCE(late_discovery,0)=0"),
        "records": q("SELECT COUNT(*) FROM tokens"),
        # Confirmed, not recorded. `graduated` is an inference from decoded trade volume and it is wrong on about
        # two rows in five; publishing it as "Graduated" on the mirror's front page repeated the error the
        # corrections table below exists to disclose. Both are reported, so the gap is visible rather than tidied.
        "graduated": q("SELECT COUNT(*) FROM tokens WHERE graduated_confirmed_by IS NOT NULL"),
        "graduated_recorded": q("SELECT COUNT(*) FROM tokens WHERE graduated=1"),
        "with_metadata": q("SELECT COUNT(*) FROM tokens WHERE meta_at IS NOT NULL"),
    }
    for t in ("trades", "hist_trades", "operator_wallets", "pool_map"):
        try:
            out[t] = q(f"SELECT COUNT(*) FROM {t}")
        except sqlite3.Error:
            out[t] = 0          # a table this build does not carry holds nothing, which is what that means
    # The corrections travel with the file, so the mirror states its own errata rather than deferring to a website
    # that may not outlive it. A file built before the table existed simply has none to report.
    try:
        out["corrections"] = db.execute(
            "SELECT id, issued_at, subject, finding, remedy FROM corrections ORDER BY issued_at").fetchall()
    except sqlite3.Error:
        out["corrections"] = []
    try:
        out["built_at"] = q("SELECT v FROM meta WHERE k='built_at'")
    except sqlite3.Error:
        out["built_at"] = None
    # Coverage comes from `runs`, never from MIN(created_at).
    #
    # The old query took the earliest launch in the file and labelled it "Continuous coverage from". Two rows in this
    # archive are reconstructions of older launches — one from 2026-05-10 — so the mirror's front page advertised four
    # months of continuous observation on a record holding eight days of it, computed from a single rebuilt row. That
    # is the exact overstatement DATA.md opens by warning against ("anyone describing this as four months of history
    # is reading the span and not the coverage"), published on the artefact a grant reviewer reads first.
    #
    # `runs` holds the intervals the collector was actually observing, which is what coverage means here. The span is
    # still reported, separately and under its own name, because it is a true and different fact.
    try:
        first = q("SELECT MIN(started_at) FROM runs")
        out["coverage_from"] = datetime.datetime.utcfromtimestamp(first / 1000).isoformat() + "Z"
    except Exception:
        out["coverage_from"] = None
    try:
        first = q("SELECT MIN(created_at) FROM tokens WHERE created_at > 1756000000000")
        out["span_from"] = datetime.datetime.utcfromtimestamp(first / 1000).isoformat() + "Z"
    except Exception:
        out["span_from"] = None
    db.close()
    return out

def documents(path, manifest_path):
    """The launch documents sidecar, verified against its own manifest before it can be deposited.

    This is the layer with the strongest claim to be in a permanent deposit, and it is the one that was not in it.
    record.db describes on-chain facts, which an archival node can rebuild for anyone willing to pay. A launch's own
    account of itself lives behind a URI its creator controls, is ~99% retrievable for two days and ~12% after a
    week, and for several thousand launches this is now the only surviving copy. Reconstructible data was being
    preserved forever while unreconstructible data was not.

    Verified, not trusted: the manifest carries a sha256 of the uncompressed NDJSON, and this recomputes it from the
    bytes about to be uploaded. A mismatch is refused rather than reported, because a deposit cannot be withdrawn and
    a corpus that does not match its own manifest is worse than no corpus — it would put a hash on the permanent
    record that nothing in the world satisfies.
    """
    if not path.exists() or not manifest_path.exists():
        return None
    m = json.loads(manifest_path.read_text())
    h = hashlib.sha256()
    with gzip.open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    if m.get("sha256") and h.hexdigest() != m["sha256"]:
        raise SystemExit(f"FAIL  documents sidecar does not match its manifest\n"
                         f"      manifest {m['sha256']}\n      actual   {h.hexdigest()}\n"
                         f"      Refusing to deposit. A permanent record must not carry a hash nothing satisfies.")
    m["gzipBytes"] = path.stat().st_size
    return m

def readme(c, size, built_iso, docs=None):
    # Errata, rendered from the file's own corrections table. A deposit that cannot be withdrawn needs a way to be
    # corrected, and pointing at a website for it defeats the reason the deposit exists.
    if c["corrections"]:
        rows = []
        for cid, issued, subject, finding, remedy in c["corrections"]:
            when = datetime.datetime.utcfromtimestamp(issued / 1000).strftime("%Y-%m-%d")
            what = f"`{subject}`" if subject else "the record"
            rows.append(f"### {cid} — {when}\n\n**Concerns {what}.** {finding}\n\n**What was done.** {remedy}\n")
        errata = ("## Errata\n\nThis deposit cannot be withdrawn or renamed, so corrections are published into it "
                  "rather than issued elsewhere. Every correction this project has made is below and in the "
                  "`corrections` table of the file itself, which is append-only: a correction is superseded by a new "
                  "row naming it, never edited.\n\n" + "\n".join(rows))
    else:
        errata = ""
    if docs:
        cov = docs.get("launchesWithBytesHeld") or docs.get("launchesCovered") or 0
        corpus = (
            "\n## The launch documents\n\n"
            "`documents.ndjson.gz` is the second artefact in this deposit and the one that cannot be rebuilt.\n\n"
            f"| | |\n|---|---|\n"
            f"| Documents | {docs.get('documents', 0):,} |\n"
            f"| Launches with their bytes held | {cov:,} |\n"
            f"| Compressed | {docs.get('gzipBytes', 0):,} bytes |\n"
            f"| Uncompressed | {docs.get('ndjsonBytes', 0):,} bytes |\n"
            f"| sha256 of the uncompressed NDJSON | `{docs.get('sha256','')}` |\n\n"
            "Everything in `record.db` describes the chain, and an archival node can rebuild it for anyone willing "
            "to pay. This file cannot be rebuilt at any price. A launch's own account of itself — what it claimed to "
            "be — lives behind a URI its creator owns, and measured on 2026-09-09 those assets are about 99% "
            "retrievable after two days and 12% after a week. For several thousand launches here this is the only "
            "surviving copy.\n\n"
            "One JSON document per line, each carrying the mint, the URI it was fetched from, when it was fetched, "
            "and the document as served. The sha256 above is of the uncompressed stream and is verified against this "
            "file before every deposit. CC0-1.0, like the rest.\n"
        )
    else:
        corpus = (
            "\n## Scope of this deposit\n\n"
            "This deposit contains `record.db` only. The launch documents corpus published at "
            "`chainoftitle.org/data/documents.ndjson.gz` is **not** included in this revision.\n"
        )
    return f"""---
license: cc0-1.0
pretty_name: Chain of Title — Solana launch provenance
tags: [solana, provenance, pump.fun, memecoin, public-good]
---

# Chain of Title — the launch record

One immutable row per Solana launch, recorded as it happened, with the supporting tables needed to answer a question
about any one of them. Public domain under CC0-1.0. Use it without asking, including commercially.

**Cite as `doi:10.57967/hf/10338`.** Live site: <https://chainoftitle.org>

## What is in THIS deposit

Row counts are read from the file in this repository, not from the collector, which is always further ahead. This
deposit describes itself.

| | |
|---|---|
| Built | `{built_iso}` |
| Size | {size:,} bytes |
| Launches observed from the creation transaction | {c['launches']:,} |
| Records in the file | {c['records']:,} |
| Graduated (confirmed) | {c['graduated']:,} |
| Graduated (recorded, unverified — see errata) | {c['graduated_recorded']:,} |
| Buyout trades (curve buys ≥ 40 SOL) | {c['trades']:,} |
| Reconstructed buyout history | {c['hist_trades']:,} |
| Operator wallets | {c['operator_wallets']:,} |
| Launches with their declared metadata captured | {c['with_metadata']:,} |
| Continuous observation from | `{c['coverage_from']}` |
| Earliest launch in the file (span, not coverage) | `{c['span_from']}` |

`launches` counts what was watched from the creation transaction — the population every claim is about. `records`
counts every row, which additionally includes launches restored after the fact and those rebuilt from chain history.
They are different numbers and are never used interchangeably.

{corpus}
{errata}
## Read this before quoting a number

**Coverage is data, not a footnote.** The `runs` table holds the intervals during which the collector was observing.
A launch outside those intervals was not seen, and its absence from this file is not evidence about the launch.
Reconstructed rows are marked (`rebuilt_at`, `rebuilt_complete`) and are never presented as observations.

**Launch facts are permanent; pool balances are not.** Everything describing the first blocks of a launch is a fact
about a moment and stays true. `vault_sol` is a balance read at `vault_at` and may be wildly wrong now.

**A null is not a clean result.** Where this archive holds no answer it says so. Absence of a warning is not a
finding, and any consumer treating it as one is doing so against the documented contract.

## Deposits

This mirror is re-deposited when the published record is rebuilt. Each deposit is a point-in-time snapshot and states
its own build time above; the DOI resolves to this dataset, and earlier deposits remain in its revision history.

```sql
SELECT mint, symbol, dev_pct, curve_buyers FROM tokens WHERE graduated = 1 LIMIT 5;
```
"""

def main():
    if not REC.exists():
        print(f"FAIL  {REC} does not exist — nothing to deposit"); return 1
    tok = token()
    if not tok:
        print("FAIL  HF_TOKEN is not set. The deposit is the citable copy; refusing to pretend it happened."); return 1

    size = REC.stat().st_size
    c = counts(REC)
    docs = documents(DOCS, DOCS_MANIFEST)
    built_ms = c["built_at"]
    built_iso = (datetime.datetime.utcfromtimestamp(int(built_ms) / 1000).isoformat() + "Z") if built_ms else "unrecorded"
    print(f"record   {REC}  {size:,} bytes, built {built_iso}")
    print(f"holds    {c['launches']:,} launches, {c['trades']:,} buyout trades, {c['hist_trades']:,} hist, {c['operator_wallets']:,} operator wallets")

    # Refuse to deposit something smaller than what is already there. The mirror is the copy that outlives the site;
    # overwriting it with less is the one mistake here that cannot be walked back by rebuilding.
    from huggingface_hub import HfApi
    api = HfApi(token=tok)
    try:
        info = api.repo_info(REPO, repo_type="dataset", files_metadata=True)
        prev = next((f.size for f in info.siblings if f.rfilename == "record.db" and f.size), 0)
    except Exception as e:
        print(f"  (could not read the current deposit: {e})"); prev = 0
    if prev:
        print(f"mirror   currently {prev:,} bytes")
        if size < prev * 0.9 and "--allow-shrink" not in sys.argv:
            print(f"FAIL  this record is smaller than the deposit it would replace ({size:,} < {prev:,}).")
            print("      The mirror is the copy that outlives the site. Pass --allow-shrink only on purpose.")
            return 1

    if DRY:
        if docs: print(f"         + {docs['documents']:,} launch documents, {docs['gzipBytes']:,} bytes, hash verified")
        else:    print("         no documents sidecar found — README will scope itself to record.db")
        print("DRY RUN — nothing uploaded."); return 0

    (ROOT / "data/_README.md").write_text(readme(c, size, built_iso, docs))
    api.upload_file(path_or_fileobj=str(REC), path_in_repo="record.db", repo_id=REPO, repo_type="dataset",
                    commit_message=f"Record of {built_iso}: {c['launches']:,} launches")
    if docs:
        api.upload_file(path_or_fileobj=str(DOCS), path_in_repo="documents.ndjson.gz", repo_id=REPO,
                        repo_type="dataset",
                        commit_message=f"Launch documents: {docs.get('documents', 0):,} unreconstructible records")
        api.upload_file(path_or_fileobj=str(DOCS_MANIFEST), path_in_repo="documents.json", repo_id=REPO,
                        repo_type="dataset", commit_message="Manifest for the launch documents corpus")
    api.upload_file(path_or_fileobj=str(ROOT / "data/_README.md"), path_in_repo="README.md", repo_id=REPO,
                    repo_type="dataset", commit_message=f"Describe the deposit of {built_iso}")
    print(f"PASS  deposited {size:,} bytes to {REPO} — doi:10.57967/hf/10338")
    return 0

if __name__ == "__main__":
    sys.exit(main())
