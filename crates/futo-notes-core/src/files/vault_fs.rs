//! Vault-relative I/O shared by sync and the local note engine.
use std::path::{Component, Path};

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

pub fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    platform::read(root, relative)
}

pub fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    platform::write_atomic(root, relative, bytes)
}

pub fn remove(root: &Path, relative: &str) -> Result<bool, String> {
    platform::remove(root, relative)
}

pub fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    platform::rename(root, source, destination)
}

pub fn exists(root: &Path, relative: &str) -> Result<bool, String> {
    platform::exists(root, relative)
}

pub fn set_mtime_ms(root: &Path, relative: &str, modified_at_ms: i64) -> Result<(), String> {
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

pub fn read_optional(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, String> {
    platform::read_optional(root, relative)
}
pub fn create_new(root: &Path, relative: &str, bytes: &[u8]) -> Result<bool, String> {
    platform::create_new(root, relative, bytes)
}
pub fn move_no_replace(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    platform::move_no_replace(root, source, destination)
}
pub fn create_dir_all(root: &Path, relative: &str) -> Result<(), String> {
    platform::create_dir_all(root, relative)
}

pub fn rename_case(root: &Path, source: &str, destination: &str) -> Result<(), String> {
    platform::rename_case(root, source, destination)
}

/// Local-store policy: report committed writes if directory fsync is unsupported.
/// Sync uses `write_atomic` and retains strict journal durability.
pub fn write_atomic_local(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
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
    platform::rename_local(root, source, destination)
}
