use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::app::AppState;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

/// Sliding-window rate limiter state.
#[derive(Clone)]
pub struct RateLimiter {
    /// Map of IP → list of request timestamps.
    entries: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
    max_attempts: usize,
    window: std::time::Duration,
}

impl RateLimiter {
    pub fn new(max_attempts: usize, window_secs: u64) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            max_attempts,
            window: std::time::Duration::from_secs(window_secs),
        }
    }

    /// Check if a request from this IP is allowed. Returns `true` if allowed.
    pub fn check(&self, ip: &str) -> bool {
        let mut entries = self.entries.lock().unwrap();
        let now = Instant::now();
        let timestamps = entries.entry(ip.to_string()).or_default();

        // Remove expired entries
        timestamps.retain(|t| now.duration_since(*t) < self.window);

        if timestamps.len() >= self.max_attempts {
            return false;
        }

        timestamps.push(now);
        true
    }

    /// Remove expired entries for all IPs. Call periodically.
    pub fn cleanup(&self) {
        let mut entries = self.entries.lock().unwrap();
        let now = Instant::now();
        entries.retain(|_, timestamps| {
            timestamps.retain(|t| now.duration_since(*t) < self.window);
            !timestamps.is_empty()
        });
    }
}

/// Extract client IP from the peer socket address.
///
/// Do not trust forwarding headers unless the deployment explicitly strips and
/// rewrites them at the proxy boundary.
fn extract_ip(request: &Request) -> String {
    request
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|ci| ci.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Axum middleware that rate-limits requests.
pub async fn rate_limit(
    State(limiter): State<RateLimiter>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let ip = extract_ip(&request);
    if !limiter.check(&ip) {
        return Err(AppError::too_many_requests(
            "Too many requests — try again later",
        ));
    }
    Ok(next.run(request).await)
}

/// Hash a raw token for lookup (must match the hash used at login).
fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Axum middleware that validates Bearer token authentication.
pub async fn require_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let auth_header = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::unauthorized("Missing Authorization header"))?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::unauthorized("Invalid Authorization header format"))?;

    if token.is_empty() {
        return Err(AppError::unauthorized("Empty token"));
    }

    let token_hash = hash_token(token);
    let db = state.db.clone();

    let valid = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sessions WHERE token_hash = ?1",
                [&token_hash],
                |row| row.get(0),
            )
            .map_err(|e| AppError::internal(e.to_string()))?;
        Ok::<bool, AppError>(exists)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;

    if !valid {
        return Err(AppError::unauthorized("Invalid or expired token"));
    }

    Ok(next.run(request).await)
}
