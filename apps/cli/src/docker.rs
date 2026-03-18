use anyhow::{bail, Context, Result};
use std::process::Command;

pub const DEFAULT_PORT: u16 = 3005;
pub const DEFAULT_DATA_PATH: &str = "./stonefruit-data";

pub fn generate_compose(port: u16, data_path: &str) -> String {
    let data_mount = format!(
        "{}:/app/apps/server/data",
        yaml_double_quote(data_path.trim())
    );
    format!(
        r#"services:
  server:
    container_name: stonefruit
    image: gitlab.futo.org:5050/stonefruit/stonefruit/server:latest
    ports:
      - "{port}:{port}"
    volumes:
      - "{data_mount}"
    environment:
      - PORT={port}
      - DATABASE_PATH=./data/stonefruit.db
      - NOTES_PATH=./data/notes
    restart: unless-stopped
"#
    )
}

fn yaml_double_quote(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
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

pub fn compose_up(work_dir: &std::path::Path) -> Result<()> {
    run_compose(work_dir, &["up", "-d"])
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

#[cfg(test)]
mod tests {
    use super::{generate_compose, DEFAULT_DATA_PATH};

    #[test]
    fn compose_uses_selected_port() {
        let compose = generate_compose(4141, DEFAULT_DATA_PATH);
        assert!(compose.contains("\"4141:4141\""));
        assert!(compose.contains("PORT=4141"));
    }

    #[test]
    fn compose_uses_selected_data_path() {
        let compose = generate_compose(4141, "/srv/stonefruit data");
        assert!(compose.contains("\"/srv/stonefruit data:/app/apps/server/data\""));
        assert!(!compose.contains("volumes:\n  data:"));
    }
}
