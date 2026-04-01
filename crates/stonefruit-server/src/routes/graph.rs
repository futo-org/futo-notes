//! `GET /graph/layout` — server-computed UMAP + K-Means graph layout.

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::app::AppState;
use crate::error::AppError;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct GraphLayoutResponse {
    pub nodes: Vec<GraphNode>,
    pub clusters: Vec<GraphCluster>,
    pub note_count: usize,
    pub indexed_count: usize,
}

#[derive(Serialize)]
pub struct GraphNode {
    pub filename: String,
    pub x: f32,
    pub y: f32,
    pub cluster_index: usize,
}

#[derive(Serialize)]
pub struct GraphCluster {
    pub index: usize,
    pub label: String,
    pub center_x: f32,
    pub center_y: f32,
    pub radius: f32,
    pub color_index: usize,
    pub filenames: Vec<String>,
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// `GET /graph/layout`
pub async fn layout(State(state): State<AppState>) -> Result<Json<GraphLayoutResponse>, AppError> {
    // Load note vectors from DB (average per-filename, L2-normalize)
    let note_vectors = tokio::task::spawn_blocking({
        let db = state.db.clone();
        move || load_note_vectors(&db)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?
    .map_err(|e| AppError::internal(&e))?;

    let note_count = note_vectors.len();
    if note_count < 2 {
        return Ok(Json(GraphLayoutResponse {
            nodes: note_vectors
                .iter()
                .map(|v| GraphNode {
                    filename: v.filename.clone(),
                    x: 0.0,
                    y: 0.0,
                    cluster_index: 0,
                })
                .collect(),
            clusters: vec![],
            note_count,
            indexed_count: note_count,
        }));
    }

    // Compute layout on blocking thread (CPU-heavy, uses rayon internally)
    let (positions, clusters) = tokio::task::spawn_blocking(move || {
        let seed = 0x51f1_5e77_u64;
        let n_neighbors = 15.min(note_count - 1).max(2);
        let positions =
            stonefruit_core::graph::compute_layout(&note_vectors, seed, n_neighbors, 0.1);
        let clusters =
            stonefruit_core::graph::compute_clusters(&note_vectors, &positions, seed as u32);
        (positions, clusters)
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))?;

    // Build cluster membership lookup
    let mut cluster_for_file: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for cluster in &clusters {
        for f in &cluster.filenames {
            cluster_for_file.insert(f.clone(), cluster.index);
        }
    }

    let nodes: Vec<GraphNode> = positions
        .iter()
        .map(|p| GraphNode {
            filename: p.filename.clone(),
            x: p.x,
            y: p.y,
            cluster_index: cluster_for_file.get(&p.filename).copied().unwrap_or(0),
        })
        .collect();

    let graph_clusters: Vec<GraphCluster> = clusters
        .into_iter()
        .map(|c| GraphCluster {
            index: c.index,
            label: c.label,
            center_x: c.center_x,
            center_y: c.center_y,
            radius: c.radius,
            color_index: c.color_index,
            filenames: c.filenames,
        })
        .collect();

    Ok(Json(GraphLayoutResponse {
        nodes,
        clusters: graph_clusters,
        note_count,
        indexed_count: note_count,
    }))
}

/// Load per-note average vectors from the database.
fn load_note_vectors(
    db: &std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
) -> Result<Vec<stonefruit_core::graph::NoteVector>, String> {
    let conn = db.lock().unwrap();

    // Get dims from search_config
    let dims: usize = crate::db::get_search_config(&conn, "dims")
        .map_err(|e| e.to_string())?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if dims == 0 {
        return Ok(vec![]);
    }

    // Get all chunk embeddings grouped by filename
    let mut stmt = conn
        .prepare(
            "SELECT c.filename, v.embedding
             FROM note_chunks_vec v
             JOIN note_chunks c ON c.chunk_id = v.chunk_id
             ORDER BY c.filename",
        )
        .map_err(|e| e.to_string())?;

    let mut current_filename: Option<String> = None;
    let mut current_embeddings: Vec<Vec<f32>> = Vec::new();
    let mut result: Vec<stonefruit_core::graph::NoteVector> = Vec::new();

    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let filename: String = row.get(0).map_err(|e| e.to_string())?;
        let emb_bytes: Vec<u8> = row.get(1).map_err(|e| e.to_string())?;

        // Convert bytes to f32 vec
        let embedding: Vec<f32> = emb_bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();

        if current_filename.as_deref() != Some(&filename) {
            // Flush previous
            if let Some(ref prev) = current_filename {
                if let Some(avg) =
                    stonefruit_core::graph::average_and_normalize(&current_embeddings)
                {
                    result.push(stonefruit_core::graph::NoteVector {
                        filename: prev.clone(),
                        embedding: avg,
                    });
                }
            }
            current_filename = Some(filename);
            current_embeddings.clear();
        }
        current_embeddings.push(embedding);
    }

    // Flush last
    if let Some(ref prev) = current_filename {
        if let Some(avg) = stonefruit_core::graph::average_and_normalize(&current_embeddings) {
            result.push(stonefruit_core::graph::NoteVector {
                filename: prev.clone(),
                embedding: avg,
            });
        }
    }

    Ok(result)
}
