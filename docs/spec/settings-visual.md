# Settings Screen — Visual Spec

How the Settings screen **looks and is laid out**, captured from the Tauri /
desktop implementation (`src/components/SettingsScreen.svelte`). This is the
visual companion to `settings.md` (which covers behavior). The goal: someone
who has never seen the screen could rebuild it pixel-for-pixel from this
document.

All colors are CSS custom properties (`src/styles/app.css`). Concrete values
are listed in [Color tokens](#color-tokens) at the end. `var(--color-bg)` etc.
are referenced throughout.

The two sections immediately below draw the line between **what is allowed to
look different per platform** (the chrome) and **what must be the same
everywhere** (the content and functionality). The detailed sections after them
([Overall structure](#overall-structure) onward) are the desktop/Tauri
reference rendering — they are *one valid presentation of the shared model*,
not a requirement for every platform.

---

## Platform-specific (presentation / chrome)

Each shell renders settings with its own native idioms. These differences are
**expected and allowed** — they should not be "fixed" to match desktop.

| Concern | Desktop / Tauri (`SettingsScreen.svelte`) | Native Android (`apps/android/.../ui/SettingsScreen.kt`) | Native iOS (`apps/ios/`) |
|---|---|---|---|
| Presentation | Modal **bottom sheet** — dim overlay, panel rises from bottom, ≤600px centered, rounded top corners, ≤85vh, internal scroll | **Full screen** — Compose `Scaffold` with a `TopAppBar` ("Settings" + back arrow) | *Not yet built — only `SyncView.swift` exists* |
| Dismissal | Click overlay / `Escape` / `×` close button in the sticky header | Back arrow (and system back) | — |
| Rendering | HTML/CSS in the WebView; styles from `app.css` tokens | Compose + Material 3 (`SegmentedButton`, `Surface`, `HorizontalDivider`) themed via `FutoTheme` | — |
| Theme control order | **Auto · Dark · Light** | **Light · Dark · Auto** | — |
| Account header | None | None — folded into the single "Self-hosted sync" Sync row (see settings.md) | — |
| Sync UI | **Inline** in the Sync card (URL, password, Connect / Sync now, links) | A single **"Self-hosted sync" row that routes to a separate Sync screen** (`onOpenSync`); no inline form | — |
| Storage / notes dir | **Storage** section — shows path, "Change directory" (folder picker + app restart), "Reset to default" | Absent (mobile sandbox; no user-chosen directory) | — |
| Editor note | Absent | Absent — the "Editor" / "file over app" caption was removed (see settings.md) | — |
| About / source link | Absent (version footer only) | **Source** row linking to GitLab + version | — |
| Benchmark | **Benchmark** section (on-device embedding test + results table) | Absent | — |
| Crash reporting toggles | Present (switch + "always send" sub-row) | Absent | — |
| Danger zone | "Full reset" (two-tap confirm) + dev-only "Test crash" | Absent | — |
| Blocking progress | In-panel overlay (spinner + phase / error) for Connect and Full reset | Handled on the dedicated Sync screen | — |

> **Gap (iOS):** the native iOS shell has no Settings screen yet. When it is
> built it should present the [shared model](#shared-content--functionality)
> using iOS-native idioms (e.g. a `NavigationStack` + grouped `List`/`Form`,
> `Toggle`, a segmented `Picker`).

> **Gap (parity):** native Android currently omits crash-reporting controls,
> the benchmark, and the full-reset action that desktop exposes. These are
> shared-model items (below) that Android has not implemented yet — not
> intentional platform differences.

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
  - *(The label set and meanings are shared; visual order and control style are
    platform-specific.)*
- **Sync** — connect to a hosted E2EE server and sync.
  - Disconnected: enter **Server URL** + **password**, then **Connect** (which
    connects and runs an initial sync).
  - Connected: **Sync now**, **Forget password** (when a password is saved),
    **Reset connection** (disconnect). Show **last-sync time** and current
    status/errors.
  - Connecting/syncing surfaces progress phases: Connecting → Syncing →
    Reconciling / Uploading / Downloading (`current/total`).
  - See `sync.md` for the authoritative sync behavior.
- **Crash reporting** — opt-in **"Share crash reports"**; when on, a nested
  **"Always send automatically"** option. Persisted in preferences
  (`crashReporting.enabled`, `crashReporting.alwaysSend`).
- **Full reset (danger)** — permanently delete all notes and app data. Must be
  **guarded by an explicit confirmation** (desktop uses two-tap: "Full reset" →
  "Tap again to confirm" → deletes, then reloads).
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
sandbox), the **Benchmark** section, and the dev-only **Test crash** button.
These are desktop conveniences and need not appear on mobile.

---

## Overall structure

Settings is a **modal bottom sheet**, not a full page.

- A dim **overlay** covers the whole window: `rgba(var(--ink-rgb), 0.35)` —
  i.e. the ink color (near-black in light, near-white in dark) at 35% opacity.
  `z-index: 200`, fixed to all four edges.
- The overlay is a flex container that **bottom-aligns and horizontally
  centers** its child (`align-items: flex-end; justify-content: center`), so
  the panel rises from the bottom edge.
- Clicking the overlay (outside the panel) closes Settings. Pressing `Escape`
  closes it. Both are suppressed while a blocking overlay is up (see
  [Blocking overlays](#blocking-overlays)).

### The panel

- Full width up to `max-width: 600px`; centered.
- Background `var(--color-bg)`.
- Top corners rounded `16px`; bottom corners square (`border-radius: 16px 16px
  0 0`) — it's anchored to the bottom of the viewport.
- `max-height: 85vh`, scrolls internally (`overflow-y: auto`).
- Bottom padding `max(16px, env(safe-area-inset-bottom))` so content clears the
  home indicator on devices.
- `position: relative` — it is the positioning context for the blocking
  overlays, which fill the panel only.

---

## Header

A horizontal bar at the top of the panel that **sticks** while content scrolls.

- `padding: 20px 20px 12px`, `position: sticky; top: 0`, background
  `var(--color-bg)` (so scrolling content slides under it), `z-index: 1`.
- Left: title **"Settings"** — `font-size: 20px`, `font-weight: 600`, color
  `var(--color-text)`.
- Right: a **close button** (`×`, the `&times;` glyph).
  - `36×36px` square, `border-radius: 10px`, no border.
  - Background `var(--color-surface)`; on `:active` it darkens to
    `var(--color-border)`.
  - Glyph `font-size: 22px`, color `var(--color-muted)`, nudged up via
    `padding: 0 0 4px`.
  - The button is **hidden** while a blocking overlay is active.

---

## Content layout

`padding: 0 20px`. Content is a vertical stack of **sections**, each
`margin-bottom: 24px`.

Each section is:
1. A **section title** — `font-size: 12px`, `font-weight: 600`,
   `text-transform: uppercase`, `letter-spacing: 0.06em`, color
   `var(--color-muted)`, `margin: 0 0 8px 4px` (note the 4px left indent).
2. One **card** (`.settings-card`) OR one or more standalone rows/buttons.
   - Card: background `var(--color-surface)`, `border-radius: 12px`,
     `padding: 14px`.

Sections appear in this order (some are conditional):

1. **Storage** — desktop only
2. **Appearance** — always
3. **Sync** — only when the platform has a filesystem
4. **Crash Reporting** — always
5. **Benchmark** — always
6. **Danger zone** — always
7. Version footer

---

## Section: Storage *(desktop only)*

Rendered only on desktop and only once the notes directory has loaded
(`isDesktop && notesDir`). A single card containing:

- A line of muted text showing the **current notes directory path**
  (`.settings-btn-desc`: `font-size: 13px`, color `var(--color-muted)`).
- Below it (`margin-top: 10px`), a **"Change directory"** button — the inline
  button style (see [Buttons](#buttons-and-controls)): solid
  `var(--color-text)` fill, `var(--color-bg)` label, centered, full-width
  within the action row.
- If the directory has been customized away from the default, a **"Reset to
  default"** text link appears below (the small underlined link style).

---

## Section: Appearance

A single card containing a **segmented control** plus a hint.

- **Segmented control** (`.settings-segmented`): a 3-column equal-width grid
  (`grid-template-columns: repeat(3, minmax(0, 1fr))`, `gap: 4px`).
  - Track: `padding: 4px`, `border-radius: 12px`, background
    `var(--color-bg)`, `1px solid var(--color-border)`. (Note: the track is
    bg-colored inside a surface-colored card, so it reads as inset.)
  - Three segments in order: **Auto**, **Dark**, **Light**.
  - Each segment: `border-radius: 9px`, no border, `font-size: 14px`,
    `font-weight: 500`, `padding: 9px 8px`.
  - **Inactive** segment: transparent background, `var(--color-muted)` text.
  - **Active** segment: background `var(--color-primary)`, text
    `var(--color-bg)`.
  - On `:active` press (inactive): faint primary tint
    `rgba(var(--primary-rgb), 0.12)`.
- **Hint** below the control: "Auto follows your system theme." — muted hint
  text (`.settings-hint`: `margin: 6px 0`, `line-height: 1.35`,
  `font-size: 13px`, muted).

---

## Section: Sync *(only with a filesystem)*

A single card. Its contents depend on connection state.

**Common field styling:**
- **Input label** (`.settings-input-label`): block, `font-size: 13px`, color
  `var(--color-muted)`, `margin: 2px 2px 6px`.
- **Text input** (`.settings-input`): full width, `1px solid
  var(--color-border)`, background `var(--color-bg)`, text
  `var(--color-text)`, `border-radius: 10px`, `padding: 10px 12px`,
  `font-size: 14px`, `margin-bottom: 10px`. On focus the border becomes
  `var(--color-primary)` (no glow). A read-only input is shown at
  `opacity: 0.7` with a pointer cursor.

### Disconnected (no auth token)

1. Label **"Server URL"** + text input (placeholder `notes.example.com`).
2. Label **"Password"** + password input (placeholder `Server password`).
3. Hint: "Use the password you configured when installing your FUTO Notes
   server."
4. An action row with a single **"Connect"** inline button (full-width solid
   button). While working it shows **"Working..."** and is disabled
   (`opacity: 0.6`).
5. **"Last sync: never"** (or a relative time) as a muted hint.
6. If there's a status message, an extra muted hint line below it.

### Connected (has auth token)

1. Label **"Server URL"** + the same input, now **read-only** (dimmed,
   pointer cursor). Clicking it triggers the reset-connection confirm.
2. Then one of:
   - If no saved password: label **"Vault password"** + password input
     (placeholder `Required after restart`).
   - If password is saved: hint "Password saved on this device."
3. Action row with a **"Sync now"** inline button (→ "Working..." + disabled
   while busy).
4. If a password is saved: a **"Forget password"** text link.
5. A **"Reset connection"** text link.
6. **"Last sync: …"** muted hint, plus an optional status line.

---

## Section: Crash Reporting

This section uses **toggle rows**, not a card.

- **Toggle row** (`.settings-toggle-row`): a full-width row, background
  `var(--color-surface)`, `border-radius: 12px`, `padding: 14px 16px`,
  space-between layout, `margin-bottom: 2px`. Scales to `0.98` on press.
  - Left: a text column (`gap: 2px`):
    - **Label** (`.settings-btn-label`): `font-size: 16px`, `font-weight:
      500`, color `var(--color-text)`.
    - **Description** (`.settings-btn-desc`): `font-size: 13px`, muted.
  - Right: a **switch** (see below), `margin-left: 12px`, never shrinks.
- First row: **"Share crash reports"** / "Help improve FUTO Notes by sharing
  anonymous crash logs when they occur".
- When that toggle is **on**, a **sub-row** appears directly beneath it:
  **"Always send automatically"** / "Send reports without asking each time".
  - The sub-row has `padding-left: 24px` (indented) and
    `border-radius: 0 0 12px 12px` with `margin-top: 0`, so it visually fuses
    to the bottom of the parent row as one rounded block.

### The switch

- Track: `48×28px`, `border-radius: 14px`, background `var(--color-border)`
  when off → `var(--color-primary)` when on (`transition: background 0.2s`).
- Thumb: `24×24px` circle, background `var(--color-bg)`, positioned `top: 2px;
  left: 2px`, soft shadow `0 1px 3px rgba(var(--ink-rgb), 0.15)`. When on, it
  slides right via `transform: translateX(20px)` (`transition 0.2s`).

---

## Section: Benchmark

A single card for testing on-device embedding inference.

1. Hint at top (`margin-top: 0`): "Test on-device embedding inference. First
   run downloads the model (~35 MB)."
2. Action row with a **"Run benchmarks"** inline button (→ "Running..." +
   disabled while running).
3. While running, an *italic* phase line (`.bench-phase`, muted) reports the
   current step.
4. On error, a hint line colored `var(--color-danger)`.
5. On success, a **results table** (`.bench-table`):
   - Full width, `border-collapse: collapse`, `font-size: 13px`.
   - Header cells: left-aligned, `font-weight: 600`, muted, `font-size: 11px`,
     uppercase, `letter-spacing: 0.04em`, `border-bottom: 1px solid
     var(--color-border)`. Columns: **Test**, **Load**, **Embed**.
   - Body cells: `var(--color-text)`, hairline bottom border (border color at
     50% via `color-mix`); last row has no border.
   - The Load/Embed numeric cells (`.bench-num`) are right-aligned,
     `font-variant-numeric: tabular-nums`, `white-space: nowrap`, formatted as
     `<n> ms`.
   - Below the table, a muted hint: "Output: <dims>-dim vectors. The real
     indexer holds one session — load cost is paid once."

---

## Section: Danger zone

No card — standalone full-width buttons.

- **Full reset** button (`.settings-btn.settings-btn-danger`): full-width,
  `padding: 14px 16px`, background `var(--color-surface)`, `border-radius:
  12px`, left-aligned text, scales to `0.98` on press.
  - It holds a stacked text column (label + description, `gap: 2px`).
  - In a danger button the **label is colored `var(--color-danger)`**; the
    description stays muted.
  - State machine on the label/description:
    - Default: **"Full reset"** / "Permanently remove all notes and app data".
    - After first tap (armed): **"Tap again to confirm"** / "This cannot be
      undone!".
    - While deleting: description shows "Deleting..." and the button is
      disabled.
- **Test crash** button — *dev builds only* (`import.meta.env.DEV`).
  `margin-top: 8px`, same danger-button style. Label **"Test crash"** / "Throw
  an error to test crash reporting".

---

## Version footer

Centered muted text at the bottom: **"FUTO Notes v<version>"**.
`.settings-version`: `font-size: 12px`, color `var(--color-muted)`,
`margin: 16px 0 8px`, `text-align: center`.

---

## Buttons and controls

Reusable styles referenced above.

- **Inline button** (`.settings-btn-inline`): the primary action button used
  inside action rows. `flex: 1` (fills the row), background
  `var(--color-text)`, label color `var(--color-bg)` (i.e. inverted), centered
  text, `padding: 10px 12px`, `font-weight: 500`, `border-radius: 10px`.
  - Lives inside `.settings-actions`: a flex row, `gap: 8px`,
    `margin-top: 4px; margin-bottom: 6px`.
- **Full-width list button** (`.settings-btn`, used by Danger zone):
  space-between layout, `padding: 14px 16px`, background
  `var(--color-surface)`, `border-radius: 12px`, left-aligned. `:active`
  scales to `0.98`.
- **Any button when disabled**: `opacity: 0.6`, default cursor, no press
  transform.
- **Text link** (`.settings-link-btn`): block, no background/border,
  `font-size: 12px`, color `var(--color-muted)`, underlined, `margin: 6px 0
  2px`. `:active` drops to `opacity: 0.6`. Used for "Reset to default",
  "Forget password", "Reset connection".

---

## Blocking overlays

Two full-panel overlays cover the panel (not the whole window) while a
long/destructive op runs. Both share `.connect-sync-overlay`:

- `position: absolute; inset: 0` (fills the panel only), background
  `var(--color-bg)`, rounded top corners `16px 16px 0 0` to match the panel,
  `z-index: 10`, centered column layout with `gap: 16px`.
- While active, the header close button is hidden and overlay/Escape dismissal
  is disabled.

**Connect + sync overlay** (during "Connect"):
- Spinner (`.connect-sync-spinner`): `32×32px`, `3px` border in
  `var(--color-border)` with the top edge `var(--color-primary)`, full circle,
  spins `0.8s linear infinite`.
- Phase text (`.connect-sync-phase`) below it: `font-size: 15px`, muted,
  `font-variant-numeric: tabular-nums` (so the `X/Y` counter doesn't jitter).
  Phases cycle through "Connecting to server...", "Syncing notes...",
  "Reconciling N/M…", "Uploading N/M…", "Downloading N/M…".
- On error: the spinner is replaced by an error message
  (`.connect-sync-error`: `font-size: 14px`, `var(--color-danger)`, centered,
  `padding: 0 24px`, `line-height: 1.4`) plus a **"Close"** button
  (`.connect-sync-cancel`: `var(--color-surface)` bg, `var(--color-text)`,
  `padding: 10px 24px`, `border-radius: 10px`).

**Nuke overlay** (during Full reset): identical layout. Spinner + phase text
"Deleting all notes...", or on error the same error + "Close" button.

---

## Color tokens

Defined in `src/styles/app.css`. Both themes:

| Token | Light | Dark |
|---|---|---|
| `--color-primary` | `#F26B1F` | `#FF7A33` |
| `--color-primary-hover` | `#D9550F` | `#FF9559` |
| `--color-text` | `#0F0F0F` | `#FAFAFA` |
| `--color-border` | `#E5E5E5` | `#262626` |
| `--color-surface` | `#F2F2F2` | `#171717` |
| `--color-muted` | `#737373` | `#A3A3A3` |
| `--color-bg` | `#FCFCFC` | `#0A0A0A` |
| `--color-danger` | `#DC2626` | `#EF4444` |
| `--ink-rgb` (overlay) | `15, 15, 15` | `250, 250, 250` |
| `--primary-rgb` | `242, 107, 31` | `255, 122, 51` |

Theme follows the Appearance segmented control (Auto/Dark/Light); Auto tracks
the system setting.

---

> **Note:** This spec describes the desktop/Tauri presentation. Native iOS and
> Android shells render their own settings UI and may diverge — record such
> divergences as `> **Gap:**` notes in `settings.md`.
