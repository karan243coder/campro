package com.securecam.app;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundCamera")
public class BackgroundCameraPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String username = call.getString("username");
        Intent intent = new Intent(getContext(), CameraForegroundService.class);
        intent.putExtra("username", username);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                String packageName = getContext().getPackageName();
                if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + packageName));
                    if (getActivity() != null) {
                        getActivity().startActivity(intent);
                    } else {
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(intent);
                    }
                }
            }
            call.resolve();
        } catch (Exception e) {
            try {
                Intent settings = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
                call.resolve();
            } catch (Exception ignored) {
                call.reject("Unable to open battery optimization settings");
            }
        }
    }

    // 🔥 NEW: Wake screen + unlock (can be called from JS or Telegram)
    @PluginMethod
    public void wakeScreen(PluginCall call) {
        try {
            Context ctx = getContext();
            if (ctx == null) { call.reject("Context null"); return; }

            Intent appIntent = new Intent(ctx, MainActivity.class);
            appIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            appIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            appIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                appIntent.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
                appIntent.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                appIntent.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }

            ctx.startActivity(appIntent);

            // Wake lock to turn screen on
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock wakeLock = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK |
                    PowerManager.ACQUIRE_CAUSES_WAKEUP |
                    PowerManager.FULL_WAKE_LOCK,
                    "SecureCam:ScreenWake");
            wakeLock.acquire(10000);
            if (wakeLock.isHeld()) wakeLock.release();

            // Dismiss keyguard
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                KeyguardManager kgm = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
                if (kgm != null && getActivity() != null) {
                    kgm.requestDismissKeyguard(getActivity(), null);
                }
            }

            call.resolve();
        } catch (Exception e) {
            call.reject("Wake screen failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), CameraForegroundService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
