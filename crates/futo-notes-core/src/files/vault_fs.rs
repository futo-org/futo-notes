//! Vault-relative I/O shared by sync and the local note engine.
//!
//! Destination installers protect pending editor recovery by default. Callers
//! hold `vault_mutation_guard` across their decision and installation; these
//! functions never acquire it recursively (bootstrap workers share its span).
//! Low-level metadata I/O and an attached editor's own checkpoint are explicit
//! exceptions. Directory moves stamp their destination prefix before OS I/O.
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};

pub use platform::{create_pinned_recovery, open_pinned_recovery, PinnedRecoveryFile};

fn relative_components(relative: &str) -> Result<Vec<&std::ffi::OsStr>, String> {
    let components = Path::new(relative)
        .components()
        .map(|component| match component {
            Component::Normal(component) => Ok(component),
            _ => Err(format!("unsafe vault-relative path: {relative}")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err("empty vault-relative path".to_owned());
    }
    Ok(components)
}

/// The vault-relative name that resolves back to `path` (the inverse of
/// `relative_components`): its components joined with `/`. On Unix a `\` is an
/// ordinary character inside a component, so `a\b.md` is named `a\b.md`, never
/// `a/b.md`. `None` when a component is not UTF-8, which no name can address.
pub fn relative_name(root: &Path, path: &Path) -> Option<String> {
    let components = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|component| match component {
            Component::Normal(component) => component.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    Some(components.join("/"))
}

/// Why a vault-relative path could not be resolved to its parent directory.
///
/// `NotFound` is ABSENCE, not a fault: a leaf cannot be there if the folder
/// holding it is not, so a caller asking "is it there?", "remove it" or "move
/// it" is told no/nothing-to-do. Every other reason — a symlink, a plain file
/// where a folder belongs, no permission — is a fault the caller must see.
/// BOTH implementations answer with this one type: they diverged on exactly
/// this distinction for three releases (github#48), and a shared type plus the
/// shared rules in `vault_fs/contract_tests.rs` is what keeps them together.
enum OpenParentError {
    NotFound(String),
    Other(String),
}

impl OpenParentError {
    fn message(self) -> String {
        match self {
            Self::NotFound(message) | Self::Other(message) => message,
        }
    }
}

/// Set once the OS refuses to create a file or folder directly in the vault root
/// for want of permission — Windows Controlled Folder Access over an existing
/// folder, a read-only mount, a folder owned by another user (crash #1788). Such a
/// folder still lists and reads, so the refusal is the only sign; the desktop
/// reports the vault unusable from then on instead of probing it. Only CREATION
/// counts: a rename or delete refused because another process holds the file
/// (antivirus, a sync client, the indexer) is transient, and a single unreadable
/// file says nothing about the vault.
static ACCESS_REFUSED: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
thread_local! {
    /// This thread's refusals: the flag is process-wide, and the two contract
    /// suites run in parallel, so only a per-thread count shows a test its own.
    static TEST_REFUSALS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static REFUSE_NEXT_CREATE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Makes this thread's next create in the vault fail as the OS refusing it, so
/// the refusal wiring runs as root (Linux CI) and on Windows, where no
/// permission bit a test can set refuses anything.
#[cfg(test)]
fn refuse_next_create() {
    REFUSE_NEXT_CREATE.with(|refuse| refuse.set(true));
}

/// Fails with `refusal` when `refuse_next_create` armed this create, checked just
/// before the real one so both reach the same error path. Always `Ok` outside tests.
#[cfg_attr(not(test), allow(unused_variables))]
pub(crate) fn refused_create<E>(refusal: E) -> Result<(), E> {
    #[cfg(test)]
    if REFUSE_NEXT_CREATE.with(|refuse| refuse.replace(false)) {
        return Err(refusal);
    }
    Ok(())
}

pub fn access_refused() -> bool {
    ACCESS_REFUSED.load(Ordering::Relaxed)
}

#[cfg(test)]
fn refusal_count() -> usize {
    TEST_REFUSALS.with(std::cell::Cell::get)
}

/// Whether a create failed because the OS will not let this process write there.
/// Controlled Folder Access answers a create it blocks with ERROR_FILE_NOT_FOUND
/// rather than access denied (crashes 1739 and 952), and a create directly in a
/// root that exists has no other reason to fail that way.
fn is_refusal(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem
    ) || cfg!(windows) && error.raw_os_error() == Some(2)
}

/// Whether a vault-relative path names an entry directly in the root.
fn in_root(relative: &str) -> bool {
    Path::new(relative).components().nth(1).is_none()
}

/// Every place that creates a file or folder in the vault reports its failure
/// here. Only a create directly in the root counts: settings, open tabs, images
/// and top-level notes all land there, so a folder that refuses writes is caught
/// on its first such write, while one read-only subfolder (a root-owned
/// `.crashlogs`, a shared `Archive/`) fails only its own writes.
pub(crate) fn note_create_failure(error: &std::io::Error, in_root: bool) {
    if in_root && is_refusal(error) {
        ACCESS_REFUSED.store(true, Ordering::Relaxed);
        #[cfg(test)]
        TEST_REFUSALS.with(|count| count.set(count.get() + 1));
    }
}

fn context(operation: &str, relative: &str, error: impl std::fmt::Display) -> String {
    format!("{operation} vault path {relative}: {error}")
}

/// Preflight for path-based OS capabilities (such as trash) and enumeration.
/// I/O below additionally pins each parent directory on Unix, so mutations do
/// not rely on this check to close the check/use window.
pub fn validate_path(root: &Path, relative: &str) -> Result<(), String> {
    if std::fs::symlink_metadata(root).is_ok_and(|metadata| is_link(&metadata)) {
        return Err("vault root symlink rejected".to_owned());
    }
    let mut path = root.to_owned();
    for component in relative_components(relative)? {
        path.push(component);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if is_link(&metadata) => {
                return Err(format!("vault symlink rejected: {}", path.display()))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points are also outside the vault contract.
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[cfg(unix)]
#[path = "vault_fs/unix.rs"]
mod platform;

#[cfg(not(unix))]
#[path = "vault_fs/fallback.rs"]
mod platform;

/// The portable implementation ships ONLY where `platform` is not it — Windows
/// — so on Unix it would never be compiled, let alone run. That is how a
/// missing-parent divergence in it reached three releases (github#48). It is
/// plain `std::fs` and needs no Windows to run, so it is compiled here under
/// test and held to the same rules as the shipped implementation
/// (`vault_fs/contract_tests.rs`). Only the rules it answers are used, hence
/// the dead-code allowance.
#[cfg(all(test, unix))]
#[path = "vault_fs/fallback.rs"]
#[allow(dead_code)]
mod fallback;

pub fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    platform::read(root, relative)
}

pub fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    super::recovery_coordination::protect_replacement(root, relative)?;
    before_install(relative);
    platform::write_atomic(root, relative, bytes)
}

/// Opens a recovery stream without following vault symlinks. Returning a file
/// distinguishes OS append acceptance from the caller's later durable flush.
pub fn open_append(root: &Path, relative: &str) -> Result<std::fs::File, String> {
    platform::open_append(root, relative)
}

/// Flushes an existing regular file before recovery state can be retired.
pub fn sync_file(root: &Path, relative: &str) -> Result<(), String> {
    platform::sync_file(root, relative)
}

pub fn remove(root: &Path, relative: &str) -> Result<bool, String> {
    platform::remove(root, relative)
}

pub fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    protect_move(root, source, destination)?;
    before_install(destination);
    platform::rename(root, source, destination)
}

pub fn exists(root: &Path, relative: &str) -> Result<bool, String> {
    platform::exists(root, relative)
}

pub fn set_mtime_ms(root: &Path, relative: &str, modified_at_ms: i64) -> Result<(), String> {
    // An `updated_at` that failed to parse arrives as 0; never stamp 1970.
    if modified_at_ms <= 0 {
        return Ok(());
    }
    platform::set_mtime_ms(root, relative, modified_at_ms)
}

pub fn sync_parent(root: &Path, relative: &str) -> Result<(), String> {
    platform::sync_parent(root, relative)
}

#[cfg(all(any(test, feature = "test-support"), unix))]
pub fn fail_directory_sync_on_call(call: usize) {
    platform::fail_directory_sync_on_call(call);
}

#[cfg(all(test, unix))]
#[path = "vault_fs/tests.rs"]
mod tests;

// Deliberately `cfg(test)` and not `cfg(all(test, unix))`: these are the rules
// the Windows build has to answer, so the Windows build is the last place they
// should be absent. Gated to Unix they ran 0 times in ci/win-build.ps1's suite
// (pipeline 36582), which is github#48's own shape — a check gated away from
// the platform that needs it. The file is plain `std::fs` and builds anywhere;
// it is the `fallback` SUITE inside that is Unix-only, because off Unix
// `platform` already is that code.
#[cfg(test)]
#[path = "vault_fs/contract_tests.rs"]
mod contract_tests;

pub fn read_optional(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, String> {
    platform::read_optional(root, relative)
}
pub fn create_new(root: &Path, relative: &str, bytes: &[u8]) -> Result<bool, String> {
    super::recovery_coordination::protect_replacement(root, relative)?;
    before_install(relative);
    platform::create_new(root, relative, bytes)
}
/// Exclusive install with strict directory durability, used by sync's required-absent paths.
pub fn create_new_strict(root: &Path, relative: &str, bytes: &[u8]) -> Result<bool, String> {
    super::recovery_coordination::protect_replacement(root, relative)?;
    before_install(relative);
    platform::create_new_strict(root, relative, bytes)
}
pub fn move_no_replace(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    protect_move(root, source, destination)?;
    before_install(destination);
    platform::move_no_replace(root, source, destination)
}
pub fn move_no_replace_strict(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
    protect_move(root, source, destination)?;
    before_install(destination);
    platform::move_no_replace_strict(root, source, destination)
}
pub fn create_dir_all(root: &Path, relative: &str) -> Result<(), String> {
    platform::create_dir_all(root, relative)
}

pub fn rename_case(root: &Path, source: &str, destination: &str) -> Result<(), String> {
    protect_move(root, source, destination)?;
    before_install(destination);
    platform::rename_case(root, source, destination)
}

/// Local-store policy: report committed writes if directory fsync is unsupported.
/// Sync uses `write_atomic` and retains strict journal durability.
pub fn write_atomic_local(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    super::recovery_coordination::protect_replacement(root, relative)?;
    before_install(relative);
    platform::write_atomic_local(root, relative, bytes)
}
pub fn create_dir(root: &Path, relative: &str) -> Result<(), String> {
    platform::create_dir(root, relative)
}
pub fn remove_dir(root: &Path, relative: &str, recursive: bool) -> Result<(), String> {
    platform::remove_dir(root, relative, recursive)
}
pub fn clear(root: &Path) -> Result<(), String> {
    platform::clear(root)
}

pub fn remove_local(root: &Path, relative: &str) -> Result<bool, String> {
    platform::remove_local(root, relative)
}
pub fn rename_local(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    protect_move(root, source, destination)?;
    before_install(destination);
    platform::rename_local(root, source, destination)
}

/// All destination installers require the caller's vault guard across its
/// decision and install. Metadata operations bypass visible-note policy only.
pub(crate) fn write_metadata_atomic_local(
    root: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<(), String> {
    platform::write_atomic_local(root, relative, bytes)
}

pub(crate) fn recovery_directory_exists(root: &Path) -> Result<bool, String> {
    match platform::entry_is_directory(root, ".futo-editor-recovery")? {
        Some(true) => Ok(true),
        None => Ok(false),
        Some(false) => Err("editor recovery path is not a directory".to_owned()),
    }
}

fn protect_move(root: &Path, source: &str, destination: &str) -> Result<(), String> {
    validate_path(root, source)?;
    validate_path(root, destination)?;
    match platform::entry_is_directory(root, source)? {
        Some(true) => super::recovery_coordination::protect_directory(root, destination),
        Some(false) => super::recovery_coordination::protect_replacement(root, destination),
        None => Ok(()),
    }
}

/// Only an attached editor's locked checkpoint may exempt its own recovery id.
/// Foreign parking destinations always use the default replacement policy.
/// This capability neither locks nor suppresses policy outside its own calls.
pub struct EditorCheckpointInstall<'a> {
    root: &'a Path,
    recovery_id: &'a str,
}

impl<'a> EditorCheckpointInstall<'a> {
    pub fn new(root: &'a Path, recovery_id: &'a str) -> Result<Self, String> {
        super::ensure_safe_note_id(recovery_id)?;
        Ok(Self { root, recovery_id })
    }

    pub fn adopt_existing(&self, relative: &str) -> Result<(), String> {
        if super::note_id_from_relative_path(relative).as_deref() != Some(self.recovery_id) {
            super::recovery_coordination::protect_replacement(self.root, relative)?;
        }
        Ok(())
    }

    pub fn write_atomic_local(&self, relative: &str, bytes: &[u8]) -> Result<(), String> {
        self.adopt_existing(relative)?;
        before_install(relative);
        platform::write_atomic_local(self.root, relative, bytes)
    }

    pub fn create_new(&self, relative: &str, bytes: &[u8]) -> Result<bool, String> {
        self.adopt_existing(relative)?;
        before_install(relative);
        platform::create_new(self.root, relative, bytes)
    }
}

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    static BEFORE_INSTALL: std::cell::RefCell<Option<Box<dyn Fn(&str)>>> = const { std::cell::RefCell::new(None) };
}

/// Filesystem fault seam after durable destination coordination and before OS
/// installation. Ordinary metadata writes do not invoke it. It never suppresses policy.
#[cfg(any(test, feature = "test-support"))]
pub fn set_before_install_hook(hook: Option<Box<dyn Fn(&str)>>) {
    BEFORE_INSTALL.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg_attr(not(any(test, feature = "test-support")), allow(unused_variables))]
fn before_install(relative: &str) {
    #[cfg(any(test, feature = "test-support"))]
    BEFORE_INSTALL.with(|slot| {
        if let Some(hook) = slot.borrow().as_ref() {
            hook(relative);
        }
    });
}
