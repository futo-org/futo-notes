## Verification record audit (2026-09-02)

- Fresh Linux Auto startup applies the webview fallback immediately and then reads the current
  portal value after installing the change listener. A mismatched first frame is therefore
  possible under M1's ungated-render rule, but the wrong theme cannot persist until a later
  desktop change. Installed GNOME/KDE launches reached the current desktop appearance.
- The installed GNOME Wayland VM confirmed the final undecorated one-row header and compositor
  identity. The earlier ten-minute native-decoration alternative probe was not recorded and was
  not recreated after implementation; this is explicitly a missing historical probe, not
  evidence for changing the verified final design.
- Component tests prove the tab strip and empty band own drag regions while controls do not, and
  the installed GNOME/KDE checks covered the collapsed sidebar spacing. These are the retained
  WS3 checks; no commit-body evidence is implied beyond this record.
