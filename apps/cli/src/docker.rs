use anyhow::{bail, Context, Result};
use std::process::Command;

pub const DEFAULT_PORT: u16 = 3005;

pub fn generate_compose(port: u16) -> String {
    format!(
        r#"services:
  server:
    container_name: stonefruit
    image: gitlab.futo.org:5050/stonefruit/stonefruit/server:latest
    ports:
      - "{port}:{port}"
    volumes:
      - data:/app/apps/server/data
    environment:
      - PORT={port}
      - DATABASE_PATH=./data/stonefruit.db
      - NOTES_PATH=./data/notes
    restart: unless-stopped

volumes:
  data:
"#
    )
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
    use super::generate_compose;

    #[test]
    fn compose_uses_selected_port() {
        let compose = generate_compose(4141);
        assert!(compose.contains("\"4141:4141\""));
        assert!(compose.contains("PORT=4141"));
    }
}
