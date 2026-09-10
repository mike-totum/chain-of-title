#!/bin/sh
# Every route the site actually needs, checked against a deployed URL. Written after two deploys in a row shipped an
# image missing files nobody thought to look for: the first had no database, the second no pages, and both were only
# noticed by hand. A deploy is not finished until this passes.
#   sh scripts/smoke.sh https://chainoftitle.org
#
# A failure here has to explain itself on the first run, because the failure is intermittent: this script failed twice
# on 2026-09-09 and has passed on every re-run since, and both diagnostics were lost — the output was read through
# `tail`, the FAIL line had already scrolled past, and a check that only says which route failed cannot say why.
# So: every response body is kept on disk, a failing check prints the curl exit code and the start of what it got,
# and the failures are repeated at the very end where `tail` will find them.
U="${1:-https://web-production-cd0de.up.railway.app}"
MINT="${2:-2rA7wLGp7EqXZdpGx268ZojNNKWovkUWRKEa96VBpump}"
OUT=$(mktemp -d /tmp/smoke.XXXXXX)
fail=0
FAILS="$OUT/failures"
: > "$FAILS"

# The first 160 characters of a body, as text. Printing the bytes raw made every HTML failure look identical -
# 160 characters of doctype and meta tags, the same for a 404 page as for a stack trace - so the markup is stripped
# and the visible words are shown instead. JSON has no tags and passes through untouched, which is the point.
peek() { tr '\n' ' ' < "$1" | sed -e 's|<style[^>]*>.*</style>||' -e 's/<[^>]*>/ /g' | tr -s ' ' | head -c 160; }

# Records a failure once and prints it once. Both copies come from here so the summary cannot drift from the line
# printed in place, which is how a diagnostic ends up saying less than the run that produced it.
lose() {
  printf '  FAIL %-24s %s\n' "$1" "$2" | tee -a "$FAILS"
  fail=1
}

check() {
  name=$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')
  body="$OUT/$name.body"
  code=$(curl -s -o "$body" -w '%{http_code}' --max-time 30 "$U$1" 2>"$OUT/$name.curlerr")
  rc=$?
  # curl's own exit code, not the HTTP status: a timeout, a DNS failure and a reset connection all leave the status
  # at 000, and those are three different faults. 28 is the timeout — the one to expect on a slow link.
  if [ $rc -ne 0 ]; then
    lose "$1" "curl exit $rc after $(wc -c < "$body" | tr -d ' ') bytes$([ -s "$OUT/$name.curlerr" ] && printf ': %s' "$(cat "$OUT/$name.curlerr")")"
    return
  fi
  if [ "$code" != "$2" ]; then
    lose "$1" "expected $2, got $code — body says: $(peek "$body")"
    return
  fi
  if [ -n "$3" ] && ! grep -q "$3" "$body"; then
    lose "$1" "$3 not found in $(wc -c < "$body" | tr -d ' ') bytes — body says: $(peek "$body")"
    return
  fi
  printf '  ok   %-24s %s\n' "$1" "$code"
}

echo "smoke test against $U"
check "/"                    200 "Chain of Title"
check "/method.html"         200 "launched clean"
check "/data.html"           200 "record.db"
check "/favicon.svg"         200 ""
check "/og.png"              200 ""
check "/lookup?mint=$MINT"   302 ""
check "/api.html"            200 "cleanAtBirth"
check "/pledge.html"         200 "never"
check "/corrections.html"    200 "corrections@chainoftitle.org"
check "/api/summary.json"    200 "clean"
check "/t/$MINT.html"        200 "At launch"
check "/live.html"           200 "Live"

# The JSON surface. `verdict` is the field integrators branch on, so its absence is a broken deploy even when the
# route answers 200 — and `not_an_address` proves the error bodies are records rather than bare strings.
check "/api/v1/status"                200 "launches"
check "/api/v1/token/$MINT"           200 "verdict"
check "/api/v1/token/notanaddress"    400 "not_an_address"
check "/api/v1/nope"                  404 "unknown_endpoint"
check "/api"                 404   # a directory path is a 404, not an EISDIR 500

# The bulk archive, without pulling it. This check used to GET the whole file into /tmp under a 30 s deadline; that
# was 68 MB when it was written and 117 MB by 2026-09-10, so the one check in this script whose cost grows with the
# archive was also the one most likely to time out on a slow link — a deploy gate that fails harder the better the
# project does. The server ignores Range (it answers 200 with the whole body), so this is a HEAD for the status and
# a GET truncated at the header for the bytes: together they prove the route serves an actual SQLite file.
# The cluster route, reached the way a reader reaches it: by following the first operator link on the front page.
# Naming a cluster here instead would have put one real operator in a public test suite and made the deploy gate
# fail the day that group dropped out of a rebuild - a check failing for a reason that has nothing to do with the
# deploy. An empty list is itself the failure: the operator map feeding it is what gates the whole archive.
first=$(sed -n 's|.*href="\(o/[1-9A-HJ-NP-Za-km-z]\{4,12\}\.html\)".*|\1|p' "$OUT/_.body" | head -1)
if [ -n "$first" ]; then check "/$first" 200 "Operator cluster"
else lose "/o/<cluster>.html" "the front page lists no operator clusters to follow"; fi

bulk=$(curl -s -o /dev/null -I -w '%{http_code}' --max-time 30 "$U/data/record.db")
[ "$bulk" = "200" ] || lose "/data/record.db" "HEAD expected 200, got $bulk"
magic=$(curl -s --max-time 30 "$U/data/record.db" 2>/dev/null | head -c 15)
if [ "$magic" = "SQLite format 3" ]; then printf '  ok   %-24s %s\n' "/data/record.db" "$bulk"
else lose "/data/record.db" "first 15 bytes are '$magic', not a SQLite header"; fi

if [ $fail -eq 0 ]; then
  rm -rf "$OUT"
  echo "PASS"
else
  # Repeated here on purpose. Both lost diagnostics were lost to `tail`, so the summary has to be the last thing
  # printed, and the bodies have to outlive the run — a failure nobody can look at is a failure nobody can fix.
  echo
  echo "FAIL — do not consider this deployed"
  cat "$FAILS"
  echo "responses kept in $OUT"
  exit 1
fi
