# Agent-native FUTO Notes: design decisions

The decisions behind `just puppet` (`crates/futo-puppet`, `src/app/puppet`, the phones'
`PuppetServer*` listeners), each with the reason it holds. Decided with Mason from 2026-09-15
on; this file states what is true now, and git history keeps how it got here. How to use
the tool is the `puppet` skill (`.claude/skills/puppet/`); this is why it is built this way.

## Problem

Agents could not drive the app quickly, and could not tell what the UI did when a tap, hover
or drag landed somewhere. Screenshots are slow and token-heavy, the accessibility tree is
slow and brittle for planning, and neither says which handler ran. So UI interaction bugs
were found by reading code and guessing.

## One CLI, one listener per shell

```
futo-puppet  ──▶  per-shell debug listener  ──▶  the real app on a real device
   │                (desktop / iOS / Android)
   ├─ act      do <Verb> <json> · a JSON array of steps is a batch
   ├─ input    click · tap · drag · scroll · type · press — real platform input
   └─ read     look · actions · elements · state · notes · search · file · doc · at · show · events · diff · screenshot
```

- **Syntax.** One process per call: a command name and one JSON object, checked against a
  schema. No flags, no expression language, no `key=value` grammar: each is a second
  grammar to learn, and a Rust CLI would need an embedded interpreter for an expression
  language. CLI commands are fixed and documented once (the skill, the usage text), never
  in `actions`.
- **One verb namespace.** A verb runs through the running shell's own call site, whether it
  ends in a Svelte handler, a Swift view or the Rust store; the agent never learns which.
  An earlier plan linked the store into the CLI for headless "core" commands: a second
  command family that only told the agent where a verb executes.
- **One channel per shell** carries verbs, reads and the trace, so there is one ordered
  timeline live and one file after. Desktop speaks the debug build's mcp-bridge WebSocket;
  each phone's debug build runs an HTTP listener on the worktree's slot port.
- **No ranking, tiers or line budgets.** Each answer is bounded by its question. Ranked
  output is task-blind and dresses facts as findings; typed overviews plus named queries
  that cut into them are not.
- **Element identity is shared.** The ref `elements` prints (`e3` for the page, `n4` for a
  phone's native row) is the ref `tap`, `click` and `show` accept.
- `step` acts once and observes everything as JSON, for a program that drives the app.

## Reads

| Command    | Answers                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `look`     | `state`, `elements`, the screen's verbs and the vault's size in one read                                                   |
| `actions`  | the verbs on this screen, one a line: `OpenNote {noteId: string, mode?: current｜foreground｜background}`                  |
| `elements` | the screen as one outline: sections, then each row's ref, role, label, what it responds to, note or folder, rect, `→ Verb` |
| `state`    | what the app holds: screen, open note, which lines show, selection, dialogs, tabs, settings, sync, `pending`, `copied`     |
| `doc`      | the open note's lines on screen: positions, kind, text, and the saved markdown where it differs                            |
| `notes`    | every note id and folder path in the vault                                                                                 |
| `search`   | the app's own search, ranked note ids                                                                                      |
| `file`     | a note's markdown on disk, the open note saved first unless `save:false`; narrowed in the CLI, never capped                |
| `at`       | the element stack at a point, hit and painted, and the owner of each pointer event                                         |
| `show`     | one element in depth (box, clipping, handlers, hit versus paint); `{"text"}`: where that text shows                        |
| `events`   | the trace: the input events the page saw and each handler that ran                                                         |
| `diff`     | between two snapshots; by default the last action's                                                                        |

`actions` prints each verb's arguments in a short form, not its JSON Schema: 56–61% smaller,
and agents read it as well. `{"json":true}` gives the raw typed form of anything.

**A note is read where it shows (2026-10-22).** `doc`, `show {"text"}`, `step` and receipts
carry only the lines on screen (`puppetNoteLines.ts`, two binary searches over where lines
paint); a change off screen is reported only as where it is. Whole-note reads were more than
a person ever sees, and slow: snapshotting the document cost 21 s per tap on an 80,000-line
note. `state` keeps what debugging needs and a person's eyes do not (the note the editor
holds, which lines show, loading, the selection's positions). The note's size is left out
until something needs it.

**One screen, one outline.** `elements` has the same shape on every target. The phones' native
screens come from the app's own accessibility, read in-process (iOS `PuppetScreenReader.swift`
keeps an element only where the window's hit test at its point reaches it; Android reads the
merged Compose semantics of the topmost window that takes touches). On a phone's editor
screen the page's rows join the native ones, shifted into screen points (iOS) or dp
(Android), so one coordinate space holds the whole screen (`crates/futo-puppet/src/screen.rs`).
Only what a click or a finger can reach is listed; a half-covered control carries `aim`, the
point that reaches it. Native refs persist in `.puppet/native-refs.json`. A row prints what it
responds to in a person's words (`click`, `tap`, `hold`); handler names stay in `show`, `at`
and `events`.

## Acting as a person does

- **Every step is one a person could take from the screen as it is.** A verb that acts on one
  row (`OpenNote`, `ToggleFolder`, a row's menu) is refused when that row is not among
  `elements`: an id a person cannot see is not something a person can open.
- **A refusal carries the next call.** Agents rebuilt paths by trial from prose advice
  (about 75 row refusals in five batch runs). The CLI now prints the batch that reaches the
  row from where the agent stands (the closed folders above it, a phone's `GoBack`s from its
  navigation stack), ready to paste; it never runs it. A misnamed argument prints the call it
  meant; a verb this screen lacks lists the ones it has.
- **Text off screen is reached by `ScrollToLine` (2026-10-26).** A verb aimed at text or a line
  off screen (for a range, its start) is refused with `ScrollToLine {"line"}`, a convenience
  that does a scroll wheel's work in one call and refuses 409 if the line still does not show.
  Find stays its own verbs (`OpenFind`, `SetFindQuery`) for searching, but is not the way
  back: it folds case and stops at chips and images, so it can land on another occurrence.
- **Verbs live with their controls.** A component registers the verbs for the handlers it
  owns while it is mounted (`registerPuppetVerbs` in `puppetRegistry.ts`), so `actions` is
  per screen by construction. A desktop modal opens a scope (`puppetModalScope`) that hides
  the verbs behind it. The phones do the same natively: iOS `.puppetVerbs { … }`
  (`PuppetVerbs.swift`), Android `PuppetVerbScope` (`PuppetVerbs.kt`), counted only while
  the screen's own stack entry is on top. A verb that returns a promise answers 202 with a
  pending record, and the CLI prints the settled receipt.
- **Controls name their verbs.** Each verb lists the catalog keys of its controls' labels
  (`controls`), so a row reads `→ CloseFind`; a row whose label is the user's own (a note, a
  folder) claims its verb by selector (`controlsMatching`). `just check-puppet-verbs` holds
  this on all three platforms: a labelled control that no verb claims fails, a verb whose
  label is on no control fails, and a Svelte, SwiftUI or Compose file with a handler must
  register verbs or sit in its allowlist with a reason. Matching handlers instead of labels
  paired 1 of 28 rows: Svelte wraps nearly every handler.
- **Confirmations are the app's own dialogs** on every platform. A verb opens the dialog a
  click opens; `ConfirmDialog` and `DismissDialog` answer it. `answer` on a verb is the CLI
  pressing one of them next, so the dialog's own act (its toast, its delete) runs.
- **Pickers take a path** (`InsertImage`, `SetNotesDirectory`). `SetNotesDirectory` refuses,
  in Rust, any path that does not resolve inside `just tauri-dev`'s data folder, or that names
  `futo-notes` (M3).

## Editor verbs

- **The selection is the argument.** Formatting verbs take no arguments and act on the
  selection, as their toolbar buttons do; they are named after the `TOOLBAR_EXEC` ids
  (`Bold`, `Heading`, `TaskList`, …). `Select` supplies the selection.
- **Positions are ProseMirror's**, read from `doc`, `show {"text"}` or `state`, never counted
  from markdown. `expect` refuses 409 if the text at a range differs; `docVersion` (a hash of
  the document) refuses if the document moved.
- **Text anchors (2026-09-21).** `Select` and `Replace` take `{"find"}`, `Insert` takes
  `{"after"}`/`{"before"}`, matched literally and required to match once on screen; several
  matches are refused with every position. Offsets are true for exactly one version of the
  document, and their failure is silent: a batch reused an offset after an earlier step
  edited the text, formatted whatever slid into place, and the receipt said 200. The CLI
  also refuses a batch step that reuses a bare offset after an earlier step edited the text.
- **Fast writes are not input.** `Insert`, `Replace` and the line verbs are one transaction
  each, read as markdown, with no keymap or input rule. They arrange a document; behaviour
  that comes from typing is tested with `PlaceCaret`/`Select`, then `Type` and `Press`.
  `actions` marks them `"convenience": true`.

## Real input

- **Desktop:** the debug app builds platform mouse and key events and hands them to its own
  web view (`apps/tauri/src-tauri/src/puppet_input.rs`): `NSEvent`s to WKWebView's responder
  methods on macOS, `GdkEvent`s to the WebKitGTK widget on Linux, DevTools
  `Input.dispatch*Event` to WebView2 on Windows. The page sees `isTrusted` events and nothing
  reaches the window server, so the human's other windows never get them (M24). The window is
  never activated, because macOS's key-window rule dropped clicks while the human was in
  another window. The web view is a mouse surface, so its gesture is `click`, not `tap`.
- **Phones:** `tap`, `drag`, `type` and `press` go through the simulator's and emulator's own
  input (`axe`, `adb`) behind the CLI, never as a driver the agent learns. `axe` and `adb`
  exit 0 wherever a touch lands, so each debug app records the touches it receives
  (`PuppetTouches.swift`, `PuppetTouches.kt`) and a receipt opens with what the touch hit; a
  touch the app never received fails instead of reading as `no change`.
- **The two Backs.** `do GoBack` is the app's back button on both phones. Android's system
  Back is a different act (it closes the keyboard, a bar, a menu or dialog first), so it is
  the key `press {"key":"Back"}`; iOS has none and refuses it.

## Receipts

- **What an action did.** The CLI reads `state` and the vault before and after every `do`,
  gesture and `step` on all three targets (`crates/futo-puppet/src/app.rs`) and reports each
  changed key as `was → now`, notes and folders added, removed and written. A switch that
  repainted no row used to read as `no change`. `settings` is each platform's whole settings
  store under its own keys, secrets as `set`: a hand-picked set missed some. `copied` is the
  text the app last put on the clipboard, recorded where the app writes it, never read back
  from a clipboard the user shares. In-memory UI state has no generic reader on any
  platform; what shows is `elements`, what persists is `settings`, and the rest that matters
  is work in flight (`pending`) and the undo depth.
- **Read whole (2026-10-01).** Agents filtered 92% of receipts, and the one failure in that
  run was a `grep` that hid the line saying a new note had been discarded. Receipts are text,
  verdict first, every row on one line with every field: 0.40× the tokens of the JSON they
  replaced. A batch prints each step's verdict and facts, then the screen it ended on once
  the page stops moving. A Claude Code hook (`scripts/puppet-receipt-hook.mjs`) refuses a
  piped or filtered action, because agents chose a filter before seeing any receipt.
- **Statuses:** 409 is a stale position or a state that refuses (permanent states too); 503
  is not ready yet. Every receipt is appended to `.puppet/trace.jsonl` in the worktree.

## The inspector engine (page side)

The web view is the whole desktop UI and the editor on both phones, and the one surface where
"what handles this tap" has an exact answer.

- **Describe:** rect, clipping ancestors, `pointer-events`, owning Svelte component, handlers
  by event and function name. The component file comes from the `__svelte_meta.loc.file`
  that a Svelte 5 dev build stamps on each element; function names alone collide. The
  phones' editor page is a production build, so its elements name no component.
- **Probe:** the stack at a point, merged from `elementsFromPoint` and geometry so
  `pointer-events: none` layers still show, and hit versus paint: an analytic prediction of
  what an element paints, checked by the browser just inside each edge and rounded corner.
- **Trace:** one patch of `addEventListener` installed before the app mounts
  (`puppetListeners.ts`) wraps every listener, ProseMirror's included; Svelte's delegated
  handlers are recorded by rewriting the per-element table along the event's path. Per event:
  target, path, `isTrusted`, each handler in order, what it prevented, and for the editor the
  position it resolved against where the selection settled.
- **Not traced:** execution inside handlers. It distorts the timing of the bugs being chased
  and produces thousands of lines per tap.
- **Regions are derived, not declared.** The one declared list is pseudo-elements, which
  paint but have no DOM node.

## Release and safety

- **Compiled out of release.** `TEST_HOOKS_ENABLED` (`src/app/testHooksEnabled.ts`) is
  replaced statically by Vite and the engine is a dynamic import behind it, so a release
  bundle carries none of it. Every native debug recipe builds `editor.html` as release does,
  minified, plus `VITE_INCLUDE_TEST_HOOKS=true`, which adds the engine and keeps function
  names (without them every handler is named `Id`). A development bundle was twice the size
  and slower, so debug apps and the perf gate ran code that does not ship. Release also
  closes every channel that could reach the page: the mcp-bridge is
  `cfg(debug_assertions)`, iOS `isInspectable` is `#if DEBUG`, Android's DevTools follow
  `BuildConfig.DEBUG`, and the phones' listeners exist only in debug builds.
- **A hand-built release after a debug recipe** packages the staged debug `editor.html`.
  Accepted (2026-10-26): CI and the deploy scripts rebuild the bundle, nobody builds a release
  by hand, and the release listener is absent, so nothing can call the page code.
- **Only this checkout's debug app.** A desktop target is resolved only through
  `scripts/qa-target.mjs` (M24), and the CLI remembers the vetted process (pid, start time,
  executable, vault override) in `.puppet/verified-desktop-app.json`. A phone listener is
  checked against the claimed device: Android against the owner of its `adb forward`
  (`--no-rebind`), iOS against the simulator's udid on the first request.
- **Only adb reaches the Android listener (2026-10-26).** Any app on the device could reach a
  loopback port and read or delete notes. The listener is an abstract local socket
  (`localabstract:futo-puppet`) that accepts only the shell and root users, which is how adbd
  connects for `adb forward`; every app runs as its own user and is refused.
- **Nothing hangs.** A desktop app that stops answering is an error after 10 s.

## Not built

- The overlay (boxes, tap markers, drag paths drawn in the page from the same probe data),
  `--profile` on one action, per-step screenshots, and source-map `file:line` per handler.
- **Bind each verb to its control (after v1; recorded 2026-10-20).** Every control is written
  twice, `onclick={toggleSidebar}` and `puppetVerb('ToggleSidebar', …, toggleSidebar)`, and only
  the label's catalog key ties them. That a click and `do` run the same code holds by
  convention: the phones' confirmation dialogs once took a translated label, claimed no key,
  and agents guessed past them. The binding belongs where the control is written: a small
  UI-owned helper (`<button {@attach control(toggle)}>`, iOS `.puppetControl(verb)`, Android
  `Modifier.puppetClickable(verb)`) that wires the real click to the verb and, in debug builds
  only, records element → (verb, args) for `elements`. It would delete `controls` on ~145
  verbs, the label matching, the per-control half of `check-puppet-verbs` and its allowlist.
  Open questions: it must own `preventDefault`, `stopPropagation` and keyboard activation on
  a non-button, puppet-only arguments (`answer`) must stay unreachable from a click, and
  whether an identifier inside iOS `.swipeActions`, a `Menu` or the toolbar reaches the
  accessibility tree is unverified.
