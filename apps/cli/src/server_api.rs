use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize, Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub setup_complete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupStatus {
    Created,
    AlreadyConfigured,
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

pub fn setup(base_url: &str, password: &str) -> Result<SetupStatus> {
    let client = client()?;
    let response = client
        .post(format!("{}/setup", trim_url(base_url)))
        .json(&SetupRequest { password })
        .send()
        .with_context(|| format!("failed to reach {}", base_url))?;

    match response.status() {
        StatusCode::CREATED => Ok(SetupStatus::Created),
        StatusCode::CONFLICT => Ok(SetupStatus::AlreadyConfigured),
        StatusCode::UNPROCESSABLE_ENTITY => bail!("password must be at least 8 characters"),
        code => bail!("setup returned status {}", code),
    }
}

pub fn login(base_url: &str, password: &str) -> Result<String> {
    let client = client()?;
    let response = client
        .post(format!("{}/login", trim_url(base_url)))
        .json(&LoginRequest { password })
        .send()
        .with_context(|| format!("failed to reach {}", base_url))?;

    match response.status() {
        StatusCode::OK => {
            let data: LoginResponse = response.json().context("invalid login response")?;
            Ok(data.token)
        }
        StatusCode::UNAUTHORIZED => bail!("invalid password"),
        StatusCode::FORBIDDEN => bail!("setup not complete"),
        code => bail!("login returned status {}", code),
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

pub fn dashboard_status_auth(base_url: &str, token: &str) -> Result<Value> {
    let client = client()?;
    let response = client
        .get(format!("{}/dashboard/status", trim_url(base_url)))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .with_context(|| format!("failed to reach {}", base_url))?;

    match response.status() {
        StatusCode::OK => response
            .json::<Value>()
            .context("invalid dashboard status response"),
        StatusCode::UNAUTHORIZED => bail!("session expired or invalid"),
        code => bail!("status request returned {}", code),
    }
}

pub fn reset_password(base_url: &str, admin_token: &str, new_password: &str) -> Result<()> {
    let client = client()?;
    let response = client
        .post(format!("{}/admin/reset-password", trim_url(base_url)))
        .header("Authorization", format!("AdminToken {}", admin_token))
        .json(&ResetPasswordRequest { new_password })
        .send()
        .with_context(|| format!("failed to reach {}", base_url))?;

    match response.status() {
        StatusCode::OK => Ok(()),
        StatusCode::UNAUTHORIZED => bail!("invalid admin token"),
        StatusCode::UNPROCESSABLE_ENTITY => bail!("new password must be at least 8 characters"),
        StatusCode::TOO_MANY_REQUESTS => bail!("too many attempts — try again later"),
        code => bail!("reset-password returned status {}", code),
    }
}

pub fn wait_for_healthy(base_url: &str, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check_health(base_url).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    bail!(
        "server did not become healthy within {}s",
        timeout.as_secs()
    );
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

#[derive(Debug, Serialize)]
struct LoginRequest<'a> {
    password: &'a str,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
    token: String,
}

#[derive(Debug, Serialize)]
struct ResetPasswordRequest<'a> {
    new_password: &'a str,
}
