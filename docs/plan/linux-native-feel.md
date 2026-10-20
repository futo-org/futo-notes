# Linux native feel — plan

Status: implemented and locally verified 2026-09-02. Branch `linux-native-feel`, worktree
`~/Developer/futo-notes-linux-native-feel`, based on `main` at f063c98e. The RPM was verified on
Fedora KDE and in a Fedora 43 GNOME Wayland VM; non-Linux desktop checks remain CI/manual follow-up
coverage.

Seven workstreams that make the Tauri desktop app read as a Linux application instead of a web
page in a frame. All of them stay inside the current architecture: Svelte in a WebKitGTK webview
under Tauri. Nothing here depends on the editor swap, the egui spike
(`docs/plan/egui-desktop-spike.md` on `poc/egui-desktop-shell`, killed on its embedding probe), or
a Flatpak manifest, which is deliberately out of scope.

The steps below are a starting shape, not a script. Where a step says "decide", the implementer
picks, records the choice in the commit body, and moves on. Where a step says "measure" or
"verify", the result goes in the commit body too. A workstream that turns out to be wrong on a
real desktop is dropped or reshaped, not forced.

- [Ground rules (from AGENTS.md, restated because every workstream touches them)](linux-native-feel/ground-rules.md)
- [Suggested order](linux-native-feel/suggested-order.md)
- [WS1 — Stop disabling the GPU renderer on every Linux machine](linux-native-feel/ws1-gpu-renderer.md)
- [WS2 — Read desktop settings over D-Bus](linux-native-feel/ws2-desktop-settings-over-dbus.md)
- [WS3 — One header row: window controls in the top band](linux-native-feel/ws3-one-header-row.md)
- [WS4 — System font for the interface](linux-native-feel/ws4-system-font.md)
- [WS5 — Desktop entry, markdown association, open a file](linux-native-feel/ws5-desktop-entry.md)
- [WS6 — File dialogs through the desktop portal](linux-native-feel/ws6-file-dialogs-portal.md)
- [WS7 — Ctrl+Q quits](linux-native-feel/ws7-ctrl-q-quits.md)
- [Cross-cutting verification before each MR](linux-native-feel/cross-cutting-verification.md)
- [Recorded implementation decisions](linux-native-feel/recorded-implementation-decisions.md)
- [Verification record audit (2026-09-02)](linux-native-feel/verification-record-audit.md)
