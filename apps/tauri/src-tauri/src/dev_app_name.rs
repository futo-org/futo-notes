//! Name a `just tauri-dev` instance after its git branch in the macOS Dock and
//! Cmd-Tab (debug builds only).
//!
//! The Dock names an unbundled process by its executable's file name, so when
//! `scripts/tauri-dev.mjs` sets `FUTO_DEV_APP_FILE_NAME`, the process
//! re-executes itself from a hard link of that name beside the cargo binary.
//! `exec` keeps the PID, so the Tauri CLI still owns, restarts and stops it.
//! The link stays in `target/debug/`, so the embedded Info.plist and Tauri's
//! resource dir are unchanged. With no bundle id, WebKit keys its
//! `~/Library/{WebKit,Caches}` folders on the same name, so each branch gets
//! its own browser storage; `just wt gc` sweeps those of branches no worktree
//! has checked out. The name's rules live in `devAppFileName`
//! (`scripts/lib/slot.mjs`); `scripts/qa-target.mjs` enumerates by its prefix.

use std::os::unix::process::CommandExt;
use std::path::Path;

pub(crate) fn relaunch_under_dev_app_name() {
    let Some(file_name) = std::env::var_os("FUTO_DEV_APP_FILE_NAME") else {
        return;
    };
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    // A name with a separator would link somewhere other than beside the binary.
    if Path::new(&file_name).components().count() != 1 {
        return;
    }
    let link = executable.with_file_name(&file_name);
    // Every rebuild replaces the binary, so relink rather than reuse the old one.
    let _ = std::fs::remove_file(&link);
    if let Err(error) = std::fs::hard_link(&executable, &link) {
        eprintln!("[dev-app-name] could not link {}: {error}", link.display());
        return;
    }
    // Removing the variable is what makes this run once: the relaunched
    // process returns at the top.
    let error = std::process::Command::new(&link)
        .args(std::env::args_os().skip(1))
        .env_remove("FUTO_DEV_APP_FILE_NAME")
        .exec();
    eprintln!(
        "[dev-app-name] could not relaunch as {}: {error}",
        link.display()
    );
}
