---
name: puppet
description: Drive and read a running FUTO Notes debug build — desktop, iOS or Android — with `just puppet`. The one way to interact with the apps. Use for ANY task that touches what the app does — a bug report, "fix this", "it does X instead of Y", "does this look right", "test this on iPhone/Android", "check the app", reproducing a symptom, verifying a fix, trying a new feature, driving the UI, or reading the app's real state. Load it before reading source for a reported behaviour.
---

# Controlling FUTO Notes with `just puppet`

Every action a user can take is a **verb**; every question is a **query**; every gesture
is real platform input. Each answers in well under a second with a receipt saying what
changed. Nothing else drives the app.

## Connect

```bash
just puppet look                             # desktop (default): this worktree's `just tauri-dev`
FUTO_PUPPET_TARGET=ios just puppet look      # iOS: this worktree's simulator
FUTO_PUPPET_TARGET=android just puppet look  # Android: this worktree's emulator
```

Start with `look`: the app is often already running, and `look` answering means you are
connected. A phone target is always this worktree's own device: a worktree with none claims
one from the pool on its first phone command (booting it can take minutes), and no command
reaches a device another worktree owns. "The app answered nothing" means the app is not
running: launch it with the command that answer prints (`ANDROID_SERIAL=… just
android-native`, `SIM=… just ios-native`). Desktop targets are resolved only
through `scripts/qa-target.mjs`, which refuses anything but a debug build of this
checkout — the user's installed app runs on this machine on their real vault. A desktop
app that stops answering is an error after 10 s ("did not answer within 10s"), never a hang.

## Use it the way a person does

You are here to see what a user would see: a real bug, a new feature, a flow. That only
works if you reach things the way a user can, so every step is one a person could take
**from the screen as it is now**. `actions` lists only the verbs this screen has; the rest
is on you:

- A note is opened by its row, so its row has to be on screen: `OpenNote`, `OpenFolder`,
  `ToggleFolder` and the other verbs that act on one row refuse a row you cannot see. On
  desktop, `ScrollToRow` to each closed folder on its path and `ToggleFolder` it, outermost
  first (an opened folder can push the next row below the fold), then `ScrollToRow` to the
  note; on a phone, `OpenFolder` one screen at a time, the same way. A refusal prints that
  batch from where you are (`do '[…]'`): run it as printed.
- To find a note, search for it as a person would: the search box, or `search` for the same
  hits without opening anything. It matches titles, bodies, tags and folders, so the goal's
  own words find it. For every note in a folder, or the newest one, filter `notes` by the
  folder (`notes | grep 'journal/2026/'`): it lists all of them, where the screen shows only
  what fits, and search stops at 10 hits and ranks by match, not date.
- A menu item is chosen from an open menu, a picker entry from an open picker, a setting
  from the settings screen. Open the surface first.
- Knowing an id from `notes` or `search` tells you where to go, not that you are there.

Take the shortest path that a user could take. Batch the steps you already know
(`do '[["ToggleFolder",{"path":"work"}],["ScrollToRow",{"path":"work/team"}],["ToggleFolder",{"path":"work/team"}],["ScrollToRow",{"noteId":"work/team/standup"}],["OpenNote",{"noteId":"work/team/standup"}]]'`),
and read between steps when what comes next depends on what appeared. Steps that depend on
each other go in ONE batch, never in commands chained with `;`: a batch stops at a refusal
and names the steps it did not run, while `;` runs the next command anyway, on a screen or
document the refused step never changed.

## How the app is laid out

- **Desktop** is one window. The sidebar on the left is the note explorer: folders and
  notes as a tree, collapsed folders hiding their rows. The main area is the editor with ONE
  open note (`screen` is `editor:<noteId>`, `home` when none), with tabs above it for other
  open notes. `OpenNote` replaces the note in this tab; `"mode":"foreground"` opens it in a
  new tab (Cmd+Shift-click), `"background"` in one behind; `ActivateTab` switches to an
  open one. Settings, search and dialogs are overlays: while one is open,
  nothing behind it is on offer but the window's shortcuts, as for a person.
- **A phone** is a stack of full screens. The first is the note list (`list`); a folder opens
  its own list (`folder:<path>`). Opening a note **replaces the whole screen** with that note
  (`editor:<noteId>`): no list, no other notes, so the list's verbs are not there. To reach
  another note from inside one, `GoBack` to the list, then open it. Settings, Search and Sync
  are screens of their own, left with `GoBack`. The editor's page sits among native
  controls (the top bar, the title field, the keyboard's toolbar); `elements` lists both as
  one screen, native ones as `n1`, `n2`, …, the page's as `e1`, `e2`, ….
- **Text from another note** travels as a person carries it: open that note, `Select` it,
  `Copy` (which copies only what is selected), go to the target, place the caret, `Paste`.
- **A note you create and leave empty is discarded** when you go back from it (its body
  empty, its title as created), on every platform, as a person's would be. Write into it
  before you leave it.
- **A note is read where it shows**, as a person reads it: `doc`, receipts and
  `show {"text"}` see the lines on screen; `state` says which note (`note`, its path), which
  lines show (`onScreen`), `loading`, the selection. A change off screen reads `doc L40–42 changed off screen`.
  Unseen text is reached with `ScrollToLine {"line"}` (or Find, `OpenFind` and `SetFindQuery`,
  to search for it); a verb aimed off screen is refused with the `ScrollToLine` batch.

## The loop

Look, act, check what changed.

```bash
just puppet look                     # the reads below in one: where you are, the screen, its verbs, the vault's size
just puppet state                    # where you are: screen, dialogs, note, tabs, settings, sync, selection
just puppet actions                  # the verbs on THIS screen, one a line with what each takes (name? = optional)
just puppet elements                 # the screen as an outline: sections, each row, where, and → Verb: do that verb
just puppet do <Verb> '{…}'          # act; a JSON array of [Verb, args] pairs is one batch
just puppet doc                      # the open note's lines on screen: positions, kind, text, saved markdown
just puppet relaunch                 # phones: close the app and open it again; answers with `look`
```

`look` is for the start, after `relaunch`, and when you are lost: `state` without the stored
settings, `elements`, the screen's verbs (a row's own verb named once), the vault's size, and the
open note's lines on screen when it has a note open. After an action, its receipt is what changed.

JSON holding an apostrophe goes in double quotes, its own quotes escaped:
`do OpenNote "{\"noteId\":\"mom's list\"}"`. The `'\''` and `'"'"'` tricks are refused as
brace expansion; a refusal's suggested command is already written this way.

Reads answer about the whole app, whatever the screen shows, and never change it, except that
`file` saves the open note first unless given `"save":false`:

```bash
just puppet notes                    # the whole vault: every note id and folder
just puppet search '{"query":"…"}'   # the vault ranked by what the notes say, as the search box ranks it
just puppet file '{"noteId":"…"}'    # the note's markdown on disk, the open note saved first: every line
                                     #   unless "lines":"40-60" or "find":"…" (+ "around":N) narrows it;
                                     #   "save":false saves nothing: the disk as it is
just puppet show '{"text":"…"}'      # where text on screen is: its positions, line and box
just puppet at '{"x":…,"y":…}'       # what is under a point: hit stack, owners, cursor, editor position
just puppet show '{"ref":"e3"}'      # one element: box, stacking, clipping, cursor
just puppet events '{"since":N}'     # the input events the page saw, each handler that ran, what it prevented
just puppet screenshot               # the screen as a PNG (path printed): open it with Read for a colour or a layout
```

**The receipt is the check.** Every action answers with what it did, most important first,
the same on every target:

```
OK CreateNote · action 12 · events 3 · snapshots 4 → 5
noteId "work/retro"
screen "folder:work" → "editor:work/retro"
vault +note "work/retro"
+ sidebar · list: e7  FolderTreeNoteRow  button  "retro"  note=work/retro click keys  8,40 263×48  → OpenNote
- dialog: e3 button "Close search", e4 text "Search notes..."
```

- The first line is the verdict: `OK <Verb>` (a gesture's: `OK tap · screen list`), or
  `REFUSED <status> <Verb>: <why>`. In a batch each step has its own block, and the steps
  after a refusal are named `not run: …`.
  A batch's steps say what each did and how many rows it touched (`rows +3 -1 ~0`); the
  rows themselves come once, at the end, as the screen the batch left you on, once it has
  stopped moving (`the screen now, against before the batch:`). A row a later step took away
  again is not repeated: it is not there to act on. `.puppet/trace.jsonl` and `{"json":true}`
  keep every step's rows.
- Then what the verb answered (`noteId`, `selected`, the `editor` it left), then what it did
  to the app: the document (`doc L4 -removed +inserted`, in the saved markdown), the selection, the screen, the
  app's state as `was → now` (open note, tabs, dialogs, every stored setting, sync, work still
  `pending`, undo depth), the `vault` (notes and folders added or removed, notes written: a
  rename lists the notes whose links it rewrote) and what it `copied`.
- Then the screen: `+` a row that appeared, on one line with everything `elements` shows;
  `~` a row that changed (`rect a → b`, `flags`, `text`); `-` rows that went, by name. A step
  that opened another screen lists everything that screen shows. `no change` means nothing
  changed. `before this, the page changed on its own` is a load or a timer that moved after
  the previous receipt.
- On a phone, a tap opens with what it landed on (`touch @41,84 → n1 button "Settings"`, or
  `(not a control)`); nothing traces native handlers, so a native tap has no events, and a
  touch the app never received is refused instead of reading as `no change`. `type` and `press`
  go to whatever has focus, so tap the field first; the receipt opens with what took the keys
  (`type "lease" → n189 field "Find in note"`). `press Back` is Android's system Back,
  `do GoBack` the app's. They are for testing real input; `do Type` and `do Press` write into
  the editor on every platform, any text, and go in a batch. Either one refused for what the
  other does prints the call that works.
- `{"json":true}` in a step's args prints the raw receipts instead.

**Run each action bare and read its receipt whole; never pipe or redirect one.** Every line is
the app as your next step will find it: a `GoBack | grep status` hid the vault line saying the
new note was discarded, and that run reported a note that no longer existed. A receipt is
under 60 lines, a batch's too, the screen it leaves you on included, so there is
nothing to trim:

- It already says what the action did to the document and the app; follow it with `doc` or
  `state` only for what it does not say.
- A key pressed N times is one action: `press {"key":"Backspace","count":14}`.
- To find one row, search a read: `elements | grep standup`.

That covers every action (`do`, `tap`, `click`, `drag`, `scroll`, `type`, `press`, `relaunch`)
and `look`: no `head`, `tail`, `grep` or `/dev/null` after one. In Claude Code a hook refuses one
that has it.

**`elements` is the screen as a person sees it**, one outline on every platform: sections in
reading order (`top bar`, `sidebar · list`, `list`, `editor`, `keyboard toolbar`, a `sheet`, a
`dialog`, a `menu`, a row's menu naming its row: `menu · note "standup"`), each row's ref,
role, label, what it responds to (`click`, `right-click`, `keys`, `tap`, `hold`), note or
folder, and rect. A section that scrolls says where the rest is: `list · rows 7–14 of 18 · more
above and below`. Only what a click or a finger can reach is listed, so a row under a bar, a
sheet, a dialog or another control is not; a control half covered is listed with `aim x,y`, the
point that reaches it.

Real input, when the question is what a **click or finger** does — focus moves, a
mousedown that closes something, a drag that scrolls instead of selecting:

```bash
just puppet click '{"x":…,"y":…}'                       # desktop: real mouse click into the web view
just puppet click '{"x":…,"y":…,"hold":0.8}'            #   press and hold
just puppet click '{"x":…,"y":…,"count":2}'             #   double-click; "button":"right" too
just puppet tap '{"x":…,"y":…}'                         # iOS/Android: real touch; "hold" for a long press
just puppet drag '{"x":…,"y":…,"x2":…,"y2":…}'          # everywhere; on a phone this is a swipe
just puppet scroll '{"x":…,"y":…,"dy":300}'             # desktop: mouse wheel over the point, dy > 0 is down
just puppet type '{"text":"…"}'                         # real key presses into what has focus, every platform
just puppet press '{"key":"Mod-b"}'                     #   one key (desktop: any chord), "count" repeats it
```

Coordinates are the numbers `elements` reports, never a screenshot's: CSS pixels on desktop,
and on a phone the screen's points (iOS) or dp (Android) everywhere, the editor's page
included (`show`, `at` and `events` speak them too). `{"ref":"e12"}` or `{"ref":"n4"}` in
place of `x`,`y` aims where a click reaches that element; `tap`, `click` and `drag` take
`{"text":"…"}` too: that text on screen. A touch inside the editor that the
page never received is refused, not reported as `no change`. Every receipt is appended to
`.puppet/trace.jsonl`.

Full command surface, verb map per platform, receipts and exit codes:
`references/commands.md`. Traps that have cost real runs: `references/gotchas.md`.

Scrolling, fast or real: `references/scrolling.md`.
Writing text, fast or real, and the argument names agents guess wrong most: `references/commands/editor-verbs.md`.

## The rules

1. **See the failure before you edit.** A report names a symptom; make it happen in the
   running app and quote the `state`, `doc`, receipt or trace that shows it. Reading
   source until you have a theory is not reproduction, and a test you wrote is not
   either — it asserts what you already believe.
2. **In a trace, the cause is the earliest event that should not have happened.** Fix
   what emitted it, not the handler that reacted to it. A run that read
   `focusout`-before-`click` off the trace and then patched the click handler's reading
   of state had the cause on screen and fixed the symptom.
3. **Reproduce where the bug lives.** A report with no platform is a desktop report.
   jsdom is not a browser, headless Chromium is not the WebKit desktop ships, and
   neither has the native shell around it.

   | The report says                        | Reproduce on                                           |
   | -------------------------------------- | ------------------------------------------------------ |
   | desktop, or no platform                | `just tauri-dev`                                       |
   | "on my phone", Android wording         | `just android-native` on a claimed emulator            |
   | "on my iPhone"                         | `just ios-native` on a claimed simulator               |
   | a cursor, colour, flash or layout      | the real shell, `at` for the cursor, plus `just puppet screenshot` |
   | a wrong character, position or selection | `state` and `doc`, never a screenshot                |

4. **One driver at a time.** Only `just puppet` touches the app. Retired for driving:
   - `axe` (`tap`, `type`, `swipe`, `describe-ui`) and `scripts/describe-ios-ui.mjs`
   - `adb shell input tap|swipe|text`, `uiautomator dump`, `just android-drive tap`
   - the desktop MCP bridge's `webview_interact` / `webview_keyboard`
   - DOM `.click()` or `execCommand` from a console — they miss Svelte handlers
   - AppleScript UI scripting and click injection, any platform (AGENTS.md M24)

   Still used, as oracles and lifecycle: screenshots (`just puppet screenshot` first;
   `just qa-shot` when there is no debug bridge), the vault on disk (`simctl get_app_container … data`/Documents/fake-notes, `.tauri-data/notes/`,
   `adb pull`), `just qa-claim|qa-status|qa-release`, `just tauri-dev|ios-native|android-native`,
   `simctl`/`adb` install and launch, `scripts/cdp-invoke.mjs`, `just android-drive state`.
   To relaunch the app to see what a launch does, `just puppet relaunch`, not `am force-stop`
   or `simctl terminate` and a sleep.

5. **A refusal says what to do next.** A row out of reach prints the batch that reaches
   it, a misnamed argument the call it meant, a note or folder the vault lacks the ones
   it has in another case or folder, and a verb this screen lacks the verbs it has: open
   the surface that owns it (`OpenSettings`, `OpenFind`, `OpenNoteContextMenu`).
   409 is a stale position or state; 503 is not-ready. Never retry the same call unchanged,
   reach for a retired driver, or sleep. If a surface the app owns has no verb, file it:
   `papercuts add "<surface>: no verb for <action>" --tag puppet` (the known ones are in
   `.claude/skills/verify/references/ios/native-chrome.md` and `android.md`).
6. **Ask, don't count.** `doc`, `show {"text"}` and `state` give positions; prove ranges with
   `expect` or `docVersion` so a stale one refuses instead of editing the wrong place.
7. **No screenshot to read state.** The editor renders markdown away, so pixels cannot
   say what is selected or saved. A screenshot is the only thing that can say a colour is wrong:
   `just puppet screenshot`, then Read the PNG it names; on desktop it captures a hidden window too.
8. **Verbs are literal.** `Insert` is one transaction: no keymap or input rule runs, Enter
   does not continue a list. Keystroke behaviour is a real-input question.
9. **Name the object, not the pixel.** `OpenNote {noteId}`, `ToggleFolder {path}` once
   the row is on screen. Use `at`/`show` and real input only when the question is
   geometric or about the input itself.
10. **The spec is the contract.** If `docs/spec/` states the behaviour, that is what the
    fix must produce; read it before deciding what "correct" means. Editing a spec line
    to describe your change is moving the goalposts (AGENTS.md M2). Recording verified
    behaviour it did not cover is a Gap note and welcome.
11. **Only your own app.** Never resolve a desktop app by process name, never drive an
    unclaimed simulator or emulator (`.claude/skills/verify/references/session.md`).

Then the repo's fix discipline applies as written: a regression test that fails before
the fix, the owning layer's chain, siblings grepped (AGENTS.md §7.9, M17, M18).

Design record: `docs/research/agent-native-app-design.md`.
