package com.securecam.app;

import android.content.Intent;
import android.os.Build;

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

    // Call from app.js: BackgroundCamera.stop()
    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), CameraForegroundService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
