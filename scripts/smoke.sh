#!/bin/sh
# Every route the site actually needs, checked against a deployed URL. Written after two deploys in a row shipped an
# image missing files nobody thought to look for: the first had no database, the second no pages, and both were only
# noticed by hand. A deploy is not finished until this passes.
#   sh scripts/smoke.sh https://chainoftitle.org
U="${1:-https://web-production-cd0de.up.railway.app}"
MINT="${2:-2rA7wLGp7EqXZdpGx268ZojNNKWovkUWRKEa96VBpump}"
fail=0
check() {
  code=$(curl -s -o /tmp/smoke.out -w '%{http_code}' --max-time 30 "$U$1")
  if [ "$code" != "$2" ]; then printf '  FAIL %-22s expected %s, got %s\n' "$1" "$2" "$code"; fail=1; return; fi
  if [ -n "$3" ] && ! grep -q "$3" /tmp/smoke.out; then printf '  FAIL %-22s %s not found in body\n' "$1" "$3"; fail=1; return; fi
  printf '  ok   %-22s %s\n' "$1" "$code"
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
check "/data/record.db"      200 ""

# The JSON surface. `verdict` is the field integrators branch on, so its absence is a broken deploy even when the
# route answers 200 — and `not_an_address` proves the error bodies are records rather than bare strings.
check "/api/v1/status"                200 "launches"
check "/api/v1/token/$MINT"           200 "verdict"
check "/api/v1/token/notanaddress"    400 "not_an_address"
check "/api/v1/nope"                  404 "unknown_endpoint"
check "/api"                 404   # a directory path is a 404, not an EISDIR 500
[ $fail -eq 0 ] && echo "PASS" || { echo "FAIL — do not consider this deployed"; exit 1; }
