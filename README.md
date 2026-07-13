# 🛡️ SecureCam — AI Motion Security Camera

Dedicated security camera app. Phone ko ek jagah mount karke (charge pe laga, screen ON), ye continuous camera feed chalata hai, motion detect karta hai, aur sab kuch Telegram pe bhej deta hai. Remote control bhi Telegram se.

---

## 🎯 Features

| Feature | Description |
|---------|-------------|
| 📹 Live Camera Feed | Full-screen camera (front/back switchable) |
| 🏃 Motion Detection | Frame comparison se movement detect, auto clip record |
| 🔴 Continuous Recording | Segments me record (30s/60s/2min), auto Telegram upload |
| 📸 Snapshot | Instant photo → Telegram |
| 🔒 Screen Always ON | Wake Lock API se screen band nahi hota |
| 📡 Remote Control | Telegram se sab commands |

---

## 📡 Telegram Bot Commands

Bot me ye commands bhejo (apne Cyber ID ke saath):

| Command | Kaam |
|---------|------|
| `/snap username` | Instant photo le ke Telegram bhej |
| `/start_rec username` | Continuous recording start |
| `/stop_rec username` | Recording stop |
| `/arm username` | Motion detection ON |
| `/disarm username` | Motion detection OFF |
| `/cam_on username` | Camera enable |
| `/cam_off username` | Camera disable |
| `/cam_switch username` | Front ↔ Back camera switch |

**Example:** `/snap my_room_cam` → us camera ka instant photo Telegram pe aa jayega.

---

## 🚀 Setup (3 steps)

### Step 1: Backend deploy (callprobot)
Backend already Koyeb pe chal raha hai. Same `SERVER_URL` use karta hai app. Naya kuch nahi karna.

### Step 2: App chalao (testing — browser)
Sabse pehle browser me test kar lo:
```bash
cd secure-cam
python3 -m http.server 8000
```
Browser kholo: **http://localhost:8000**

### Step 3: Phone pe lagao (2 options)

**Option A — PWA (easy, no APK):**
1. Phone browser me app kholo
2. Browser menu → "Add to Home Screen"
3. Icon ban jayega → kholo → camera chalu

**Option B — Android APK (proper app):**
Same Capacitor process jo meetlink-mobile ke liye bataya tha:
```bash
cd secure-cam
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init SecureCam com.securecam.app --web-dir=.
npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
```
APK milega: `android/app/build/outputs/apk/debug/app-debug.apk`

---

## 📱 Phone kaise set karna hai (security camera setup)

1. Phone ko **charge pe laga do** (power bank ya charger)
2. Mount kar do monitoring spot pe (tripod, stand ya tape se)
3. **SecureCam app kholo** → login
4. Screen ON rahega (Wake Lock)
5. Settings me **Motion Sensitivity** adjust karo
6. **ARM** dabao (ya Telegram se `/arm` bhejo)
7. Bas! Ab koi movement hui to auto clip Telegram pe aa jayega

---

## ⚙️ Settings (app ke andar)

| Setting | Default | Kaam |
|---------|---------|------|
| Motion Sensitivity | 8 | Kam value = zyada sensitive (1-20) |
| Motion Clip Duration | 10s | Motion detect pe kitna long clip |
| Continuous Record Segment | 30s | Har kitne sec ka segment |
| Motion Cooldown | 15s | Do motion clips ke beech gap |

---

## 🔧 How it works (technical)

```
Phone Camera (getUserMedia)
    ├── Live Preview → Full screen video
    ├── Motion Detection → Canvas frame comparison (every 600ms)
    │       └── Motion detected → 10s clip record → upload to backend
    ├── Continuous Recording → MediaRecorder segments → upload
    └── Snapshot → Canvas capture → upload as file
                    ↓
            Backend (callprobot)
                    ├── /api/upload-recording → FFmpeg WebM→MP4 → Telegram
                    ├── /api/upload-file → Telegram document + link
                    ├── /api/event → Telegram alert messages
                    └── /api/camera-control → polls Telegram commands
```

---

## ❓ Common Problems

| Problem | Solution |
|---------|----------|
| Screen band ho raha hai | Wake Lock browser me support karna chahiye. Chrome/Safari latest use karo. APK me better chalega. |
| Camera black screen | Phone Settings → Browser → Permissions → Camera allow |
| Motion nahi detect | Sensitivity kam karo (slider left), ya lighting check karo |
| Bahut zyada false alerts | Sensitivity badhao (slider right), cooldown badhao |
| Backend connect nahi | Internet check karo. `/api/status` test karo browser me |
| Telegram pe nahi aa raha | Bot token + channel ID backend me configured hona chahiye |

---

## 📁 Project Structure
```
secure-cam/
├── index.html      # Login + Camera dashboard UI
├── app.js          # Camera, motion, recording, polling logic
├── style.css       # Security camera dark theme
└── README.md       # This file
```

---

## ⚡ Quick Start
```
1. python3 -m http.server 8000  (ya phone pe APK install)
2. Create Cyber ID (e.g. "my_room_cam")
3. Mount phone, ARM motion detection
4. Telegram se /snap my_room_cam test karo!
```
