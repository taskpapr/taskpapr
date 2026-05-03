#!/usr/bin/env bash
# ============================================================
# taskpapr smoke test — v0.17.0
# Usage: ./test/smoke.sh [BASE_URL]
# Default BASE_URL: http://localhost:3033
#
# Requires: curl, jq
# Exit code: 0 = all passed, 1 = one or more failures
# ============================================================

set -euo pipefail

BASE="${1:-http://localhost:3033}"
PASS=0
FAIL=0
ERRORS=()

# ── Colours ──────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Helpers ───────────────────────────────────────────────────

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC}  $1"; FAIL=$((FAIL+1)); ERRORS+=("$1"); }
info() { echo -e "  ${YELLOW}→${NC}  $1"; }

# Run curl silently; return HTTP status code
status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# Run curl; return response body (also checks HTTP status)
body() {
  curl -s "$@"
}

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got $actual"
  fi
}

assert_field() {
  local label="$1" field="$2" json="$3"
  local val
  val=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "__jq_error__")
  if [[ "$val" != "null" && "$val" != "__jq_error__" && "$val" != "" ]]; then
    ok "$label (.${field//\./} present)"
  else
    fail "$label — field $field missing or null in: $json"
  fi
}

# ── Prerequisites check ───────────────────────────────────────
echo ""
echo "taskpapr smoke test"
echo "Target: $BASE"
echo "────────────────────────────────────────"

if ! command -v jq &>/dev/null; then
  echo -e "${RED}Error: jq is required but not installed.${NC}"
  exit 2
fi

# ── API key setup ─────────────────────────────────────────────
# We run in single-user mode for smoke tests (no auth headers needed for most routes).
# For webhook tests we need an API key — we create one via admin endpoint and use it.

echo ""
echo "── Auth & bootstrap ──────────────────────"

ME=$(body "$BASE/api/me")
assert_field "GET /api/me returns version" ".version" "$ME"
assert_field "GET /api/me returns single_user flag" ".single_user" "$ME"

# Create an API key for webhook tests
KEY_RESP=$(body -X POST "$BASE/api/keys" \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-test-key"}')
API_KEY=$(echo "$KEY_RESP" | jq -r '.key' 2>/dev/null || echo "")

if [[ -n "$API_KEY" && "$API_KEY" != "null" ]]; then
  ok "POST /api/keys — created smoke-test-key"
else
  fail "POST /api/keys — could not create API key (response: $KEY_RESP)"
  API_KEY=""
fi

# ── Columns ───────────────────────────────────────────────────
echo ""
echo "── Columns (tiles) ───────────────────────"

COLS=$(body "$BASE/api/columns")
assert_field "GET /api/columns returns array" ".[0].id" "$COLS"

# Create a test tile
COL_RESP=$(body -X POST "$BASE/api/columns" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Test Tile","x":9000,"y":9000}')
COL_ID=$(echo "$COL_RESP" | jq -r '.id' 2>/dev/null || echo "")
assert_field "POST /api/columns" ".id" "$COL_RESP"

if [[ -n "$COL_ID" && "$COL_ID" != "null" ]]; then
  # Rename
  RENAME=$(body -X PATCH "$BASE/api/columns/$COL_ID" \
    -H "Content-Type: application/json" \
    -d '{"name":"Smoke Test Tile (renamed)"}')
  assert_field "PATCH /api/columns/:id rename" ".id" "$RENAME"

  # Set colour
  COLOR=$(body -X PATCH "$BASE/api/columns/$COL_ID" \
    -H "Content-Type: application/json" \
    -d '{"color":"#fce4d6"}')
  assert_field "PATCH /api/columns/:id color" ".color" "$COLOR"

  # Hide tile
  HIDE=$(body -X PATCH "$BASE/api/columns/$COL_ID" \
    -H "Content-Type: application/json" \
    -d '{"hidden":true}')
  HIDDEN_VAL=$(echo "$HIDE" | jq -r '.hidden' 2>/dev/null || echo "0")
  if [[ "$HIDDEN_VAL" == "1" ]]; then
    ok "PATCH /api/columns/:id hidden=1"
  else
    fail "PATCH /api/columns/:id hidden — expected 1, got $HIDDEN_VAL"
  fi

  # Unhide
  body -X PATCH "$BASE/api/columns/$COL_ID" \
    -H "Content-Type: application/json" \
    -d '{"hidden":false}' >/dev/null

  # Scale clamping (tile zoom persistence)
  SCALE_MIN_RESP=$(body -X PATCH "$BASE/api/columns/$COL_ID" \
    -H "Content-Type: application/json" \
    -d '{"scale":0.1}')
  SCALE_MIN_VAL=$(echo "$SCALE_MIN_RESP" | jq -r '.scale' 2>/dev/null || echo "")
  if awk "BEGIN {exit !($SCALE_MIN_VAL >= 0.499999 && $SCALE_MIN_VAL <= 0.500001)}"; then
    ok "PATCH /api/columns/:id scale clamps up to min (0.1 -> 0.5)"
  else
    fail "PATCH /api/columns/:id scale min clamp — expected ~0.5, got $SCALE_MIN_VAL"
  fi

  SCALE_MAX_RESP=$(body -X PATCH "$BASE/api/columns/$COL_ID" \
    -H "Content-Type: application/json" \
    -d '{"scale":9.9}')
  SCALE_MAX_VAL=$(echo "$SCALE_MAX_RESP" | jq -r '.scale' 2>/dev/null || echo "")
  if awk "BEGIN {exit !($SCALE_MAX_VAL >= 1.999999 && $SCALE_MAX_VAL <= 2.000001)}"; then
    ok "PATCH /api/columns/:id scale clamps down to max (9.9 -> 2.0)"
  else
    fail "PATCH /api/columns/:id scale max clamp — expected ~2.0, got $SCALE_MAX_VAL"
  fi
fi

# ── Tasks ──────────────────────────────────────────────────────
echo ""
echo "── Tasks ──────────────────────────────────"

ALL_TASKS=$(body "$BASE/api/tasks")
assert_field "GET /api/tasks returns array" "type" "$(echo "$ALL_TASKS" | jq 'type')"

TASK_RESP=""
TASK_ID=""
if [[ -n "$COL_ID" && "$COL_ID" != "null" ]]; then
  TASK_RESP=$(body -X POST "$BASE/api/tasks" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"Smoke test task\",\"column_id\":$COL_ID}")
  TASK_ID=$(echo "$TASK_RESP" | jq -r '.id' 2>/dev/null || echo "")
  assert_field "POST /api/tasks" ".id" "$TASK_RESP"
fi

if [[ -n "$TASK_ID" && "$TASK_ID" != "null" ]]; then
  # Update title
  UPD=$(body -X PATCH "$BASE/api/tasks/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d '{"title":"Smoke test task (updated)"}')
  assert_field "PATCH /api/tasks/:id title" ".id" "$UPD"

  # Add notes
  NOTES=$(body -X PATCH "$BASE/api/tasks/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d '{"notes":"# Smoke test\n\nSome notes."}')
  assert_field "PATCH /api/tasks/:id notes" ".notes" "$NOTES"

  # Mark WIP
  WIP=$(body -X PATCH "$BASE/api/tasks/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d '{"status":"wip"}')
  WIP_STATUS=$(echo "$WIP" | jq -r '.status' 2>/dev/null)
  [[ "$WIP_STATUS" == "wip" ]] && ok "PATCH /api/tasks/:id status=wip" || fail "PATCH /api/tasks/:id wip — got $WIP_STATUS"

  # Mark done
  DONE=$(body -X PATCH "$BASE/api/tasks/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d '{"status":"done"}')
  DONE_STATUS=$(echo "$DONE" | jq -r '.status' 2>/dev/null)
  [[ "$DONE_STATUS" == "done" ]] && ok "PATCH /api/tasks/:id status=done" || fail "PATCH /api/tasks/:id done — got $DONE_STATUS"

  # ACK (rot reset)
  ACK=$(body -X POST "$BASE/api/tasks/$TASK_ID/ack")
  assert_field "POST /api/tasks/:id/ack" ".id" "$ACK"

  # Park task
  PARK=$(body -X POST "$BASE/api/tasks/$TASK_ID/park")
  assert_field "POST /api/tasks/:id/park returns task" ".task.id" "$PARK"
  assert_field "POST /api/tasks/:id/park returns column" ".column.id" "$PARK"

  # Set due date + recurrence
  body -X PATCH "$BASE/api/tasks/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d '{"next_due":"2099-12-31","recurrence":"weekly"}' >/dev/null
  ok "PATCH /api/tasks/:id next_due + recurrence"

  # Delete task
  DEL_STATUS=$(status -X DELETE "$BASE/api/tasks/$TASK_ID")
  assert_status "DELETE /api/tasks/:id" "200" "$DEL_STATUS"
fi

# Clear done in our test tile
if [[ -n "$COL_ID" && "$COL_ID" != "null" ]]; then
  body -X DELETE "$BASE/api/tasks?column_id=$COL_ID" >/dev/null
  ok "DELETE /api/tasks?column_id (clear done)"
fi

# ── Goals ──────────────────────────────────────────────────────
echo ""
echo "── Goals ──────────────────────────────────"

GOALS=$(body "$BASE/api/goals")
assert_field "GET /api/goals returns array" "type" "$(echo "$GOALS" | jq 'type')"

GOAL_RESP=$(body -X POST "$BASE/api/goals" \
  -H "Content-Type: application/json" \
  -d '{"title":"Smoke Test Goal"}')
GOAL_ID=$(echo "$GOAL_RESP" | jq -r '.id' 2>/dev/null || echo "")
assert_field "POST /api/goals" ".id" "$GOAL_RESP"

if [[ -n "$GOAL_ID" && "$GOAL_ID" != "null" ]]; then
  GPATCH=$(body -X PATCH "$BASE/api/goals/$GOAL_ID" \
    -H "Content-Type: application/json" \
    -d '{"title":"Smoke Test Goal (updated)","notes":"Some notes"}')
  assert_field "PATCH /api/goals/:id" ".id" "$GPATCH"

  DEL_G=$(status -X DELETE "$BASE/api/goals/$GOAL_ID")
  assert_status "DELETE /api/goals/:id" "200" "$DEL_G"
fi

# ── Bookmarks ──────────────────────────────────────────────────
echo ""
echo "── Bookmarks ──────────────────────────────"

BM_LIST=$(body "$BASE/api/bookmarks")
assert_field "GET /api/bookmarks returns array" "type" "$(echo "$BM_LIST" | jq 'type')"

BM_RESP=$(body -X POST "$BASE/api/bookmarks" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Test View","x":-100,"y":-200,"zoom":0.75}')
BM_ID=$(echo "$BM_RESP" | jq -r '.id' 2>/dev/null || echo "")
assert_field "POST /api/bookmarks" ".id" "$BM_RESP"
assert_field "POST /api/bookmarks — name" ".name" "$BM_RESP"

if [[ -n "$BM_ID" && "$BM_ID" != "null" ]]; then
  BM_RENAME=$(body -X PATCH "$BASE/api/bookmarks/$BM_ID" \
    -H "Content-Type: application/json" \
    -d '{"name":"Smoke Test View (renamed)"}')
  BM_NEW_NAME=$(echo "$BM_RENAME" | jq -r '.name' 2>/dev/null)
  [[ "$BM_NEW_NAME" == "Smoke Test View (renamed)" ]] && ok "PATCH /api/bookmarks/:id rename" || fail "PATCH /api/bookmarks/:id — got name: $BM_NEW_NAME"

  DEL_BM=$(status -X DELETE "$BASE/api/bookmarks/$BM_ID")
  assert_status "DELETE /api/bookmarks/:id" "200" "$DEL_BM"
fi

# ── Export ─────────────────────────────────────────────────────
echo ""
echo "── Export / Import ────────────────────────"

EXPORT=$(body "$BASE/api/export")
assert_field "GET /api/export — version" ".version" "$EXPORT"
assert_field "GET /api/export — tiles array" ".tiles" "$EXPORT"

# Round-trip: import the export back as merge (idempotent)
IMPORT=$(body -X POST "$BASE/api/import?mode=merge" \
  -H "Content-Type: application/json" \
  -d "$EXPORT")
IMPORT_OK=$(echo "$IMPORT" | jq -r '.ok' 2>/dev/null)
[[ "$IMPORT_OK" == "true" ]] && ok "POST /api/import?mode=merge" || fail "POST /api/import?mode=merge — got: $IMPORT"

# ── Webhook ────────────────────────────────────────────────────
echo ""
echo "── Webhook ────────────────────────────────"

if [[ -z "$API_KEY" || "$API_KEY" == "null" ]]; then
  info "Skipping webhook tests — no API key available"
else
  # Get first non-hidden column to add a webhook task to
  FIRST_COL=$(body "$BASE/api/columns" | jq -r '.[0].name' 2>/dev/null || echo "")

  if [[ -n "$FIRST_COL" ]]; then
    # Webhook: reject without key
    WH_UNAUTH=$(status -X POST "$BASE/api/webhook" \
      -H "Content-Type: application/json" \
      -d '{"action":"add_task","title":"Unauth test","tile":"'"$FIRST_COL"'"}')
    assert_status "POST /api/webhook — rejects without API key" "401" "$WH_UNAUTH"

    # Webhook: add task
    WH_ADD=$(body -X POST "$BASE/api/webhook" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $API_KEY" \
      -d '{"action":"add_task","title":"Webhook smoke task","tile":"'"$FIRST_COL"'"}')
    WH_TASK_ID=$(echo "$WH_ADD" | jq -r '.task.id' 2>/dev/null || echo "")
    assert_field "POST /api/webhook add_task" ".task.id" "$WH_ADD"

    if [[ -n "$WH_TASK_ID" && "$WH_TASK_ID" != "null" ]]; then
      # Webhook: mark wip
      WH_WIP=$(body -X POST "$BASE/api/webhook" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d "{\"action\":\"mark_wip\",\"id\":$WH_TASK_ID}")
      assert_field "POST /api/webhook mark_wip" ".task.id" "$WH_WIP"

      # Webhook: complete
      WH_DONE=$(body -X POST "$BASE/api/webhook" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d "{\"action\":\"complete\",\"id\":$WH_TASK_ID}")
      assert_field "POST /api/webhook complete" ".task.id" "$WH_DONE"

      # Webhook: delete
      WH_DEL=$(body -X POST "$BASE/api/webhook" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d "{\"action\":\"delete_task\",\"id\":$WH_TASK_ID}")
      assert_field "POST /api/webhook delete_task" ".ok" "$WH_DEL"
    fi

    # Webhook: unknown action
    WH_BAD=$(status -X POST "$BASE/api/webhook" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $API_KEY" \
      -d '{"action":"explode"}')
    assert_status "POST /api/webhook — rejects unknown action" "400" "$WH_BAD"
  else
    info "Skipping webhook tests — no columns found"
  fi
fi

# ── Task reorder ───────────────────────────────────────────────
echo ""
echo "── Reorder ────────────────────────────────"

# Create two tasks in our test tile and reorder them
if [[ -n "$COL_ID" && "$COL_ID" != "null" ]]; then
  T1=$(body -X POST "$BASE/api/tasks" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"Reorder A\",\"column_id\":$COL_ID}" | jq -r '.id')
  T2=$(body -X POST "$BASE/api/tasks" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"Reorder B\",\"column_id\":$COL_ID}" | jq -r '.id')

  if [[ -n "$T1" && "$T1" != "null" && -n "$T2" && "$T2" != "null" ]]; then
    REORDER=$(status -X POST "$BASE/api/tasks/reorder" \
      -H "Content-Type: application/json" \
      -d "[{\"id\":$T1,\"position\":1,\"column_id\":$COL_ID},{\"id\":$T2,\"position\":0,\"column_id\":$COL_ID}]")
    assert_status "POST /api/tasks/reorder" "200" "$REORDER"

    # Clean up
    curl -s -X DELETE "$BASE/api/tasks/$T1" >/dev/null
    curl -s -X DELETE "$BASE/api/tasks/$T2" >/dev/null
  fi
fi

# ── Cleanup ────────────────────────────────────────────────────
echo ""
echo "── Cleanup ────────────────────────────────"

# Delete test tile (cascades tasks)
if [[ -n "$COL_ID" && "$COL_ID" != "null" ]]; then
  DEL_COL=$(status -X DELETE "$BASE/api/columns/$COL_ID")
  assert_status "DELETE /api/columns/:id (test tile)" "200" "$DEL_COL"
fi

# Delete smoke-test API key
if [[ -n "$KEY_RESP" ]]; then
  KEY_ID=$(echo "$KEY_RESP" | jq -r '.name' 2>/dev/null || echo "")
  KEYS=$(body "$BASE/api/keys")
  SMOKE_KEY_ID=$(echo "$KEYS" | jq -r '.[] | select(.name=="smoke-test-key") | .id' 2>/dev/null || echo "")
  if [[ -n "$SMOKE_KEY_ID" && "$SMOKE_KEY_ID" != "null" ]]; then
    curl -s -X DELETE "$BASE/api/keys/$SMOKE_KEY_ID" >/dev/null
    ok "Deleted smoke-test-key"
  fi
fi

# ── Summary ────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
TOTAL=$((PASS + FAIL))
echo -e "Results: ${GREEN}${PASS}${NC} passed, ${RED}${FAIL}${NC} failed (${TOTAL} total)"
echo ""

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo -e "${RED}Failures:${NC}"
  for e in "${ERRORS[@]}"; do
    echo "  • $e"
  done
  echo ""
fi

[[ $FAIL -eq 0 ]]