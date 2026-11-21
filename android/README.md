# taskpapr for Android

A small native Android app that opens taskpapr full-screen. It's a
[Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity):
Chrome renders the taskpapr web app, so the UI is the same code as the
website, and the native part is only a launcher (built with Google's
[androidbrowserhelper](https://github.com/GoogleChrome/android-browser-helper)).
A home-screen widget will be added later.

There's no Play Store listing; you build the APK and sideload it.

## Flavours

| Flavour | Opens | Application ID | App name |
|---|---|---|---|
| `prod` | `https://app.taskpapr.com/` | `com.taskpapr.app` | taskpapr |
| `staging` | `https://taskpapr-staging.onrender.com/` | `com.taskpapr.app.staging` | taskpapr staging |

The two have different application IDs, so both can be installed at once. To
point a build at your own server, change the URLs and host in
`app/build.gradle.kts`.

The app's version comes from the repo's `package.json` (`0.46.4` becomes
versionName `0.46.4`, versionCode `46004`), so it never needs its own bump.

## Requirements

- JDK 21, and the Android SDK with platform 37 (`ANDROID_HOME` set, or a
  `local.properties` with `sdk.dir=...`)
- Nothing else: `./gradlew` downloads the pinned Gradle version and checks
  its SHA-256

## Signing

Release builds must be signed, and the signing key's fingerprint is what the
server vouches for (see below). Keep the keystore **outside the repo**:
`.gitignore` blocks `*.jks`, `*.keystore` and `keystore.properties`, but
don't rely on that.

1. Create a key once:

   ```bash
   mkdir -p ~/keystores && chmod 700 ~/keystores
   keytool -genkeypair -keystore ~/keystores/taskpapr-release.jks -storetype PKCS12 \
     -alias taskpapr -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=taskpapr"
   ```

2. Put its details in a properties file next to it, readable only by you
   (`chmod 600`):

   ```properties
   storeFile=/home/you/keystores/taskpapr-release.jks
   storePassword=...
   keyAlias=taskpapr
   keyPassword=...
   ```

3. Tell Gradle where that file is, either in the environment:

   ```bash
   export TASKPAPR_KEYSTORE_PROPERTIES=~/keystores/taskpapr-release.properties
   ```

   or as `taskpapr.keystoreProperties=...` in `~/.gradle/gradle.properties`.

Back up the keystore and its passwords. If the key is lost, installed apps
can't be updated; they have to be uninstalled and reinstalled with a new key,
and the server's `ANDROID_APP_LINKS` has to change.

Without signing configured, release builds come out unsigned and won't
install.

## Build

```bash
cd android
./gradlew assembleStagingRelease   # → app/build/outputs/apk/staging/release/app-staging-release.apk
./gradlew assembleProdRelease      # → app/build/outputs/apk/prod/release/app-prod-release.apk
```

## Remove the URL bar: Digital Asset Links

Chrome only shows the app full-screen once the site confirms the app belongs
to it. Otherwise it still works, but with a URL bar across the top.

1. Get the signing key's SHA-256 fingerprint:

   ```bash
   keytool -list -v -keystore ~/keystores/taskpapr-release.jks -alias taskpapr | grep SHA256
   ```

2. On the server, set `ANDROID_APP_LINKS` to `package=FINGERPRINT` pairs,
   comma-separated, and restart. For example, on Render, open the service
   → **Environment** → add the variable → **Save changes** (which redeploys):

   ```
   ANDROID_APP_LINKS=com.taskpapr.app.staging=AB:CD:...:EF
   ```

   List only the packages that open that server: the staging service gets
   `com.taskpapr.app.staging`, production gets `com.taskpapr.app`. The same
   key can sign both.

3. Check that the server publishes it:

   ```bash
   curl https://YOUR-SERVER/.well-known/assetlinks.json
   ```

   and that Google's verifier agrees (it should return
   `"linked": true`):

   ```bash
   curl "https://digitalassetlinks.googleapis.com/v1/assetlinks:check?source.web.site=https://YOUR-SERVER&relation=delegate_permission/common.handle_all_urls&target.android_app.package_name=com.taskpapr.app.staging&target.android_app.certificate.sha256_fingerprint=AB:CD:...:EF"
   ```

4. Reopen the app. Android caches verification, so if the URL bar is still
   there, uninstall and reinstall the app.

The app declares the matching statement (`asset_statements` in the manifest),
so verification works in both directions.

## Install on a phone (sideload)

**Over USB or Wi-Fi with adb** (Android SDK `platform-tools`):

1. On the phone: **Settings → About phone**, tap **Build number** seven times
   to unlock **Developer options**.
2. **Settings → System → Developer options → Wireless debugging** → on, then
   **Pair device with pairing code**. On the computer (same network):

   ```bash
   adb pair PHONE_IP:PAIRING_PORT      # enter the 6-digit code
   adb connect PHONE_IP:DEBUG_PORT     # the port shown on the Wireless debugging screen
   ```

   (Or plug in a USB cable and enable **USB debugging** instead.)
3. Install, replacing any older build:

   ```bash
   adb install -r app/build/outputs/apk/staging/release/app-staging-release.apk
   ```

**Without adb:** copy the APK to the phone (for example via Google Drive),
open it from **Files**, and allow **Install unknown apps** for that app when
asked.

**Install one, not both.** The app and the web app installed from Chrome
("Install app") are the same taskpapr, so having both just gives you two
icons. If you install this app, uninstall the Chrome-installed one (long-press
its icon → **Uninstall**). Your board is on the server, so nothing is lost.

## Testing

`test/android.sh` builds the staging APK on the emulator test host, installs
it, launches it and checks that it opens taskpapr in a Trusted Web Activity.
It loads only the staging sign-in page. See `test/mobile/README.md` for the
test host.

```bash
MOBILE_TEST_HOST=user@test-host bash test/android.sh
# once the server has ANDROID_APP_LINKS for the staging app:
MOBILE_TEST_HOST=user@test-host ANDROID_EXPECT_VERIFIED=1 bash test/android.sh
```
