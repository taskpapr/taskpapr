#!/usr/bin/env bash
# ============================================================
# taskpapr Android app test — builds the staging-flavour app (a Trusted Web
# Activity, see android/), installs it on the test host's emulator and checks
# that it launches into taskpapr.
#
# Usage: MOBILE_TEST_HOST=user@test-host bash test/android.sh
#
# Uses the same test host, emulator, lock and droid.sh as test/mobile.sh (see
# test/mobile/README.md). The app opens the real staging site, but only its
# public sign-in page: nothing signs in and no data is read or written.
#
# What it checks:
#   1. the staging release APK builds and is signed (signing is configured on
#      the host; see android/README.md)
#   2. it installs, launches, and Chrome shows the taskpapr sign-in page
#   3. whether Chrome verified the app against the site's
#      /.well-known/assetlinks.json: verified = full-screen, no URL bar.
#      Unverified only fails when ANDROID_EXPECT_VERIFIED=1, because it
#      depends on the deployed server's ANDROID_APP_LINKS, not on this code.
#
# Environment:
#   MOBILE_TEST_HOST         ssh target of the test host (required)
#   ANDROID_REMOTE_DIR       build directory on the host (default taskpapr-android-build)
#   ANDROID_EXPECT_VERIFIED  1 = fail if the URL bar is showing
#   ANDROID_LOCK_HELD        1 = the caller (e.g. test/mobile.sh) already holds
#                            the emulator lock, so don't take or release it
#   MOBILE_SHOTS_DIR         where screenshots land (default test/mobile/screenshots)
#   MOBILE_LOCK_WAIT / MOBILE_LOCK_STALE   as in test/mobile.sh
#
# Exit code: 0 = all passed, 1 = a check failed, 2 = setup problem.
# ============================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${MOBILE_TEST_HOST:-}"
REMOTE_DIR="${ANDROID_REMOTE_DIR:-taskpapr-android-build}"   # relative to the host's $HOME
SHOTS_DIR="${MOBILE_SHOTS_DIR:-$ROOT/test/mobile/screenshots}"
LOCK_WAIT="${MOBILE_LOCK_WAIT:-900}"
LOCK_STALE="${MOBILE_LOCK_STALE:-3600}"
EXPECT_VERIFIED="${ANDROID_EXPECT_VERIFIED:-0}"
LOCK_HELD="${ANDROID_LOCK_HELD:-0}"

PKG="com.taskpapr.app.staging"
LAUNCHER="com.google.androidbrowserhelper.trusted.LauncherActivity"
APK="android/app/build/outputs/apk/staging/release/app-staging-release.apk"
SIGN_IN="Sign in with GitHub"   # on the staging sign-in page

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0
ok()    { echo -e "  ${GREEN}✓${NC}  $1"; PASS=$((PASS+1)); }
info()  { echo -e "  ${YELLOW}→${NC}  $1"; }
fail()  { echo -e "  ${RED}✗${NC}  $1" >&2; exit 1; }
setup_fail() { echo -e "  ${RED}✗${NC}  setup: $1" >&2; exit 2; }

[[ -n "$HOST" ]] || setup_fail "set MOBILE_TEST_HOST=user@host (the machine running the Android emulator)"
for t in ssh rsync; do command -v "$t" >/dev/null || setup_fail "'$t' is required locally"; done

CTL_DIR="$(mktemp -d)"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ControlMaster=auto
     -o "ControlPath=$CTL_DIR/ctl" -o ControlPersist=120)
# The host's login shell config provides JAVA_HOME, ANDROID_HOME and the
# signing config (TASKPAPR_KEYSTORE_PROPERTIES); non-interactive zsh reads
# ~/.zshenv, so run commands through it.
r()     { "${SSH[@]}" "$HOST" "$*"; }
droid() { r "bash ~/$REMOTE_DIR/test/mobile/droid.sh $(printf '%q ' "$@")"; }
adb()   { r "\"\${ANDROID_HOME:-\$HOME/Library/Android/sdk}/platform-tools/adb\" $* </dev/null"; }

LOCKED=0; EMULATOR_WAS_RUNNING=1; INSTALLED=0; STEP=0

cleanup() {
  local code=$?
  set +e
  if [[ $LOCKED == 1 || $LOCK_HELD == 1 ]]; then
    echo; info "tearing down"
    mkdir -p "$SHOTS_DIR"
    rm -f "$SHOTS_DIR"/android-*.png   # only this script's screenshots
    rsync -a -e "${SSH[*]}" "$HOST:$REMOTE_DIR/.shots/" "$SHOTS_DIR/" 2>/dev/null \
      && info "screenshots: $SHOTS_DIR"
    [[ $INSTALLED == 1 ]] && adb uninstall "$PKG" >/dev/null
    [[ $EMULATOR_WAS_RUNNING == 0 ]] && droid stop >/dev/null
    [[ $LOCKED == 1 ]] && r "rm -rf ~/emulator.lock"
  fi
  "${SSH[@]}" -O exit "$HOST" 2>/dev/null
  rm -rf "$CTL_DIR"
  echo
  if [[ $code == 0 ]]; then echo -e "${GREEN}android: all $PASS checks passed${NC}"
  else echo -e "${RED}android: FAILED (exit $code) after $PASS passing checks${NC}"; fi
  exit $code
}
trap cleanup EXIT
trap 'exit 130' INT TERM

shot() {
  STEP=$((STEP+1))
  droid shot "$REMOTE_DIR/.shots/$(printf 'android-%02d-%s.png' "$STEP" "$1")" || true
}

# ── Build (no emulator needed, so before the lock) ────────────
echo "taskpapr android test → $HOST"
r true || setup_fail "cannot ssh to $HOST"
info "syncing android/ to ~/$REMOTE_DIR"
# (the host's shell may be zsh, where an unmatched glob is an error, so no globs)
r "rm -rf ~/$REMOTE_DIR/.shots && mkdir -p ~/$REMOTE_DIR/test/mobile ~/$REMOTE_DIR/.shots" \
  || setup_fail "cannot create ~/$REMOTE_DIR on the host"
rsync -az --delete -e "${SSH[*]}" --exclude .gradle --exclude build --exclude local.properties \
  "$ROOT/android/" "$HOST:$REMOTE_DIR/android/" || setup_fail "rsync to host failed"
rsync -az -e "${SSH[*]}" "$ROOT/package.json" "$HOST:$REMOTE_DIR/package.json"
rsync -az -e "${SSH[*]}" "$ROOT/test/mobile/droid.sh" "$HOST:$REMOTE_DIR/test/mobile/droid.sh"

info "building the staging release APK (first run downloads Gradle and dependencies)"
r "cd ~/$REMOTE_DIR/android && ./gradlew --no-daemon -q assembleStagingRelease </dev/null > ../build.log 2>&1" \
  || { r "tail -30 ~/$REMOTE_DIR/build.log" >&2; fail "the staging APK did not build"; }
# apksigner exits non-zero for an unsigned APK, i.e. no signing config on the host.
# Newest installed build-tools (several versions can coexist).
r "bt=\$(ls -d \"\${ANDROID_HOME:-\$HOME/Library/Android/sdk}\"/build-tools/* | tail -1) && \
   \"\$bt/apksigner\" verify ~/$REMOTE_DIR/$APK </dev/null" >/dev/null 2>&1 \
  || setup_fail "the APK built but isn't signed: set TASKPAPR_KEYSTORE_PROPERTIES on the host (android/README.md)"
ok "the staging release APK builds and is signed"

# ── Lock ──────────────────────────────────────────────────────
if [[ $LOCK_HELD != 1 ]]; then
  info "acquiring emulator lock"
  deadline=$(( SECONDS + LOCK_WAIT ))
  until r "mkdir ~/emulator.lock 2>/dev/null && echo \"\$(date +%s) android.sh from $(hostname)\" > ~/emulator.lock/owner"; do
    age=$(r "echo \$(( \$(date +%s) - \$(cut -d' ' -f1 ~/emulator.lock/owner 2>/dev/null || date +%s) ))")
    if (( age > LOCK_STALE )); then
      info "removing stale lock (${age}s old)"; r "rm -rf ~/emulator.lock"; continue
    fi
    (( SECONDS < deadline )) || setup_fail "emulator lock still held after ${LOCK_WAIT}s: $(r 'cat ~/emulator.lock/owner')"
    sleep 5
  done
  LOCKED=1
fi

# ── Emulator ──────────────────────────────────────────────────
droid running || EMULATOR_WAS_RUNNING=0
info "booting emulator$([[ $EMULATOR_WAS_RUNNING == 1 ]] && echo ' (already running)')"
droid boot >/dev/null || setup_fail "emulator failed to boot"

# ── Install + launch ──────────────────────────────────────────
adb uninstall "$PKG" >/dev/null 2>&1 || true   # start clean: no state from earlier runs
adb install "\$HOME/$REMOTE_DIR/$APK" | grep -q Success || fail "the APK did not install"
INSTALLED=1
droid has-package "^package:${PKG//./\\.}[[:space:]]*\$" || fail "$PKG is not listed after installing"
ok "installs on the emulator as $PKG"

adb shell am force-stop com.android.chrome
adb shell am start -W -n "$PKG/$LAUNCHER" | grep -q "Status: ok" || fail "the launcher activity did not start"
# Render's free tier can take ~a minute to wake staging up.
droid wait-for "$SIGN_IN" 150 || { shot no-ui; fail "the app did not show the taskpapr sign-in page"; }
top=$(droid top-activity)
[[ "$top" == com.android.chrome/*customtabs.CustomTabActivity ]] \
  || { shot wrong-activity; fail "taskpapr opened in '$top', not in a Chrome Trusted Web Activity"; }
ok "launches into taskpapr (sign-in page) inside Chrome's Trusted Web Activity"
shot launched

# ── Verified (no URL bar) or fallback ─────────────────────────
# Chrome shows a Custom Tab toolbar with a URL bar when verification fails.
adb shell uiautomator dump /sdcard/android-ui.xml >/dev/null
url_bars=$(adb shell cat /sdcard/android-ui.xml | grep -o 'com.android.chrome:id/url_bar' | wc -l | tr -d ' ')
if [[ "$url_bars" == 0 ]]; then
  ok "Chrome verified the app against the site's assetlinks.json: full-screen, no URL bar"
elif [[ "$EXPECT_VERIFIED" == 1 ]]; then
  shot url-bar
  fail "a URL bar is showing: the site's /.well-known/assetlinks.json doesn't list $PKG with this signing key (check ANDROID_APP_LINKS on the server)"
else
  echo -e "  ${YELLOW}–${NC}  NOTE: URL bar showing (site not verified for $PKG yet). Set ANDROID_APP_LINKS on the server, then rerun with ANDROID_EXPECT_VERIFIED=1"
fi
