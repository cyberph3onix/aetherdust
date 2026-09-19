#!/bin/bash
# Run the pinned `undeployed` Midnight stack WITHOUT Docker: pulls the official images' layers via the Docker Hub
# registry API, extracts them, and runs the binaries natively (they are plain x86-64 Linux ELF executables).
#   deploy/native/stack.sh pull    # one-time: fetch node 1.0.2, indexer-standalone 4.3.5, proof-server 8.1.0 (~1.2 GB)
#   deploy/native/stack.sh up      # start all three in the background (logs in $STACK_DIR/logs)
#   deploy/native/stack.sh status  # health of node / indexer / proof server
#   deploy/native/stack.sh down    # stop them
#   deploy/native/stack.sh reset   # stop + wipe chain/indexer data (fresh genesis)
# Versions match deploy/standalone.yml (official support matrix 2026-09-20). Prefer Docker where available.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
STACK_DIR=${STACK_DIR:-$HOME/.cache/aetherdust-midnight-stack}
NODE_TAG=${NODE_TAG:-1.0.2}; INDEXER_TAG=${INDEXER_TAG:-4.3.5}; PS_TAG=${PS_TAG:-8.1.0}
mkdir -p "$STACK_DIR"/{img,data/node,data/indexer,logs,pids}

pull() {
  [ -d "$STACK_DIR/img/node/rootfs/res" ] || bash "$HERE/pull.sh" midnightntwrk/midnight-node "$NODE_TAG" "$STACK_DIR/img/node"
  [ -f "$STACK_DIR/img/indexer/rootfs/usr/local/bin/indexer-standalone" ] || bash "$HERE/pull.sh" midnightntwrk/indexer-standalone "$INDEXER_TAG" "$STACK_DIR/img/indexer"
  [ -n "$(find "$STACK_DIR/img/proof-server/rootfs" -name midnight-proof-server -type f 2>/dev/null | head -1)" ] || bash "$HERE/pull.sh" midnightntwrk/proof-server "$PS_TAG" "$STACK_DIR/img/proof-server"
  echo "images ready in $STACK_DIR/img"
}

up() {
  pull
  # node (reads res/<preset> relative to cwd)
  ( cd "$STACK_DIR/img/node/rootfs" && CFG_PRESET=dev BASE_PATH="$STACK_DIR/data/node" RUST_BACKTRACE=1 \
      setsid nohup ./midnight-node > "$STACK_DIR/logs/node.log" 2>&1 < /dev/null & echo $! > "$STACK_DIR/pids/node" )
  # indexer (config.yaml relative to cwd; all infra via APP__ env)
  ( cd "$STACK_DIR/img/indexer/rootfs/opt/indexer-standalone" && env \
      APP__APPLICATION__NETWORK_ID=undeployed \
      APP__INFRA__NODE__URL=ws://127.0.0.1:9944 APP__INFRA__SPO_NODE__URL=ws://127.0.0.1:9944 \
      APP__INFRA__SPO_NODE__BLOCKFROST_ID=dummy-not-using-spo \
      APP__INFRA__STORAGE__CNN_URL="$STACK_DIR/data/indexer/indexer.sqlite" \
      APP__INFRA__LEDGER_DB__CNN_URL="$STACK_DIR/data/indexer/ledger-db.sqlite" \
      APP__INFRA__STORAGE__PASSWORD=indexer APP__INFRA__PUB_SUB__PASSWORD=indexer APP__INFRA__LEDGER_STATE_STORAGE__PASSWORD=indexer \
      APP__INFRA__SECRET=303132333435363738393031323334353637383930313233343536373839303132 RUST_LOG=info \
      setsid nohup "$STACK_DIR/img/indexer/rootfs/usr/local/bin/indexer-standalone" > "$STACK_DIR/logs/indexer.log" 2>&1 < /dev/null & echo $! > "$STACK_DIR/pids/indexer" )
  # proof server (Nix-built glibc PIE: run through the host loader; downloads SRS params to ~/.cache/midnight on first run)
  PS_BIN=$(find "$STACK_DIR/img/proof-server/rootfs" -name midnight-proof-server -type f | head -1)
  ( setsid nohup /lib64/ld-linux-x86-64.so.2 "$PS_BIN" --port 6300 > "$STACK_DIR/logs/proof-server.log" 2>&1 < /dev/null & echo $! > "$STACK_DIR/pids/proof-server" )
  echo "started; waiting for health…"; sleep 15; status
}

status() {
  printf "node:         "; curl -s -m 3 http://127.0.0.1:9944/health || echo "DOWN"; echo
  printf "indexer:      "; curl -s -m 3 -X POST http://127.0.0.1:8088/api/v4/graphql -H 'content-type: application/json' -d '{"query":"{ block { height } }"}' || echo "DOWN"; echo
  printf "proof-server: "; curl -s -m 3 http://127.0.0.1:6300/version || echo "DOWN"; echo
}

down() {
  for p in proof-server indexer node; do
    [ -f "$STACK_DIR/pids/$p" ] && { kill "$(cat "$STACK_DIR/pids/$p")" 2>/dev/null || true; rm -f "$STACK_DIR/pids/$p"; }
  done
  pkill -f "midnight-node" 2>/dev/null || true; pkill -f "indexer-standalone" 2>/dev/null || true; pkill -f "midnight-proof-server" 2>/dev/null || true
  echo "stopped"
}

reset() { down; rm -rf "$STACK_DIR/data"; mkdir -p "$STACK_DIR"/data/{node,indexer}; echo "data wiped"; }

case "${1:-}" in pull) pull;; up) up;; status) status;; down) down;; reset) reset;; *) echo "usage: $0 pull|up|status|down|reset"; exit 1;; esac
