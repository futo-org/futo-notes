# Settings Screen — Visual Spec

How the Settings screen **looks and is laid out**. This is the visual
companion to `settings.md` (which covers behavior).

All colors are CSS custom properties (`src/styles/app.css`). Concrete values
are listed in [Color tokens](#color-tokens) at the end.

The two sections below draw the line between **what is allowed to look
different per platform** (the chrome) and **what must be the same everywhere**
(the content and functionality). The pixel-level walkthrough of the desktop
rendering that used to follow them was one valid presentation, not a
requirement — it duplicated what the component and its CSS already encode and
repeatedly drifted, so it was removed (2026-07-15). The desktop presentation's
authority is the code: `src/features/settings/SettingsScreen.svelte`, its
sibling section components, the `settings*.css` capability files beside them,
and the tokens in `src/styles/app.css`.

---

## Platform-specific (presentation / chrome)

Each shell renders settings with its own native idioms. These differences are
**expected and allowed** — they should not be "fixed" to match desktop.

| Concern                 | Desktop / Tauri (`SettingsScreen.svelte`)                                                                                   | Native Android (`apps/android/.../ui/SettingsScreen.kt`)                                                                                      | Native iOS (`apps/ios/Sources/SettingsView.swift`)                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Presentation            | Modal **bottom sheet** — dim overlay, panel rises from bottom, ≤600px centered, rounded top corners, ≤85vh, internal scroll | **Full screen** — Compose `Scaffold` with a `TopAppBar` ("Settings" + back arrow)                                                             | **Sheet** — a `NavigationStack` wrapping a grouped `Form` (title "Settings", inline display mode)                 |
| Dismissal               | Click overlay / `Escape` / `×` close button in the sticky header                                                            | Back arrow (and system back)                                                                                                                  | **"Done"** trailing toolbar button + interactive drag-to-dismiss (both suppressed while resetting)                |
| Rendering               | HTML/CSS in the WebView; styles from `app.css` tokens                                                                       | Compose + Material 3 (`SegmentedButton`, `Surface`, `HorizontalDivider`) themed via `FutoTheme`                                               | Native SwiftUI (`Form` `Section`s, `Picker`, `Toggle`, `Link`) tinted `Theme.primary`                             |
| Theme control order     | **Auto · Dark · Light**                                                                                                     | **Light · Dark · Auto**                                                                                                                       | **Light · Dark · Auto** (segmented `Picker`)                                                                      |
| Account header          | None                                                                                                                        | None — folded into the single "Self-hosted sync" Sync row (see settings.md)                                                                   | None — folded into the single "Self-hosted sync" Sync row                                                         |
| Sync UI                 | **Inline** in the Sync card (URL, password, Connect / Sync now, links)                                                      | A single **"Self-hosted sync" row that routes to a separate Sync screen** (`onOpenSync`); no inline form                                      | A single **"Self-hosted sync" row** (with SYNCED/LOCAL badge) that presents `SyncView` as a sheet; no inline form |
| Storage / notes dir     | **Storage** section — shows path, "Change directory" (folder picker + app restart), "Reset to default"                      | **Storage** section — "Storage location" path readout + storage-**mode** switcher (Device/App storage — see app.md); no free directory picker | **Storage** section — read-only "Notes folder" path readout (selectable, monospaced); no picker (fixed sandbox)   |
| Editor note             | Absent                                                                                                                      | Absent — the "Editor" / "file over app" caption was removed (see settings.md)                                                                 | Absent                                                                                                            |
| About / source link     | Absent (version footer only)                                                                                                | **About** section — "Open source" row linking to GitLab + a Version row                                                                       | **About** section — "Open source" link to GitLab + a "Version" row                                                |
| Issue reporting         | Present — "Share crash reports", nested "Send crashes automatically", and "Report an issue" link                               | Present — "Share crash reports" `Switch`, nested "Send crashes automatically" (shown only while the first is on), and "Report an issue" link | Present — "Share crash reports" `Toggle`, "Send crashes automatically" `Toggle` (disabled while the first is off), and "Report an issue" link |
| Danger zone             | "Full reset" (modal confirm) + dev-only "Test crash"                                                                        | "Full reset" (modal `ConfirmDialog`) + debug-only "Test crash" (in a Debug group)                                                             | "Full reset" (`confirmationDialog`) + `#if DEBUG` "Test crash"                                                    |
| Benchmark               | Absent — the Benchmark section was removed from the desktop component                                                       | Absent                                                                                                                                        | Absent                                                                                                            |
| Blocking progress       | In-panel overlay (spinner + phase / error) for Connect and Full reset                                                       | Full-screen overlay ("Deleting all notes…") during Full reset; Connect handled on the Sync screen                                             | Full-screen overlay ("Deleting all notes…") during Full reset; Connect handled in `SyncView`                      |

---

## Shared (content & functionality)

Regardless of how a platform draws its settings, the **set of controls, their
copy, their behavior, and their underlying state are the same**. A user moving
between desktop, Android, and iOS should find the same capabilities with the
same meanings. This is the part that belongs to the app, not the shell.

**Settings every shell should expose, and what each does:**

- **Theme preference** — three choices: **Auto**, **Dark**, **Light**.
  - "Auto" follows the OS theme. The choice persists across restarts.
  - Backed by the shared appearance preference (`appearance.theme` on desktop).
  - _(The label set and meanings are shared; visual order and control style are
    platform-specific.)_
- **Sync** — connect to a hosted E2EE server and sync.
  - Disconnected: enter **Server URL** + **password**, then **Connect** (which
    connects and runs an initial sync).
  - Connected: **Sync now**, **Forget password** (when a password is saved),
    **Reset connection** (disconnect). Show **last-sync time** and current
    status/errors.
  - Connecting/syncing surfaces progress phases: Connecting → Syncing →
    Reconciling / Uploading / Downloading (`current/total`) _(the granular
    phase/count readout is the desktop inline card; the native shells show
    simpler "Connecting…"/"Syncing…" states, and a fast local sync may only
    ever show a generic spinner)_.
  - See `sync.md` for the authoritative sync behavior.
- **Issue reporting** — opt-in **"Share crash reports"**; when on, a nested
  **"Send crashes automatically"** option. A **"Report an issue"** link opens
  the FUTO Notes GitHub issue tracker
  (`https://github.com/futo-org/futo-notes/issues`). Crash preferences persist
  as `crashReporting.enabled` and `crashReporting.alwaysSend`.
- **Full reset (danger)** — permanently delete all notes and app data. Must be
  **guarded by an explicit modal confirmation dialog**: tapping "Full reset"
  opens a confirm dialog ("Permanently delete all notes and app data? This
  cannot be undone."); only confirming deletes, then reloads. (A bare in-place
  two-tap is not enough — a stray double-tap wiped everything too easily.)
- **App version** — display the running version (`FUTO Notes v<version>`).

**Shared semantics that hold on every platform:**

- The **color/token roles** in [Color tokens](#color-tokens) are the shared
  design vocabulary (primary, text, surface, muted, bg, border, danger, the
  orange `--color-primary` accent). Each shell maps these to its own theming
  system, but the roles and the light/dark intent are shared.
- **Destructive actions confirm before acting**; long/destructive operations
  block interaction and report progress or error rather than failing silently.
- **Copy is shared** where the same control exists — e.g. "Auto follows your
  system theme.", "Permanently remove all notes and app data". Platforms should
  reuse this wording rather than inventing their own.

**Platform-only items (NOT part of the shared model):** the desktop **Storage**
directory picker (desktop has a user-chosen notes folder; mobile uses a fixed
sandbox) and the dev-only **Test crash** button. These are desktop conveniences
and need not appear on mobile.

---

## Color tokens

Defined in `src/styles/app.css`. Both themes:

| Token                   | Light          | Dark            |
| ----------------------- | -------------- | --------------- |
| `--color-primary`       | `#F26B1F`      | `#FF7A33`       |
| `--color-primary-hover` | `#D9550F`      | `#FF9559`       |
| `--color-text`          | `#0F0F0F`      | `#FAFAFA`       |
| `--color-border`        | `#E5E5E5`      | `#262626`       |
| `--color-surface`       | `#F2F2F2`      | `#171717`       |
| `--color-muted`         | `#737373`      | `#A3A3A3`       |
| `--color-bg`            | `#FCFCFC`      | `#0A0A0A`       |
| `--color-danger`        | `#DC2626`      | `#EF4444`       |
| `--ink-rgb` (overlay)   | `15, 15, 15`   | `250, 250, 250` |
| `--primary-rgb`         | `242, 107, 31` | `255, 122, 51`  |

Theme follows the Appearance segmented control (Auto/Dark/Light); Auto tracks
the system setting.

---

> **Note:** This spec describes the desktop/Tauri presentation. Native iOS and
> Android shells render their own settings UI and may diverge — record such
> divergences as `> **Gap:**` notes in `settings.md`.
