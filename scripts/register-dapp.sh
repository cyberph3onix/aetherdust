#!/usr/bin/env bash
# Operator helper: register a DApp with a running AetherDust and print its API key.
#   scripts/register-dapp.sh <contractAddress> [entryPoint=increment] [name=CounterDApp]
# Creates the application, sets a policy that sponsors only <entryPoint> on <contractAddress>, issues one API key.
# Reads AETHERDUST_ADMIN_TOKEN from deploy/.env (or the environment); talks to AETHERDUST_URL (default http://localhost:8080).
set -euo pipefail
cd "$(dirname "$0")/.."
ADDR=${1:?usage: $0 <contractAddress> [entryPoint] [name]}
EP=${2:-increment}
NAME=${3:-CounterDApp}
API=${AETHERDUST_URL:-http://localhost:8080}
ADMIN=${AETHERDUST_ADMIN_TOKEN:-$(grep '^AETHERDUST_ADMIN_TOKEN=' deploy/.env | cut -d= -f2-)}
[[ "$ADDR" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "contract address must be 64 hex chars" >&2; exit 1; }
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d$1)"; }
auth=(-H "Authorization: Bearer $ADMIN" -H 'content-type: application/json')

APP=$(curl -sf -X POST "$API/v1/admin/applications" "${auth[@]}" -d "{\"name\":\"$NAME\"}" | j '["id"]')
echo "application: $APP ($NAME)"
curl -sf -X PUT "$API/v1/admin/applications/$APP/policy" "${auth[@]}" -d "{
  \"contracts\": {\"$ADDR\": [\"$EP\"]},
  \"limits\": {\"period\":\"daily\",\"global_budget_dust\":\"50\",\"per_user_budget_dust\":\"5\",\"max_fee_per_tx_dust\":\"1\"},
  \"rate_limit\": {\"requests_per_minute_per_credential\":60,\"requests_per_minute_per_user\":10,\"requests_per_minute_per_ip\":120}
}" > /dev/null
echo "policy:      $EP on $ADDR (50 DUST/day, 5 DUST/user/day, 1 DUST/tx)"
KEY=$(curl -sf -X POST "$API/v1/admin/applications/$APP/api-keys" "${auth[@]}" -d "{\"env\":\"live\",\"label\":\"$NAME\"}" | j '["token"]')
echo
echo "API key (shown once — paste it into the DApp):"
echo "$KEY"
