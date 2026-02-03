package com.futo.notes;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

@CapacitorPlugin(name = "DrawerBack")
public class DrawerBackPlugin extends Plugin {
  @PluginMethod
  public void setDrawerOpen(PluginCall call) {
    Boolean open = call.getBoolean("open");
    if (open != null && getActivity() instanceof MainActivity) {
      ((MainActivity) getActivity()).setDrawerOpen(open);
    }
    call.resolve();
  }
}
