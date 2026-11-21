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
# shellcheck disable=SC2016  # single quotes on purpose: $PATH expands on the host
REMOTE_PATH='export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin";'
r()     { "${SSH[@]}" "$HOST" "$REMOTE_PATH $*"; }
droid() { r "bash ~/$REMOTE_DIR/test/mobile/droid.sh $(printf '%q ' "$@")"; }

LOCKED=0; SERVER_STARTED=0; EMULATOR_WAS_RUNNING=1; REVERSED=0; TUNNEL=0; STEP=0; NET_OFF=0; ROTATED=0
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
    # Both throwaway servers (the sign-in-required one only exists briefly)
    [[ $SERVER_STARTED == 1 ]] && r "kill \$(cat '$RUN_TMP'/*.pid) 2>/dev/null; sleep 1; kill -9 \$(cat '$RUN_TMP'/*.pid) 2>/dev/null; rm -rf '$RUN_TMP'"
    [[ $NET_OFF == 1 ]] && droid net on
    [[ $ROTATED == 1 ]] && droid rotate portrait
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
# (Re)starts the server on the same temp DB; the offline checks stop and
# restart it to simulate a deploy or crash.
start_server() {
  r "cd ~/$REMOTE_DIR && SINGLE_USER_MODE=true PORT=$PORT DB_PATH=$RUN_TMP/test.db \
     nohup node server.js >> $RUN_TMP/server.log 2>&1 < /dev/null & echo \$! > $RUN_TMP/server.pid"
  r "for i in \$(seq 1 30); do curl -fs localhost:$PORT/health >/dev/null && exit 0; sleep 1; done; exit 1" \
    || { r "tail -20 $RUN_TMP/server.log" >&2; setup_fail "server did not become healthy"; }
}
# SIGKILL, not SIGTERM: server.js's graceful shutdown waits for open
# connections, and the live-update (SSE) streams never close by themselves,
# so a SIGTERM'd server keeps serving them while refusing new requests.
stop_server() {
  r "kill -9 \$(cat $RUN_TMP/server.pid) 2>/dev/null; for i in \$(seq 1 20); do curl -fs localhost:$PORT/health >/dev/null || exit 0; sleep 0.5; done; exit 1" \
    || setup_fail "server did not stop"
}
SERVER_STARTED=1
start_server

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

TODAY_ADD="+ Add task"                 # the Today screen's capture button
CAPTURE_HINT="What needs doing?"      # the capture field's placeholder
droid open "$BASE/"
sleep 3
droid dismiss-popups
droid open "$BASE/"     # first-run screens can swallow the first navigation
label=$(tr '[:lower:]' '[:upper:]' <<<"$first_col")   # tile names render uppercase
if droid wait-for "$TODAY_ADD" 45; then ok "the phone opens to the Today screen"
else shot today-missing; fail "the phone did not open to the Today screen within 45s"; fi
shot today-home
droid tap-text "Show board" || { shot no-board-button; fail "no 'Show board' (📅) button on the Today screen"; }
if droid wait-for "$label" 15; then ok "one tap on 📅 shows the board with the '$first_col' tile"
else shot board-missing; fail "the board did not show the '$first_col' tile after tapping 📅"; fi
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

# ── Phone: Today screen and quick capture ──────────────────────
echo; echo "Phone: Today screen and quick capture"

second_col=$(jq -r 'sort_by(.x) | .[1].name' <<<"$cols")
second_col_id=$(jq -r 'sort_by(.x) | .[1].id' <<<"$cols")
[[ -n "$second_col" && "$second_col" != null ]] || fail "fresh server has fewer than two tiles to test against"

# Evaluate JS in the page (DevTools protocol over adb; see droid.sh eval).
page() { droid eval "$BASE/" "$1"; }

# Wait until the API has a task with this title; prints "column_id status".
task_in_api() {
  local t="$1" found=""
  for _ in $(seq 1 15); do
    found=$(curl -fs "$API/api/tasks" | jq -r --arg t "$t" '.[] | select(.title == $t) | "\(.column_id) \(.status)"' 2>/dev/null)
    [[ -n "$found" ]] && { echo "$found"; return 0; }
    sleep 1
  done
  return 1
}

# Every header control must sit fully inside the screen, and the offline
# note (when shown) must be fully readable and not overlap any control.
# shellcheck disable=SC2016  # JS template literal, not shell expansion
HEADER_FIT_JS='(() => {
  const vw = document.documentElement.clientWidth;
  const header = document.querySelector(".app-header");
  const shown = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const controls = [...header.querySelectorAll("button, .user-trigger, .app-title__mark, .sync-stamp")].filter(shown);
  const out = controls.filter(el => { const r = el.getBoundingClientRect(); return r.left < 0 || r.right > vw + 0.5; })
                      .map(el => el.id || el.className);
  const note = document.getElementById("offline-note");
  let noteProblem = "";
  if (shown(note)) {
    const n = note.getBoundingClientRect();
    if (note.scrollWidth > note.clientWidth + 1 || n.left < 0 || n.right > vw + 0.5) noteProblem = "offline note is cut off";
    const hit = controls.find(el => { const r = el.getBoundingClientRect();
      return r.left < n.right && n.left < r.right && r.top < n.bottom && n.top < r.bottom; });
    if (hit) noteProblem = "offline note overlaps " + (hit.id || hit.className);
  }
  if (header.scrollWidth > header.clientWidth + 1) out.push("header scrolls sideways");
  return out.length || noteProblem ? `width ${vw}px: ${out.concat(noteProblem || []).join(", ")}` : "fits";
})()'

# 1. Back to Today; capture from its button into a non-default tile.
droid tap-text "Show Today" || { shot no-today-button; fail "no 'Show Today' (📅) button on the board"; }
droid wait-for "$TODAY_ADD" 15 || { shot today-not-back; fail "tapping 📅 on the board did not return to the Today screen"; }
fit=$(page "$HEADER_FIT_JS") || fail "could not inspect the header layout"
[[ "$fit" == fits ]] || { shot header-clipped; fail "phone header does not fit: $fit"; }
ok "the phone header fits the screen with every control visible"

# Chrome keeps localStorage for this origin between runs (an aborted run
# skips the uninstall that clears it), so forget any remembered tile first.
page 'localStorage.removeItem("taskpapr.captureTileId"); "ok"' >/dev/null || fail "could not reset the remembered tile"
droid tap-text "$TODAY_ADD"
droid wait-for "$CAPTURE_HINT" 10 || { shot no-capture; fail "'+ Add task' on the Today screen did not open capture"; }
[[ "$(page 'document.activeElement && document.activeElement.id')" == capture-input ]] \
  || { shot capture-unfocused; fail "capture opened without the text field focused"; }
ok "'+ Add task' opens capture with the field focused"
shot capture-open
droid tap-text "$first_col" || { shot no-tile-picker; fail "capture's tile picker does not show '$first_col' by default"; }
droid wait-for "$second_col" 10 || { shot picker-list; fail "the tile picker did not list '$second_col'"; }
droid tap-text "$second_col"
sleep 1
droid tap-text "$CAPTURE_HINT"
cap1="Captured one $(date +%H%M%S)"
droid type "$cap1"
droid key 66
found=$(task_in_api "$cap1") || { shot capture-missing; fail "task '$cap1' captured on the phone never reached the API"; }
read -r got_col got_status <<<"$found"
[[ "$got_col" == "$second_col_id" ]] || fail "captured task landed in tile $got_col, expected '$second_col' ($second_col_id)"
ok "capture saves the task in the chosen tile ('$second_col')"
droid wait-for "Added to $second_col" 5 || { shot no-confirmation; fail "no 'Added to $second_col' confirmation after saving"; }
ok "saving shows a quiet confirmation"
droid has "$CAPTURE_HINT" && { shot capture-stuck; fail "capture stayed open after saving"; }

droid tap-text "$TODAY_ADD"
droid wait-for "$CAPTURE_HINT" 10 || fail "capture did not reopen"
[[ "$(page 'document.getElementById("capture-tile").selectedOptions[0].text')" == "$second_col" ]] \
  || { shot picker-forgot; fail "the tile picker did not remember '$second_col'"; }
ok "the tile picker remembers the last tile used on this device"
droid tap-text Close

# 2. Today list: same tasks, same order as the Today tile; ticks off by touch.
mk_today() {   # title order → task id
  local id
  id=$(curl -fs -X POST -H 'Content-Type: application/json' \
       -d "$(jq -n --arg t "$1" --argjson c "$first_col_id" '{title:$t, column_id:$c}')" "$API/api/tasks" | jq -r .id) || return 1
  curl -fs -X PATCH -H 'Content-Type: application/json' \
       -d "{\"today_flag\":true,\"today_order\":$2}" "$API/api/tasks/$id" >/dev/null || return 1
  echo "$id"
}
today1="Today one"; today2="Today two"
# Flag in reverse creation order, so Today order differs from board order.
mk_today "$today2" 2 >/dev/null || fail "could not flag '$today2' for Today via the API"
id1=$(mk_today "$today1" 1) || fail "could not flag '$today1' for Today via the API"
if droid wait-for "$today1" 20 && droid wait-for "$today2" 5; then ok "tasks flagged elsewhere appear on the Today screen live (SSE)"
else shot today-not-live; fail "tasks flagged via the API did not appear on the Today screen"; fi
order=$(page 'JSON.stringify([...document.querySelectorAll("#phone-today-list .today-task-title")].map(e => e.textContent))')
expected=$(page 'JSON.stringify(todayTasksSorted().map(t => t.title))')
[[ "$order" == "$expected" && "$order" == "[\"$today1\",\"$today2\"]" ]] \
  || fail "Today screen order $order differs from the Today tile's $expected"
ok "the Today screen lists the Today tile's tasks in the same order"
shot today-list
droid tap-text "Mark done: $today1" || { shot no-checkbox; fail "no checkbox for '$today1'"; }
done_status=""
for _ in $(seq 1 15); do
  done_status=$(curl -fs "$API/api/tasks" | jq -r --argjson id "$id1" '.[] | select(.id == $id) | .status')
  [[ "$done_status" == "done" ]] && break; sleep 1
done
[[ "$done_status" == "done" ]] || { shot tick-failed; fail "ticking '$today1' did not mark it done in the API (status: $done_status)"; }
for _ in $(seq 1 10); do droid has "$today1" || break; sleep 1; done
droid has "$today1" && { shot ticked-still-shown; fail "'$today1' is done but still listed on the Today screen"; }
ok "ticking a task completes it via the API and removes it from Today"
shot today-ticked

# Changes made while the app is in the background show as soon as it's back,
# not after the 5-minute safety-net poll (the live-update stream is dropped
# or ignored while hidden). A marker on window proves the page wasn't reloaded.
today3="Today three"
# Count full data refreshes from here on (refreshAllData is a global function).
[[ "$(page 'window.__catchUpMarker = 1; window.__refreshes = 0;
  const orig = refreshAllData;
  refreshAllData = (...args) => { window.__refreshes++; return orig(...args); };
  document.visibilityState')" == visible ]] \
  || fail "could not mark the page before backgrounding it"
droid key 3; sleep 3
[[ "$(page 'document.visibilityState')" == hidden ]] || fail "Chrome did not go to the background"
mk_today "$today3" 3 >/dev/null || fail "could not flag '$today3' for Today via the API"
sleep 5   # let the change's live-update event arrive while hidden
droid resume com.android.chrome
if droid wait-for "$today3" 10; then
  [[ "$(page 'String(window.__catchUpMarker)')" == 1 ]] || fail "the page reloaded on resume, so the catch-up wasn't what showed the change"
  ok "a change made while the app was in the background shows within seconds of returning"
  sleep 15   # long enough for the live-update stream to reconnect and run its own catch-up
  refreshes=$(page 'String(window.__refreshes)')
  [[ "$refreshes" == 1 ]] || fail "returning to the app refreshed the board $refreshes times for one change (expected 1)"
  ok "returning to the app refreshes the board once, not once per resume signal"
else shot resume-stale; fail "after returning to the app, '$today3' (flagged while it was in the background) was not shown within 10s"; fi

# 3. The app shortcut's URL opens capture directly: one action from the home screen.
droid open "$BASE/?capture=1"
droid wait-for "$CAPTURE_HINT" 30 || { shot shortcut-no-capture; fail "/?capture=1 did not open capture"; }
[[ "$(page 'document.activeElement && document.activeElement.id')" == capture-input ]] \
  || { shot shortcut-unfocused; fail "/?capture=1 opened capture without focusing the field"; }
[[ "$(page 'location.search')" == "" ]] || fail "/?capture=1 left the parameter in the URL (a reload would reopen capture)"
cap2="Captured two $(date +%H%M%S)"
droid type "$cap2"
droid key 66
found=$(task_in_api "$cap2") || { shot shortcut-capture-missing; fail "task '$cap2' captured via /?capture=1 never reached the API"; }
[[ "${found%% *}" == "$second_col_id" ]] || fail "task captured via /?capture=1 went to tile ${found%% *}, not the remembered '$second_col'"
ok "/?capture=1 opens a focused capture field: type, Enter, saved to the remembered tile"

# 4. A capture that can't be saved says so and keeps the text.
droid tap-text "$TODAY_ADD"
droid wait-for "$CAPTURE_HINT" 10 || fail "capture did not open for the failure check"
cap3="Captured three $(date +%H%M%S)"
droid type "$cap3"
stop_server
droid key 66
CAPTURE_OFFLINE="Offline: not saved. Your text is still here; try again when you're back online."
droid wait-for "$CAPTURE_OFFLINE" 20 || { shot no-capture-error; fail "a capture that could not be saved showed no error"; }
droid has "$cap3" || { shot capture-text-lost; fail "the failed capture's text was cleared"; }
ok "a failed capture is shown, with the text kept for retry"
droid wait-for "Offline · changes won't save" 20 || { shot no-note-capture; fail "no offline note after the server went away"; }
fit=$(page "$HEADER_FIT_JS") || fail "could not inspect the header layout"
[[ "$fit" == fits ]] || { shot header-clipped-offline; fail "phone header does not fit while offline: $fit"; }
ok "the phone header still fits with the offline note showing"
shot capture-failed-offline
start_server
for _ in $(seq 1 30); do droid has "Offline · changes won't save" || break; sleep 1; done
droid tap-text Add || fail "no Add button to retry the capture"
task_in_api "$cap3" >/dev/null || { shot retry-missing; fail "retrying the capture after reconnecting did not save it"; }
ok "retrying after reconnecting saves the kept text"

# 5. Wide screens are unchanged: in landscape (wider than 600px) taskpapr
#    shows the canvas, and 📅 toggles the floating Today tile as before.
droid has "$CAPTURE_HINT" && { shot capture-left-open; fail "capture stayed open after the retry saved"; }
droid rotate landscape; ROTATED=1
wide=""
for _ in $(seq 1 15); do
  wide=$(page 'JSON.stringify({ phone: matchMedia("(max-width: 600px)").matches,
    today: !document.getElementById("phone-today").classList.contains("hidden") })') || true
  [[ "$wide" == '{"phone":false,"today":false}' ]] && break; sleep 1
done
[[ "$wide" == '{"phone":false,"today":false}' ]] || { shot wide-phone-ui; fail "a wide screen still shows the phone Today screen ($wide)"; }
droid wait-for "$label" 15 || { shot wide-no-board; fail "a wide screen does not show the board"; }
tile=$(page 'document.getElementById("btn-today").click(); new Promise(r => setTimeout(() => r(JSON.stringify({
    tile: !!document.getElementById("today-tile"),
    rows: [...document.querySelectorAll("#today-tile .today-task-title")].map(e => e.textContent) })), 300))')
[[ "$tile" == "{\"tile\":true,\"rows\":[\"$today2\",\"$today3\"]}" ]] || { shot wide-no-tile; fail "on a wide screen 📅 did not open the Today tile as before ($tile)"; }
shot wide-today-tile
[[ "$(page 'document.getElementById("btn-today").click(); !!document.getElementById("today-tile")')" == false ]] \
  || fail "on a wide screen 📅 did not close the Today tile again"
ok "wide screens keep the canvas and the floating Today tile"
droid rotate portrait; ROTATED=0
droid wait-for "$TODAY_ADD" 15 || { shot portrait-not-today; fail "back in portrait, the Today screen did not return"; }

# ── PWA: installable, standalone, honest offline ──────────────
echo; echo "PWA: install, standalone launch, offline"

# 1. The install files are public: Chrome fetches the manifest without
#    cookies, so behind the sign-in gate installation would silently fail.
version=$(jq -r .version "$ROOT/package.json")
manifest=$(curl -fs "$API/manifest.webmanifest") || fail "GET /manifest.webmanifest failed"
jq -e '.display == "standalone" and .start_url == "/"
       and any(.icons[]; .purpose == "maskable")
       and any(.shortcuts[]; .name == "Add task")' <<<"$manifest" >/dev/null \
  || fail "manifest lacks standalone display, a maskable icon or the 'Add task' shortcut"
while read -r icon; do
  curl -fs -o /dev/null "$API$icon" || fail "manifest icon $icon is not served"
done < <(jq -r '.icons[].src' <<<"$manifest")
sw_headers=$(curl -fs -D - -o /dev/null "$API/sw.js") || fail "GET /sw.js failed"
grep -qi '^content-type: application/javascript' <<<"$sw_headers" || fail "/sw.js is not served as JavaScript"
grep -qi '^cache-control: no-cache' <<<"$sw_headers" || fail "/sw.js must be served with Cache-Control: no-cache"
curl -fs "$API/sw.js" | grep -qF "const VERSION = '$version'" || fail "/sw.js is not stamped with version $version"
ok "manifest, icons and the service worker (stamped v$version) are served"

# Same check against a second throwaway server that requires sign-in
# (fake GitHub OAuth credentials; nothing ever contacts GitHub).
AUTH_PORT=$((PORT + 1))
r "curl -fs localhost:$AUTH_PORT/health >/dev/null" \
  && setup_fail "something is already listening on the host's port $AUTH_PORT"
r "cd ~/$REMOTE_DIR && SINGLE_USER_MODE=false GITHUB_CLIENT_ID=mobile-test GITHUB_CLIENT_SECRET=mobile-test \
   PORT=$AUTH_PORT DB_PATH=$RUN_TMP/auth.db nohup node server.js > $RUN_TMP/auth.log 2>&1 < /dev/null & echo \$! > $RUN_TMP/auth.pid"
r "for i in \$(seq 1 30); do curl -fs localhost:$AUTH_PORT/health >/dev/null && exit 0; sleep 1; done; exit 1" \
  || { r "tail -20 $RUN_TMP/auth.log" >&2; setup_fail "sign-in-required server did not become healthy"; }
codes=$(r "for u in / /manifest.webmanifest /sw.js /icons/maskable_512.png; do curl -s -o /dev/null -w '%{http_code} ' localhost:$AUTH_PORT\$u; done")
r "kill \$(cat $RUN_TMP/auth.pid); rm -f $RUN_TMP/auth.pid"
[[ "$codes" == "302 200 200 200 " ]] \
  || fail "with sign-in required, expected / → 302 and manifest, worker, icon → 200; got: $codes"
ok "with sign-in required, the board redirects to /login but the install files stay public"

# 2. Install from Chrome's menu. Start clean: remove taskpapr icons left on the
#    home screen by earlier runs, or Chrome would offer "Open" instead.
droid key 3; sleep 2
for _ in 1 2 3; do
  droid has taskpapr || break
  droid long-press taskpapr; sleep 1
  droid tap-text Remove >/dev/null 2>&1; sleep 1
done
droid has taskpapr && { shot old-icon-stuck; fail "could not remove the taskpapr icon left by an earlier run"; }

droid open "$BASE/"
droid wait-for "$TODAY_ADD" 30 || { shot board-before-install; fail "taskpapr did not load before install"; }
droid tap-text "Customize and control Google Chrome" 2>/dev/null \
  || droid tap-text "Update available. More options" 2>/dev/null \
  || { shot no-chrome-menu; fail "could not find Chrome's menu button"; }
droid wait-for "Add to Home screen" 10 || { shot no-a2hs; fail "Chrome's menu has no 'Add to Home screen'"; }
droid tap-text "Add to Home screen"
# Chrome only says "Install app" when the manifest and service worker make
# the site installable; otherwise it offers a plain bookmark shortcut.
if droid wait-for "Install app" 15; then ok "Chrome offers to install taskpapr as an app"
else shot not-installable; fail "Chrome offered a bookmark shortcut, not 'Install app': not installable"; fi
droid tap-text Install
# Without a WebAPK (e.g. on localhost) the launcher asks to confirm the icon.
droid wait-for "Add to home screen" 20 && droid tap-text "Add to home screen"
sleep 3
droid key 3; sleep 2
droid wait-for taskpapr 15 || { shot no-icon; fail "no taskpapr icon on the home screen after installing"; }
if droid has-package 'org\.chromium\.webapk\.'; then install_kind=WebAPK
else install_kind="shortcut (no WebAPK minted, as expected on localhost)"; fi
info "installed as: $install_kind"
shot installed-icon

# 3. Launch from the home screen: it must open standalone, without browser UI.
droid tap-text taskpapr
droid wait-for "$TODAY_ADD" 30 || { shot app-board-missing; fail "the installed app did not show the Today screen"; }
activity=$(droid top-activity)
if [[ "$activity" =~ (WebappActivity|webapk) ]] \
   && ! droid has "Customize and control Google Chrome" && ! droid has "Update available. More options"; then
  ok "the installed app launches standalone, without the browser toolbar ($activity)"
else shot not-standalone; fail "the installed app opened with browser UI ($activity)"; fi
shot standalone

# 4. The server going away while the network stays up (deploy, crash,
#    sleeping instance) and the board sits idle: the dropped live-update
#    stream must lead to the offline note, which clears once it's back.
OFFLINE_NOTE="Offline · changes won't save"
stop_server
if droid wait-for "$OFFLINE_NOTE" 40; then ok "the server going away shows the offline note, with no user action"
else shot no-note-server-gone; fail "no offline note after the server became unreachable"; fi
start_server
for _ in $(seq 1 30); do droid has "$OFFLINE_NOTE" || break; sleep 1; done
droid has "$OFFLINE_NOTE" && { shot note-stuck-server-back; fail "the offline note stayed after the server came back"; }
ok "the offline note clears once the server is reachable again"

# Losing the network entirely while the board is open shows it too.
droid net off; NET_OFF=1
droid unreverse "$PORT"   # and make the server itself unreachable
if droid wait-for "$OFFLINE_NOTE" 20; then ok "losing the connection shows '$OFFLINE_NOTE'"
else shot no-offline-note; fail "no offline note after the connection dropped"; fi
shot offline-live

# 5. Opening the app with no connection: the cached shell loads, says it
#    can't reach taskpapr, and shows no board data as if it were current.
droid force-stop com.android.chrome
droid key 3; sleep 2
droid tap-text taskpapr
UNAVAILABLE="Can't reach taskpapr. Your board will load when you're back online."
droid wait-for "$UNAVAILABLE" 30 || { shot cold-offline; fail "opening offline did not explain that the board can't load"; }
droid has "$today2" && { shot cold-offline-stale; fail "opening offline showed the Today task '$today2' from an earlier load"; }
droid has "$OFFLINE_NOTE" || { shot cold-offline-no-note; fail "opening offline did not show the offline note"; }
ok "opening offline shows the cached shell with an explanation, and no stale tasks"
shot offline-cold

# 6. Back online: the board loads by itself and the note clears.
droid reverse "$PORT"
droid net on; NET_OFF=0
droid wait-for "$today2" 45 || { shot no-recovery; fail "the Today screen did not load after the connection came back"; }
droid has "$OFFLINE_NOTE" && { shot note-stuck; fail "the offline note is still shown after reconnecting"; }
ok "reconnecting loads the board and clears the offline note"
shot back-online

# 7. The "Add task" app shortcut. Manifest shortcuts only exist for WebAPK
#    installs, so on a plain shortcut install only its URL can be checked.
if [[ "$install_kind" == WebAPK ]]; then
  droid key 3; sleep 2
  droid long-press taskpapr
  droid wait-for "Add task" 10 || { shot no-shortcut; fail "long-pressing the app icon does not offer 'Add task'"; }
  droid tap-text "Add task"
  droid wait-for "$CAPTURE_HINT" 30 || { shot shortcut-board; fail "the 'Add task' shortcut did not open capture"; }
  ok "long-pressing the icon offers 'Add task', which opens capture"
else
  echo -e "  ${YELLOW}–${NC}  SKIP long-press 'Add task': needs a WebAPK install (check on a real phone over https)"
  droid open "$BASE/?capture=1"
  droid wait-for "$CAPTURE_HINT" 30 || { shot capture-url; fail "the shortcut's URL /?capture=1 does not open capture"; }
  ok "the shortcut's URL /?capture=1 opens capture"
fi
