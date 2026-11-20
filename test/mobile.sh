#!/usr/bin/env bash
# ============================================================
# taskpapr mobile test — drives real Chrome in an Android emulator
#
# Usage: MOBILE_TEST_HOST=user@test-host bash test/mobile.sh
#
# The emulator lives on a separate test host (anything with the Android SDK,
# an AVD and hardware virtualisation, e.g. an Apple Silicon Mac); this script
# runs wherever the code is and drives the host over ssh. Per run it:
#   1. takes a lock on the host so only one run uses the emulator at a time
#   2. copies this checkout to the host (rsync) and installs deps there
#   3. starts a THROWAWAY single-user server (temp DB, never a real instance)
#   4. boots the emulator and maps its localhost:PORT to the server (adb
#      reverse), so Chrome sees a secure context, as a PWA needs
#   5. drives Chrome through the UI and checks results through the API
#   6. copies screenshots back here, then tears everything down — even on
#      failure
#
# See test/mobile/README.md for host setup and environment variables.
# Requires locally: bash, ssh, rsync, curl, jq.
# Exit code: 0 = all passed, 1 = a check failed, 2 = setup problem.
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${MOBILE_TEST_HOST:-}"
REMOTE_DIR="${MOBILE_REMOTE_DIR:-taskpapr-mobile-test}"   # relative to the host's $HOME
PORT="${MOBILE_PORT:-3099}"                                # server port on the host
LOCAL_PORT="${MOBILE_LOCAL_PORT:-3199}"                    # tunnel port here, for API checks
SHOTS_DIR="${MOBILE_SHOTS_DIR:-$ROOT/test/mobile/screenshots}"
LOCK_WAIT="${MOBILE_LOCK_WAIT:-900}"                       # seconds to wait for the emulator lock
LOCK_STALE="${MOBILE_LOCK_STALE:-3600}"                    # a lock older than this is presumed dead
BASE="http://localhost:$PORT"                              # URL as Chrome on the emulator sees it
API="http://localhost:$LOCAL_PORT"                         # same server, via the ssh tunnel

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0
ok()    { echo -e "  ${GREEN}✓${NC}  $1"; PASS=$((PASS+1)); }
info()  { echo -e "  ${YELLOW}→${NC}  $1"; }
fail()  { echo -e "  ${RED}✗${NC}  $1" >&2; exit 1; }
setup_fail() { echo -e "  ${RED}✗${NC}  setup: $1" >&2; exit 2; }

[[ -n "$HOST" ]] || setup_fail "set MOBILE_TEST_HOST=user@host (the machine running the Android emulator)"
for t in ssh rsync curl jq; do command -v "$t" >/dev/null || setup_fail "'$t' is required locally"; done

# ── One multiplexed ssh connection for the whole run ─────────
CTL_DIR="$(mktemp -d)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ControlMaster=auto
     -o "ControlPath=$CTL_DIR/ctl" -o ControlPersist=120)
# Non-interactive ssh shells on macOS often lack Homebrew in PATH.
REMOTE_PATH='export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin";'
r()     { "${SSH[@]}" "$HOST" "$REMOTE_PATH $*"; }
droid() { r "bash ~/$REMOTE_DIR/test/mobile/droid.sh $(printf '%q ' "$@")"; }

LOCKED=0; SERVER_STARTED=0; EMULATOR_WAS_RUNNING=1; REVERSED=0; TUNNEL=0; STEP=0
RUN_TMP=""

cleanup() {
  local code=$?
  set +e
  if [[ $LOCKED == 1 ]]; then
    echo; info "tearing down"
    mkdir -p "$SHOTS_DIR"
    rm -f "$SHOTS_DIR"/*.png   # only this run's screenshots
    rsync -a -e "${SSH[*]}" "$HOST:$REMOTE_DIR/.mobile-shots/" "$SHOTS_DIR/" 2>/dev/null \
      && info "screenshots: $SHOTS_DIR"
    [[ $SERVER_STARTED == 1 ]] && r "kill \$(cat '$RUN_TMP/server.pid') 2>/dev/null; sleep 1; rm -rf '$RUN_TMP'"
    [[ $REVERSED == 1 ]] && droid unreverse "$PORT"
    [[ $EMULATOR_WAS_RUNNING == 0 ]] && droid stop >/dev/null
    r "rm -rf ~/emulator.lock"
  fi
  [[ $TUNNEL == 1 ]] && "${SSH[@]}" -O cancel -L "$LOCAL_PORT:localhost:$PORT" "$HOST" 2>/dev/null
  "${SSH[@]}" -O exit "$HOST" 2>/dev/null
  rm -rf "$CTL_DIR"
  echo
  if [[ $code == 0 ]]; then echo -e "${GREEN}mobile: all $PASS checks passed${NC}"
  else echo -e "${RED}mobile: FAILED (exit $code) after $PASS passing checks${NC}"; fi
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

shot() {
  STEP=$((STEP+1))
  local name; name=$(printf '%02d-%s.png' "$STEP" "$1")
  droid shot "$REMOTE_DIR/.mobile-shots/$name" || true   # ssh starts in the host's $HOME
}

# ── Lock ──────────────────────────────────────────────────────
echo "taskpapr mobile test → $HOST"
r true || setup_fail "cannot ssh to $HOST"
info "acquiring emulator lock"
deadline=$(( SECONDS + LOCK_WAIT ))
until r "mkdir ~/emulator.lock 2>/dev/null && echo \"\$(date +%s) mobile.sh from $(hostname)\" > ~/emulator.lock/owner"; do
  age=$(r "echo \$(( \$(date +%s) - \$(cut -d' ' -f1 ~/emulator.lock/owner 2>/dev/null || date +%s) ))")
  if (( age > LOCK_STALE )); then
    info "removing stale lock (${age}s old)"; r "rm -rf ~/emulator.lock"; continue
  fi
  (( SECONDS < deadline )) || setup_fail "emulator lock still held after ${LOCK_WAIT}s: $(r 'cat ~/emulator.lock/owner')"
  sleep 5
done
LOCKED=1

# ── Code + deps on the host ───────────────────────────────────
info "syncing checkout to ~/$REMOTE_DIR"
rsync -az --delete -e "${SSH[*]}" \
  --exclude .git --exclude node_modules --exclude data --exclude '.env*' \
  --exclude .claude --exclude test/mobile/screenshots --exclude .mobile-shots --exclude .lockhash \
  "$ROOT/" "$HOST:$REMOTE_DIR/" || setup_fail "rsync to host failed"
r "rm -rf ~/$REMOTE_DIR/.mobile-shots && mkdir -p ~/$REMOTE_DIR/.mobile-shots"

node_ok=$(r "node -e 'const [a,b]=process.versions.node.split(\".\").map(Number);console.log(a>22||(a==22&&b>=5)?\"yes\":process.version)'" 2>/dev/null || echo missing)
[[ "$node_ok" == yes ]] || setup_fail "host needs Node 22.5+ on PATH (found: $node_ok)"

r "cd ~/$REMOTE_DIR && h=\$(shasum package-lock.json | cut -d' ' -f1) && \
   if [ -d node_modules ] && [ \"\$(cat .lockhash 2>/dev/null)\" = \"\$h\" ]; then echo deps-cached; \
   else npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null && echo \$h > .lockhash && echo deps-installed; fi" \
  | sed 's/^/  →  /' || setup_fail "npm ci failed on host"

# ── Throwaway server ──────────────────────────────────────────
r "curl -fs localhost:$PORT/health >/dev/null" \
  && setup_fail "something is already listening on the host's port $PORT (MOBILE_PORT to change)"
RUN_TMP=$(r "mktemp -d /tmp/taskpapr-mobile.XXXXXX")
info "starting throwaway server (single-user, temp DB in $RUN_TMP)"
r "cd ~/$REMOTE_DIR && SINGLE_USER_MODE=true PORT=$PORT DB_PATH=$RUN_TMP/test.db \
   nohup node server.js > $RUN_TMP/server.log 2>&1 < /dev/null & echo \$! > $RUN_TMP/server.pid"
SERVER_STARTED=1
r "for i in \$(seq 1 30); do curl -fs localhost:$PORT/health >/dev/null && exit 0; sleep 1; done; exit 1" \
  || { r "tail -20 $RUN_TMP/server.log" >&2; setup_fail "server did not become healthy"; }

curl -fs "http://localhost:$LOCAL_PORT/health" >/dev/null 2>&1 \
  && setup_fail "local port $LOCAL_PORT is busy (MOBILE_LOCAL_PORT to change)"
"${SSH[@]}" -O forward -L "$LOCAL_PORT:localhost:$PORT" "$HOST" 2>/dev/null || setup_fail "ssh port forward failed"
TUNNEL=1
curl -fs "$API/health" >/dev/null || setup_fail "server not reachable through the tunnel"

# ── Emulator ──────────────────────────────────────────────────
droid running || EMULATOR_WAS_RUNNING=0
info "booting emulator$([[ $EMULATOR_WAS_RUNNING == 1 ]] && echo ' (already running)')"
droid boot >/dev/null || setup_fail "emulator failed to boot"
droid reverse "$PORT" || setup_fail "adb reverse failed"
REVERSED=1

# ── Tests ─────────────────────────────────────────────────────
echo; echo "Baseline: board on the phone"

cols=$(curl -fs "$API/api/columns") || fail "GET /api/columns failed"
first_col=$(jq -r 'sort_by(.x) | .[0].name' <<<"$cols")
first_col_id=$(jq -r 'sort_by(.x) | .[0].id' <<<"$cols")
[[ -n "$first_col" && "$first_col" != null ]] || fail "fresh server has no tiles to test against"

droid open "$BASE/"
sleep 3
droid dismiss-popups
droid open "$BASE/"     # first-run screens can swallow the first navigation
label=$(tr '[:lower:]' '[:upper:]' <<<"$first_col")   # tile names render uppercase
if droid wait-for "$label" 45; then ok "board loads in Chrome and shows the '$first_col' tile"
else shot board-missing; fail "board did not show the '$first_col' tile within 45s"; fi
droid tap-text "⌂" 2>/dev/null || true   # reset pan/zoom left over in localStorage
sleep 1
shot board

title="Mobile check $(date +%H%M%S)"
droid tap-text "+ Add task…" || { shot no-add-input; fail "no visible '+ Add task…' input"; }
sleep 1
droid type "$title"
droid key 66
found=""
for _ in $(seq 1 15); do
  found=$(curl -fs "$API/api/tasks" | jq -r --arg t "$title" '.[] | select(.title == $t) | "\(.column_id) \(.status)"')
  [[ -n "$found" ]] && break
  sleep 1
done
[[ -n "$found" ]] || { shot add-task-missing; fail "task '$title' typed on the phone never reached the API"; }
read -r got_col got_status <<<"$found"
[[ "$got_col" == "$first_col_id" ]] || fail "task landed in tile $got_col, expected '$first_col' ($first_col_id)"
[[ "$got_status" == active ]] || fail "new task has status '$got_status', expected 'active'"
ok "adding a task by touch creates it via the API in '$first_col'"
if droid wait-for "$title" 10; then ok "the new task is shown on the board"
else shot add-task-not-shown; fail "task exists in the API but is not shown on the board"; fi
shot task-added
