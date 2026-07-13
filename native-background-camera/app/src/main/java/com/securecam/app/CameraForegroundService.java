package com.securecam.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import android.util.Size;
import android.view.Surface;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.Collections;
import java.util.List;

/**
 * Runs as a foreground service so recording keeps working when the screen is
 * off or the app is backgrounded/minimized. Android REQUIRES a persistent
 * notification for any app using the camera/mic from a foreground service
 * (this is enforced by the OS, not optional) — that notification IS the
 * on-device indicator that recording may be active.
 *
 * Independently polls the same /api/camera-control endpoint the web app
 * already uses (see app.js pollCommands()), because JS timers in the WebView
 * get throttled/frozen by Android Doze/App Standby once the screen is off —
 * this native polling loop does not.
 */
public class CameraForegroundService extends Service {

    private static final String TAG = "CameraFgService";
    private static final String CHANNEL_ID = "securecam_recording";
    private static final int NOTIF_ID = 4201;

    // Same backend already used by app.js — keep in sync with SERVER_URL there.
    private static final String SERVER_URL = "https://familiar-gertrudis-botakingtipd-f3991937.koyeb.app";
    private static final long POLL_INTERVAL_MS = 5000;

    private String username; // Cyber ID, passed in via intent extra on start
    private long lastCmdTimestamp = 0;

    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private MediaRecorder mediaRecorder;
    private HandlerThread bgThread;
    private Handler bgHandler;
    // Keeps command polling alive while the screen is off. Without this,
    // Android Doze can delay Handler/network work and Telegram commands may
    // arrive only after the phone wakes.
    private PowerManager.WakeLock serviceWakeLock;
    // Extra guard while MediaRecorder is active.
    private PowerManager.WakeLock wakeLock;
    private boolean isRecording = false;
    // /cam_off disables native background camera use but keeps the foreground
    // service alive, so a later /cam_on can still be received from Telegram.
    private boolean cameraEnabled = true;
    private File currentOutputFile;
    private String currentSessionId;
    private int currentSegmentNumber = 1;

    private final Handler pollHandler = new Handler();
    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            pollCommandsOnce();
            pollHandler.postDelayed(this, POLL_INTERVAL_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        bgThread = new HandlerThread("CameraBg");
        bgThread.start();
        bgHandler = new Handler(bgThread.getLooper());

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        serviceWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SecureCam::CommandPollWakeLock");
        serviceWakeLock.setReferenceCounted(false);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SecureCam::RecordingWakeLock");
        wakeLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("username")) {
            username = intent.getStringExtra("username");
        }

        Notification notification = buildNotification("Standing by");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        } else {
            startForeground(NOTIF_ID, notification);
        }
        acquireServiceWakeLock();

        // Start independent command polling — this is what lets you send
        // start/stop from the office and have it apply even with the
        // screen off, without relying on the WebView being active.
        pollHandler.removeCallbacks(pollRunnable);
        pollHandler.post(pollRunnable);

        return START_STICKY; // ask the OS to restart the service if it gets killed
    }

    @Override
    public void onDestroy() {
        pollHandler.removeCallbacks(pollRunnable);
        stopRecordingInternal();
        releaseWakeLock(serviceWakeLock);
        if (bgThread != null) bgThread.quitSafely();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireServiceWakeLock() {
        try {
            if (serviceWakeLock != null && !serviceWakeLock.isHeld()) {
                serviceWakeLock.acquire();
                Log.i(TAG, "Command polling wake lock acquired");
            }
        } catch (Exception e) {
            Log.w(TAG, "Unable to acquire service wake lock: " + e.getMessage());
        }
    }

    private void releaseWakeLock(PowerManager.WakeLock lock) {
        try {
            if (lock != null && lock.isHeld()) lock.release();
        } catch (Exception ignored) {}
    }

    // ---------------- Command polling (native, screen-off safe) ----------------

    private void pollCommandsOnce() {
        if (username == null) return;
        bgHandler.post(() -> {
            try {
                String encodedUsername = URLEncoder.encode(username, "UTF-8");
                URL url = new URL(SERVER_URL + "/api/camera-control?username=" + encodedUsername);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                int code = conn.getResponseCode();
                if (code == 200) {
                    String body = readStream(conn.getInputStream());
                    JSONObject json = new JSONObject(body);
                    String action = json.optString("action", "none");
                    long ts = json.optLong("timestamp", 0);
                    if (!"none".equals(action) && ts > lastCmdTimestamp) {
                        lastCmdTimestamp = ts;
                        handleCommand(action);
                    }
                }
                conn.disconnect();
            } catch (Exception e) {
                Log.w(TAG, "poll failed: " + e.getMessage());
            }
        });
    }

    private void handleCommand(String cmd) {
        if (cmd == null) return;
        switch (cmd) {
            case "cam_on":
                cameraEnabled = true;
                updateNotification(isRecording ? "Recording" : "Standing by");
                Log.i(TAG, "Camera enabled by remote command");
                break;
            case "cam_off":
                cameraEnabled = false;
                if (isRecording) {
                    stopRecordingInternal();
                } else {
                    closeCamera();
                    updateNotification("Camera disabled");
                }
                Log.i(TAG, "Camera disabled by remote command");
                break;
            case "start_rec":
                startRecordingInternal();
                break;
            case "stop_rec":
                stopRecordingInternal();
                break;
            default:
                // snap/arm/disarm etc. can still be handled by the existing
                // WebView JS logic when foreground. To support them with the
                // screen off, implement them here natively too.
                break;
        }
    }

    private String readStream(java.io.InputStream is) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[1024];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toString("UTF-8");
    }

    // ---------------- Camera2 + MediaRecorder ----------------

    private void startRecordingInternal() {
        if (isRecording) return;
        if (!cameraEnabled) {
            Log.i(TAG, "start_rec ignored because camera is disabled. Send /cam_on first.");
            updateNotification("Camera disabled");
            return;
        }

        if (androidx.core.app.ActivityCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "Camera permission missing");
            return;
        }

        try {
            CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            String cameraId = pickBackCameraId(manager);
            if (cameraId == null) {
                Log.e(TAG, "No camera found");
                return;
            }

            currentSessionId = username + "_native_" + System.currentTimeMillis();
            currentSegmentNumber = 1;
            currentOutputFile = new File(getExternalFilesDir(null), currentSessionId + "_part1.mp4");

            mediaRecorder = new MediaRecorder();
            mediaRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            mediaRecorder.setOutputFile(currentOutputFile.getAbsolutePath());
            mediaRecorder.setVideoEncodingBitRate(4_000_000);
            mediaRecorder.setVideoFrameRate(24);
            mediaRecorder.setVideoSize(1280, 720);
            mediaRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
            // Keep native background recording video-only. The WebView camera
            // prompt currently requests camera permission only (audio:false),
            // so using MIC here makes APK recording fail on many phones with a
            // SecurityException unless a separate microphone grant is added.
            mediaRecorder.prepare();

            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice device) {
                    cameraDevice = device;
                    startCaptureSession();
                }

                @Override
                public void onDisconnected(CameraDevice device) {
                    device.close();
                    cameraDevice = null;
                }

                @Override
                public void onError(CameraDevice device, int error) {
                    device.close();
                    cameraDevice = null;
                    Log.e(TAG, "Camera error: " + error);
                }
            }, bgHandler);

        } catch (Exception e) {
            Log.e(TAG, "startRecordingInternal failed", e);
        }
    }

    private void startCaptureSession() {
        try {
            Surface recorderSurface = mediaRecorder.getSurface();
            List<Surface> surfaces = Collections.singletonList(recorderSurface);

            CaptureRequest.Builder builder = cameraDevice.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            builder.addTarget(recorderSurface);

            cameraDevice.createCaptureSession(surfaces, new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession session) {
                    captureSession = session;
                    try {
                        session.setRepeatingRequest(builder.build(), null, bgHandler);
                        mediaRecorder.start();
                        isRecording = true;
                        if (wakeLock != null && !wakeLock.isHeld()) {
                            wakeLock.acquire();
                        }
                        updateNotification("Recording");
                    } catch (Exception e) {
                        Log.e(TAG, "setRepeatingRequest failed", e);
                    }
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession session) {
                    Log.e(TAG, "Capture session config failed");
                }
            }, bgHandler);

        } catch (Exception e) {
            Log.e(TAG, "startCaptureSession failed", e);
        }
    }

    private void stopRecordingInternal() {
        if (!isRecording) {
            closeCamera();
            return;
        }
        try {
            mediaRecorder.stop();
        } catch (Exception e) {
            Log.w(TAG, "mediaRecorder.stop failed: " + e.getMessage());
        }
        try {
            mediaRecorder.reset();
            mediaRecorder.release();
        } catch (Exception ignored) {}
        mediaRecorder = null;
        isRecording = false;
        closeCamera();
        updateNotification("Standing by");

        releaseWakeLock(wakeLock);

        if (currentOutputFile != null && currentOutputFile.exists()) {
            uploadClip(currentOutputFile, currentSessionId, currentSegmentNumber);
        }
    }

    private void closeCamera() {
        if (captureSession != null) {
            captureSession.close();
            captureSession = null;
        }
        if (cameraDevice != null) {
            cameraDevice.close();
            cameraDevice = null;
        }
    }

    private String pickBackCameraId(CameraManager manager) throws Exception {
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics chars = manager.getCameraCharacteristics(id);
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                return id;
            }
        }
        return manager.getCameraIdList().length > 0 ? manager.getCameraIdList()[0] : null;
    }

    // ---------------- Upload finished clip to existing backend ----------------

    private void uploadClip(File file, String sessionId, int segmentNumber) {
        bgHandler.post(() -> {
            try {
                URL url = new URL(SERVER_URL + "/api/upload-recording");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(60000);

                String boundary = "----SecureCamBoundary" + System.currentTimeMillis();
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

                try (OutputStream os = conn.getOutputStream()) {
                    // Match app.js uploadRecording(): backend expects the file
                    // field to be named "video" plus these recording metadata
                    // fields. Sending "file"/"username" here makes the native
                    // APK upload fail even though Web/PWA uploads work.
                    writeFormField(os, boundary, "roomId", sessionId != null ? sessionId : username + "_native");
                    writeFormField(os, boundary, "segmentNumber", String.valueOf(segmentNumber));
                    writeFormField(os, boundary, "isLast", "true");
                    writeFormField(os, boundary, "segmentSize", String.valueOf(file.length()));
                    writeFilePart(os, boundary, "video", file, "video/mp4");
                    os.write(("--" + boundary + "--\r\n").getBytes("UTF-8"));
                    os.flush();
                }

                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    Log.i(TAG, "upload response: " + code);
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                } else {
                    String err = conn.getErrorStream() != null ? readStream(conn.getErrorStream()) : "";
                    Log.e(TAG, "upload failed: " + code + " " + err);
                }
                conn.disconnect();
            } catch (Exception e) {
                Log.e(TAG, "uploadClip failed", e);
            }
        });
    }

    private void writeFormField(OutputStream os, String boundary, String name, String value) throws IOException {
        os.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
        os.write(("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n").getBytes("UTF-8"));
        os.write((value + "\r\n").getBytes("UTF-8"));
    }

    private void writeFilePart(OutputStream os, String boundary, String fieldName, File file, String mimeType) throws IOException {
        os.write(("--" + boundary + "\r\n").getBytes("UTF-8"));
        os.write(("Content-Disposition: form-data; name=\"" + fieldName + "\"; filename=\"" + file.getName() + "\"\r\n").getBytes("UTF-8"));
        os.write(("Content-Type: " + mimeType + "\r\n\r\n").getBytes("UTF-8"));
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = fis.read(buffer)) != -1) {
                os.write(buffer, 0, read);
            }
        }
        os.write("\r\n".getBytes("UTF-8"));
    }

    // ---------------- Notification (required by Android, kept visible) ----------------

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "SecureCam Recording", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shows when SecureCam camera is active");
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String status) {
        Intent openApp = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, openApp,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("SecureCam")
                .setContentText(status)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private void updateNotification(String status) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIF_ID, buildNotification(status));
    }
}
