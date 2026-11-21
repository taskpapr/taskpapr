#!/usr/bin/env bash
# ============================================================
# droid.sh — drive the Android emulator used by test/mobile.sh
#
# Runs ON the test host (the machine with the Android SDK and emulator).
# test/mobile.sh copies the repo there and calls it over ssh.
#
# Usage: droid.sh <command> [args]
#   boot                 start the AVD headless (no-op if running) and wait for boot
#   running              exit 0 if the AVD is running
#   stop                 shut the emulator down
#   reverse PORT         make the emulator's localhost:PORT reach the host's PORT
#   unreverse PORT       undo `reverse`
#   open URL             open URL in Chrome (reuses one dedicated tab)
#   shot FILE            save a PNG screenshot to FILE
#   texts                print visible text / content-desc / hint values
#   has LABEL            exit 0 if a visible node's text, content-desc or hint is LABEL
#   wait-for LABEL [SEC] wait (default 30s) until `has LABEL` succeeds
#   tap-text LABEL       tap the first visible node whose text, content-desc or hint is LABEL
#   type TEXT            type ASCII text into the focused field
#   key CODE             send a key event (66 = Enter, 4 = Back, 3 = Home)
#   long-press LABEL     touch and hold the first visible node labelled LABEL
#   top-activity         print the component of the foreground activity
#   has-package PATTERN  exit 0 if an installed package name matches PATTERN (ERE)
#   force-stop PKG       force-stop an app (e.g. com.android.chrome)
#   net on|off           turn the emulator's wifi and mobile data on or off
#   dismiss-popups       tap through Chrome first-run / promo dialogs
#
# Environment:
#   ANDROID_HOME   SDK location (default: ~/Library/Android/sdk)
#   MOBILE_AVD     AVD name (default: taskpapr_pixel)
#
# Gotchas baked in:
#   - every adb call reads </dev/null, otherwise `adb shell` swallows the stdin
#     of whatever script invoked us (e.g. a heredoc sent over ssh)
#   - the emulator runs with -gpu swangle_indirect; swiftshader_indirect crashes
#     as soon as Chrome renders a page
#   - Chrome keeps hidden copies of some inputs with zero-size bounds; those
#     are skipped when matching
# ============================================================

set -uo pipefail

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ADB="$SDK/platform-tools/adb"
EMULATOR="$SDK/emulator/emulator"
AVD="${MOBILE_AVD:-taskpapr_pixel}"
CHROME_TAB_ID="taskpapr-mobile-test"

die() { echo "droid: $*" >&2; exit 1; }
a()   { "$ADB" "$@" </dev/null; }

[[ -x "$ADB" ]] || die "adb not found at $ADB (set ANDROID_HOME)"

is_running() { pgrep -f -- "-avd $AVD( |\$)" >/dev/null 2>&1; }

# One <node .../> per line from the current UI hierarchy.
dump() {
  a shell uiautomator dump /sdcard/droid-ui.xml >/dev/null 2>&1
  a shell cat /sdcard/droid-ui.xml | tr '>' '\n'
}

# Grep-safe exact match on text, content-desc or hint; skips zero-size nodes.
visible_matches() {
  local label="$1" esc
  # XML-escape first (uiautomator writes &amp; / &quot;), then escape every ERE metacharacter.
  esc=$(printf '%s' "$label" | sed -e 's/&/\&amp;/g' -e 's/"/\&quot;/g' -e 's/[][\.*^$/+?(){}|]/\\&/g')
  dump | grep -E "(text|content-desc|hint)=\"$esc\"" | grep -v 'bounds="\[0,0\]\[0,0\]"'
}

center_of() {
  # stdin: node lines; stdout: "X Y" of the first node's bounds centre
  local b
  b=$(head -1 | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -oE '[0-9]+' | tr '\n' ' ')
  # shellcheck disable=SC2086
  set -- $b
  [[ $# -eq 4 ]] || return 1
  echo "$(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  boot)
    [[ -x "$EMULATOR" ]] || die "emulator not found at $EMULATOR"
    # An emulator that is still shutting down looks "running" for a few
    # seconds, so (re)launch whenever none is running rather than only once.
    launched=0
    for _ in $(seq 1 120); do
      [[ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]] && break
      if ! is_running; then
        (( launched < 2 )) || die "emulator exited during boot (see ~/emulator.log)"
        nohup "$EMULATOR" -avd "$AVD" -no-window -no-audio -no-boot-anim \
          -gpu swangle_indirect -no-snapshot-save >"$HOME/emulator.log" 2>&1 </dev/null &
        disown
        launched=$((launched + 1))
      fi
      sleep 2
    done
    [[ "$(a shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]] || die "emulator did not finish booting within 240s"
    a shell settings put system screen_off_timeout 2147483647 >/dev/null
    a shell wm dismiss-keyguard >/dev/null 2>&1 || a shell input keyevent 82
    echo booted ;;
  running)   is_running ;;
  stop)
    is_running || { echo "not running"; exit 0; }
    a emu kill >/dev/null 2>&1
    for _ in $(seq 1 30); do is_running || { echo stopped; exit 0; }; sleep 1; done
    die "emulator did not stop" ;;
  reverse)   a reverse "tcp:$1" "tcp:$1" >/dev/null ;;
  unreverse) a reverse --remove "tcp:$1" >/dev/null 2>&1 || true ;;
  open)
    a shell am start -n com.android.chrome/com.google.android.apps.chrome.Main \
      -a android.intent.action.VIEW -d "$1" \
      --es com.android.browser.application_id "$CHROME_TAB_ID" >/dev/null 2>&1 ;;
  shot)      a exec-out screencap -p > "$1" ;;
  texts)     dump | grep -oE '(text|content-desc|hint)="[^"]+"' ;;
  has)       [[ -n "$(visible_matches "$1")" ]] ;;
  wait-for)
    deadline=$(( SECONDS + ${2:-30} ))
    while (( SECONDS < deadline )); do
      [[ -n "$(visible_matches "$1")" ]] && exit 0
      sleep 1
    done
    exit 1 ;;
  tap-text)
    xy=$(visible_matches "$1" | center_of) || die "no visible node labelled '$1'"
    # shellcheck disable=SC2086
    a shell input tap $xy ;;
  type)
    # `input text` treats spaces as separators; %s is its escape for a space.
    a shell input text "$(printf '%s' "$1" | sed 's/ /%s/g')" ;;
  key)       a shell input keyevent "$1" ;;
  long-press)
    xy=$(visible_matches "$1" | center_of) || die "no visible node labelled '$1'"
    # shellcheck disable=SC2086
    set -- $xy
    a shell input swipe "$1" "$2" "$1" "$2" 1500 ;;
  top-activity)
    a shell dumpsys activity activities | grep -m1 topResumedActivity \
      | grep -oE '[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+' | head -1 ;;
  has-package) a shell pm list packages | grep -qE "$1" ;;
  force-stop)  a shell am force-stop "$1" ;;
  net)
    case "${1:-}" in
      on)  a shell svc wifi enable;  a shell svc data enable ;;
      off) a shell svc wifi disable; a shell svc data disable ;;
      *)   die "usage: net on|off" ;;
    esac ;;
  dismiss-popups)
    # Chrome first-run, sign-in and promo screens. Loop until none are found.
    for _ in 1 2 3 4 5 6; do
      tapped=0
      for label in "Stay signed out" "No thanks" "No, thanks" "Use without an account" \
                   "Got it" "Accept & continue" "Not now" "Skip"; do
        xy=$(visible_matches "$label" | center_of) || continue
        # shellcheck disable=SC2086
        a shell input tap $xy; tapped=1; sleep 2; break
      done
      [[ $tapped == 1 ]] || break
    done ;;
  *) sed -n '/^# Usage/,/^# Environment/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'; exit 2 ;;
esac
