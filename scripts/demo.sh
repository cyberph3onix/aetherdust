#!/usr/bin/env bash
# Walks the AetherDust API end to end with curl. Needs: a running API, AETHERDUST_URL, AETHERDUST_API_KEY.
#   AETHERDUST_API_KEY=ad_... scripts/demo.sh
set -euo pipefail
URL=${AETHERDUST_URL:-http://127.0.0.1:8080}
KEY=${AETHERDUST_API_KEY:?set AETHERDUST_API_KEY (from `aetherdust bootstrap`)}
CONTRACT=abababababababababababababababababababababababababababababababab
# python3 rather than xxd: it is already required below and is present on more machines
REAL_TX_HEX=$(python3 -c 'import sys;print(open(sys.argv[1],"rb").read().hex())' "$(dirname "$0")/../packages/midnight/fixtures/user-sealed-unpaid-1.bin")
j() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(json.dumps(d,indent=1)[:900])'; }
post() { curl -s -w '\nHTTP %{http_code}\n' -X POST "$URL/v1/sponsorship/requests${2:-}" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d "$1" | cut -c1-600; }
mock() { printf '{"request_id":"%s","user_id":"%s","transaction":{"format":"mock","id":"%s","calls":[{"address":"%s","entryPoint":"%s"}]}}' "$1" "$2" "$1" "$CONTRACT" "${3:-claim}"; }
N=$RANDOM
echo "== 1. approved + long-poll until confirmed (mock chain) =="; post "$(mock demo-$N-1 alice)" '?wait=10000'
echo "== 2. idempotent retry → 200, same id =="; post "$(mock demo-$N-1 alice)"
echo "== 3. wrong entry point → ENTRY_POINT_NOT_ALLOWED =="; post "$(mock demo-$N-2 alice drain)"
echo "== 4. unknown contract → CONTRACT_NOT_ALLOWED =="; post "$(printf '{"request_id":"demo-%s-3","user_id":"alice","transaction":{"format":"mock","id":"demo-%s-3","calls":[{"address":"%s","entryPoint":"claim"}]}}' $N $N $(printf 'cd%.0s' {1..32}))"
echo "== 5. per-user allowance (0.01 DUST) exhausted for alice =="; post "$(mock demo-$N-4 alice)"; post "$(mock demo-$N-5 alice)"
echo "== 6. real Midnight bytes (Phase 0 fixture) through the real inspector (PREFLIGHT_FAILED/TTL is the correct answer after 2026-09-19T21:53Z — real transactions expire) =="; post "{\"request_id\":\"demo-$N-real\",\"user_id\":\"bob\",\"transaction\":{\"format\":\"midnight-ledger-v8\",\"encoding\":\"hex\",\"bytes\":\"$REAL_TX_HEX\"}}"
echo "== 7. status =="; curl -s "$URL/v1/sponsorship/requests/demo-$N-1" -H "Authorization: Bearer $KEY" | j
echo "== 8. usage =="; curl -s "$URL/v1/usage" -H "Authorization: Bearer $KEY" | j
