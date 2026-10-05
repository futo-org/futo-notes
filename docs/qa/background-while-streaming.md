# Background while streaming

## Why a device

The native lifecycle and WebView scheduling decide when a posted edit reaches the
mailbox. Browser tests establish the protocol, but cannot prove OS suspension.

## Story

Open a synthetic 20,000-section note, type a marker in its first section while the tail streams, background within one second, wait for the save, terminate and reopen. The marker and final section must remain in the file.

Use a claimed device, the debug application and an isolated synthetic vault.
Inspect disk bytes after reopening; a visible marker alone does not prove persistence.

## Last run

2026-10-03, `step1-editor-ownership`, claimed Android emulator `futo-qa-0`
(`emulator-5560`), debug app: passed. The 20,000-section document was still
streaming at open and typing. Immediate Home followed by process restart retained
`ownershipmarker`, section 19,999 and 597,794 saved bytes. The final build passed
the rerun as well.

iOS 27 iPhone 17 Pro simulator `futo-qa-0`, debug app using `release-ffi`: passed
with software-keyboard input. The initial AXe run could not establish typing; a separate
probe on the unchanged baseline showed HID typing doing nothing while a software
key touch saved. The software-keyboard rerun passed with a 60,000-section note: immediate Home
retained the typed marker and section 59,999 on disk after terminating the app.
The automated story checks disk after termination; it does not relaunch to inspect
the note visually. Protocol and native
unit checks are recorded in `docs/plan/editor-owns-the-document.md`.

## Not proven

OS process kill before any flush can run remains outside the persistence guarantee.
A simulator run cannot establish physical-device suspension timing.
