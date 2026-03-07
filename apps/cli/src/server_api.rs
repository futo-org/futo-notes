use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug, Deserialize, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub setup_complete: bool,
}

pub fn check_health(base_url: &str) -> Result<HealthResponse> {
    let client = client()?;
    let response = client
        .get(format!("{}/health", trim_url(base_url)))
        .send()
        .with_context(|| format!("failed to reach {}", base_url))?;

    if response.status() != StatusCode::OK {
        bail!("health check returned status {}", response.status());
    }

    response
        .json::<HealthResponse>()
        .context("invalid health response")
}

pub fn setup(base_url: &str, password: &str) -> Result<()> {
    let client = client()?;
    let response = client
        .post(format!("{}/setup", trim_url(base_url)))
        .json(&SetupRequest { password })
        .send()
        .with_context(|| format!("failed to reach {}", base_url))?;

    match response.status() {
        StatusCode::CREATED => Ok(()),
        StatusCode::CONFLICT => bail!("server is already configured"),
        StatusCode::UNPROCESSABLE_ENTITY => bail!("password must be at least 8 characters"),
        code => bail!("setup returned status {}", code),
    }
}

pub fn dashboard_status(base_url: &str) -> Result<Value> {
    let client = client()?;
    let response = client
        .get(format!("{}/dashboard/status", trim_url(base_url)))
        .send()
        .with_context(|| format!("failed to reach {}", base_url))?;

    if response.status() != StatusCode::OK {
        bail!("status request returned {}", response.status());
    }

    response
        .json::<Value>()
        .context("invalid dashboard status response")
}

fn client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .context("failed to create HTTP client")
}

fn trim_url(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

#[derive(Debug, Serialize)]
struct SetupRequest<'a> {
    password: &'a str,
}
