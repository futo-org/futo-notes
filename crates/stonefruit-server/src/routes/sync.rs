use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use stonefruit_core::sync::{SyncCheckRequest, SyncCheckStatus, SyncRequest, SyncResponse};

use crate::app::AppState;
use crate::error::AppError;
use crate::indexer::IndexerCommand;

/// POST /sync — full sync.
pub async fn sync(
    State(state): State<AppState>,
    Json(req): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, AppError> {
    if req.device_id.is_empty() {
        return Err(AppError::bad_request("device_id is required"));
    }

    // Validate filenames (basic safety)
    for item in &req.inventory {
        validate_filename(&item.filename)?;
    }
    for item in &req.changed {
        validate_filename(&item.filename)?;
    }
    for item in &req.new {
        validate_filename(&item.filename)?;
    }
    for filename in &req.deleted {
        validate_filename(filename)?;
    }

    let db = state.db.clone();
    let notes_dir = state.notes_dir.clone();

    let response = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;
        crate::sync_engine::process_sync(&conn, &notes_dir, &req)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;

    let _ = state.indexer_tx.try_send(IndexerCommand::Reindex);

    Ok(Json(response))
}

/// POST /sync/check — quick version check.
pub async fn sync_check(
    State(state): State<AppState>,
    Json(req): Json<SyncCheckRequest>,
) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();

    let server_version = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;
        crate::db::get_sync_version(&conn).map_err(|e| AppError::internal(e.to_string()))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;

    let status = if req.version >= server_version {
        SyncCheckStatus::UpToDate
    } else {
        SyncCheckStatus::ChangesAvailable
    };

    Ok(Json(json!({
        "status": status,
        "version": server_version,
    })))
}

fn validate_filename(filename: &str) -> Result<(), AppError> {
    if filename.is_empty() {
        return Err(AppError::bad_request("Empty filename"));
    }
    if filename.contains("..") || filename.starts_with('/') || filename.starts_with('\\') {
        return Err(AppError::bad_request(format!(
            "Unsafe filename: {filename}"
        )));
    }
    Ok(())
}
