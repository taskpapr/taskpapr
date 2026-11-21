#!/usr/bin/env bash
# ============================================================
# taskpapr graceful-shutdown regression test (TASK-8)
# Usage: bash test/shutdown.sh [PORT]
# Default PORT: 3098
#
# Starts its own throwaway server (temp SQLite DB, single-user mode) from
# this checkout — never point it at a real instance. Checks that SIGTERM
# with an SSE stream open on /api/events:
#   1. ends the SSE stream and exits within $DEADLINE seconds, code 0
#   2. still lets an in-flight request (slow upload) finish with a 200
#
# Requires: curl, jq, node
# Exit code: 0 = all passed, 1 = one or more failures
# ============================================================

set -uo pipefail

PORT="${1:-3098}"
BASE="http://localhost:$PORT"
DEADLINE=5
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
SERVER_PID=""
PASS=0
FAIL=0

ok()   { echo "  ✓  $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗  $1"; FAIL=$((FAIL+1)); }

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -9 "$SERVER_PID" 2>/dev/null
  fi
  jobs -p | xargs -r kill 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

start_server() {
  local db="$TMP/taskpapr-$1.db"
  (cd "$ROOT" && PORT="$PORT" DB_PATH="$db" exec node server.js) >"$TMP/server-$1.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do
    curl -sf "$BASE/health" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  echo "  server failed to start on port $PORT:"; cat "$TMP/server-$1.log"
  exit 1
}

# Make sure the server from the previous case is gone (it should already be).
cleanup_server() { kill -9 "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; }

# Wait up to $DEADLINE s for the server to exit; sets EXIT_CODE ("" if still running).
wait_for_exit() {
  EXIT_CODE=""
  for _ in $(seq 1 $((DEADLINE * 10))); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      wait "$SERVER_PID"; EXIT_CODE=$?
      return
    fi
    sleep 0.1
  done
}

if curl -s "$BASE/health" >/dev/null 2>&1; then
  echo "Port $PORT is already in use; pass a free port: bash test/shutdown.sh <port>"
  exit 1
fi

echo "taskpapr shutdown test — throwaway server on :$PORT"

# ── 1. SIGTERM with an open SSE stream ──────────────────────────
echo "SIGTERM with an SSE client connected"
start_server sse
curl -sN "$BASE/api/events" >"$TMP/sse.out" 2>/dev/null &
CURL_PID=$!
sleep 0.5
if grep -q ': connected' "$TMP/sse.out"; then ok "SSE stream open"; else fail "SSE stream did not open"; fi

kill -TERM "$SERVER_PID"
wait_for_exit
if [ -z "$EXIT_CODE" ]; then
  fail "server still running ${DEADLINE}s after SIGTERM (shutdown hangs on SSE)"
elif [ "$EXIT_CODE" -eq 0 ]; then
  ok "server exited within ${DEADLINE}s with code 0"
else
  fail "server exited with code $EXIT_CODE (expected 0)"
fi
sleep 0.2
if kill -0 "$CURL_PID" 2>/dev/null; then
  fail "SSE stream still open after shutdown"
else
  ok "SSE stream was ended"
fi
cleanup_server

# ── 2. In-flight request completes during shutdown ──────────────
echo "SIGTERM during an in-flight request (with an SSE client connected)"
start_server inflight
COL_ID=$(curl -s "$BASE/api/columns" | jq -r '.[0].id')
curl -sN "$BASE/api/events" >/dev/null 2>&1 &
# Stream the JSON body slowly so the request is still in flight at SIGTERM.
{ printf '{"title":"shutdown-inflight",'; sleep 1.5; printf '"column_id":%s}' "$COL_ID"; } \
  | curl -s -o "$TMP/inflight.json" -w '%{http_code}' -X POST -T - \
      -H 'Content-Type: application/json' "$BASE/api/tasks" >"$TMP/inflight.status" &
POST_PID=$!
sleep 0.5
kill -TERM "$SERVER_PID"
wait "$POST_PID"
STATUS=$(cat "$TMP/inflight.status")
if [ "$STATUS" = "200" ] && jq -e '.id' "$TMP/inflight.json" >/dev/null 2>&1; then
  ok "in-flight POST /api/tasks completed with 200"
else
  fail "in-flight POST /api/tasks got HTTP '$STATUS' (expected 200)"
fi
wait_for_exit
if [ -z "$EXIT_CODE" ]; then
  fail "server still running ${DEADLINE}s after SIGTERM"
elif [ "$EXIT_CODE" -eq 0 ]; then
  ok "server exited within ${DEADLINE}s with code 0"
else
  fail "server exited with code $EXIT_CODE (expected 0)"
fi
cleanup_server

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
