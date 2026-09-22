#!/usr/bin/env bash
# Captures the evidence for a recorded sponsorship run (plan §22 Phase 5: "a recorded preprod run").
# Run it right after a DApp has had a call sponsored; it writes one JSON bundle plus a readable summary.
#
#   AETHERDUST_URL=http://127.0.0.1:8080 scripts/record-run.sh [output-dir]
#
# The admin token comes from deploy/.env unless AETHERDUST_ADMIN_TOKEN is already set. Nothing here mutates state.
set -euo pipefail
URL=${AETHERDUST_URL:-http://127.0.0.1:8080}
OUT=${1:-recorded-run-$(date -u +%Y%m%dT%H%M%SZ)}
if [ -z "${AETHERDUST_ADMIN_TOKEN:-}" ] && [ -f deploy/.env ]; then
  AETHERDUST_ADMIN_TOKEN=$(grep -E '^AETHERDUST_ADMIN_TOKEN=' deploy/.env | cut -d= -f2-)
fi
: "${AETHERDUST_ADMIN_TOKEN:?set AETHERDUST_ADMIN_TOKEN (or run from the repo root with deploy/.env present)}"
get() { curl -sf -H "Authorization: Bearer $AETHERDUST_ADMIN_TOKEN" "$URL$1"; }

mkdir -p "$OUT"
get /healthz                                  > "$OUT/healthz.json"
get /v1/admin/wallet                          > "$OUT/wallet.json"
get '/v1/admin/overview?hours=24&bucket=hour' > "$OUT/overview.json"
get /metrics                                  > "$OUT/metrics.txt"

python3 - "$OUT" <<'PY'
import json, sys, pathlib
out = pathlib.Path(sys.argv[1])
ov = json.loads((out / 'overview.json').read_text())
wallet = json.loads((out / 'wallet.json').read_text())
health = json.loads((out / 'healthz.json').read_text())
w = wallet.get('live') or wallet.get('snapshot') or {}

# the most recent confirmed request is the run being recorded
confirmed = [r for r in ov.get('recent_requests', []) if r['internal_status'] == 'CONFIRMED']
lines = [
    f"network            {health.get('network')} ({health.get('adapter')} adapter)",
    f"generated          {ov.get('generated_at')}",
    f"sponsor wallet     {w.get('dust_balance_dust')} DUST · {w.get('night')} NIGHT · {w.get('dust_coins')} coin(s) · synced={w.get('synced')}",
    f"totals             {ov['totals']['sponsored_dust']} DUST sponsored · {ov['totals']['confirmed']} confirmed · "
    f"{ov['totals']['rejected']} rejected · {ov['totals']['failed']} failed",
    f"confirmation p95   {ov['confirmation_latency'].get('p95_seconds')} s over {ov['confirmation_latency'].get('count')} in the window",
]
for a in ov.get('applications', []):
    b = a.get('budget') or {}
    lines.append(f"application        {a['name']} ({a['id']}) · sponsored {a['sponsored_dust']} DUST · "
                 f"budget {b.get('settled_dust')}/{b.get('limit_dust')} this period")
if confirmed:
    r = confirmed[0]
    lines += [
        "",
        "most recent confirmed sponsorship",
        f"  request_id       {r['request_id']}",
        f"  user_id          {r['user_id']}",
        f"  call             {r['contract']}:{r['entry_point']}",
        f"  transaction_id   {r['transaction_id']}",
        f"  sponsored        {r['sponsored_dust']} DUST (estimated {r['estimated_fee_dust']})",
        f"  block            {r['block_height']}",
        f"  submitted → confirmed  {r['submitted_at']} → {r['confirmed_at']}",
    ]
else:
    lines += ["", "no confirmed sponsorship in the window — run one, then re-run this script"]
summary = "\n".join(lines) + "\n"
(out / 'summary.txt').write_text(summary)
print(summary)
PY

# the audit trail of that request, which is the part worth pasting into a report
python3 - "$OUT" "$URL" "$AETHERDUST_ADMIN_TOKEN" <<'PY'
import json, pathlib, subprocess, sys
out, url, token = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
ov = json.loads((out / 'overview.json').read_text())
c = [r for r in ov.get('recent_requests', []) if r['internal_status'] == 'CONFIRMED']
if c:
    detail = subprocess.run(['curl', '-sf', '-H', f'Authorization: Bearer {token}', f"{url}/v1/admin/requests/{c[0]['id']}"],
                            capture_output=True, text=True).stdout
    (out / 'request.json').write_text(detail)
    events = json.loads(detail).get('events', [])
    print('audit trail:', ' → '.join(e['to'] for e in events))
PY
echo "evidence written to $OUT/"
