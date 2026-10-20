/**
 * Screen markers, timeouts and file names the native Android sync client shares.
 */

/** The emulator reaches host services (the harness sync server) through this. */
export const EMULATOR_HOST_LOOPBACK = '10.0.2.2';

/**
 * How a note-list screen is recognised: the New-note FAB's content description.
 * The list is now a folder browser (root notes + top-level folders, tapping a
 * folder pushes its contents), so there is no "All notes" title to anchor on and
 * the top-bar title is whichever folder is showing. The FAB is on every folder
 * screen and nowhere else.
 */
export const NOTE_LIST_MARKER = 'New note';

/** The Settings row that opens the Sync screen (settings.sync.label). It was
 *  "Self-hosted sync" until hosted sync existed; it is now just "Sync"
 *  (settings.md), so this alone is ambiguous with the Sync screen's own
 *  top-bar title ("Sync" too) — SETTINGS_SYNC_SECTION_MARKER anchors it to
 *  the Settings screen specifically. */
export const SETTINGS_SYNC_ROW_LABEL = 'Sync';

/** The uppercased Settings section header above the Sync row
 *  (settings.sections.sync, rendered via MicroLabel's `.uppercase()`) — present
 *  only on the Settings screen, never the Sync screen or the note list, so it
 *  safely anchors SETTINGS_SYNC_ROW_LABEL's otherwise-ambiguous tap. */
export const SETTINGS_SYNC_SECTION_MARKER = 'SYNC';

/** A hosted build (every debug build, and a prerelease-tag release build —
 *  settings.md "Sync screen, with hosted sync built in") leads the Sync
 *  screen with the hosted wizard instead of rendering the self-hosted fields
 *  this harness drives directly. This disclosure (sync.hosted.useMyOwnServer,
 *  HostedSyncSections.kt) reveals the identical SelfHostedSyncSections a
 *  hosted-off build renders up front, so tapping it is the one hosted-aware
 *  step the rest of the navigation needs. */
export const USE_MY_OWN_SERVER_LABEL = 'Use my own server';

/** Every note this harness creates on the device starts with this, so cleanup
 *  can never touch a note the harness did not write. */
export const HARNESS_NOTE_PREFIX = 'xsync-';

/** Sync checkpoint/ancestry files the Rust core keeps in the vault root — stale
 *  ones would resume a new scenario's fresh server from a dead cursor. */
export const SYNC_STATE_FILES = ['.e2ee-state.json', '.e2ee-ancestry.json'];

// An accessibility-tree dump costs ~2 s on an emulator and a screen change can
// need several, so UI waits are generous by construction, not by flake-chasing.
export const UI_TIMEOUT_MS = 45_000;
export const CONNECT_TIMEOUT_MS = 60_000;
export const SAVE_TIMEOUT_MS = 20_000;
// A live delivery normally lands in a second or two over SSE; the core's ~45 s
// safety poll is the backstop when an event is missed, so wait past it before
// calling live sync broken.
export const LIVE_TIMEOUT_MS = 90_000;
export const OPEN_NOTE_LOG_TAG = 'FutoOpenNote';
