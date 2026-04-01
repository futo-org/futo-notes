use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::docker;

pub const SETTINGS_FILENAME: &str = ".stonefruit-cli.json";
const SETTINGS_VERSION: u32 = 1;
const BASIC_STARTUP_TIMEOUT_SECS: u64 = 30;
const SEMANTIC_SEARCH_STARTUP_TIMEOUT_SECS: u64 = 900;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CliConfig {
    #[serde(default = "settings_version")]
    pub version: u32,
    pub port: u16,
    pub data_path: String,
    #[serde(default)]
    pub features: FeatureFlags,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct FeatureFlags {
    #[serde(default = "default_semantic_search_enabled")]
    pub semantic_search_enabled: bool,
    #[serde(default)]
    pub llm_enabled: bool,
}

impl CliConfig {
    pub fn new(port: u16, data_path: String, semantic_search_enabled: bool) -> Self {
        Self {
            version: SETTINGS_VERSION,
            port,
            data_path,
            features: FeatureFlags {
                semantic_search_enabled,
                llm_enabled: false,
            },
        }
    }

    pub fn startup_timeout(&self) -> Duration {
        if self.features.semantic_search_enabled {
            Duration::from_secs(SEMANTIC_SEARCH_STARTUP_TIMEOUT_SECS)
        } else {
            Duration::from_secs(BASIC_STARTUP_TIMEOUT_SECS)
        }
    }
}

pub fn settings_path(work_dir: &Path) -> PathBuf {
    work_dir.join(SETTINGS_FILENAME)
}

pub fn load(work_dir: &Path) -> Result<Option<CliConfig>> {
    let path = settings_path(work_dir);
    if !path.exists() {
        return Ok(None);
    }

    let content =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let config: CliConfig = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(Some(config))
}

pub fn save(work_dir: &Path, config: &CliConfig) -> Result<()> {
    let path = settings_path(work_dir);
    let content =
        serde_json::to_string_pretty(config).context("failed to serialize CLI settings")?;
    fs::write(&path, format!("{content}\n"))
        .with_context(|| format!("failed to write {}", path.display()))
}

pub fn write_managed_files(work_dir: &Path, config: &CliConfig) -> Result<()> {
    save(work_dir, config)?;
    let compose = docker::generate_compose(config);
    let compose_path = work_dir.join("docker-compose.yml");
    fs::write(&compose_path, compose)
        .with_context(|| format!("failed to write {}", compose_path.display()))
}

pub fn load_or_infer(work_dir: &Path) -> Result<CliConfig> {
    if let Some(config) = load(work_dir)? {
        return Ok(config);
    }

    let compose_path = work_dir.join("docker-compose.yml");
    if !compose_path.exists() {
        bail!(
            "No docker-compose.yml found in {}. Run 'stonefruit setup' first.",
            work_dir.display()
        );
    }

    let content = fs::read_to_string(&compose_path)
        .with_context(|| format!("failed to read {}", compose_path.display()))?;
    let config = docker::infer_config_from_compose(&content)?;
    save(work_dir, &config)?;
    Ok(config)
}

const fn settings_version() -> u32 {
    SETTINGS_VERSION
}

pub fn base_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

const fn default_semantic_search_enabled() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_timeout_is_longer_for_semantic_search() {
        let semantic = CliConfig::new(3005, "./data".to_string(), true);
        let basic = CliConfig::new(3005, "./data".to_string(), false);

        assert!(semantic.startup_timeout() > basic.startup_timeout());
    }
}
