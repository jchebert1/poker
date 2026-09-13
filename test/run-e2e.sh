#!/usr/bin/env bash
# Starts a fresh dev-mode server on :3000 and runs the Playwright e2e test against it.
set -u
cd "$(dirname "$0")/.."
[ -f /tmp/poker.pid ] && kill "$(cat /tmp/poker.pid)" 2>/dev/null
sleep 0.5
rm -rf /tmp/pokerdata
AUTH_MODE=dev ADMIN_EMAILS=jchebert1@gmail.com DATA_DIR=/tmp/pokerdata PORT=3000 node --no-warnings server/index.js > /tmp/poker.log 2>&1 &
echo $! > /tmp/poker.pid
sleep 1
NODE_PATH=$(npm root -g) node test/e2e.js "$@"
code=$?
echo "server log tail:"; tail -5 /tmp/poker.log
exit $code
