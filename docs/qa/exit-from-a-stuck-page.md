# Exit from a stuck page

## Why a device

The native lifecycle and WebView scheduling decide when a posted edit reaches the
mailbox. Browser tests establish the protocol, but cannot prove OS suspension.

## Story

Open a synthetic 50,000-line single paragraph and press Back during parse. The shell has no announced edit and leaves immediately; the file stays unchanged. Repeat after editing a small note and switching to the giant note: the small note must retain the edit.

Use a claimed device, the debug application and an isolated synthetic vault.
Inspect disk bytes after reopening; a visible marker alone does not prove persistence.

## Last run

2026-10-03, `step1-editor-ownership`, claimed Android emulator `futo-qa-0`
(`emulator-5560`), debug app: passed both variants. Back immediately after tapping
the synthetic 50,000-line paragraph returned to the list; polling observed it
in 2,137 ms (including accessibility dump overhead). Disk bytes were identical,
and the next small note opened. Typing `switchmarker` into a small note, leaving,
opening the giant note and immediately pressing Back retained the small edit and
left the giant file unchanged.

iOS 27 iPhone 17 Pro simulator `futo-qa-0`, debug app using `release-ffi` and
software-keyboard input: passed both variants. The clean giant Back was observed
in 2,595 ms including accessibility polling; the small edit survived, and the
giant stayed byte-identical. The next small note opened and accepted input. Protocol and native unit checks are
recorded in `docs/plan/editor-owns-the-document.md`.

## Not proven

OS process kill before any flush can run remains outside the persistence guarantee.
Accessibility polling does not measure the native Back transition latency.
A simulator run cannot establish physical-device suspension timing.
