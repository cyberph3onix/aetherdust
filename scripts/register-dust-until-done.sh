#!/usr/bin/env bash
# Operator helper: keep running `wallet register-dust` until the sponsor actually has DUST.
# Public testnets can take hours (wallet sync from zero + ~12 h cross-chain settling), so this is meant for
# `nohup … &` and going to bed. Safe to re-run at any time; register-dust itself is idempotent.
#   nohup scripts/register-dust-until-done.sh > register-dust.log 2>&1 &
#   tail -f register-dust.log
set -uo pipefail
cd "$(dirname "$0")/.."
COMPOSE="docker compose -f deploy/docker-compose.yml --profile testnet"
WAIT_MIN=${WAIT_MIN:-180}       # how long each attempt waits for the first DUST after registering
RETRY_S=${RETRY_S:-120}

# 1. let any register-dust that is already running finish first (two syncs of the same wallet would race)
while docker ps --format '{{.Names}}' | grep -q 'aetherdust-worker-run'; do
  echo "$(date -u +%FT%TZ) another wallet command is still running; waiting…"; sleep 60
done

# 2. retry until `status` reports a DUST coin
for attempt in $(seq 1 50); do
  echo "$(date -u +%FT%TZ) attempt $attempt: register-dust --wait $WAIT_MIN"
  if $COMPOSE run --rm worker wallet register-dust --wait "$WAIT_MIN" 2>&1 | grep -vE 'RPC-CORE'; then
    echo "$(date -u +%FT%TZ) DONE — the sponsor has DUST. Final status:"
    $COMPOSE run --rm worker wallet status 2>&1 | grep -vE 'RPC-CORE|sync:'
    exit 0
  fi
  echo "$(date -u +%FT%TZ) not there yet; retrying in ${RETRY_S}s"
  sleep "$RETRY_S"
done
echo "$(date -u +%FT%TZ) gave up after 50 attempts — paste this log to Claude"; exit 1
