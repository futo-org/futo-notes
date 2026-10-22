## Where the other verbs live

`actions` is authoritative — a component registers its verbs while it is
mounted, a menu's options only while the menu is open. This map is so you know what to open.

**Shortcuts.** A verb that opens a dialog, a picker or a menu can take an optional argument
that does the next steps for you. `actions` lists it under the verb:

```
OpenCreateFolderDialog  {name?: string}
                          name: shortcut, then SetNewFolderName {"name":"<name>"}, SubmitNewFolder
```

`do OpenCreateFolderDialog '{"name":"trips"}'` runs exactly those three verbs, one receipt
each, as a batch would: it is the dialog's real path, typed and pressed for you, and it stops
at the first refusal. Leave the argument out to take the steps one at a time.

**Desktop, always.** `CreateNote` (no arguments: the New note button and Cmd+N, an untitled
buffer, `screen` is `editor:new` until `SetTitle` or the first typing names it; while that
buffer is still empty, another `CreateNote` is 409 — nothing new would be created),
`OpenNote {noteId, mode?: current｜foreground｜background}`, `OpenSearch`, `OpenSettings`,
`ToggleSidebar`, `NewTab`, `CloseActiveTab` (Cmd+W), `ReopenTab`, `StepTab {direction: 1｜-1}`
(Ctrl+Tab), `ActivateTabByNumber {number 1–9, 9 = last}` (Cmd+1..9), `ActivateTab` and
`CloseTabAt` (a click on a tab, its ×), `MoveTab`, `GoHome`, `SetSidebarView`, `SetSidebarWidth`,
`OpenCreateFolderDialog {name?}` (the sidebar's New folder), `ToggleFolder {path}`,
`OpenNoteContextMenu {noteId, item?}` and `OpenFolderContextMenu {path, item?}` (a right-click
on the row), `StartRenamingNote {noteId, title?}` and `StartRenamingFolder {path, name?}` (a
double-click or F2 on the row), `MoveNote {noteId, targetPath ("" = root)}` and
`MoveFolder {path, targetPath}` (a row dragged onto a folder), `ToggleTagGroup`, `SelectImage`,
`DeselectImage`, `ToggleImageMenu`, `DeleteSelectedImage`, `ClearSyncStatus`, `InstallUpdate`
(the banner), `ToggleSortMenu` (then, while it is open, `SetSortOrder {key: name｜lastModified}`
or `{direction: ascending｜descending}`, one pick: a key keeps the list's position), while the
vault is unusable `SetNotesDirectory {path, answer?}` (the banner's button, held to the same
dev-vault rule as in Settings), and on Linux `MinimizeWindow`, `ToggleMaximizeWindow`,
`CloseWindow`.

**A row's menu, while open.** The note menu: `RenameNote {title?}`, `MoveNoteToFolder
{targetPath?}`, `DeleteNote {answer?}`. The folder menu: `NewNoteInFolder`, `NewSubfolder {name?}`,
`RenameFolder {name?}`, `MoveFolderToFolder {targetPath?}`, `DeleteFolder {answer?}`. Each acts on
the row the menu opened for, which its section names (`menu · note "work/retro"`), so none takes
a `noteId` or `path`: `DeleteNote` opens the delete dialog for that note, and `answer` confirms or
dismisses it in the same call. `CloseContextMenu` closes it. `OpenFolderContextMenu {path, item:
"NewSubfolder"}` opens the menu and picks the option in one call.

**The inline rename field, while open.** `SetNewName {name}`, `SubmitRename` (Enter),
`CancelRename` (Escape).

**Which tab.** `ActivateTab` and `CloseTabAt` take `{"noteId":"work/standup"}` — the note
the tab holds — or, for a tab with no note (Cmd+T's) or a note open twice, `{"index":N}`,
counting from **0** across the strip. `ActivateTabByNumber {number}` is the Cmd+1..9 key
instead: 1-based, 9 = the last tab. `MoveTab {fromIndex, toIndex}` is 0-based. Every refusal
here prints the open tabs with their indexes.

**Desktop, note open.** The editor verbs plus `SetTitle`, `ToggleNoteActionsMenu`, `RemoveTag`,
`StartAddingTag {name?}` (then, while the tag field is open, `AddTag {name}` and
`CancelAddingTag`); and once the note has a file (not on `editor:new`), while the ⋯ menu is
open: `CopyCurrentNotePath`, `MoveCurrentNoteToFolder {targetPath?}`, `DeleteCurrentNote
{answer?}`.

**Desktop overlays, while open.** Settings, search and every dialog are modal, as they are to
a person: while one is open, `actions` offers only its verbs and the window's shortcuts
(`CreateNote`, `NewTab`, `CloseActiveTab`, …), and a verb behind it is 404 `<Verb> is behind the
open dialog`. A context menu is not: a click outside it closes it and still lands. Search:
`SetSearchQuery`, `ClearSearchQuery`, `StepSearchResult`, `OpenSearchResult {index?}`,
`CloseSearch`. Folder picker: `PickFolder {path?}` (no path is its Root row; a row scrolled out of the picker is refused: scroll it first). Create-folder dialog: `SetNewFolderName`,
`SubmitNewFolder`. Any modal: `DismissDialog` (its Cancel, Escape or the backdrop); a
confirmation: `ConfirmDialog` too. Settings: `CloseSettings`, `SetTheme`,
`ToggleLanguageOptions {tag?}` (then, while the list is open, `SetLanguage {tag?}`),
`SetNotesDirectory {path, answer?}`, `ResetNotesDirectory {answer?}`, the sync and license
sections below, `ToggleAutoUpdates`, the updates button as `CheckForUpdates`, `InstallUpdate` or
`RestartToUpdate` (whichever it shows), `ToggleIssueReporting`, `ToggleAlwaysSendReports`,
`ToggleFeedbackComposer`, `ResetAllNotes {answer?}`, `TestCrash` (`just tauri-dev` only), `SimulateSyncError
{scenario}`, `SimulateSyncSuccess`, `CancelBlockingOperation`. Crash dialog: `SendCrashReport`,
`DiscardCrashReport`, `CopyCrashReport`, `SetCrashDescription`, `SetAlwaysSendCrashReports
{enabled}`, `ToggleCrashDetails`, `ToggleCrashContext`. Feedback: `SetFeedbackMessage {message}`,
`AttachImage {path}`, `RemoveFeedbackAttachment`, `SendFeedback`, `SetStagingCrashlog {enabled}`.
Sidebar: `OpenLicenseSettings`, the license label at its foot.

**Sync settings, every platform.** Each step of hosted sync offers its own controls, and
only while it is up. Signing in: `SignInWithFuto`, `Subscribe`, then
`CancelWaitingForBrowser` while the app waits on the page. A new vault: `CreateVault
{vaultPassword, repeat?}`, then the recovery key — `CopyRecoveryKey`, `SaveRecoveryKey
{path}` (desktop: the save dialog's file, never over an existing one), `ShareRecoveryKey`
(phones), `SetRecoveryKeySaved {saved}`, `ContinueRecoveryKey`. An existing vault:
`SelectUnlockMethod {method: vaultPassword｜recoveryKey｜anotherDevice}`, then `UnlockVault
{vaultPassword}` or `UnlockVault {recoveryKey}` (whichever field is open), or
`ShowPairingCode` and `CancelPairing` for another device to scan. Signed in:
`ManageSubscription`, `OpenVaultPasswordChange` (then `ChangeVaultPassword {vaultPassword,
repeat?}` or `CancelVaultPasswordChange`), `ReplaceRecoveryKey` (the old key stops working,
with no question asked), `SignOutOfFuto {answer?}`, and on the phones `OpenScanner`: the
scanner's `ScanPairingCode {code, answer?}` stands in for the camera with the string it
would read, then confirms sending this vault's key to the device it names; `CloseScanner`,
`AllowCamera` (Android), `OpenSystemSettings`. `ToggleOwnServer` opens "Use my own server",
whose fields are `ConnectSync`'s: `ConnectSync`, `SyncNow` and `DisconnectSync` (phones;
desktop adds `ForgetSyncPassword {answer?}` and `ResetSyncConnection {answer?}`) exist only
while it is open. A password field is typed into, as a person would, before the button
is pressed, so a refused one is still on screen.

**License, every platform.** `BuyLicense` (Buy, or Renew once expired), `StartLicenseEntry`
("I already paid"), then `ActivateLicense {licenseKey}` (a key or a `futonotes://` link) or
`CancelLicenseEntry`; `OpenLostKeyHelp`, `ShowLicenseKey`, `RemoveLicense` (no question
asked); `SpinCoin` taps the supporter coin, and dragging it is a real `drag`. iOS only, where
the store offers them: `BuyLicenseInAppStore` and `RestorePurchases`, the App Store's purchase
and restore (any sheet they raise is the system's).

**A page opens for real.** Buy, Lost your key, Log in, Subscribe and Manage subscription
open what their button opens, and the receipt names it (`opened "https://…"`). A macOS
debug build puts the page in Safari (or `FUTO_DEV_BROWSER`), behind your window, never in
front of it; on Linux and Windows it opens in the default browser; a phone opens its browser
sheet or app. Sign-in and checkout then wait on that page: on desktop the receipt is still
running, on a phone it answers `started` at once, and `CancelWaitingForBrowser` ends the
wait. A pairing code waits five minutes the same way.

**iOS and Android.** The note list and every folder: `OpenNote {noteId}`,
`OpenFolder {path}`, `CreateNote` (the New note button: an untitled note in the folder on
screen), `OpenCreateFolderDialog {name?}` (the New folder button; in its dialog
`SetNewFolderName {name}`, `SubmitNewFolder`, `DismissDialog`), `ScrollToRow {noteId|path}`,
and `GoBack` below the root. `OpenNote` and `OpenFolder` are a tap on a row of this screen,
pushing what the row pushes: a note or folder whose row is in another folder is 409, naming
that folder. A note row has no rename on either phone: **a note is renamed from its title
field**, `SetTitle` in the editor.

**A row's long-press menu.** On Android the menu is the app's:
`OpenNoteContextMenu {noteId, item?}` and `OpenFolderContextMenu {path, item?}` open it, and
while it is open its options are verbs — `MoveNoteToFolder {targetPath?}`, `DeleteNote
{answer?}`; `RenameFolder {name?}`, `MoveFolderToFolder {targetPath?}`, `DeleteFolder
{answer?}` — each acting on the row its section names (`menu · note "Welcome"`), so none takes
a `noteId` or `path`, and `CloseContextMenu` closes it. On iOS the long-press menu, the swipe actions,
the editor's ⋯ menu and the sort menu are iOS's own: no verb opens them, so press the row with
real input (`tap {"ref":…, "hold":0.8}`, or a `tap` on ⋯ or Sort by), read the menu's items
in `elements`, and `tap` the one you want. What an item opens is the app's again, on both
phones: the move sheet's `PickFolder {path?}` (no path is its Root row; a row scrolled out of
the sheet is refused: `drag` it into view first) and `DismissDialog`; the rename dialog's
`SetNewName {name}`, `SubmitRename` and `DismissDialog`; a confirmation's `ConfirmDialog` and
`DismissDialog`.

**The editor is its own screen**: the list's verbs are not on it — no list, no rows, no
buttons — so reach a note or a folder with `GoBack` first. What it does have, past the
editor verbs, `PickImage {source: camera｜library}` and `DismissKeyboard`: `SetTitle {title}`
(the title field's own rename; settles before it answers, so the receipt's `noteId` is the
new one); the ⋯ menu — on Android `ToggleNoteActionsMenu`, then while it is open `OpenFind`,
`MoveCurrentNoteToFolder {targetPath?}`, `CopyCurrentNotePath`, `DeleteCurrentNote
{answer?}`; on iOS a real `tap` on ⋯, then on its item — and the find bar, native on both
phones, not the page's: `SetFindQuery {query}`, `StepFind {direction: 1｜-1}` (only while
there is a match) and `CloseFind` while it is open.

**iOS native screens.** At the root list: `OpenSettings`, `OpenSync`, `SetSearchQuery {query}`, `ClearSearchQuery` (`state.search` has `query` and the
`hits` the rows show; `screen` is `search` while a query is set). Settings sheet:
`OpenSync`, `OpenFeedback` (pushes the composer; `screen` is `feedback`, `GoBack` pops
it), `SetTheme {theme: light｜dark｜auto}`, `OpenAppIcons` (then `SelectAppIcon {icon}`,
`CloseAppIcons`; an icon a license includes opens its ask instead: `BuyLicense`,
`BuyLicenseInAppStore`, `StartLicenseEntry`, `DismissDialog`), `ToggleIssueReporting`,
`ToggleAlwaysSendReports`, `ResetAllNotes {answer?}`, `TestCrash`, `GoBack` (Done). Sync
sheet: the sync settings above (`ConnectSync {url?, password?}` reuses a stored
password), `GoBack`. A sheet covers the browser, so while one is up only its verbs
are on the screen, and `state` reports `sheet`, `settings` and `sync` alongside the
editor's own state.

**Android native screens.** Every folder list: `OpenSearch`, `OpenSettings`,
`ToggleSortMenu` (then, while it is open, `SetSortOrder {key}` or `{direction}`, one pick).
Search:
`OpenNote`, `SetSearchQuery {query}`, `ClearSearchQuery` (`state.search` has `query`
and `hits`). Settings: `OpenSync`, `OpenFeedback`, `OpenStorageLocation`,
`SetTheme {theme: light｜dark｜auto}`, `SetLanguage {tag?}` (no tag: the system language),
`OpenAppIcons` (then `SelectAppIcon {icon, answer?}`, which asks first, and `CloseAppIcons`;
an icon a license includes opens its ask instead: `BuyLicense`, `StartLicenseEntry`,
`DismissDialog`),
`ToggleIssueReporting`, `ToggleAlwaysSendReports` (while reporting is on), `ResetAllNotes {answer?}`, `TestCrash`.
Sync: the sync settings above (`ConnectSync {password, url?}`: the field starts empty, so
the password is required). Storage location: `SelectStorageMode {mode:
device｜app}` and `ContinueStorage`, then on the device-storage rationale
`ContinueStorage` (migrates and restarts the app) or `DismissStorageRationale`. `state`
carries `settings` and `sync` on every screen.

**Both phones.** Feedback composer: `SetFeedbackMessage {message}`, `AttachImage {path}`
(a path on the device), `RemoveFeedbackAttachment {index}`, `SendFeedback`,
`SetStagingCrashlog {enabled}`. Crash dialog: `SetCrashDescription {text}`,
`SetAlwaysSendCrashReports {enabled}`, `ToggleCrashDetails`, `SendCrashReport`,
`DiscardCrashReport` (Don't Send also turns reporting off, as on desktop). The crash
dialog is modal: while it is up its verbs are the only ones offered, and anything else is
404 naming what is on screen. A verb whose control is not on the current screen is 404
`no such verb on this screen`; a list verb asked for from the editor says `GoBack first`.

**A phone screen is one outline.** `elements` lists what a finger can reach, read from the
app's own accessibility (each listener's `/tree`: iOS its accessibility tree, hit-tested
against its windows; Android its Compose semantics), with refs `n1`, `n2`, … that keep
naming the same element across calls, and — while a note is open — the editor page's own
rows (`e1`, …) in the `editor` section beside the native top bar, title field and keyboard
toolbar. Everything is in the screen's points (iOS) or dp (Android): the page's CSS pixels
are shifted by where the web view sits, in every read (`at`, `show`, `events`) and
every argument sent back. Rows under a bar, behind a sheet, dialog or menu, or below the fold
are not listed; `show {"ref":…}` is one of them. Every receipt, a verb's too, carries the
screen before and after once it stops moving (an editor verb's own document and selection
diff stays beside it). A `tap` or `drag` receipt opens with where the touch landed —
`touch @41,84 → n1 button "Settings"`, the topmost row there, `(not a control)` when nothing
there takes a touch — and is refused when the app never received a touch aimed at a row it reported (the app counts
the touches it gets). An iOS `tap` is a 0.1 s press, as a finger's is: SwiftUI's switches
ignore a touch that lasts no time. A read costs about 0.05 s on either phone; an action with its receipt
about 0.7 s (a tap on iOS about 1.3 s, most of it `axe` delivering the touch). `doc`,
`at`, `events`, `diff` and `show {"text"}` need the editor's page and refuse on a native
screen; `state`, `notes`, `search` and `clipboard` answer everywhere. A native control with no
verb and no row is a papercut (`papercuts add … --tag puppet`), not a reason to reach for `adb shell input` or `axe`.
iOS builds the accessibility tree only while the simulator's accessibility setting is on:
`just ios-native` switches it on before every launch, and a read with it off fails saying
so, as does a page query on an editor built without the puppet inspector (a production
`editor.html`), each with the command that fixes it.

**A verb goes through the app's own confirmation.** A verb whose control asks first —
`DeleteNote`, `DeleteFolder`, `DeleteCurrentNote`, `ResetAllNotes`, `SetNotesDirectory`,
`ResetNotesDirectory`, `ForgetSyncPassword`, `ResetSyncConnection`, `SignOutOfFuto`,
`ScanPairingCode` — opens the same dialog a click does and stops there: the receipt shows
it, and while it is up `actions` offers `ConfirmDialog` and `DismissDialog`, the dialog's
own buttons, which answer it and answer once what they started (the delete, its toast) has
finished. `{"answer":"confirm"}` or `{"answer":"dismiss"}` presses one of them next, in the
same call, and the receipt shows both steps. What
stays outside the app arrives past it: a file picker takes a `path`, the camera a `code`.
`SetNotesDirectory` takes only a folder that resolves, symlinks followed, inside the data folder
`just tauri-dev` gives this checkout, and no `futo-notes` folder there (AGENTS.md M3).

**`actions` is what you could do now, not what is mounted.** Each screen answers for
itself every time you ask, so a verb whose control is off screen or disabled is not on the
list: no editor verbs on `home`, no `InstallUpdate` without an update, no `SendFeedback`
with an empty composer, `OpenFind` or the find bar's three, never both.
