use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app::AppState;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct SetupRequest {
    pub password: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub password: String,
    pub device_info: Option<String>,
}

/// Hash a raw token for storage (SHA-256 hex).
fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Generate a random 32-byte hex token.
fn generate_token() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn validate_password(password: &str) -> Result<(), AppError> {
    crate::password::validate_password(password).map_err(AppError::bad_request)
}

/// POST /setup — first-time password setup.
pub async fn setup(
    State(state): State<AppState>,
    Json(body): Json<SetupRequest>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    validate_password(&body.password)?;

    let db = state.db.clone();
    let password = body.password;

    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;

        // Check not already set up
        let already_setup =
            crate::db::is_setup_complete(&conn).map_err(|e| AppError::internal(e.to_string()))?;
        if already_setup {
            return Err(AppError::conflict("Server is already set up"));
        }

        let password_hash =
            crate::password::hash_password(&password).map_err(AppError::internal)?;
        crate::db::insert_initial_password_hash(&conn, &password_hash)
            .map_err(|e| AppError::internal(e.to_string()))?;

        Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}

/// POST /login — authenticate and return a bearer token.
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let password = body.password;
    let device_info = body.device_info;

    tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;

        // Get stored hash
        let stored_hash: String = conn
            .query_row("SELECT password_hash FROM auth WHERE id = 1", [], |row| {
                row.get(0)
            })
            .map_err(|_| AppError::unauthorized("Server not set up or invalid credentials"))?;

        // Verify password
        crate::password::verify_password(&password, &stored_hash)
            .map_err(|_| AppError::unauthorized("Invalid password"))?;

        // Generate token
        let raw_token = generate_token();
        let token_hash = hash_token(&raw_token);

        conn.execute(
            "INSERT INTO sessions (token_hash, device_info) VALUES (?1, ?2)",
            rusqlite::params![token_hash, device_info],
        )
        .map_err(|e| AppError::internal(e.to_string()))?;

        Ok(Json(json!({ "token": raw_token })))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
}
