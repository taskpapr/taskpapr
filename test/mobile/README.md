# Mobile tests (`test/mobile.sh`)

These tests drive the **real Chrome browser in an Android emulator**: a
phone-sized Pixel running a recent Android with the Play Store image. They
check results through the API. No Playwright and no npm dependencies are
involved.

```bash
MOBILE_TEST_HOST=you@your-test-host bash test/mobile.sh
```

You run the script wherever your checkout is. It drives a separate
**test host** over ssh, because the emulator needs hardware virtualisation,
which many dev containers and cloud VMs don't have. An Apple Silicon Mac
works well as a test host.

Each run:

1. Takes a lock on the host (`~/emulator.lock`), so only one run uses the
   emulator at a time. A lock older than an hour is treated as stale.
2. Copies your checkout to the host with rsync. `.git`, `node_modules`,
   `data/` and `.env*` are never sent. It then runs `npm ci` there, only when
   `package-lock.json` has changed.
3. Starts a **throwaway single-user server** with a temp database. Tests
   never touch a real instance.
4. Boots the emulator if it isn't already running. `adb reverse` lets Chrome
   reach the server as `http://localhost:PORT`, which counts as a secure
   context, as PWA features need.
5. Runs the checks.
6. Copies screenshots back to `test/mobile/screenshots/` (gitignored).
7. Tears everything down, whether the checks passed or failed. That includes
   stopping the emulator if this run booted it.

The exit code is `0` if all checks pass, `1` if a check fails and `2` for a
setup problem.

## Test host setup (one-off)

- **ssh:** key-based login from where you run the tests (`BatchMode` is
  used, so there are no password prompts).
- **Node 22.5+** on the PATH for non-interactive ssh sessions. Homebrew's
  `/opt/homebrew/bin` is added automatically.
- **Android SDK** command-line tools, `platform-tools`, `emulator` and a
  Google Play arm64 system image. The default location is
  `~/Library/Android/sdk`; set `ANDROID_HOME` in the host's shell env to
  override it.
- **An AVD**, for example:
  `avdmanager create avd -n taskpapr_pixel -k "system-images;android-37.0;google_apis_playstore;arm64-v8a" -d pixel_10_pro_xl`

Chrome's first-run and promo screens are dismissed automatically.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MOBILE_TEST_HOST` | *(required)* | ssh target, `user@host` |
| `MOBILE_REMOTE_DIR` | `taskpapr-mobile-test` | Checkout location on the host, relative to its `$HOME` |
| `MOBILE_PORT` | `3099` | Throwaway server port on the host |
| `MOBILE_LOCAL_PORT` | `3199` | Local end of the ssh tunnel used for API checks |
| `MOBILE_SHOTS_DIR` | `test/mobile/screenshots` | Where screenshots are copied to |
| `MOBILE_LOCK_WAIT` | `900` | Seconds to wait for another run's lock |
| `MOBILE_LOCK_STALE` | `3600` | Age in seconds after which a lock is presumed dead |
| `MOBILE_AVD` | `taskpapr_pixel` | AVD name. It's read on the host, so set it in the host's shell env |

## Writing checks

`test/mobile/droid.sh` is the emulator driver. It runs on the host; in
`mobile.sh`, call it through the `droid` helper:

- `droid open URL`: opens the URL in Chrome
- `droid wait-for LABEL [SEC]`: waits until something labelled LABEL is visible
- `droid tap-text LABEL`: taps the first visible node with that label
- `droid type TEXT` / `droid key 66`: types text and presses Enter
- `droid shot`: through the `shot NAME` helper, saves a numbered screenshot
- `droid long-press LABEL`, `droid top-activity`, `droid net on|off`,
  `droid force-stop PKG`, `droid has-package PATTERN`: for app-level checks
  (home-screen icons, standalone launch, offline)
- `stop_server` / `start_server` (in `mobile.sh`): crash and restart the
  throwaway server on the same database

A label matches a node's visible text, its `content-desc` (accessible name)
or an input's placeholder (`hint`). CSS `text-transform` is applied, so a
tile named "Work" is labelled `WORK`. Emoji are not matchable, because the
UI dump encodes them as entities.

Assert outcomes through the API (`curl "$API/api/..."`, which goes through
the ssh tunnel), not only on screen. Take a screenshot before every `fail`,
so the failure state is captured.

## Gotchas

- The emulator runs with `-gpu swangle_indirect`. `swiftshader_indirect`
  crashed the emulator as soon as Chrome rendered a page.
- Every `adb` call in `droid.sh` reads from `</dev/null`. Otherwise
  `adb shell` swallows the rest of any script piped to the host over ssh.
- Chrome keeps hidden copies of some inputs with zero-size bounds;
  `droid.sh` skips them.
- Installing on `localhost` produces a Chrome **shortcut**, not a WebAPK
  (Google only mints WebAPKs for real https origins). The shortcut still
  launches standalone, but manifest `shortcuts` (long-press actions) only
  exist on WebAPK installs, so that check is skipped here.
- `adb reverse --remove` doesn't close connections that are already open,
  and a SIGTERM'd taskpapr server keeps its SSE streams alive while refusing
  new requests. To simulate the server going away, `stop_server` uses
  SIGKILL.
- Chrome's menu button is labelled "Customize and control Google Chrome",
  or "Update available. More options" when Chrome has a pending update.
