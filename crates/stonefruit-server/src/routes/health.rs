use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::app::AppState;
use crate::error::AppError;

pub async fn health(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let db = state.db.clone();
    let setup_complete = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;
        crate::db::is_setup_complete(&conn).map_err(|e| AppError::internal(e.to_string()))
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;

    Ok(Json(json!({
        "status": "ok",
        "setup_complete": setup_complete,
    })))
}
