package com.securecam.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.SurfaceTexture;
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
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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
    private static final String SERVER_URL = "https://theoretical-kynthia-mychool-a6f2b3d0.koyeb.app";
    private static final long POLL_INTERVAL_MS = 5000;

    private String username; // Cyber ID, passed in via intent extra on start
    private long lastCmdTimestamp = 0;

    private CameraDevice cameraDevice;
    private CameraCaptureSession captureSession;
    private MediaRecorder mediaRecorder;
    private HandlerThread bgThread;
    private Handler bgHandler;
    private PowerManager.WakeLock wakeLock;
    private boolean isRecording = false;
    private File currentOutputFile;

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
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SecureCam::RecordingWakeLock");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.hasExtra("username")) {
            username = intent.getStringExtra("username");
        }

        startForeground(NOTIF_ID, buildNotification("Standing by"));

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
        if (bgThread != null) bgThread.quitSafely();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------------- Command polling (native, screen-off safe) ----------------

    private void pollCommandsOnce() {
        if (username == null) return;
        bgHandler.post(() -> {
            try {
                URL url = new URL(SERVER_URL + "/api/camera-control?username=" + username);
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
            case "start_rec":
                startRecordingInternal();
                break;
            case "stop_rec":
                stopRecordingInternal();
                break;
            default:
                // ignore other commands here; snap/arm/disarm etc. can still
                // be handled by the existing WebView JS logic when foreground.
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
        if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(10 * 60 * 1000L /*10 min max*/);

        try {
            CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            String cameraId = pickBackCameraId(manager);
            if (cameraId == null) {
                Log.e(TAG, "No camera found");
                return;
            }

            currentOutputFile = new File(getExternalFilesDir(null), "clip_" + System.currentTimeMillis() + ".mp4");
            mediaRecorder = new MediaRecorder();
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            mediaRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            mediaRecorder.setOutputFile(currentOutputFile.getAbsolutePath());
            mediaRecorder.setVideoEncodingBitRate(4_000_000);
            mediaRecorder.setVideoFrameRate(24);
            mediaRecorder.setVideoSize(1280, 720);
            mediaRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            mediaRecorder.prepare();

            if (androidx.core.app.ActivityCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                Log.e(TAG, "Camera permission missing");
                return;
            }

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
            List<Surface> surfaces = List.of(recorderSurface);

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

        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();

        if (currentOutputFile != null && currentOutputFile.exists()) {
            uploadClip(currentOutputFile);
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

    private void uploadClip(File file) {
        bgHandler.post(() -> {
            try {
                URL url = new URL(SERVER_URL + "/api/upload-recording");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                String boundary = "----SecureCamBoundary";
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(("--" + boundary + "\r\n").getBytes());
                    os.write(("Content-Disposition: form-data; name=\"username\"\r\n\r\n").getBytes());
                    os.write((username + "\r\n").getBytes());

                    os.write(("--" + boundary + "\r\n").getBytes());
                    os.write(("Content-Disposition: form-data; name=\"file\"; filename=\"" + file.getName() + "\"\r\n").getBytes());
                    os.write(("Content-Type: video/mp4\r\n\r\n").getBytes());
                    java.nio.file.Files.copy(file.toPath(), os);
                    os.write(("\r\n--" + boundary + "--\r\n").getBytes());
                }

                int code = conn.getResponseCode();
                Log.i(TAG, "upload response: " + code);
                conn.disconnect();
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            } catch (Exception e) {
                Log.e(TAG, "uploadClip failed", e);
            }
        });
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
