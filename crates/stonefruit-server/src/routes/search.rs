//! `GET /search?q=...` — hybrid keyword + vector search.
//! `GET /search/status` — indexer status probe.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::oneshot;

use crate::app::AppState;
use crate::error::AppError;
use crate::indexer::{IndexerCommand, IndexerPhase};

const VECTOR_QUERY_TIMEOUT_MS: u64 = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    20
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    pub timing: SearchTiming,
    pub vector_enabled: bool,
}

#[derive(Serialize)]
pub struct SearchHit {
    /// Sync-protocol filename: `{title}.md` — always exactly one `.md` suffix.
    /// Clients derive the note ID by stripping the single `.md` suffix.
    pub filename: String,
    pub snippet: String,
    pub score: f64,
    pub source: String, // "keyword", "vector", or "both"
}

#[derive(Serialize)]
pub struct SearchTiming {
    pub keyword_ms: u64,
    pub vector_ms: u64,
    pub total_ms: u64,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub phase: IndexerPhase,
    pub model_ready: bool,
    pub vector_enabled: bool,
    pub notes_total: usize,
    pub notes_indexed: usize,
    pub model_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `GET /search?q=<query>&limit=20`
pub async fn search(
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<SearchResponse>, AppError> {
    let q = params.q.trim();
    if q.is_empty() {
        return Err(AppError::bad_request("Query parameter 'q' is required"));
    }
    let limit = params.limit.min(100);
    let total_start = Instant::now();

    // 1. BM25 keyword search
    let keyword_start = Instant::now();
    let keyword_results = {
        let db = state.db.lock().unwrap();
        crate::db::bm25_search(&db, q, limit).map_err(|e| AppError::internal(e.to_string()))?
    };
    let keyword_ms = keyword_start.elapsed().as_millis() as u64;

    // 2. Vector search (if model ready)
    let model_ready = state
        .indexer_status
        .read()
        .map(|s| s.model_ready)
        .unwrap_or(false);

    let mut vector_ms = 0u64;
    let vector_results = if model_ready {
        let vector_start = Instant::now();

        // Embed the query via the indexer
        let (reply_tx, reply_rx) = oneshot::channel();
        let sent = state
            .indexer_tx
            .send(IndexerCommand::EmbedQuery {
                text: q.to_string(),
                reply: reply_tx,
            })
            .await
            .is_ok();

        if sent {
            match tokio::time::timeout(
                std::time::Duration::from_millis(VECTOR_QUERY_TIMEOUT_MS),
                reply_rx,
            )
            .await
            {
                Ok(Ok(Ok(embedding))) => {
                    let db = state.db.lock().unwrap();
                    let results = crate::db::vector_search(&db, &embedding, limit)
                        .map_err(|e| AppError::internal(e.to_string()))?;
                    vector_ms = vector_start.elapsed().as_millis() as u64;
                    results
                }
                _ => {
                    vector_ms = vector_start.elapsed().as_millis() as u64;
                    vec![]
                }
            }
        } else {
            vec![]
        }
    } else {
        vec![]
    };

    // 3. Fuse results — deduplicate by filename, keeping the best score per note
    let keyword_ranked: Vec<(String, f64)> = {
        let mut seen = std::collections::HashSet::new();
        keyword_results
            .iter()
            .filter(|(_, filename, _, _)| seen.insert(filename.clone()))
            .map(|(_, filename, _, score)| (filename.clone(), *score))
            .collect()
    };
    let vector_ranked: Vec<(String, f64)> = {
        let mut seen = std::collections::HashSet::new();
        vector_results
            .iter()
            .filter(|(_, filename, _, _)| seen.insert(filename.clone()))
            .map(|(_, filename, _, dist)| (filename.clone(), *dist))
            .collect()
    };

    let keyword_filenames: Vec<String> = keyword_ranked.iter().map(|(f, _)| f.clone()).collect();
    let vector_filenames: Vec<String> = vector_ranked.iter().map(|(f, _)| f.clone()).collect();

    let fused = if vector_ranked.is_empty() {
        // Keyword-only: just use keyword order
        keyword_ranked
    } else {
        stonefruit_core::search::rrf_fuse(&keyword_ranked, &vector_ranked, None)
    };

    // 4. Build response with deduplication and snippets
    let mut seen = std::collections::HashSet::new();
    let mut results = Vec::new();

    // Build snippet lookup from keyword + vector results
    let mut snippets: HashMap<String, String> = HashMap::new();
    for (_, filename, chunk_text, _) in &keyword_results {
        snippets
            .entry(filename.clone())
            .or_insert_with(|| truncate_snippet(chunk_text, 200));
    }
    for (_, filename, chunk_text, _) in &vector_results {
        snippets
            .entry(filename.clone())
            .or_insert_with(|| truncate_snippet(chunk_text, 200));
    }

    for (filename, score) in &fused {
        if !seen.insert(filename.clone()) {
            continue;
        }
        let source = stonefruit_core::search::determine_source(
            filename,
            &keyword_filenames,
            &vector_filenames,
        );
        results.push(SearchHit {
            filename: filename.clone(),
            snippet: snippets.get(filename).cloned().unwrap_or_default(),
            score: *score,
            source: format!("{source:?}").to_lowercase(),
        });
        if results.len() >= limit {
            break;
        }
    }

    let total_ms = total_start.elapsed().as_millis() as u64;

    Ok(Json(SearchResponse {
        results,
        timing: SearchTiming {
            keyword_ms,
            vector_ms,
            total_ms,
        },
        vector_enabled: model_ready,
    }))
}

/// `POST /search/warmup` — fire-and-forget embed to keep Ollama model loaded.
pub async fn warmup(State(state): State<AppState>) -> Json<serde_json::Value> {
    let model_ready = state
        .indexer_status
        .read()
        .map(|s| s.model_ready)
        .unwrap_or(false);

    if model_ready {
        let (reply_tx, _reply_rx) = oneshot::channel();
        let _ = state
            .indexer_tx
            .send(IndexerCommand::EmbedQuery {
                text: "w".to_string(),
                reply: reply_tx,
            })
            .await;
    }

    Json(serde_json::json!({ "ok": true }))
}

/// `GET /search/status`
pub async fn status(State(state): State<AppState>) -> Json<StatusResponse> {
    let s = state.indexer_status.read().unwrap();
    let (notes_total, notes_indexed) = state
        .db
        .lock()
        .ok()
        .and_then(|db| crate::db::search_index_counts(&db).ok())
        .unwrap_or((s.notes_total, s.notes_processed));

    Json(StatusResponse {
        phase: s.phase,
        model_ready: s.model_ready,
        vector_enabled: s.model_ready,
        notes_total,
        notes_indexed,
        model_id: s.model_id.clone(),
    })
}

fn truncate_snippet(text: &str, max_len: usize) -> String {
    let cleaned = text.replace('\n', " ");
    if cleaned.len() <= max_len {
        cleaned
    } else {
        format!("{}...", &cleaned[..max_len])
    }
}
