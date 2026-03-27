use anyhow::{bail, Context, Result};
use std::process::Command;

pub const DEFAULT_PORT: u16 = 3005;
pub const DEFAULT_DATA_PATH: &str = "./stonefruit-data";

pub fn generate_compose(port: u16, data_path: &str) -> String {
    let data_mount = format!(
        "{}:/app/data",
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

pub fn compose_up_recreate(work_dir: &std::path::Path) -> Result<()> {
    run_compose(work_dir, &["up", "-d", "--force-recreate"])
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

pub fn parse_compose_port(work_dir: &std::path::Path) -> Result<u16> {
    let compose_path = work_dir.join("docker-compose.yml");
    let content = std::fs::read_to_string(&compose_path)
        .with_context(|| format!("failed to read {}", compose_path.display()))?;
    Ok(parse_port_from_compose(&content))
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
    use super::{generate_compose, parse_port_from_compose, DEFAULT_DATA_PATH, DEFAULT_PORT};

    #[test]
    fn compose_uses_selected_port() {
        let compose = generate_compose(4141, DEFAULT_DATA_PATH);
        assert!(compose.contains("\"4141:4141\""));
        assert!(compose.contains("PORT=4141"));
    }

    #[test]
    fn compose_uses_selected_data_path() {
        let compose = generate_compose(4141, "/srv/stonefruit data");
        assert!(compose.contains("\"/srv/stonefruit data:/app/data\""));
        assert!(!compose.contains("volumes:\n  data:"));
    }

    #[test]
    fn parse_port_extracts_custom_port() {
        let compose = generate_compose(4141, DEFAULT_DATA_PATH);
        assert_eq!(parse_port_from_compose(&compose), 4141);
    }

    #[test]
    fn parse_port_falls_back_to_default() {
        assert_eq!(parse_port_from_compose("no port here"), DEFAULT_PORT);
    }
}
