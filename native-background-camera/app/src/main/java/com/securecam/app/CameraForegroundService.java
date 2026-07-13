package com.securecam.app;

import android.app.KeyguardManager;
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
import android.view.Surface;
import android.view.WindowManager;

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
 * off or the app is backgrounded/minimized.
 *
 * Added features:
 * - /add command → wakes screen + unlocks phone + brings app to front
 * - /status command → returns current state info
 * - Independent command polling (native, not affected by Doze)
 */
public class CameraForegroundService extends Service {

    private static final String TAG = "CameraFgService";
    private static final String CHANNEL_ID = "securecam_recording";
    private static final int NOTIF_ID = 4201;

    // Same backend already used by app.js
    private static final String SERVER_URL = "https://familiar-gertrudis-botakingtipd-f3991937.koyeb.app";
    private static final long POLL_INTERVAL_MS = 5000;

    private String username;
    private long lastCmdTimestamp = 0;

    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private MediaRecorder mediaRecorder;
    private HandlerThread bgThread;
    private Handler bgHandler;
    private PowerManager.WakeLock serviceWakeLock;
    private PowerManager.WakeLock wakeLock;
    private boolean isRecording = false;
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

        pollHandler.removeCallbacks(pollRunnable);
        pollHandler.post(pollRunnable);

        return START_STICKY;
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

    // ========================================================================
    // COMMAND POLLING (native, screen-off safe)
    // ========================================================================

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

            // ================================================================
            // 🔥 NEW: /add command → Wake screen + unlock + bring app to front
            // ================================================================
            case "add":
                wakeScreenAndLaunchApp();
                break;

            // ================================================================
            // ✅ NEW: /status command → Return current state info
            // ================================================================
            case "status":
                sendStatusUpdate();
                break;

            default:
                Log.i(TAG, "Unhandled native command: " + cmd + " (handled by WebView JS when app is visible)");
                break;
        }
    }

    // ========================================================================
    // 🔥 SCREEN WAKE ON /add COMMAND
    // ========================================================================
    private void wakeScreenAndLaunchApp() {
        Log.i(TAG, "🔥 /add received — Waking screen and unlocking!");

        try {
            // Step 1: Launch the app activity with flags to turn screen on + show over lock screen
            Intent appIntent = new Intent(this, MainActivity.class);
            appIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            appIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            appIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);

            // These flags wake the screen and show the app even when locked
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                appIntent.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
                appIntent.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                appIntent.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }

            startActivity(appIntent);

            // Step 2: Acquire a WAKE_LOCK to ensure screen turns on
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock screenWakeLock = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK |
                    PowerManager.ACQUIRE_CAUSES_WAKEUP |
                    PowerManager.FULL_WAKE_LOCK,
                    "SecureCam:ScreenWake");
            screenWakeLock.acquire(10000); // Keep screen on for 10 seconds
            releaseWakeLock(screenWakeLock); // Release after acquire so screen can dim again

            // Step 3: Dismiss keyguard (lock screen) - so user sees the app directly
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                KeyguardManager keyguardManager = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
                if (keyguardManager != null) {
                    keyguardManager.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                        @Override
                        public void onDismissSucceeded() {
                            Log.i(TAG, "🔓 Lock screen dismissed successfully");
                        }

                        @Override
                        public void onDismissError() {
                            Log.w(TAG, "⚠️ Lock screen dismiss failed");
                        }

                        @Override
                        public void onDismissCancelled() {
                            Log.w(TAG, "🔒 Lock screen dismiss cancelled by user");
                        }
                    });
                }
            }

            // Step 4: Update notification to show we woke up
            updateNotification("📱 Woken by /add");

            Log.i(TAG, "✅ Screen wake + unlock complete for /add command");

        } catch (Exception e) {
            Log.e(TAG, "❌ Screen wake failed: " + e.getMessage(), e);
        }
    }

    // ========================================================================
    // ✅ STATUS UPDATE
    // ========================================================================
    private void sendStatusUpdate() {
        bgHandler.post(() -> {
            try {
                JSONObject statusJson = new JSONObject();
                statusJson.put("type", "chat_message");
                statusJson.put("roomId", username + "_secam");
                statusJson.put("sender", "SecureCam");

                String cameraState = cameraEnabled ? "ON" : "OFF";
                String recState = isRecording ? "RECORDING" : "IDLE";
                String serviceState = "Active";

                statusJson.put("text", "📊 SecureCam Status:\n"
                        + "• Camera: " + cameraState + "\n"
                        + "• Recording: " + recState + "\n"
                        + "• Service: " + serviceState + "\n"
                        + "• Screen-off mode: ✅ Enabled\n"
                        + "• Commands: ✅ Active");

                URL url = new URL(SERVER_URL + "/api/event");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.getOutputStream().write(statusJson.toString().getBytes("UTF-8"));
                conn.getInputStream().close();
                conn.disconnect();

                Log.i(TAG, "✅ Status sent");

            } catch (Exception e) {
                Log.w(TAG, "Status update failed: " + e.getMessage());
            }
        });
    }

    private String readStream(java.io.InputStream is) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[1024];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toString("UTF-8");
    }

    // ========================================================================
    // CAMERA2 + MediaRecorder
    // ========================================================================

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

    // ========================================================================
    // UPLOAD
    // ========================================================================

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

    // ========================================================================
    // NOTIFICATION
    // ========================================================================

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "SecureCam",
                    // HIGH importance so notification shows on lock screen
                    // and user knows camera is active
                    NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("SecureCam camera service status");
            channel.setShowBadge(true);
            channel.enableLights(true);
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String status) {
        Intent openApp = new Intent(this, MainActivity.class);
        // Add screen-wake flags so tapping notification also wakes the screen
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            openApp.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            openApp.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
        }
        PendingIntent pi = PendingIntent.getActivity(this, 0, openApp,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("SecureCam")
                .setContentText(status)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setOngoing(true)
                .setContentIntent(pi)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC) // Show on lock screen
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build();
    }

    private void updateNotification(String status) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.notify(NOTIF_ID, buildNotification(status));
        } catch (Exception e) {
            Log.w(TAG, "Notification update failed: " + e.getMessage());
        }
    }
}
