use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use stonefruit_core::hash::hash_sha256_bytes;
use stonefruit_core::invariants::is_image_filename;

use crate::app::AppState;
use crate::error::AppError;

const MAX_BLOB_SIZE: usize = 100 * 1024 * 1024; // 100 MB

/// PUT /blob/{filename} — upload an image blob.
pub async fn upload_blob(
    State(state): State<AppState>,
    Path(filename): Path<String>,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if !is_image_filename(&filename) {
        return Err(AppError::bad_request(format!(
            "Not a valid image filename: {filename}"
        )));
    }
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err(AppError::bad_request("Unsafe filename"));
    }
    if body.len() > MAX_BLOB_SIZE {
        return Err(AppError::bad_request(format!(
            "File too large (max {MAX_BLOB_SIZE} bytes)"
        )));
    }

    let notes_dir = state.notes_dir.clone();
    let db = state.db.clone();
    let data = body.to_vec();
    let fname = filename.clone();

    let content_hash = tokio::task::spawn_blocking(move || {
        // Write file
        let path = notes_dir.join(&fname);
        std::fs::write(&path, &data).map_err(|e| AppError::internal(e.to_string()))?;

        let hash = hash_sha256_bytes(&data);

        // Upsert note_meta
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;
        conn.execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) \
             VALUES (?1, ?2, ?3, 1) \
             ON CONFLICT(filename) DO UPDATE SET \
             content_hash = excluded.content_hash, \
             modified_at = excluded.modified_at, \
             is_blob = 1",
            rusqlite::params![fname, hash, stonefruit_core::files::now_ms()],
        )
        .map_err(|e| AppError::internal(e.to_string()))?;

        Ok::<String, AppError>(hash)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "content_hash": content_hash,
            "filename": filename,
        })),
    ))
}

/// GET /blob/{filename} — download an image blob.
pub async fn download_blob(
    State(state): State<AppState>,
    Path(filename): Path<String>,
) -> Result<Response, AppError> {
    if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
        return Err(AppError::bad_request("Unsafe filename"));
    }

    let notes_dir = state.notes_dir.clone();
    let db = state.db.clone();
    let fname = filename.clone();

    let data = tokio::task::spawn_blocking(move || {
        // Verify it's a blob in note_meta
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;
        let is_blob: bool = conn
            .query_row(
                "SELECT is_blob FROM note_meta WHERE filename = ?1",
                [&fname],
                |row| row.get::<_, i32>(0).map(|v| v != 0),
            )
            .map_err(|_| AppError::not_found(format!("Blob not found: {fname}")))?;

        if !is_blob {
            return Err(AppError::not_found(format!("Not a blob: {fname}")));
        }

        let path = notes_dir.join(&fname);
        std::fs::read(&path).map_err(|_| AppError::not_found(format!("File not found: {fname}")))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;

    Ok(([(header::CONTENT_TYPE, "application/octet-stream")], data).into_response())
}
