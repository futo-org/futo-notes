//! CLI configuration: the vault, the server, and the password command.
//!
//! Nonsecret by construction — no field can hold a password, session token,
//! or vault key. It lives in the per-user configuration directory and is
//! written atomically. A file from a newer CLI is refused rather than
//! rewritten without the fields this build does not know.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CliError, CliResult};
use crate::i18n::tf;

pub const CONFIG_VERSION: u32 = 1;
const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_command: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            vault: None,
            server: None,
            password_command: None,
        }
    }
}

/// Development builds keep their own configuration, cache, and lock
/// directories, so a dev CLI never acts on the release CLI's vault.
pub fn namespace() -> &'static str {
    if cfg!(debug_assertions) {
        "futo-notes-cli-dev"
    } else {
        "futo-notes-cli"
    }
}

fn per_user(base: Option<PathBuf>, kind: &str) -> CliResult<PathBuf> {
    base.map(|dir| dir.join(namespace()))
        .ok_or_else(|| CliError::io(format!("no per-user {kind} directory")))
}

pub fn config_dir() -> CliResult<PathBuf> {
    per_user(dirs::config_dir(), "configuration")
}

pub fn cache_dir() -> CliResult<PathBuf> {
    per_user(dirs::cache_dir(), "cache")
}

pub fn state_dir() -> CliResult<PathBuf> {
    per_user(dirs::state_dir(), "state")
}

pub fn load() -> CliResult<Config> {
    load_from(&config_dir()?)
}

pub fn save(config: &Config) -> CliResult<()> {
    save_to(&config_dir()?, config)
}

fn load_from(dir: &Path) -> CliResult<Config> {
    let path = dir.join(CONFIG_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(error) => return Err(CliError::io(error)),
    };
    let unreadable = |detail: String| {
        CliError::io(tf(
            "cli.errors.configUnreadable",
            &[("path", &path.display().to_string()), ("detail", &detail)],
        ))
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|error| unreadable(error.to_string()))?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if version != u64::from(CONFIG_VERSION) {
        return Err(CliError::io(tf(
            "cli.errors.configVersion",
            &[
                ("path", &path.display().to_string()),
                ("version", &version.to_string()),
            ],
        )));
    }
    serde_json::from_value(value).map_err(|error| unreadable(error.to_string()))
}

fn save_to(dir: &Path, config: &Config) -> CliResult<()> {
    std::fs::create_dir_all(dir).map_err(CliError::io)?;
    restrict_directory(dir);
    let json = serde_json::to_string_pretty(config).map_err(CliError::io)?;
    futo_notes_core::files::write_atomic_text(&dir.join(CONFIG_FILE), &json).map_err(CliError::io)
}

fn restrict_directory(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("futo-cli-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_file_is_an_empty_current_config() {
        let dir = temp_dir("missing");
        assert_eq!(load_from(&dir).unwrap(), Config::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_newer_version_is_refused_not_rewritten() {
        let dir = temp_dir("newer");
        let newer = r#"{"version": 2, "somethingNew": true}"#;
        std::fs::write(dir.join(CONFIG_FILE), newer).unwrap();
        assert!(load_from(&dir).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join(CONFIG_FILE)).unwrap(),
            newer
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_saved_config_round_trips() {
        let dir = temp_dir("round-trip");
        let config = Config {
            vault: Some("/home/me/notes".into()),
            server: Some("https://notes.example.net".into()),
            password_command: Some("pass show notes".into()),
            ..Config::default()
        };
        save_to(&dir, &config).unwrap();
        assert_eq!(load_from(&dir).unwrap(), config);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
