package com.futo.notes;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "StorageAccess")
public class StorageAccessPlugin extends Plugin {

    @PluginMethod
    public void checkAllFilesAccess(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", isAllFilesAccessGranted());
        call.resolve(result);
    }

    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (isAllFilesAccessGranted()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }

        try {
            Intent appIntent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            appIntent.setData(Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, appIntent, "allFilesAccessResult");
        } catch (Exception appIntentError) {
            try {
                Intent globalIntent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                startActivityForResult(call, globalIntent, "allFilesAccessResult");
            } catch (Exception globalIntentError) {
                JSObject result = new JSObject();
                result.put("granted", false);
                call.resolve(result);
            }
        }
    }

    @ActivityCallback
    private void allFilesAccessResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        JSObject ret = new JSObject();
        ret.put("granted", isAllFilesAccessGranted());
        call.resolve(ret);
    }

    private boolean isAllFilesAccessGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return true;
        }
        return Environment.isExternalStorageManager();
    }
}
