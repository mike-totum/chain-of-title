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
import os, re, sqlite3, sys, datetime, pathlib

REPO = "chainoftitle/chain-of-title"
ROOT = pathlib.Path(__file__).resolve().parent.parent

def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default

DRY = "--dry-run" in sys.argv
REC = pathlib.Path(arg("--record", str(ROOT / "data/record.db")))

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
        "graduated": q("SELECT COUNT(*) FROM tokens WHERE graduated=1"),
        "with_metadata": q("SELECT COUNT(*) FROM tokens WHERE meta_at IS NOT NULL"),
    }
    for t in ("trades", "hist_trades", "operator_wallets", "pool_map"):
        try:
            out[t] = q(f"SELECT COUNT(*) FROM {t}")
        except sqlite3.Error:
            out[t] = 0          # a table this build does not carry holds nothing, which is what that means
    try:
        out["built_at"] = q("SELECT v FROM meta WHERE k='built_at'")
    except sqlite3.Error:
        out["built_at"] = None
    try:
        first = q("SELECT MIN(created_at) FROM tokens WHERE created_at > 1756000000000")
        out["coverage_from"] = datetime.datetime.utcfromtimestamp(first / 1000).isoformat() + "Z"
    except Exception:
        out["coverage_from"] = None
    db.close()
    return out

def readme(c, size, built_iso):
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
| Graduated | {c['graduated']:,} |
| Buyout trades (curve buys ≥ 40 SOL) | {c['trades']:,} |
| Reconstructed buyout history | {c['hist_trades']:,} |
| Operator wallets | {c['operator_wallets']:,} |
| Launches with their declared metadata captured | {c['with_metadata']:,} |
| Continuous coverage from | `{c['coverage_from']}` |

`launches` counts what was watched from the creation transaction — the population every claim is about. `records`
counts every row, which additionally includes launches restored after the fact and those rebuilt from chain history.
They are different numbers and are never used interchangeably.

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
        print("DRY RUN — nothing uploaded."); return 0

    (ROOT / "data/_README.md").write_text(readme(c, size, built_iso))
    api.upload_file(path_or_fileobj=str(REC), path_in_repo="record.db", repo_id=REPO, repo_type="dataset",
                    commit_message=f"Record of {built_iso}: {c['launches']:,} launches")
    api.upload_file(path_or_fileobj=str(ROOT / "data/_README.md"), path_in_repo="README.md", repo_id=REPO,
                    repo_type="dataset", commit_message=f"Describe the deposit of {built_iso}")
    print(f"PASS  deposited {size:,} bytes to {REPO} — doi:10.57967/hf/10338")
    return 0

if __name__ == "__main__":
    sys.exit(main())
