#!/usr/bin/env bash
# taskpapr integration tests — API-only (no browser UI)
#
# Deterministic date logic is enabled via:
#   POST /api/admin/debug/date
#
# Runs a focused set of state-transition checks:
# - Dormancy sync via next_due + visibility_days
# - Recurrence completion advancement
# - Park + snooze (status + snooze_until)
# - Bookmarks ordering by position (position asc, id asc)
#
# Usage: bash test/integration-api.sh [BASE_URL]

set -euo pipefail

BASE="${1:-http://localhost:3033}"

PASS=0
FAIL=0
ERRORS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC}  $1"; FAIL=$((FAIL+1)); ERRORS+=("$1"); }
info() { echo -e "  ${YELLOW}→${NC}  $1"; }

status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

body() {
  curl -s "$@"
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

assert_equals() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    ok "$label (expected $expected)"
  else
    fail "$label — expected $expected, got $actual"
  fi
}

assert_json_has() {
  local label="$1" json="$2"
  if echo "$json" | jq -e . >/dev/null 2>&1; then
    ok "$label (valid JSON)"
  else
    fail "$label (invalid JSON)"
  fi
}

need_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: $1 is required but not installed."
    exit 2
  fi
}

need_cmd curl
need_cmd jq

echo ""
echo "taskpapr API integration tests"
echo "Target: $BASE"
echo "────────────────────────────────────────"

DEBUG_DATE="2026-03-30"
TOMORROW="$(node -e "const d=new Date('${DEBUG_DATE}T12:00:00Z'); d.setUTCDate(d.getUTCDate()+1); console.log(d.toISOString().slice(0,10));")"

info "Setting debug date to $DEBUG_DATE"
DBG_RESP=$(body -X POST "$BASE/api/admin/debug/date" \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"$DEBUG_DATE\"}")
assert_json_has "Set debug date" "$DBG_RESP"
DBG_OK=$(echo "$DBG_RESP" | jq -r '.ok' 2>/dev/null || echo "false")
[[ "$DBG_OK" == "true" ]] && ok "POST /api/admin/debug/date" || fail "POST /api/admin/debug/date did not return ok=true"

info "Creating a test tile (column)"
COL_RESP=$(body -X POST "$BASE/api/columns" \
  -H "Content-Type: application/json" \
  -d '{"name":"Integration Smoke Tile","x":1234,"y":5678}')
assert_json_has "Create column" "$COL_RESP"
COL_ID=$(echo "$COL_RESP" | jq -r '.id' 2>/dev/null || echo "")
if [[ -z "$COL_ID" || "$COL_ID" == "null" ]]; then
  fail "Create column — missing id"
  exit 1
fi
ok "POST /api/columns returns id"

# We'll clean up at the end by deleting the created tile.
cleanup() {
  # Best-effort cleanup only (CI is ephemeral; local runs are okay if cleanup misses).
  curl -s -X DELETE "$BASE/api/admin/debug/date" >/dev/null 2>&1 || true
  if [[ -n "${COL_ID:-}" && "$COL_ID" != "null" ]]; then
    curl -s -X DELETE "$BASE/api/columns/$COL_ID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo ""
echo "── Dormancy sync ─────────────────────────"

info "Creating task for dormancy test"
T1_RESP=$(body -X POST "$BASE/api/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Dormancy sync test\",\"column_id\":$COL_ID}")
assert_json_has "Create task T1" "$T1_RESP"
T1_ID=$(echo "$T1_RESP" | jq -r '.id' 2>/dev/null || echo "")
[[ -z "$T1_ID" || "$T1_ID" == "null" ]] && fail "Create task T1 — missing id" && exit 1

# visibility_days=3
# next_due=2026-04-05 => wakeDate=2026-04-02 => today 2026-03-30 < wakeDate => dormant
PATCH_DORMANT=$(body -X PATCH "$BASE/api/tasks/$T1_ID" \
  -H "Content-Type: application/json" \
  -d '{"visibility_days":3,"next_due":"2026-04-05"}')
assert_json_has "Patch dormancy window to dormant" "$PATCH_DORMANT"
T1_STATUS_1=$(echo "$PATCH_DORMANT" | jq -r '.status' 2>/dev/null || echo "")
assert_equals "Dormant status after patch" "dormant" "$T1_STATUS_1"

# next_due=2026-04-01 => wakeDate=2026-03-29 => today 2026-03-30 >= wakeDate => active
PATCH_ACTIVE=$(body -X PATCH "$BASE/api/tasks/$T1_ID" \
  -H "Content-Type: application/json" \
  -d '{"next_due":"2026-04-01"}')
assert_json_has "Patch dormancy window to active" "$PATCH_ACTIVE"
T1_STATUS_2=$(echo "$PATCH_ACTIVE" | jq -r '.status' 2>/dev/null || echo "")
assert_equals "Active status after patch" "active" "$T1_STATUS_2"

echo ""
echo "── Recurrence completion ─────────────────"

info "Creating task for recurrence test"
T2_RESP=$(body -X POST "$BASE/api/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Recurring completion test\",\"column_id\":$COL_ID}")
assert_json_has "Create task T2" "$T2_RESP"
T2_ID=$(echo "$T2_RESP" | jq -r '.id' 2>/dev/null || echo "")
[[ -z "$T2_ID" || "$T2_ID" == "null" ]] && fail "Create task T2 — missing id" && exit 1

info "Setting recurrence daily"
SETUP_REC=$(body -X PATCH "$BASE/api/tasks/$T2_ID" \
  -H "Content-Type: application/json" \
  -d '{"visibility_days":3,"next_due":"2026-04-10","recurrence":"daily"}')
assert_json_has "Setup recurrence" "$SETUP_REC"

info "Completing recurring task (status=done)"
DONE_REC=$(body -X PATCH "$BASE/api/tasks/$T2_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}')
assert_json_has "Patch status done on recurring task" "$DONE_REC"

T2_STATUS=$(echo "$DONE_REC" | jq -r '.status' 2>/dev/null || echo "")
assert_equals "Recurring task status after completion" "dormant" "$T2_STATUS"

T2_NEXT_DUE=$(echo "$DONE_REC" | jq -r '.next_due' 2>/dev/null || echo "")
assert_equals "Recurring next_due advances by +1 day" "2026-04-11" "$T2_NEXT_DUE"

echo ""
echo "── Park + snooze ─────────────────────────"

info "Creating task for park/snooze test"
T3_RESP=$(body -X POST "$BASE/api/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Park + snooze test\",\"column_id\":$COL_ID}")
assert_json_has "Create task T3" "$T3_RESP"
T3_ID=$(echo "$T3_RESP" | jq -r '.id' 2>/dev/null || echo "")
[[ -z "$T3_ID" || "$T3_ID" == "null" ]] && fail "Create task T3 — missing id" && exit 1

info "Setting next_due (so we can verify it is unchanged after snooze)"
PATCH_NEXT_DUE=$(body -X PATCH "$BASE/api/tasks/$T3_ID" \
  -H "Content-Type: application/json" \
  -d '{"next_due":"2026-04-05","visibility_days":3}')
assert_json_has "Setup next_due for T3" "$PATCH_NEXT_DUE"
NEXT_DUE_BEFORE=$(echo "$PATCH_NEXT_DUE" | jq -r '.next_due' 2>/dev/null || echo "")
[[ -z "$NEXT_DUE_BEFORE" || "$NEXT_DUE_BEFORE" == "null" ]] && fail "T3 next_due missing" && exit 1

info "Parking the task"
PARK_RESP=$(body -X POST "$BASE/api/tasks/$T3_ID/park")
assert_json_has "Park response" "$PARK_RESP"
COL_HIDDEN=$(echo "$PARK_RESP" | jq -r '.column.hidden' 2>/dev/null || echo "")
assert_equals "Park creates/uses hidden tile" "1" "$COL_HIDDEN"

TASK_COL_ID=$(echo "$PARK_RESP" | jq -r '.task.column_id' 2>/dev/null || echo "")
COL_ID_RESP=$(echo "$PARK_RESP" | jq -r '.column.id' 2>/dev/null || echo "")
assert_equals "Park moves task to hidden tile" "$COL_ID_RESP" "$TASK_COL_ID"

info "Snoozing the parked task"
SNOOZE_RESP=$(body -X POST "$BASE/api/tasks/$T3_ID/snooze")
assert_json_has "Snooze response" "$SNOOZE_RESP"

S_STATUS=$(echo "$SNOOZE_RESP" | jq -r '.status' 2>/dev/null || echo "")
assert_equals "Snooze sets dormant status" "dormant" "$S_STATUS"

S_SNOOZE_UNTIL=$(echo "$SNOOZE_RESP" | jq -r '.snooze_until' 2>/dev/null || echo "")
assert_equals "Snooze sets snooze_until=tomorrow" "$TOMORROW" "$S_SNOOZE_UNTIL"

S_NEXT_DUE=$(echo "$SNOOZE_RESP" | jq -r '.next_due' 2>/dev/null || echo "")
assert_equals "Snooze does not change next_due" "$NEXT_DUE_BEFORE" "$S_NEXT_DUE"

echo ""
echo "── Bookmarks ordering ────────────────────"

info "Creating bookmarks"
BM1_RESP=$(body -X POST "$BASE/api/bookmarks" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Integration View 1\",\"x\":1,\"y\":2,\"zoom\":1.0}")
BM2_RESP=$(body -X POST "$BASE/api/bookmarks" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Integration View 2\",\"x\":3,\"y\":4,\"zoom\":1.0}")
BM3_RESP=$(body -X POST "$BASE/api/bookmarks" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Integration View 3\",\"x\":5,\"y\":6,\"zoom\":1.0}")
assert_json_has "Bookmark 1" "$BM1_RESP"
assert_json_has "Bookmark 2" "$BM2_RESP"
assert_json_has "Bookmark 3" "$BM3_RESP"

BM1_ID=$(echo "$BM1_RESP" | jq -r '.id' 2>/dev/null || echo "")
BM2_ID=$(echo "$BM2_RESP" | jq -r '.id' 2>/dev/null || echo "")
BM3_ID=$(echo "$BM3_RESP" | jq -r '.id' 2>/dev/null || echo "")

bm_names_prefix='Integration View '

BMS_ALL=$(body "$BASE/api/bookmarks")
assert_json_has "GET /api/bookmarks" "$BMS_ALL"

ACT=$(echo "$BMS_ALL" | jq '[.[] | select(.name | startswith("'"$bm_names_prefix"'")) | {position, id}]')
SORTED=$(echo "$ACT" | jq 'sort_by(.position,.id)')

ACT_LEN=$(echo "$ACT" | jq 'length')
if [[ "$ACT_LEN" -ne 3 ]]; then
  fail "Expected exactly 3 integration bookmarks, got $ACT_LEN"
else
  if [[ "$ACT" == "$SORTED" ]]; then
    ok "Bookmarks ordered by (position ASC, id ASC)"
  else
    fail "Bookmarks ordering mismatch. ACT=$ACT SORTED=$SORTED"
  fi
fi

info "Cleaning up bookmarks"
curl -s -X DELETE "$BASE/api/bookmarks/$BM1_ID" >/dev/null 2>&1 || true
curl -s -X DELETE "$BASE/api/bookmarks/$BM2_ID" >/dev/null 2>&1 || true
curl -s -X DELETE "$BASE/api/bookmarks/$BM3_ID" >/dev/null 2>&1 || true

echo ""
echo "────────────────────────────────────────"
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ "$FAIL" -ne 0 ]]; then
  echo "Failures:"
  printf '%s\n' "${ERRORS[@]}"
  exit 1
fi

