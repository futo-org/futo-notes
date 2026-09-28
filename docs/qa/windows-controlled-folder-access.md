# Controlled Folder Access, on Windows

## Why a person, not a test

Windows Controlled Folder Access (Microsoft Defender → Ransomware protection) blocks
apps it doesn't recognise from creating or changing files in protected folders —
Documents by default, which is where the notes folder lives. It only exists on a real
Windows install with Defender running; no CI runner or VM image here turns it on.

What it returns for a blocked create decides whether FUTO Notes notices:

- The app locks itself read-only and shows a red banner the first time the OS
  refuses to create a file or folder **directly in the notes folder**
  (`vault_fs::is_refusal` / `note_create_failure`). It counts "access denied", and on
  Windows only also "file not found" (os error 2).
- The os error 2 rule is inferred from crashes 1739 and 952, where Controlled Folder
  Access refused to create the notes **folder** with "The system cannot find the file
  specified. (os error 2)". Nobody has seen what a blocked **file** create inside an
  existing folder returns. This run finds out.
- The folder-pick check (`vault_location::can_create_files_in`, a directory open for
  `FILE_ADD_FILE`) has never run on Windows. If it answers wrongly, every
  **Change directory** fails with "Could not use that folder."

## Setup

- Windows 10 or 11 with Microsoft Defender Antivirus active (a third-party antivirus
  turns Defender, and with it Controlled Folder Access, off). Toggling it needs an
  admin account.
- Clone the repo **outside** Documents, Desktop, Pictures and the other protected
  folders (for example `C:\src\futo-notes`): with the feature on, the build itself
  would be blocked from writing there.
- Build tools per CONTRIBUTING.md (Rust from `rust-toolchain.toml`, the MSVC C++
  build tools, Node from `.nvmrc`, pnpm through corepack, the Tauri CLI).
- If the release FUTO Notes is installed, don't use it during the run: Controlled
  Folder Access blocks it too. Put the setting back the way you found it afterwards.

```powershell
git fetch origin
git checkout windows-folder-crash
git pull
corepack enable
pnpm install
```

Launch the dev app with `node scripts/tauri-dev.mjs` (what `just tauri-dev` runs). In
a normal clone it uses `%USERPROFILE%\Documents\fake-notes` as the notes folder and
never touches the real `Documents\futo-notes`. The first build takes a while.

**Driving the app.** Debug builds carry a WebSocket bridge. The launch log prints
`MCP Bridge plugin initialized for ... on 127.0.0.1:<port>`; send it
`{"id":"r1","command":"execute_js","args":{"script":"<js>"}}` and read `data` from the
reply (`.claude/skills/verify/references/desktop.md`, "Raw WebSocket fallback"; Node
22 has `WebSocket` built in, so a five-line `.mjs` file does it). The checks below
are JavaScript to run that way. Don't send OS-level keystrokes to the window.

Checks used in the steps:

```js
// banner — the red bar across the top, or "no banner"
document.querySelector('.vault-unavailable-banner')?.innerText ?? 'no banner'
// status — what Rust reports
await window.__TAURI_INTERNALS__.invoke('vault_status')
// probe — one real create in the notes folder; returns "WROTE" or the error verbatim
await window.__TAURI_INTERNALS__.invoke('app_data_write', { path: '.cfa-probe.json', content: '{}' }).then(() => 'WROTE', String)
// toast — Settings → Appearance → Dark, then read the toast
document.querySelector('[aria-label="Open settings"]').click();
await new Promise((r) => setTimeout(r, 400));
[...document.querySelectorAll('.settings-segment')].find((b) => b.textContent.trim() === 'Dark').click();
await new Promise((r) => setTimeout(r, 800));
document.querySelector('.toast')?.innerText ?? 'no toast'
```

## The story

### A. An existing notes folder the app may not change (the case this branch is for)

1. Controlled Folder Access **off**. Launch once so `Documents\fake-notes` exists and
   holds the three seeded notes. Run **probe**: expect `WROTE`. Quit the app.
2. Turn it **on**. Under **Protected folders**, check that `Documents` is listed; if
   your Documents is redirected (OneDrive), add `%USERPROFILE%\Documents\fake-notes`
   itself.
3. Launch again. Expect the notes list to load normally. The banner may already be up
   if the app wrote something at launch; that is a pass too, so carry on.
4. Run **toast**. Expect "Setting changed, but it couldn't be saved.", a Windows
   "Unauthorized changes blocked" notification naming `futo-notes-tauri.exe`, and
   within about a second the banner: "FUTO Notes can't save anything. It isn't
   allowed to change your notes folder at C:\Users\...\Documents\fake-notes."
5. Run **status** (expect `available: false, accessRefused: true`) and **probe**
   (record the error exactly, including `(os error N)`).
6. Open a note and try to type. Expect the editor to take nothing.

**If there is no banner after step 4,** the refusal was not recognised. The probe's
error in step 5 is then the key result: its os error number is what the rule needs to
count.

### B. A default notes folder that cannot be created (crashes 1739 and 952)

Needs the default location, so run the app without the dev script's data folder:

1. With Controlled Folder Access **off**, rename `Documents\fake-notes` to
   `fake-notes-kept`, and delete `%APPDATA%\com.futo.notes.dev\notes-dir-override.json`
   if it exists.
2. Turn it **on**, then start the app straight from `apps\tauri`. This is the one place
   to call `cargo tauri` directly: the dev script always points the app somewhere else.
   The config path below is relative to `apps\tauri`.

   <!-- check-agent-docs: ignore-next-block -->
   ```powershell
   cd apps\tauri
   cargo tauri dev --config src-tauri/tauri.dev.conf.json
   ```
3. Expect the banner "FUTO Notes can't save anything. It isn't allowed to create its
   notes folder at C:\Users\...\Documents\fake-notes." Run **status**.
4. Quit, turn it off, and rename `fake-notes-kept` back.

### C. Choosing a folder

Run each through the bridge; the saved choice lives in the repo's `.tauri-data`, and
the dev script resets it on the next launch.

1. A writable folder outside the protected ones: create `C:\FutoPickTest`, then
   `await window.__TAURI_INTERNALS__.invoke('notes_dir_override_save', { dir: 'C:\\FutoPickTest' }).then(() => 'ACCEPTED', String)`.
   Expect `ACCEPTED`. **A refusal here is a serious bug**: it would break Change
   directory for everyone on Windows.
2. A folder a normal user cannot write, `C:\Windows`: expect a refusal starting
   "FUTO Notes can't create files in C:\Windows".
3. With Controlled Folder Access **on**, a protected folder,
   `%USERPROFILE%\Documents\FutoPickTest` (create it with the feature off first):
   record whether it is accepted or refused.

### D. Letting the app in

1. With Controlled Folder Access on, go to **Allow an app through Controlled folder
   access** → **Add an allowed app** → browse to `target\debug\futo-notes-tauri.exe` in
   the repo.
2. Relaunch. Expect no banner, and **toast** to show no save failure.

## What to report

Return this block, filled in, as the result of the run:

```text
Windows version (winver):
Commit (git rev-parse --short HEAD):
A3 notes listed; banner already up:  yes / no ; yes / no
A4 toast text:
A4 Windows notification:             yes / no
A4 banner text (or "no banner"):
A5 status:
A5 probe error, verbatim:
A6 editor took typing:               yes / no
B3 banner text:
B3 status:
C1 C:\FutoPickTest:                  ACCEPTED / refusal text
C2 C:\Windows:                       ACCEPTED / refusal text
C3 Documents\FutoPickTest (on):      ACCEPTED / refusal text
D2 banner after allowing the app:    yes / no
Anything else unexpected:
```

## Last run

Not run yet.

## Not proven by this run

- A read-only network share or other file systems, which can refuse writes with
  error codes other than these.
- Windows on ARM.
