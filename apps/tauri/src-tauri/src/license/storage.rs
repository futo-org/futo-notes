//! The license file on disk: the stored key/activation pair and where it lives.

use super::*;

/// The two plain strings on disk. Both must be present for a stored license to
/// mean anything, so a half-written file reads as "no license" rather than as a
/// pair that can never verify.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLicense {
    key: String,
    activation: String,
}

pub(super) fn read_pair(path: &Path) -> Option<LicensePair> {
    let raw = std::fs::read_to_string(path).ok()?;
    let stored = serde_json::from_str::<StoredLicense>(&raw).ok()?;
    if stored.key.trim().is_empty() || stored.activation.trim().is_empty() {
        return None;
    }
    Some(LicensePair {
        key: stored.key,
        activation: stored.activation,
    })
}

pub(super) fn write_pair(path: &Path, pair: &LicensePair) -> Result<(), String> {
    let stored = StoredLicense {
        key: pair.key.clone(),
        activation: pair.activation.clone(),
    };
    let json = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    futo_notes_core::files::write_atomic_text(path, &json)
}

pub(super) fn clear_pair(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        // Removing a license that was never stored is the state the user asked
        // for, not a failure.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// The license file for this build. Derived from the app data dir, so the
/// dev/prod split (M3) comes from the bundle identifier for free, and
/// `FUTO_NOTES_DATA_DIR` still wins so a worktree dev run keeps its own.
pub(super) fn license_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = crate::vault_location::environment_data_dir().map_or_else(
        || app.path().app_data_dir().map_err(|error| error.to_string()),
        Ok,
    )?;
    Ok(base.join(LICENSE_FILE))
}
