#!/bin/sh
set -e
case "${1:-api}" in
  api)    exec node /app/apps/api/dist/main.js ;;
  worker) exec node /app/apps/worker/dist/main.js ;;
  cli)    shift; exec node /app/apps/api/dist/cli.js "$@" ;;
  wallet) shift; exec node /app/apps/worker/dist/wallet-cli.js "$@" ;;
  *)      exec "$@" ;;
esac
