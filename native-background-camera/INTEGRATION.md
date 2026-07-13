# Background (screen-off) recording — integration guide

This adds a native Android foreground service so `/start_rec` and `/stop_rec`
from Telegram work even when the phone's screen is off or the app is
minimized. Web/PWA mode can't do this — Android kills camera access for
background browser tabs, no way around that — so this only applies to the
APK build.

## 1. Build the base APK project (from the main README, Option B)

```bash
cd secure-cam
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init SecureCam com.securecam.app --web-dir=.
npx cap add android
```

This generates `secure-cam/android/`.

## 2. Copy the native files in

```bash
cp native-background-camera/app/src/main/java/com/securecam/app/CameraForegroundService.java \
   android/app/src/main/java/com/securecam/app/

cp native-background-camera/app/src/main/java/com/securecam/app/BackgroundCameraPlugin.java \
   android/app/src/main/java/com/securecam/app/

# MainActivity.java already exists in the generated project — merge, don't
# overwrite. Just add the registerPlugin(BackgroundCameraPlugin.class) line
# shown in native-background-camera/app/.../MainActivity.java into the
# existing onCreate(), before super.onCreate(...).
```

## 3. Patch the manifest

Open `android/app/src/main/AndroidManifest.xml` and add the permissions +
`<service>` block from `native-background-camera/AndroidManifest-additions.xml`.

## 4. Runtime permission prompt

Camera permission still needs to be granted once from the app UI (the
existing `initCamera()` in app.js already triggers this via `getUserMedia`
on first login) — the native service reuses that same grant, it does not ask
again. Native background recording is video-only, matching `audio: false` in
`app.js`, so a separate microphone permission is not required.

## 5. Build

```bash
cd android && ./gradlew assembleDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`

## Telegram commands while app is minimized / screen is off

The native service polls Telegram commands independently from the WebView. It
handles `/start_rec`, `/stop_rec`, `/cam_on`, and `/cam_off` while the screen is
off or the app is minimized, as long as the foreground service notification is
still running.

For screen-off reliability the service now holds a partial CPU wake lock while
it is active. This keeps command polling responsive when the display sleeps, but
it also uses more battery — keep the phone plugged in for security-camera use.
The APK also opens Android's official battery optimization exemption prompt once
from the plugin; allow it for best results.

If the user force-stops the app, swipes/kills it on some OEM task managers, or
taps EXIT (which stops the service), Android will not let the camera wake up
from a Telegram command until the app is opened again.

## 6. Battery optimization (important)

Even with a foreground service, some OEMs (Xiaomi/Oppo/Vivo/Samsung) still
kill background services aggressively. On the phone, once installed:

`Settings → Apps → SecureCam → Battery → Unrestricted` (wording varies by
brand) — otherwise the service may get killed after a while and stop
responding to /start_rec even though everything above is set up correctly.

## What changed vs. the original screen-on design

- Original: app expects screen ON (Wake Lock keeps display awake), all
  camera/recording logic lives in `app.js` inside the WebView.
- Now: on login, `app.js` also starts `CameraForegroundService`, which owns
  its own camera session (Camera2 API) and its own command-poll loop,
  independent of the WebView. Screen can turn off; the service (with its
  own wake lock during active recording) and the persistent notification
  keep running. Stopping recording releases the wake lock again so the
  phone can still sleep between clips.
