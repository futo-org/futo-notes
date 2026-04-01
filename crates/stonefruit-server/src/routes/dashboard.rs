use axum::extract::State;
use axum::response::Html;
use axum::Json;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Instant;

use crate::app::AppState;
use crate::error::AppError;

static STARTED_AT: OnceLock<Instant> = OnceLock::new();

pub async fn dashboard() -> Html<&'static str> {
    let _ = started_at();
    Html(include_str!("dashboard.html"))
}

pub async fn status(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let _ = started_at();

    let db = state.db.clone();
    let (notes_count, sessions_count, setup_complete, chunk_count, dirty_count, last_indexed_at) =
        tokio::task::spawn_blocking(move || {
            let conn = db.lock().map_err(|e| AppError::internal(e.to_string()))?;

            let notes_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM note_meta WHERE is_blob = 0",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| AppError::internal(e.to_string()))?;

            let sessions_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
                .map_err(|e| AppError::internal(e.to_string()))?;

            let setup_complete = crate::db::is_setup_complete(&conn)
                .map_err(|e| AppError::internal(e.to_string()))?;

            let chunk_count: i64 = conn
                .query_row("SELECT COUNT(*) FROM note_chunks", [], |row| row.get(0))
                .unwrap_or(0);

            let (notes_total, notes_indexed) =
                crate::db::search_index_counts(&conn).unwrap_or((0, 0));
            let dirty = notes_total.saturating_sub(notes_indexed);

            // Most recent indexed_at timestamp (epoch seconds) from index_state
            let last_indexed_at: Option<i64> = conn
                .query_row(
                    "SELECT MAX(indexed_at) FROM index_state",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(None);

            Ok::<(usize, usize, bool, i64, usize, Option<i64>), AppError>((
                notes_count as usize,
                sessions_count as usize,
                setup_complete,
                chunk_count,
                dirty,
                last_indexed_at,
            ))
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;

    let indexer = state.indexer_status.read().unwrap().clone();
    let model_ready = indexer.model_ready;
    let phase = indexer.phase;

    let search = if model_ready || phase != crate::indexer::IndexerPhase::Disabled {
        let phase_str = match phase {
            crate::indexer::IndexerPhase::Idle => "idle",
            crate::indexer::IndexerPhase::LoadingModel => "loading_model",
            crate::indexer::IndexerPhase::Indexing => "indexing",
            crate::indexer::IndexerPhase::Disabled => "disabled",
        };
        json!({
            "enabled": true,
            "enhanced_search_enabled": true,
            "model": indexer.model_id,
            "chunk_count": chunk_count,
            "dirty_count": dirty_count,
            "last_indexed_at": last_indexed_at,
            "scheduler": {
                "phase": phase_str,
            },
            "current_job": if phase == crate::indexer::IndexerPhase::Indexing {
                Some(json!({
                    "notes_processed": indexer.notes_processed,
                    "notes_total": indexer.notes_total,
                }))
            } else {
                None
            },
        })
    } else {
        json!({ "enabled": false })
    };

    Ok(Json(json!({
        "notes_count": notes_count,
        "sessions_count": sessions_count,
        "setup_complete": setup_complete,
        "search": search,
        "plugins": null,
        "uptime_seconds": started_at().elapsed().as_secs(),
    })))
}

fn started_at() -> &'static Instant {
    STARTED_AT.get_or_init(Instant::now)
}
