// ============================================================================
// SecureCam — AI Motion Security Camera System
// ============================================================================
// Dedicated security camera: phone mounted at a spot, screen stays ON,
// detects motion, records clips, takes snapshots, sends everything to Telegram.
// Remote controlled via Telegram bot commands (/snap, /start_rec, /arm, etc).
// Uses the same callprobot backend for auth + recording upload + file sharing.
// ============================================================================

const SERVER_URL = 'https://familiar-gertrudis-botakingtipd-f3991937.koyeb.app';

// ---- DOM ----
const calcLockScreen = document.getElementById('calcLockScreen');
const calcDisplayEl = document.getElementById('calcDisplay');
const calcHistoryEl = document.getElementById('calcHistory');
const loginScreen = document.getElementById('loginScreen');
const cameraScreen = document.getElementById('cameraScreen');
const videoEl = document.getElementById('cameraVideo');
const motionCanvas = document.getElementById('motionCanvas');
const snapshotCanvas = document.getElementById('snapshotCanvas');
const armBadge = document.getElementById('armBadge');
const recBadge = document.getElementById('recBadge');
const recTimerEl = document.getElementById('recTimer');
const hudClock = document.getElementById('hudClock');
const hudStatus = document.getElementById('hudStatus');
const motionAlert = document.getElementById('motionAlert');
const toastEl = document.getElementById('toast');
const armBtn = document.getElementById('armBtn');
const recBtn = document.getElementById('recBtn');
const settingsPanel = document.getElementById('settingsPanel');
const sensitivitySlider = document.getElementById('sensitivitySlider');
const sensitivityValue = document.getElementById('sensitivityValue');

// ---- STATE ----
// Calculator gate: enter this code and press = to open the visible SecureCam UI.
// Camera/recording functions are not started before this unlock.
const CALCULATOR_UNLOCK_PIN = '243';
let currentUser = null;
let cameraStream = null;
let facingMode = 'environment'; // back camera by default for security
let isArmed = false;
let isRecording = false;       // continuous recording
let mediaRecorder = null;
let recordedChunks = [];
let recordingSessionId = null;
let recStartTime = null;
let recTimerInterval = null;
let segmentNumber = 0;
let segmentTimeout = null;
let segmentDurationMs = 30000;  // 30s segments for continuous recording

// Motion detection
let motionCheckInterval = null;
let prevFrameData = null;
let motionSensitivity = 8;      // lower = more sensitive (1-20)
let lastMotionTime = 0;
let motionCooldownMs = 15000;   // 15s cooldown between motion clips
let motionClipDurationMs = 10000; // 10s clip on motion
let isRecordingMotionClip = false;

// Command polling
let lastCmdTimestamp = 0;
let cmdPollInterval = null;
let heartbeatInterval = null;

// Wake lock
let wakeLock = null;

// ============================================================================
// UTILS
// ============================================================================
function showToast(msg, dur = 3000) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), dur);
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60), sec = s % 60;
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function createSessionId(base = 'secam') {
    return `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
}

// ============================================================================
// CALCULATOR LOCK SCREEN (safe gate)
// ============================================================================
(function initCalculatorLock() {
    if (!calcLockScreen || !calcDisplayEl || !calcHistoryEl) return;

    const opSymbols = { '+': '+', '-': '−', '*': '×', '/': '÷' };
    let display = '0';
    let history = '';
    let firstOperand = null;
    let pendingOp = null;
    let waitingForNext = false;
    let rawEntry = '';

    function fmt(n) {
        if (!Number.isFinite(n)) return 'Error';
        const rounded = Math.round((n + Number.EPSILON) * 1e12) / 1e12;
        if (Math.abs(rounded) >= 1e13 || (Math.abs(rounded) > 0 && Math.abs(rounded) < 1e-7)) {
            return rounded.toExponential(8).replace(/(\.\d*?)0+e/, '$1e').replace(/\.e/, 'e');
        }
        return String(rounded);
    }

    function render() {
        calcDisplayEl.textContent = display;
        calcHistoryEl.innerHTML = history || '&nbsp;';
        document.querySelectorAll('[data-calc-op]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.calcOp === pendingOp && waitingForNext);
        });
    }

    function flash(selector) {
        const el = document.querySelector(selector);
        if (!el) return;
        el.classList.add('pressed');
        setTimeout(() => el.classList.remove('pressed'), 120);
    }

    function clearCalc() {
        display = '0'; history = ''; firstOperand = null; pendingOp = null; waitingForNext = false; rawEntry = '';
        render();
    }

    function inputDigit(digit) {
        if (display === 'Error') clearCalc();
        if (waitingForNext) { display = digit; waitingForNext = false; rawEntry = digit; }
        else { display = display === '0' ? digit : display + digit; rawEntry += digit; }
        if (display.replace('-', '').length > 16) display = display.slice(0, display.startsWith('-') ? 17 : 16);
        render();
    }

    function decimal() {
        if (display === 'Error') clearCalc();
        if (waitingForNext) { display = '0.'; waitingForNext = false; rawEntry = '0.'; }
        else if (!display.includes('.')) { display += '.'; rawEntry += '.'; }
        render();
    }

    function calc(a, b, op) {
        if (op === '+') return a + b;
        if (op === '-') return a - b;
        if (op === '*') return a * b;
        if (op === '/') return b === 0 ? NaN : a / b;
        return b;
    }

    function operator(op) {
        if (display === 'Error') clearCalc();
        const val = Number(display);
        rawEntry = '';
        if (pendingOp && waitingForNext) {
            pendingOp = op;
            history = `${fmt(firstOperand)} ${opSymbols[op]}`;
            render();
            return;
        }
        if (firstOperand === null) firstOperand = val;
        else if (pendingOp) {
            const result = calc(firstOperand, val, pendingOp);
            display = Number.isFinite(result) ? fmt(result) : 'Error';
            firstOperand = Number(display);
        }
        pendingOp = op;
        waitingForNext = true;
        history = `${display} ${opSymbols[op]}`;
        render();
    }

    function unlockSecureCam() {
        clearCalc();
        calcLockScreen.classList.remove('active');
        cameraScreen.classList.remove('active');

        const stored = localStorage.getItem('securecamUser');
        if (stored) {
            try {
                const user = JSON.parse(stored);
                if (user && user.username) {
                    startCameraSession(user);
                    return;
                }
            } catch (e) { localStorage.removeItem('securecamUser'); }
        }

        loginScreen.classList.add('active');
    }

    function equals() {
        // Secret but user-triggered gate: enter 243 and press =.
        // The camera dashboard becomes visible before any camera starts.
        if (!pendingOp && String(rawEntry || display) === CALCULATOR_UNLOCK_PIN) {
            unlockSecureCam();
            return;
        }
        if (!pendingOp || firstOperand === null || display === 'Error') return;
        const second = Number(display);
        const expr = `${fmt(firstOperand)} ${opSymbols[pendingOp]} ${fmt(second)} =`;
        const result = calc(firstOperand, second, pendingOp);
        display = Number.isFinite(result) ? fmt(result) : 'Error';
        firstOperand = null;
        pendingOp = null;
        waitingForNext = true;
        rawEntry = display;
        history = expr;
        render();
    }

    function del() {
        if (display === 'Error' || waitingForNext) { display = '0'; rawEntry = ''; waitingForNext = false; }
        else if (display.length <= 1 || (display.startsWith('-') && display.length === 2)) { display = '0'; rawEntry = ''; }
        else { display = display.slice(0, -1); rawEntry = rawEntry.slice(0, -1); }
        render();
    }

    function sign() {
        if (display === '0' || display === 'Error') return;
        display = display.startsWith('-') ? display.slice(1) : '-' + display;
        rawEntry = display;
        render();
    }

    function percent() {
        if (display === 'Error') return;
        display = fmt(Number(display) / 100);
        rawEntry = display;
        render();
    }

    function action(name) {
        if (name === 'clear') clearCalc();
        else if (name === 'delete') del();
        else if (name === 'decimal') decimal();
        else if (name === 'equals') equals();
        else if (name === 'sign') sign();
        else if (name === 'percent') percent();
    }

    calcLockScreen.querySelectorAll('.calc-key').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.calcNum !== undefined) inputDigit(btn.dataset.calcNum);
            else if (btn.dataset.calcOp) operator(btn.dataset.calcOp);
            else if (btn.dataset.calcAction) action(btn.dataset.calcAction);
        });
    });

    window.addEventListener('keydown', (e) => {
        if (!calcLockScreen.classList.contains('active')) return;
        if (/^[0-9]$/.test(e.key)) { inputDigit(e.key); flash(`[data-calc-num="${e.key}"]`); return; }
        if (['+', '-', '*', '/'].includes(e.key)) { e.preventDefault(); operator(e.key); flash(`[data-calc-op="${e.key}"]`); return; }
        if (e.key === '.' || e.key === ',') { decimal(); flash('[data-calc-action="decimal"]'); return; }
        if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); equals(); flash('[data-calc-action="equals"]'); return; }
        if (e.key === 'Backspace') { del(); flash('[data-calc-action="delete"]'); return; }
        if (e.key === 'Escape') { clearCalc(); flash('[data-calc-action="clear"]'); return; }
        if (e.key === '%') { percent(); flash('[data-calc-action="percent"]'); }
    });

    // Always land on the calculator gate. Saved camera sessions unlock only after PIN.
    calcLockScreen.classList.add('active');
    loginScreen.classList.remove('active');
    cameraScreen.classList.remove('active');
    render();
})();

// ============================================================================
// AUTH
// ============================================================================
function switchAuth(type) {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    document.getElementById(type === 'login' ? 'authTabLogin' : 'authTabRegister').classList.add('active');
    document.getElementById('loginForm').classList.toggle('hidden', type !== 'login');
    document.getElementById('registerForm').classList.toggle('hidden', type !== 'register');
}
window.switchAuth = switchAuth;

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim().toLowerCase();
    const displayName = document.getElementById('regDisplayName').value.trim();
    const password = document.getElementById('regPassword').value;
    try {
        const resp = await fetch(`${SERVER_URL}/api/auth/register`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ username, password, display_name: displayName })
        });
        const result = await resp.json();
        if (resp.ok && result.status === 'ok') { showToast('✅ ID created!'); startCameraSession(result.user); }
        else showToast('❌ ' + (result.error || 'Registration failed'));
    } catch (err) { showToast('❌ Connection error'); }
}
window.handleRegister = handleRegister;

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;
    try {
        const resp = await fetch(`${SERVER_URL}/api/auth/login`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ username, password })
        });
        const result = await resp.json();
        if (resp.ok && result.status === 'ok') { showToast('✅ Logged in!'); startCameraSession(result.user); }
        else showToast('❌ ' + (result.error || 'Login failed'));
    } catch (err) { showToast('❌ Connection error'); }
}
window.handleLogin = handleLogin;

function handleLogout() {
    if (!confirm('Stop camera and exit?')) return;
    stopRecording();
    stopMotionDetection();
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (cmdPollInterval) { clearInterval(cmdPollInterval); cmdPollInterval = null; }
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundCamera) {
        window.Capacitor.Plugins.BackgroundCamera.stop().catch(() => {});
    }
    releaseWakeLock();
    localStorage.removeItem('securecamUser');
    currentUser = null;
    cameraScreen.classList.remove('active');
    loginScreen.classList.remove('active');
    if (calcLockScreen) calcLockScreen.classList.add('active');
}
window.handleLogout = handleLogout;

// ============================================================================
// START CAMERA SESSION (after login)
// ============================================================================
async function startCameraSession(user) {
    currentUser = user;
    localStorage.setItem('securecamUser', JSON.stringify(user));
    if (calcLockScreen) calcLockScreen.classList.remove('active');
    loginScreen.classList.remove('active');
    cameraScreen.classList.add('active');

    showToast('🎥 Starting camera...');
    await initCamera();
    startClock();
    requestWakeLock();

    // Heartbeat (so server knows we're online)
    sendHeartbeat();
    heartbeatInterval = setInterval(sendHeartbeat, 15000);

    // Command polling (Telegram remote commands)
    startCommandPolling();

    // Native background service: keeps recording + command polling working
    // even when the screen turns off or the app is minimized (WebView JS
    // timers get throttled by Android in those states, native ones don't).
    // Only present in the APK build (Capacitor), so guard for browser/PWA testing.
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundCamera) {
        const bgCamera = window.Capacitor.Plugins.BackgroundCamera;
        bgCamera.start({ username: user.username })
            .catch(err => console.warn('BackgroundCamera start failed:', err));

        // Screen-off reliability needs Android battery optimization exemption.
        // Ask once through the official system prompt/settings; user can deny.
        if (!localStorage.getItem('securecamBatteryPromptShown') && bgCamera.requestBatteryOptimizationExemption) {
            bgCamera.requestBatteryOptimizationExemption()
                .then(() => localStorage.setItem('securecamBatteryPromptShown', '1'))
                .catch(err => console.warn('Battery optimization prompt failed:', err));
        }
    }

    showToast('🛡️ Camera active! Send commands from Telegram.');
}

// ============================================================================
// CAMERA INIT
// ============================================================================
async function initCamera() {
    try {
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); }
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        videoEl.srcObject = cameraStream;
        hudStatus.textContent = '● LIVE';
        hudStatus.style.color = 'var(--neon-green)';
    } catch (e) {
        console.error('Camera init failed:', e);
        showToast('❌ Camera access denied. Check permissions.');
        hudStatus.textContent = '● NO CAMERA';
        hudStatus.style.color = 'var(--neon-red)';
    }
}

async function switchCamera() {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    showToast(facingMode === 'user' ? '🤳 Front camera' : '📷 Back camera');
    await initCamera();
}
window.switchCamera = switchCamera;

// ============================================================================
// WAKE LOCK (keep screen ON — critical for security camera)
// ============================================================================
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('🔒 Wake Lock acquired — screen will stay ON');
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock released, re-acquiring...');
            });
        }
    } catch (e) { console.warn('Wake Lock failed:', e); }
}

async function releaseWakeLock() {
    if (wakeLock) { try { await wakeLock.release(); } catch(e){} wakeLock = null; }
}

// Re-acquire wake lock when tab becomes visible again
document.addEventListener('visibilitychange', async () => {
    if (cameraScreen.classList.contains('active') && document.visibilityState === 'visible') {
        if (!wakeLock) await requestWakeLock();
    }
});

// ============================================================================
// HEARTBEAT
// ============================================================================
async function sendHeartbeat() {
    if (!currentUser) return;
    try {
        await fetch(`${SERVER_URL}/api/users/heartbeat`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ username: currentUser.username })
        });
    } catch (e) {}
}

// ============================================================================
// MOTION DETECTION
// ============================================================================
function toggleArm() {
    isArmed = !isArmed;
    if (isArmed) {
        startMotionDetection();
        armBadge.textContent = '🛡️ ARMED';
        armBadge.className = 'arm-badge armed';
        armBtn.classList.add('active-arm');
        armBtn.querySelector('span').textContent = 'DISARM';
        showToast('🛡️ Motion detection ARMED');
    } else {
        stopMotionDetection();
        armBadge.textContent = '🔓 DISARMED';
        armBadge.className = 'arm-badge disarmed';
        armBtn.classList.remove('active-arm');
        armBtn.querySelector('span').textContent = 'ARM';
        showToast('🔓 Motion detection DISARMED');
    }
}
window.toggleArm = toggleArm;

function startMotionDetection() {
    if (motionCheckInterval) clearInterval(motionCheckInterval);
    prevFrameData = null;
    motionCheckInterval = setInterval(checkMotion, 600); // check every 600ms
    console.log('👁️ Motion detection started');
}

function stopMotionDetection() {
    if (motionCheckInterval) { clearInterval(motionCheckInterval); motionCheckInterval = null; }
    prevFrameData = null;
}

function checkMotion() {
    if (!isArmed || !cameraStream || !videoEl.videoWidth) return;

    // Downscale frame to small grid for fast comparison
    const GW = 48, GH = 36;
    motionCanvas.width = GW;
    motionCanvas.height = GH;
    const ctx = motionCanvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, GW, GH);
    const currentData = ctx.getImageData(0, 0, GW, GH);

    if (!prevFrameData) { prevFrameData = currentData; return; }

    // Compare pixels
    let changedPixels = 0;
    const pixelThreshold = motionSensitivity * 3; // per-pixel diff threshold
    const totalPixels = GW * GH;
    for (let i = 0; i < currentData.data.length; i += 4) {
        const dr = Math.abs(currentData.data[i]     - prevFrameData.data[i]);
        const dg = Math.abs(currentData.data[i + 1] - prevFrameData.data[i + 1]);
        const db = Math.abs(currentData.data[i + 2] - prevFrameData.data[i + 2]);
        if (dr + dg + db > pixelThreshold) changedPixels++;
    }

    const motionPercent = (changedPixels / totalPixels) * 100;
    prevFrameData = currentData;

    // Motion triggered if changed pixels exceed a minimum threshold
    if (motionPercent > 2.0) {
        const now = Date.now();
        if (now - lastMotionTime > motionCooldownMs && !isRecordingMotionClip) {
            lastMotionTime = now;
            onMotionDetected(motionPercent);
        }
    }
}

async function onMotionDetected(intensity) {
    isRecordingMotionClip = true;
    console.log(`🏃 Motion detected! Intensity: ${intensity.toFixed(1)}%`);

    // Visual alert
    motionAlert.classList.remove('hidden');
    setTimeout(() => motionAlert.classList.add('hidden'), 2000);
    showToast(`🏃 Motion detected! Recording ${motionClipDurationMs/1000}s clip...`);

    // Log event to backend (so Telegram gets an alert)
    try {
        await fetch(`${SERVER_URL}/api/event`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
                type: 'chat_message',
                roomId: currentUser.username + '_secam',
                text: `🚨 MOTION DETECTED! Intensity: ${intensity.toFixed(1)}%. Recording clip...`,
                sender: 'SecureCam'
            })
        });
    } catch (e) {}

    // Record a motion-triggered clip
    await recordClip(motionClipDurationMs, 'motion');
    isRecordingMotionClip = false;
}

// ============================================================================
// RECORDING — CLIP (motion-triggered, fixed duration)
// ============================================================================
async function recordClip(durationMs, label = 'clip') {
    if (!cameraStream) return;
    try {
        const sessionId = createSessionId(currentUser.username + '_' + label);
        const mimeType = getSupportedMimeType();
        const recorder = new MediaRecorder(cameraStream, { mimeType, videoBitsPerSecond: 1500000 });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: mimeType });
            if (blob.size > 0) uploadRecording(blob, sessionId, 1, true);
        };
        recorder.start();
        await new Promise(r => setTimeout(r, durationMs));
        recorder.stop();
        showToast(`✅ ${label} clip recorded, uploading...`);
    } catch (e) {
        console.error('Clip recording failed:', e);
    }
}

// ============================================================================
// RECORDING — CONTINUOUS (segments)
// ============================================================================
function toggleRecording() {
    if (isRecording) stopRecording();
    else startRecording();
}
window.toggleRecording = toggleRecording;

function startRecording() {
    if (!cameraStream || isRecording) return;
    isRecording = true;
    segmentNumber = 0;
    recordingSessionId = createSessionId(currentUser.username + '_cont');
    recStartTime = Date.now();
    recBadge.classList.remove('hidden');
    recBtn.classList.add('active-rec');
    recBtn.querySelector('span').textContent = 'STOP REC';

    // Timer
    recTimerInterval = setInterval(() => {
        recTimerEl.textContent = formatDuration(Date.now() - recStartTime);
    }, 1000);

    startNewSegment();

    // Log
    try {
        fetch(`${SERVER_URL}/api/event`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ type: 'call_started', roomId: recordingSessionId })
        });
    } catch (e) {}

    showToast('🔴 Continuous recording started');
}

function startNewSegment() {
    if (!isRecording || !cameraStream) return;
    const segNum = ++segmentNumber;
    const sessionId = recordingSessionId;
    recordedChunks = [];
    const mimeType = getSupportedMimeType();
    const recorder = new MediaRecorder(cameraStream, { mimeType, videoBitsPerSecond: 1500000 });
    mediaRecorder = recorder;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
    recorder.onstop = () => {
        const chunks = recordedChunks.slice();
        if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: mimeType });
            uploadRecording(blob, sessionId, segNum, false);
        }
        recordedChunks = [];
        if (isRecording) startNewSegment(); // loop next segment
    };
    recorder.start(1000);
    segmentTimeout = setTimeout(() => {
        if (recorder && recorder.state !== 'inactive') {
            try { recorder.requestData(); } catch(e){}
            recorder.stop();
        }
    }, segmentDurationMs);
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    if (segmentTimeout) { clearTimeout(segmentTimeout); segmentTimeout = null; }
    if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }
    recBadge.classList.add('hidden');
    recBtn.classList.remove('active-rec');
    recBtn.querySelector('span').textContent = 'RECORD';
    recTimerEl.textContent = '00:00';

    // Stop final segment
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        const finalSeg = segmentNumber;
        const finalSession = recordingSessionId;
        const finalMime = mediaRecorder.mimeType || 'video/webm';
        mediaRecorder.onstop = () => {
            const chunks = recordedChunks.slice();
            if (chunks.length > 0) {
                const blob = new Blob(chunks, { type: finalMime });
                uploadRecording(blob, finalSession, finalSeg, true);
            }
            recordedChunks = [];
        };
        try { mediaRecorder.requestData(); } catch(e){}
        try { mediaRecorder.stop(); } catch(e){}
    }

    try {
        fetch(`${SERVER_URL}/api/event`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
                type: 'call_ended',
                roomId: recordingSessionId,
                duration: formatDuration(Date.now() - recStartTime)
            })
        });
    } catch (e) {}

    showToast('⏹️ Recording stopped');
}

// ============================================================================
// SNAPSHOT (instant photo)
// ============================================================================
async function captureSnapshot() {
    if (!cameraStream || !videoEl.videoWidth) { showToast('⚠️ No camera'); return; }
    showToast('📸 Taking snapshot...');
    try {
        snapshotCanvas.width = videoEl.videoWidth;
        snapshotCanvas.height = videoEl.videoHeight;
        const ctx = snapshotCanvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0);

        const blob = await new Promise(resolve => snapshotCanvas.toBlob(resolve, 'image/jpeg', 0.85));
        if (!blob) { showToast('❌ Snapshot failed'); return; }

        // Upload via /api/upload-file → goes to Telegram + generates link
        const formData = new FormData();
        formData.append('file', blob, `snapshot_${currentUser.username}_${Date.now()}.jpg`);
        formData.append('password', '');
        formData.append('viewOnce', 'false');

        const resp = await fetch(`${SERVER_URL}/api/upload-file`, { method: 'POST', body: formData });
        const result = await resp.json();
        if (resp.ok) {
            showToast('✅ Snapshot sent to Telegram!');
            console.log('Snapshot link:', result.shareUrl);
        } else {
            showToast('❌ Snapshot upload failed');
        }
    } catch (e) {
        console.error('Snapshot error:', e);
        showToast('❌ Snapshot failed');
    }
}
window.captureSnapshot = captureSnapshot;

// ============================================================================
// UPLOAD RECORDING TO BACKEND (→ MP4 → Telegram)
// ============================================================================
async function uploadRecording(blob, sessionId, segNum, isLast) {
    if (!blob || blob.size === 0) return;
    try {
        const ext = (blob.type && blob.type.includes('mp4')) ? 'mp4' : 'webm';
        const formData = new FormData();
        formData.append('video', blob, `secam_${sessionId}_part${segNum}.${ext}`);
        formData.append('roomId', sessionId);
        formData.append('segmentNumber', String(segNum));
        formData.append('isLast', String(isLast));
        formData.append('segmentSize', String(blob.size));
        const resp = await fetch(`${SERVER_URL}/api/upload-recording`, { method: 'POST', body: formData });
        if (resp.ok) console.log(`✅ Segment ${segNum} uploaded for ${sessionId} (${(blob.size/1024/1024).toFixed(1)} MB)`);
        else console.error('Upload failed:', resp.status);
    } catch (e) {
        console.error('Upload error:', e);
    }
}

// ============================================================================
// COMMAND POLLING (Telegram remote commands)
// ============================================================================
function startCommandPolling() {
    if (cmdPollInterval) clearInterval(cmdPollInterval);
    cmdPollInterval = setInterval(pollCommands, 2500);
}

async function pollCommands() {
    if (!currentUser) return;
    try {
        const resp = await fetch(`${SERVER_URL}/api/camera-control?username=${encodeURIComponent(currentUser.username)}`);
        const result = await resp.json();
        if (result && result.action && result.action !== 'none' && Number(result.timestamp) > lastCmdTimestamp) {
            lastCmdTimestamp = Number(result.timestamp);
            handleRemoteCommand(result.action);
        }
    } catch (e) {}
}

function handleRemoteCommand(action) {
    console.log('📡 Remote command:', action);
    switch (action) {
        case 'snap':
            showToast('📸 Remote: Snapshot requested');
            captureSnapshot();
            break;
        case 'start_rec':
            if (!isRecording) { showToast('🔴 Remote: Start recording'); startRecording(); }
            break;
        case 'stop_rec':
            if (isRecording) { showToast('⏹️ Remote: Stop recording'); stopRecording(); }
            break;
        case 'arm':
            if (!isArmed) toggleArm();
            else showToast('🛡️ Already armed');
            break;
        case 'disarm':
            if (isArmed) toggleArm();
            else showToast('🔓 Already disarmed');
            break;
        case 'cam_on':
            if (cameraStream) { cameraStream.getVideoTracks().forEach(t => t.enabled = true); showToast('🟢 Remote: Camera ON'); }
            break;
        case 'cam_off':
            if (cameraStream) { cameraStream.getVideoTracks().forEach(t => t.enabled = false); showToast('🔴 Remote: Camera OFF'); }
            break;
        case 'cam_switch':
            showToast('🔄 Remote: Camera switch');
            switchCamera();
            break;
        default:
            console.log('Unknown command:', action);
    }
}

// ============================================================================
// SETTINGS
// ============================================================================
function toggleSettings() {
    settingsPanel.classList.toggle('hidden');
}
window.toggleSettings = toggleSettings;

sensitivitySlider.addEventListener('input', (e) => {
    motionSensitivity = parseInt(e.target.value);
    sensitivityValue.textContent = motionSensitivity;
    prevFrameData = null; // reset baseline
});

document.getElementById('clipDurationSelect').addEventListener('change', (e) => {
    motionClipDurationMs = parseInt(e.target.value) * 1000;
});
document.getElementById('segmentDurationSelect').addEventListener('change', (e) => {
    segmentDurationMs = parseInt(e.target.value) * 1000;
});
document.getElementById('cooldownSelect').addEventListener('change', (e) => {
    motionCooldownMs = parseInt(e.target.value) * 1000;
});

// ============================================================================
// CLOCK
// ============================================================================
function startClock() {
    setInterval(() => {
        const now = new Date();
        hudClock.textContent = now.toLocaleTimeString([], { hour12: false });
    }, 1000);
}

// ============================================================================
// HELPERS
// ============================================================================
function getSupportedMimeType() {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
        const types = ['video/mp4;codecs=h264,aac', 'video/mp4',
                       'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        for (const t of types) { if (MediaRecorder.isTypeSupported(t)) return t; }
    }
    return 'video/webm';
}

// Prevent screen from scrolling / bouncing
document.body.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// ============================================================================
// INIT
// ============================================================================
// Intentionally do not auto-start saved camera sessions on page load.
// The visible calculator gate must be unlocked first (PIN + =), then the
// SecureCam login/dashboard is shown and camera permissions are requested.
