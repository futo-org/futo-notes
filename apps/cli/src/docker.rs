use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;

use crate::config::CliConfig;

pub const DEFAULT_PORT: u16 = 3005;
pub const DEFAULT_DATA_PATH: &str = "./stonefruit-data";
pub const DEFAULT_OLLAMA_MODEL: &str = "qwen3-embedding:0.6b";
pub const DEFAULT_SEARCH_MODEL_ID: &str = "qwen3-embedding-0.6b";
pub const DEFAULT_SEARCH_EMBED_DIMS: usize = 1024;

const SERVER_IMAGE: &str = "gitlab.futo.org:5050/stonefruit/stonefruit/server:latest";
const OLLAMA_IMAGE: &str = "ollama/ollama:latest";
const SERVER_DATA_SUFFIXES: [&str; 2] = [":/app/data", ":/app/apps/server/data"];
const FINAL_LAYER_STATUSES: &[&str] = &["Pull complete", "Already exists", "Mounted from"];
const LAYER_STATUS_PREFIXES: &[&str] = &[
    "Pulling fs layer",
    "Waiting",
    "Downloading",
    "Download complete",
    "Verifying Checksum",
    "Extracting",
    "Pull complete",
    "Already exists",
    "Mounted from",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullProgress {
    pub image: String,
    pub image_index: usize,
    pub image_count: usize,
    pub completed_layers: usize,
    pub total_layers: usize,
    pub status: String,
}

pub fn generate_compose(config: &CliConfig) -> String {
    let mut lines = vec![
        "services:".to_string(),
        "  server:".to_string(),
        "    container_name: stonefruit".to_string(),
        format!("    image: {SERVER_IMAGE}"),
        "    ports:".to_string(),
        format!("      - \"{0}:{0}\"", config.port),
        "    volumes:".to_string(),
        format!(
            "      - \"{}:/app/data\"",
            yaml_double_quote(config.data_path.trim())
        ),
    ];

    if config.features.semantic_search_enabled {
        lines.extend(server_depends_on_lines());
    }

    lines.push("    environment:".to_string());
    lines.extend(server_environment_lines(config));
    lines.push("    restart: unless-stopped".to_string());

    if config.features.semantic_search_enabled {
        lines.extend(ollama_service_lines());
    }

    lines.join("\n") + "\n"
}

pub fn infer_config_from_compose(content: &str) -> Result<CliConfig> {
    Ok(CliConfig::new(
        parse_port_from_compose(content),
        parse_data_path_from_compose(content)?,
        semantic_search_enabled(content),
    ))
}

pub fn check_docker() -> Result<String> {
    let output = Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .context("failed to invoke docker")?;

    if !output.status.success() {
        bail!(
            "docker is not available: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn compose_pull(work_dir: &std::path::Path) -> Result<()> {
    run_compose(work_dir, &["pull"])
}

pub fn pull_images_with_progress(
    config: &CliConfig,
    mut on_progress: impl FnMut(PullProgress),
) -> Result<()> {
    let images = compose_images(config);
    let image_count = images.len();

    for (index, image) in images.iter().enumerate() {
        let image_index = index + 1;
        let mut state = PullImageState::new(image.clone(), image_index, image_count);
        on_progress(state.progress("Connecting to registry".to_string()));

        let mut child = Command::new("docker")
            .args(["pull", image])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("failed to start docker pull for {image}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("failed to capture docker pull stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("failed to capture docker pull stderr"))?;

        let (tx, rx) = mpsc::channel();
        let stdout_handle = stream_pull_lines(stdout, tx.clone());
        let stderr_handle = stream_pull_lines(stderr, tx);
        let mut error_lines = Vec::new();

        for line in rx {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(progress) = state.update(trimmed) {
                on_progress(progress);
            } else {
                error_lines.push(trimmed.to_string());
            }
        }

        stdout_handle
            .join()
            .map_err(|_| anyhow::anyhow!("docker pull stdout reader panicked"))?;
        stderr_handle
            .join()
            .map_err(|_| anyhow::anyhow!("docker pull stderr reader panicked"))?;

        let status = child
            .wait()
            .with_context(|| format!("failed to wait for docker pull {image}"))?;
        if !status.success() {
            let details = error_lines.join("\n");
            let message = if details.trim().is_empty() {
                format!("docker pull {image} failed with status {status}")
            } else {
                format!("docker pull {image} failed: {details}")
            };
            bail!("{message}");
        }

        on_progress(state.finish());
    }

    Ok(())
}

pub fn compose_up(work_dir: &std::path::Path) -> Result<()> {
    run_compose(work_dir, &["up", "-d", "--remove-orphans"])
}

pub fn compose_up_recreate(work_dir: &std::path::Path) -> Result<()> {
    run_compose(
        work_dir,
        &["up", "-d", "--force-recreate", "--remove-orphans"],
    )
}

pub fn get_container_image_id(container_name: &str) -> Result<Option<String>> {
    let output = Command::new("docker")
        .args(["inspect", container_name, "--format", "{{.Image}}"])
        .output()
        .context("failed to invoke docker inspect")?;

    if !output.status.success() {
        return Ok(None);
    }

    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if id.is_empty() {
        Ok(None)
    } else {
        Ok(Some(id))
    }
}

fn server_depends_on_lines() -> Vec<String> {
    vec![
        "    depends_on:".to_string(),
        "      ollama:".to_string(),
        "        condition: service_healthy".to_string(),
    ]
}

fn compose_images(config: &CliConfig) -> Vec<String> {
    let mut images = vec![SERVER_IMAGE.to_string()];
    if config.features.semantic_search_enabled {
        images.push(OLLAMA_IMAGE.to_string());
    }
    images
}

fn server_environment_lines(config: &CliConfig) -> Vec<String> {
    let mut lines = vec![
        format!("      - PORT={}", config.port),
        "      - DATABASE_PATH=./data/stonefruit.db".to_string(),
        "      - NOTES_PATH=./data/notes".to_string(),
    ];

    if config.features.semantic_search_enabled {
        lines.extend([
            format!("      - SEARCH_OLLAMA_MODEL={DEFAULT_OLLAMA_MODEL}"),
            "      - SEARCH_OLLAMA_BASE_URL=http://ollama:11434".to_string(),
            format!("      - SEARCH_MODEL_ID={DEFAULT_SEARCH_MODEL_ID}"),
            format!("      - SEARCH_EMBED_DIMS={DEFAULT_SEARCH_EMBED_DIMS}"),
        ]);
    }

    lines
}

fn ollama_service_lines() -> Vec<String> {
    vec![
        "  ollama:".to_string(),
        "    container_name: stonefruit-ollama".to_string(),
        format!("    image: {OLLAMA_IMAGE}"),
        format!(
            "    entrypoint: [\"/bin/sh\", \"-lc\", \"ollama serve & pid=$$!; until ollama list >/dev/null 2>&1; do sleep 1; done; ollama pull {DEFAULT_OLLAMA_MODEL}; wait $$pid\"]"
        ),
        "    healthcheck:".to_string(),
        format!(
            "      test: [\"CMD-SHELL\", \"ollama show {DEFAULT_OLLAMA_MODEL} >/dev/null 2>&1\"]"
        ),
        "      interval: 10s".to_string(),
        "      timeout: 5s".to_string(),
        "      retries: 60".to_string(),
        "      start_period: 5s".to_string(),
        "    volumes:".to_string(),
        "      - ollama:/root/.ollama".to_string(),
        "    restart: unless-stopped".to_string(),
        "volumes:".to_string(),
        "  ollama:".to_string(),
    ]
}

fn yaml_double_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn parse_port_from_compose(content: &str) -> u16 {
    for line in content.lines() {
        let trimmed = line.trim().trim_start_matches("- ");
        if let Some(port_str) = trimmed.strip_prefix("PORT=") {
            if let Ok(port) = port_str.trim().parse::<u16>() {
                return port;
            }
        }
    }
    DEFAULT_PORT
}

fn parse_data_path_from_compose(content: &str) -> Result<String> {
    for line in content.lines() {
        let trimmed = line.trim().trim_start_matches("- ").trim_matches('"');
        for suffix in SERVER_DATA_SUFFIXES {
            if let Some(host_path) = trimmed.strip_suffix(suffix) {
                return Ok(host_path.to_string());
            }
        }
    }

    bail!("could not determine data path from docker-compose.yml")
}

fn semantic_search_enabled(content: &str) -> bool {
    content.contains("SEARCH_OLLAMA_MODEL=") || content.contains("\n  ollama:\n")
}

fn run_compose(work_dir: &std::path::Path, args: &[&str]) -> Result<()> {
    let output = Command::new("docker")
        .arg("compose")
        .args(args)
        .current_dir(work_dir)
        .output()
        .with_context(|| format!("failed to run docker compose {}", args.join(" ")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let details = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        bail!("docker compose {} failed: {}", args.join(" "), details);
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct PullImageState {
    image: String,
    image_index: usize,
    image_count: usize,
    layers: HashMap<String, String>,
    status: String,
}

impl PullImageState {
    fn new(image: String, image_index: usize, image_count: usize) -> Self {
        Self {
            image,
            image_index,
            image_count,
            layers: HashMap::new(),
            status: "Preparing pull".to_string(),
        }
    }

    fn update(&mut self, line: &str) -> Option<PullProgress> {
        if let Some((prefix, status)) = line.split_once(':') {
            let status = status.trim();
            if is_layer_status(status) {
                self.layers
                    .insert(prefix.trim().to_string(), status.to_string());
                self.status = status.to_string();
                return Some(self.progress(status.to_string()));
            }
        }

        if line.starts_with("Status:")
            || line.starts_with("Digest:")
            || line.contains("Pulling from")
        {
            self.status = line.to_string();
            return Some(self.progress(self.status.clone()));
        }

        None
    }

    fn finish(&mut self) -> PullProgress {
        if self.layers.is_empty() {
            return PullProgress {
                image: self.image.clone(),
                image_index: self.image_index,
                image_count: self.image_count,
                completed_layers: 1,
                total_layers: 1,
                status: "Image ready".to_string(),
            };
        }

        for status in self.layers.values_mut() {
            if !is_final_layer_status(status) {
                *status = "Pull complete".to_string();
            }
        }

        self.progress("Image ready".to_string())
    }

    fn progress(&self, status: String) -> PullProgress {
        let total_layers = self.layers.len();
        let completed_layers = self
            .layers
            .values()
            .filter(|status| is_final_layer_status(status))
            .count();

        PullProgress {
            image: self.image.clone(),
            image_index: self.image_index,
            image_count: self.image_count,
            completed_layers,
            total_layers,
            status,
        }
    }
}

fn is_layer_status(status: &str) -> bool {
    LAYER_STATUS_PREFIXES
        .iter()
        .any(|prefix| status.starts_with(prefix))
}

fn is_final_layer_status(status: &str) -> bool {
    FINAL_LAYER_STATUSES
        .iter()
        .any(|prefix| status.starts_with(prefix))
}

fn stream_pull_lines<R: std::io::Read + Send + 'static>(
    reader: R,
    tx: mpsc::Sender<String>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        generate_compose, infer_config_from_compose, parse_port_from_compose, PullImageState,
    };
    use crate::config::CliConfig;
    use crate::docker::DEFAULT_PORT;

    #[test]
    fn compose_uses_selected_port() {
        let compose = generate_compose(&CliConfig::new(4141, "./data".to_string(), true));
        assert!(compose.contains("\"4141:4141\""));
        assert!(compose.contains("PORT=4141"));
    }

    #[test]
    fn compose_uses_selected_data_path() {
        let compose = generate_compose(&CliConfig::new(
            4141,
            "/srv/stonefruit data".to_string(),
            false,
        ));
        assert!(compose.contains("\"/srv/stonefruit data:/app/data\""));
        assert!(!compose.contains("volumes:\n  data:"));
    }

    #[test]
    fn compose_adds_ollama_when_semantic_search_is_enabled() {
        let compose = generate_compose(&CliConfig::new(3005, "./data".to_string(), true));
        assert!(compose.contains("container_name: stonefruit-ollama"));
        assert!(compose.contains("SEARCH_OLLAMA_MODEL=qwen3-embedding:0.6b"));
    }

    #[test]
    fn compose_skips_ollama_when_semantic_search_is_disabled() {
        let compose = generate_compose(&CliConfig::new(3005, "./data".to_string(), false));
        assert!(!compose.contains("stonefruit-ollama"));
        assert!(!compose.contains("SEARCH_OLLAMA_MODEL="));
    }

    #[test]
    fn parse_port_extracts_custom_port() {
        let compose = generate_compose(&CliConfig::new(4141, "./data".to_string(), false));
        assert_eq!(parse_port_from_compose(&compose), 4141);
    }

    #[test]
    fn parse_port_falls_back_to_default() {
        assert_eq!(parse_port_from_compose("no port here"), DEFAULT_PORT);
    }

    #[test]
    fn infer_config_reads_semantic_search_from_compose() {
        let compose = generate_compose(&CliConfig::new(4141, "/srv/stonefruit".to_string(), true));
        let config = infer_config_from_compose(&compose).unwrap();
        assert_eq!(config.port, 4141);
        assert_eq!(config.data_path, "/srv/stonefruit");
        assert!(config.features.semantic_search_enabled);
    }

    #[test]
    fn infer_config_supports_legacy_mount_path() {
        let compose = r#"services:
  server:
    environment:
      - PORT=3005
    volumes:
      - "./stonefruit-data:/app/apps/server/data"
"#;
        let config = infer_config_from_compose(compose).unwrap();
        assert_eq!(config.data_path, "./stonefruit-data");
        assert!(!config.features.semantic_search_enabled);
    }

    #[test]
    fn pull_progress_counts_completed_layers() {
        let mut state = PullImageState::new("example:latest".to_string(), 1, 1);
        state.update("abc123: Pulling fs layer");
        state.update("def456: Pulling fs layer");
        let progress = state.update("abc123: Pull complete").unwrap();

        assert_eq!(progress.total_layers, 2);
        assert_eq!(progress.completed_layers, 1);
    }

    #[test]
    fn pull_progress_marks_cached_image_ready() {
        let mut state = PullImageState::new("example:latest".to_string(), 1, 1);
        state.update("Status: Image is up to date for example:latest");
        let progress = state.finish();

        assert_eq!(progress.total_layers, 1);
        assert_eq!(progress.completed_layers, 1);
        assert_eq!(progress.status, "Image ready");
    }
}
