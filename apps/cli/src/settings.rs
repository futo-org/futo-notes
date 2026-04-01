use anyhow::{bail, Context, Result};
use std::io::{self, Write};
use std::path::PathBuf;

use crate::cli::SettingsArgs;
use crate::config;
use crate::{docker, server_api};

pub fn run(args: SettingsArgs) -> Result<()> {
    let work_dir = resolve_work_dir(args.compose_dir.as_deref())?;
    let mut config = config::load_or_infer(&work_dir)?;

    let current = config.features.semantic_search_enabled;
    let desired = match (args.enable_semantic_search, args.disable_semantic_search) {
        (true, false) => true,
        (false, true) => false,
        (false, false) => prompt_semantic_search(current)?,
        _ => unreachable!("clap enforces flag conflicts"),
    };

    if desired == current {
        config::write_managed_files(&work_dir, &config)?;
        println!(
            "Semantic search is already {}. No restart needed.",
            enabled_label(current)
        );
        return Ok(());
    }

    config.features.semantic_search_enabled = desired;
    config::write_managed_files(&work_dir, &config)?;

    println!(
        "Applying settings in {}",
        work_dir.join("docker-compose.yml").display()
    );
    docker::check_docker()?;
    docker::compose_pull(&work_dir)?;
    docker::compose_up_recreate(&work_dir)?;
    server_api::wait_for_healthy(&base_url(config.port), config.startup_timeout())?;

    println!(
        "Semantic search is now {}.",
        enabled_label(config.features.semantic_search_enabled)
    );
    Ok(())
}

pub fn resolve_work_dir(compose_dir: Option<&str>) -> Result<PathBuf> {
    match compose_dir {
        Some(dir) => {
            let path = PathBuf::from(dir);
            if !path.is_dir() {
                bail!("{dir} is not a directory");
            }
            Ok(path)
        }
        None => std::env::current_dir().context("failed to get working directory"),
    }
}

pub fn base_url(port: u16) -> String {
    config::base_url(port)
}

fn prompt_semantic_search(current: bool) -> Result<bool> {
    println!("Semantic search is currently {}.", enabled_label(current));
    print!("Enable semantic search? [{}]: ", prompt_default(current));
    io::stdout().flush().context("failed to flush stdout")?;

    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .context("failed to read user input")?;
    let value = input.trim().to_ascii_lowercase();

    if value.is_empty() {
        return Ok(current);
    }

    match value.as_str() {
        "y" | "yes" => Ok(true),
        "n" | "no" => Ok(false),
        _ => bail!("please answer yes or no"),
    }
}

fn prompt_default(current: bool) -> &'static str {
    if current {
        "Y/n"
    } else {
        "y/N"
    }
}

fn enabled_label(enabled: bool) -> &'static str {
    if enabled {
        "enabled"
    } else {
        "disabled"
    }
}

#[cfg(test)]
mod tests {
    use super::base_url;

    #[test]
    fn base_url_formats_localhost() {
        assert_eq!(base_url(3005), "http://localhost:3005");
    }
}
