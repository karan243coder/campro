package com.securecam.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundCamera")
public class BackgroundCameraPlugin extends Plugin {

    // Call from app.js: BackgroundCamera.start({ username: currentUser.username })
    // Starts the foreground service so recording + command polling keep
    // working even after the screen turns off or the app is minimized.
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

    // Call from app.js: BackgroundCamera.requestBatteryOptimizationExemption()
    // Opens Android's official prompt/settings so the user can allow SecureCam
    // to keep polling commands while the screen is off. This is a user-visible
    // system permission flow, not a bypass.
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

    // Call from app.js: BackgroundCamera.stop()
    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), CameraForegroundService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
