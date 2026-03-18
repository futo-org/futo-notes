use crate::cli::StatusArgs;
use crate::server_api;
use anyhow::Result;
use serde_json::Value;
use std::io::{self, BufRead};

pub fn run(args: StatusArgs) -> Result<()> {
    let health = server_api::check_health(&args.base_url)?;

    // Resolve password for authenticated status
    let password = if args.password_stdin {
        Some(
            io::stdin()
                .lock()
                .lines()
                .next()
                .transpose()?
                .unwrap_or_default(),
        )
    } else {
        args.password.clone()
    };

    let dashboard = if let Some(pw) = &password {
        let token = server_api::login(&args.base_url, pw)?;
        server_api::dashboard_status_auth(&args.base_url, &token).ok()
    } else {
        // Try unauthenticated (will fail with 401 on hardened servers)
        server_api::dashboard_status(&args.base_url).ok()
    };

    if args.json {
        let payload = serde_json::json!({
            "health": health,
            "dashboard": dashboard,
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }

    println!("Stonefruit server status");
    println!("  URL: {}", args.base_url);
    println!("  Health: {}", health.status);
    println!("  Setup complete: {}", yes_no(health.setup_complete));

    if let Some(status) = dashboard {
        print_line(&status, "notes_count", "Notes");
        print_line(&status, "sessions_count", "Sessions");
        print_line(&status, "uptime_seconds", "Uptime (s)");
        print_nested_line(&status, &["search", "enabled"], "Search enabled");
        print_nested_line(&status, &["transforms", "enabled"], "Transforms enabled");
    } else if password.is_none() {
        println!("  (use --password to view full dashboard status)");
    }

    Ok(())
}

fn print_line(status: &Value, key: &str, label: &str) {
    if let Some(value) = status.get(key) {
        println!("  {}: {}", label, json_value(value));
    }
}

fn print_nested_line(status: &Value, path: &[&str], label: &str) {
    let mut value = status;
    for key in path {
        match value.get(key) {
            Some(next) => value = next,
            None => return,
        }
    }

    println!("  {}: {}", label, json_value(value));
}

fn json_value(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(v) => yes_no(*v).to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => v.clone(),
        _ => value.to_string(),
    }
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}
