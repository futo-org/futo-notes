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
- Controlled Folder Access answers a blocked create with "The system cannot find the
  file specified. (os error 2)": for the notes **folder** in crashes 1739 and 952,
  and for a **file** in an existing folder in the last run.
- The folder-pick check (`vault_location::ensure_can_create_files_in`, a directory
  open for `FILE_ADD_FILE`) creates nothing, so Controlled Folder Access never sees
  it. If it answers wrongly, every **Change directory** fails.

## Setup

- Windows 10 or 11 with Microsoft Defender Antivirus active (a third-party antivirus
  turns Defender, and with it Controlled Folder Access, off). Toggling it needs an
  admin account.
- Clone the repo **outside** Documents, Desktop, Pictures and the other protected
  folders (for example `C:\src\futo-notes`): with the feature on, the build itself
  would be blocked from writing there.
- Build tools per CONTRIBUTING.md: Rust from `rust-toolchain.toml`, the MSVC C++
  build tools, Node from `.nvmrc`, pnpm (`corepack enable` needs an admin shell; an
  installed pnpm works too), and the Tauri CLI (`cargo install tauri-cli --locked`;
  CI does the same in `ci/win-install-deps.ps1`). On ARM64, put
  `C:\Program Files\LLVM\bin` on `PATH`: `ring` needs clang.
- If the release FUTO Notes is installed, don't use it during the run: Controlled
  Folder Access blocks it too. Put the setting back the way you found it afterwards.

```powershell
git fetch origin
git checkout windows-folder-crash
git pull
pnpm install
```

**Launching.** Cases A, C and D use the dev script, `node scripts/tauri-dev.mjs` from
the repo root (what `just tauri-dev` runs). In a normal clone it uses
`%USERPROFILE%\Documents\fake-notes` as the notes folder, keeps its settings in the
repo's `.tauri-data`, rewrites them on every launch, and never touches the real
`Documents\futo-notes`. With Controlled Folder Access on, Defender also blocks the
script's own `node.exe` on `fake-notes` at launch; that is expected. Case B needs a
different launch, given there. Quit the app
by closing its window. The first build takes a while.

**Driving the app.** Debug builds carry a WebSocket bridge. The launch log prints
`MCP Bridge plugin initialized for ... on 127.0.0.1:<port>`; send it
`{"id":"r1","command":"execute_js","args":{"script":"<js>"}}` and read `data` from the
reply (`.claude/skills/verify/references/desktop.md`, "Raw WebSocket fallback"; Node
22 has `WebSocket` built in, so a five-line `.mjs` file does it). Send each check
below exactly as written, one line: the bridge returns the value of a single
expression, so a script with statements or a comment line in front returns nothing.
Don't send OS-level keystrokes to the window. The checks match English UI text, so
run the app in English.

| Check | Send |
|---|---|
| **banner** | `document.querySelector('.vault-unavailable-banner')?.innerText ?? 'no banner'` |
| **status** | `await window.__TAURI_INTERNALS__.invoke('vault_status')` |
| **probe** | `await window.__TAURI_INTERNALS__.invoke('app_data_write', { path: '.cfa-probe.json', content: '{}' }).then(() => 'WROTE', String)` |
| **toast** | `(async () => { document.querySelector('[aria-label="Open settings"]').click(); await new Promise((r) => setTimeout(r, 400)); [...document.querySelectorAll('.settings-segment')].find((b) => b.textContent.trim() === 'Dark').click(); await new Promise((r) => setTimeout(r, 800)); const toast = document.querySelector('.toast')?.innerText ?? 'no toast'; document.querySelector('[aria-label="Close settings"]').click(); return toast; })()` |
| **type** | `(async () => { const editor = document.querySelector('.ProseMirror'); editor.focus(); document.execCommand('insertText', false, 'QA'); return 'editable ' + editor.contentEditable + ', took typing ' + editor.textContent.includes('QA'); })()` |

**probe** makes one real create in the notes folder (a hidden `.cfa-probe.json`) and
returns `WROTE` or the error word for word.

## The story

### A. An existing notes folder the app may not change (the case this branch is for)

1. Controlled Folder Access **off**. Launch so `Documents\fake-notes` exists and holds
   the three seeded notes. Run **probe**: expect `WROTE`. Quit.
2. Turn it **on**. Under **Protected folders**, check that `Documents` is listed; if
   your Documents is redirected (OneDrive), add `%USERPROFILE%\Documents\fake-notes`
   itself.
3. Launch again. Expect the notes list to load normally. The banner may already be up
   if the app wrote something at launch; that is a pass too, so carry on.
4. Run **toast**. Expect "Setting changed, but it couldn't be saved.", a Defender
   block of `futo-notes-tauri.exe` (Event Viewer → Applications and Services Logs →
   Microsoft → Windows → Windows Defender → Operational, event 1123; the
   "Unauthorized changes blocked" notification may not show), and
   within about a second the **banner**: "FUTO Notes can't save anything. It isn't
   allowed to change your notes folder at C:\Users\...\Documents\fake-notes."
5. Run **status** (expect `available: false`, `accessRefused: true`) and **probe**
   (record the error exactly, including `(os error N)`).
6. Click a note in the sidebar by hand, then run **type**. Expect `editable false, took typing
   false`. Quit.

**If status in step 5 still says `available: true`,** the refusal was not
recognised, and the probe's os error number is what the rule needs to count. (Probe
calls the command directly, so it never raises the banner itself; a missing banner
with `accessRefused: true` means the **toast** click missed, not the rule.)

### C. Choosing a folder

In a dev-script launch; an accepted choice lands in `.tauri-data` and the next launch
resets it. Send each as one line.

1. A writable folder outside the protected ones. Create `C:\FutoPickTest`, then send
   `await window.__TAURI_INTERNALS__.invoke('notes_dir_override_save', { dir: 'C:\\FutoPickTest' }).then(() => 'ACCEPTED', String)`.
   Expect `ACCEPTED`. **A refusal here is a serious bug**: it would break Change
   directory for everyone on Windows.
2. A folder a normal user cannot write: the same with `C:\\Windows`. Expect a refusal
   starting "FUTO Notes can't create files in C:\Windows".
3. With Controlled Folder Access **on**, a protected folder: create
   `%USERPROFILE%\Documents\FutoPickTest` with the feature off first, then send the
   same with that path written out in full, backslashes doubled. Record whether it is
   accepted or refused (last run: accepted).
4. Quit.

### B. A default notes folder that cannot be created (crashes 1739 and 952)

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
3. Expect the **banner** "FUTO Notes can't save anything. It isn't allowed to create
   its notes folder at C:\Users\...\Documents\fake-notes." Run **status**: expect
   `available: false`, `accessRefused: false` (the folder is missing, not refused).
4. Quit, turn it off, and rename `fake-notes-kept` back.

### D. Letting the app in

1. Turn Controlled Folder Access **on**, then **Allow an app through Controlled folder
   access** → **Add an allowed app** → browse to `target\debug\futo-notes-tauri.exe`
   in the repo.
2. Launch with the dev script. Expect no **banner**, and **toast** to return
   `no toast`.
3. Quit, and put Controlled Folder Access and its allowed apps back the way you found
   them.

## What to report

Return this block, filled in, as the result of the run:

```text
Windows version (winver):
Commit (git rev-parse --short HEAD):
A3 notes listed; banner already up:  yes / no ; yes / no
A4 toast:
A4 Defender event 1123:              yes / no
A4 banner (or "no banner"):
A5 status:
A5 probe error, verbatim:
A6 type:
C1 C:\FutoPickTest:                  ACCEPTED / refusal text
C2 C:\Windows:                       ACCEPTED / refusal text
C3 Documents\FutoPickTest (on):      ACCEPTED / refusal text
B3 banner:
B3 status:
D2 banner; toast:
Anything else unexpected:
```

## Last run

2026-09-28, Windows 11 Pro 25H2 (build 26200.9457, ARM64), commit 6b7eac23; the
refusal detection is unchanged since. **Pass.**

- A: notes listed, no banner at launch. **toast** gave "Setting changed, but it
  couldn't be saved.", Defender logged event 1123 (no notification seen), and the
  banner said "isn't allowed to change your notes folder". Status `available:
  false, accessRefused: true`. Probe: "The system cannot find the file specified.
  (os error 2) (creating temp ...\fake-notes\.sf-tmp-...)". The editor took no
  typing.
- B: banner "isn't allowed to create its notes folder"; status `available: false,
  accessRefused: false`.
- C: `C:\FutoPickTest` accepted. `C:\Windows` refused: "FUTO Notes can't create
  files in C:\Windows: Access is denied. (os error 5)". A protected
  `Documents\FutoPickTest` was **accepted** with no Defender block: the pick check
  does not catch Controlled Folder Access, the lock does at the first write.
- D: with the app allowed, no banner, no toast, and the probe wrote.

## Not proven by this run

- A read-only network share or other file systems, which can refuse writes with
  error codes other than these.
- Windows on x64 (the error codes come from the OS, not the CPU).
