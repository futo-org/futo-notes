package com.futo.notes;

import android.os.Build;
import android.os.Bundle;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  private boolean drawerOpen = false;
  private OnBackPressedCallback legacyBackCallback;
  private OnBackInvokedCallback predictiveBackCallback;
  private boolean predictiveRegistered = false;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    registerPlugin(DrawerBackPlugin.class);
    registerPlugin(FolderImportPlugin.class);
    super.onCreate(savedInstanceState);
    setupBackCallbacks();
  }

  public void setDrawerOpen(boolean open) {
    drawerOpen = open;
    updateBackCallbackRegistration();
  }

  private void setupBackCallbacks() {
    legacyBackCallback = new OnBackPressedCallback(false) {
      @Override
      public void handleOnBackPressed() {
        toggleDrawer();
      }
    };
    getOnBackPressedDispatcher().addCallback(this, legacyBackCallback);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      predictiveBackCallback = this::toggleDrawer;
    }
  }

  private void updateBackCallbackRegistration() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
      if (predictiveBackCallback == null) {
        return;
      }
      if (drawerOpen && !predictiveRegistered) {
        dispatcher.registerOnBackInvokedCallback(
          OnBackInvokedDispatcher.PRIORITY_OVERLAY,
          predictiveBackCallback
        );
        predictiveRegistered = true;
      } else if (!drawerOpen && predictiveRegistered) {
        dispatcher.unregisterOnBackInvokedCallback(predictiveBackCallback);
        predictiveRegistered = false;
      }
      return;
    }

    if (legacyBackCallback != null) {
      legacyBackCallback.setEnabled(drawerOpen);
    }
  }

  private void toggleDrawer() {
    if (getBridge() == null || getBridge().getWebView() == null) {
      return;
    }
    getBridge().getWebView().post(() -> getBridge().getWebView().evaluateJavascript(
      "window.__toggleNotesDrawer && window.__toggleNotesDrawer()",
      null
    ));
  }
}
