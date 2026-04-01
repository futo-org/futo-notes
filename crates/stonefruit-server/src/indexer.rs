//! Background embedding indexer.
//!
//! Runs on a dedicated blocking thread (via `spawn_blocking`) with its own
//! SQLite connection. Detects dirty notes, chunks content, embeds each chunk,
//! and writes results to `note_chunks` + `note_chunks_vec` + `note_chunks_fts`.
//!
//! The embedding backend is injected as a trait (`Embedder`) so it can be
//! swapped for tests or alternative models.

use crate::db;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tokio::sync::{mpsc, oneshot};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Commands sent to the indexer task via its channel.
pub enum IndexerCommand {
    /// Re-check for dirty notes and index them.
    Reindex,
    /// Embed a query string and return the vector.
    EmbedQuery {
        text: String,
        reply: oneshot::Sender<Result<Vec<f32>, String>>,
    },
    /// Graceful shutdown.
    Shutdown,
}

/// Current indexer phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexerPhase {
    Idle,
    LoadingModel,
    Indexing,
    Disabled,
}

/// Observable indexer status (shared via `Arc<RwLock<_>>`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexerStatus {
    pub phase: IndexerPhase,
    pub notes_total: usize,
    pub notes_processed: usize,
    pub model_ready: bool,
    pub model_id: Option<String>,
}

impl Default for IndexerStatus {
    fn default() -> Self {
        Self {
            phase: IndexerPhase::Disabled,
            notes_total: 0,
            notes_processed: 0,
            model_ready: false,
            model_id: None,
        }
    }
}

/// Trait for embedding text into a vector. Implement for llama-cpp, mock, etc.
pub trait Embedder: Send + 'static {
    /// The model's unique identifier (used to detect model changes).
    fn model_id(&self) -> &str;
    /// Embedding dimensionality.
    fn dims(&self) -> usize;
    /// Query prefix prepended before query text (but not document text).
    fn query_prefix(&self) -> &str;
    /// Embed a single piece of text. Returns a vector of length `dims()`.
    fn embed(&self, text: &str) -> Result<Vec<f32>, String>;
}

/// Configuration for spawning the indexer.
pub struct IndexerConfig {
    pub db_path: PathBuf,
    pub notes_dir: PathBuf,
    pub status: Arc<RwLock<IndexerStatus>>,
}

// ---------------------------------------------------------------------------
// Indexer task
// ---------------------------------------------------------------------------

/// Spawn the background indexer on a blocking thread. Returns a channel sender.
///
/// If `embedder` is `None`, the indexer runs in `Disabled` mode.
pub fn spawn_indexer(
    config: IndexerConfig,
    embedder: Option<Box<dyn Embedder>>,
) -> mpsc::Sender<IndexerCommand> {
    let (tx, rx) = mpsc::channel(32);
    tokio::task::spawn_blocking(move || indexer_loop(config, embedder, rx));
    tx
}

/// Main indexer loop. Runs on a blocking thread, owns its DB connection.
/// Uses `recv_blocking` to wait on the async channel from a sync context.
fn indexer_loop(
    config: IndexerConfig,
    embedder: Option<Box<dyn Embedder>>,
    mut rx: mpsc::Receiver<IndexerCommand>,
) {
    // Open dedicated DB connection
    let conn = match open_indexer_db(&config.db_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Indexer: failed to open DB: {e}");
            return;
        }
    };

    // Set up model if available
    let embedder = match embedder {
        Some(emb) => {
            if let Err(e) = setup_model(&conn, emb.as_ref()) {
                tracing::error!("Indexer: failed to set up model: {e}");
                return;
            }
            update_status(&config.status, |s| {
                s.phase = IndexerPhase::Idle;
                s.model_ready = true;
                s.model_id = Some(emb.model_id().to_string());
            });
            tracing::info!(
                "Indexer: model ready ({}), dims={}",
                emb.model_id(),
                emb.dims()
            );
            run_index_pass(
                &conn,
                &config.notes_dir,
                emb.as_ref(),
                &config.status,
                &mut rx,
            );
            Some(emb)
        }
        None => {
            tracing::info!("Indexer: no model configured, running in disabled mode");
            update_status(&config.status, |s| {
                s.phase = IndexerPhase::Disabled;
            });
            None
        }
    };

    // Main loop: poll channel with 60s timeout
    loop {
        // Use blocking_recv with a timeout via try_recv + sleep
        let cmd = recv_with_timeout(&mut rx, std::time::Duration::from_secs(60));

        match cmd {
            Some(IndexerCommand::Shutdown) => {
                tracing::info!("Indexer: shutting down");
                break;
            }
            None if rx.is_closed() => {
                tracing::info!("Indexer: channel closed, shutting down");
                break;
            }
            Some(IndexerCommand::EmbedQuery { text, reply }) => {
                let result = embed_query_text(&embedder, &text);
                let _ = reply.send(result);
            }
            Some(IndexerCommand::Reindex) | None => {
                // None = timeout, treat as periodic tick
                if let Some(ref emb) = embedder {
                    run_index_pass(
                        &conn,
                        &config.notes_dir,
                        emb.as_ref(),
                        &config.status,
                        &mut rx,
                    );
                }
            }
        }
    }
}

/// Blocking receive with timeout. Returns `None` on timeout (not on close).
fn recv_with_timeout(
    rx: &mut mpsc::Receiver<IndexerCommand>,
    timeout: std::time::Duration,
) -> Option<IndexerCommand> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match rx.try_recv() {
            Ok(cmd) => return Some(cmd),
            Err(mpsc::error::TryRecvError::Empty) => {
                if std::time::Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(mpsc::error::TryRecvError::Disconnected) => return None,
        }
    }
}

fn embed_query_text(embedder: &Option<Box<dyn Embedder>>, text: &str) -> Result<Vec<f32>, String> {
    match embedder {
        Some(emb) => {
            let query_text = format!("{}{}", emb.query_prefix(), text);
            emb.embed(&query_text)
        }
        None => Err("Embedding model not loaded".to_string()),
    }
}

fn update_status(status: &Arc<RwLock<IndexerStatus>>, f: impl FnOnce(&mut IndexerStatus)) {
    if let Ok(mut s) = status.write() {
        f(&mut s);
    }
}

/// Open a DB connection for the indexer with sqlite-vec loaded.
fn open_indexer_db(db_path: &Path) -> Result<Connection, String> {
    db::register_sqlite_vec();
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    db::init_schema(&conn).map_err(|e| e.to_string())?;
    db::init_search_schema(&conn).map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Check if the model changed since last index run. If so, clear all index data
/// and recreate the vec0 table with the correct dimensions.
fn setup_model(conn: &Connection, embedder: &dyn Embedder) -> Result<(), String> {
    let stored_id = db::get_search_config(conn, "model_id").map_err(|e| e.to_string())?;
    let stored_dims = db::get_search_config(conn, "dims").map_err(|e| e.to_string())?;
    let stored_dims = stored_dims.and_then(|s| s.parse::<usize>().ok());
    let (chunk_count, index_state_count, vec_row_count) =
        db::search_index_storage_counts(conn).map_err(|e| e.to_string())?;

    let needs_rebuild = stored_id.as_deref() != Some(embedder.model_id())
        || stored_dims != Some(embedder.dims())
        || (chunk_count > 0 && vec_row_count == 0)
        || (index_state_count > 0 && chunk_count == 0);

    if needs_rebuild {
        tracing::info!(
            "Indexer: rebuilding index state ({:?}/{:?} -> {}/{})",
            stored_id,
            stored_dims,
            embedder.model_id(),
            embedder.dims()
        );
        db::clear_all_index_data(conn).map_err(|e| e.to_string())?;
        db::create_vec_table(conn, embedder.dims()).map_err(|e| e.to_string())?;
    }

    // Store model metadata
    db::set_search_config(conn, "model_id", embedder.model_id()).map_err(|e| e.to_string())?;
    db::set_search_config(conn, "dims", &embedder.dims().to_string()).map_err(|e| e.to_string())?;
    db::set_search_config(conn, "query_prefix", embedder.query_prefix())
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Run one indexing pass: find dirty notes, chunk, embed, write.
/// Yields to `EmbedQuery` commands between batches.
fn run_index_pass(
    conn: &Connection,
    notes_dir: &Path,
    embedder: &dyn Embedder,
    status: &Arc<RwLock<IndexerStatus>>,
    rx: &mut mpsc::Receiver<IndexerCommand>,
) {
    let (dirty, orphaned) = match db::get_dirty_filenames(conn) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Indexer: failed to get dirty filenames: {e}");
            return;
        }
    };

    // Clean up orphaned index entries
    for filename in &orphaned {
        if let Err(e) = db::remove_index_for_filename(conn, filename) {
            tracing::warn!("Indexer: failed to remove orphan {filename}: {e}");
        }
    }

    if dirty.is_empty() {
        return;
    }

    let total = dirty.len();
    update_status(status, |s| {
        s.phase = IndexerPhase::Indexing;
        s.notes_total = total;
        s.notes_processed = 0;
    });

    tracing::info!("Indexer: {total} dirty notes to index");

    for (i, filename) in dirty.iter().enumerate() {
        let note_path = notes_dir.join(filename);
        let content = match std::fs::read_to_string(&note_path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Indexer: failed to read {filename}: {e}");
                continue;
            }
        };

        let chunks = stonefruit_core::search::chunk_content(&content);
        let mut db_chunks: Vec<(String, usize, usize, Vec<f32>)> = Vec::new();

        for chunk in &chunks {
            let embed_text = stonefruit_core::search::build_embedding_text(filename, &chunk.text);
            match embedder.embed(&embed_text) {
                Ok(vec) => {
                    db_chunks.push((
                        chunk.text.clone(),
                        chunk.start_offset,
                        chunk.end_offset,
                        vec,
                    ));
                }
                Err(e) => {
                    tracing::warn!("Indexer: embed failed for chunk of {filename}: {e}");
                }
            }
        }

        if let Err(e) = db::replace_chunks_for_filename(conn, filename, &db_chunks) {
            tracing::error!("Indexer: failed to write chunks for {filename}: {e}");
            continue;
        }

        // Get the current content hash for this file from note_meta
        let hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM note_meta WHERE filename = ?1",
                rusqlite::params![filename],
                |row| row.get(0),
            )
            .ok();

        if let Some(hash) = hash {
            if let Err(e) = db::mark_indexed(conn, filename, &hash) {
                tracing::error!("Indexer: failed to mark indexed {filename}: {e}");
            }
        }

        update_status(status, |s| {
            s.notes_processed = i + 1;
        });

        // Query embeddings are user-facing; serve them between each note so
        // background indexing does not monopolize the model for long stretches.
        drain_embed_queries(rx, embedder);
    }

    update_status(status, |s| {
        s.phase = IndexerPhase::Idle;
        s.notes_processed = total;
    });

    tracing::info!("Indexer: finished indexing {total} notes");
}

/// Drain any pending `EmbedQuery` commands from the channel without blocking.
fn drain_embed_queries(rx: &mut mpsc::Receiver<IndexerCommand>, embedder: &dyn Embedder) {
    loop {
        match rx.try_recv() {
            Ok(IndexerCommand::EmbedQuery { text, reply }) => {
                let result = {
                    let query_text = format!("{}{}", embedder.query_prefix(), text);
                    embedder.embed(&query_text)
                };
                let _ = reply.send(result);
            }
            Ok(IndexerCommand::Reindex) => {
                // Already indexing, ignore
            }
            Ok(IndexerCommand::Shutdown) => {
                tracing::info!("Indexer: received shutdown during drain, will exit after batch");
            }
            Err(_) => break,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Mock embedder that returns a fixed vector based on text length.
    struct MockEmbedder;

    impl Embedder for MockEmbedder {
        fn model_id(&self) -> &str {
            "mock-model-v1"
        }
        fn dims(&self) -> usize {
            4
        }
        fn query_prefix(&self) -> &str {
            "query: "
        }
        fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
            let len = text.len() as f32;
            Ok(vec![len / 1000.0, 0.5, 0.3, 0.1])
        }
    }

    fn setup_test_env() -> (TempDir, PathBuf, Connection) {
        db::register_sqlite_vec();
        let tmp = TempDir::new().unwrap();
        let db_path = tmp.path().join("test.db");
        let notes_dir = tmp.path().join("notes");
        std::fs::create_dir_all(&notes_dir).unwrap();

        let conn = Connection::open(&db_path).unwrap();
        db::init_schema(&conn).unwrap();
        db::init_search_schema(&conn).unwrap();
        (tmp, db_path, conn)
    }

    #[test]
    fn test_setup_model_creates_vec_table() {
        let (_tmp, _db_path, conn) = setup_test_env();
        let emb = MockEmbedder;
        setup_model(&conn, &emb).unwrap();

        // Should be able to insert into vec table
        conn.execute(
            "INSERT INTO note_chunks (chunk_id, filename, chunk_text) VALUES (1, 'a.md', 'hi')",
            [],
        )
        .unwrap();
        let v = [0.1f32, 0.2, 0.3, 0.4];
        conn.execute(
            "INSERT INTO note_chunks_vec (chunk_id, embedding) VALUES (?1, ?2)",
            rusqlite::params![1_i64, zerocopy::IntoBytes::as_bytes(&v[..])],
        )
        .unwrap();

        assert_eq!(
            db::get_search_config(&conn, "model_id").unwrap(),
            Some("mock-model-v1".to_string())
        );
        assert_eq!(
            db::get_search_config(&conn, "dims").unwrap(),
            Some("4".to_string())
        );
    }

    #[test]
    fn test_setup_model_change_clears_index() {
        let (_tmp, _db_path, conn) = setup_test_env();

        let emb = MockEmbedder;
        setup_model(&conn, &emb).unwrap();

        db::mark_indexed(&conn, "test.md", "hash1").unwrap();
        let chunks = vec![("hello".to_string(), 0, 5, vec![0.1f32, 0.2, 0.3, 0.4])];
        db::replace_chunks_for_filename(&conn, "test.md", &chunks).unwrap();

        struct MockV2;
        impl Embedder for MockV2 {
            fn model_id(&self) -> &str {
                "mock-model-v2"
            }
            fn dims(&self) -> usize {
                4
            }
            fn query_prefix(&self) -> &str {
                ""
            }
            fn embed(&self, _text: &str) -> Result<Vec<f32>, String> {
                Ok(vec![0.0; 4])
            }
        }

        setup_model(&conn, &MockV2).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM index_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_setup_model_rebuilds_when_vectors_are_missing() {
        let (_tmp, _db_path, conn) = setup_test_env();

        let emb = MockEmbedder;
        setup_model(&conn, &emb).unwrap();

        conn.execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at) VALUES ('test.md', 'hash1', 100)",
            [],
        )
        .unwrap();
        db::mark_indexed(&conn, "test.md", "hash1").unwrap();
        let chunks = vec![("hello".to_string(), 0, 5, vec![0.1f32, 0.2, 0.3, 0.4])];
        db::replace_chunks_for_filename(&conn, "test.md", &chunks).unwrap();

        conn.execute("DELETE FROM note_chunks_vec", []).unwrap();

        setup_model(&conn, &emb).unwrap();

        let (dirty, _orphaned) = db::get_dirty_filenames(&conn).unwrap();
        assert_eq!(dirty, vec!["test.md".to_string()]);
    }

    #[tokio::test]
    async fn test_indexer_indexes_dirty_notes() {
        let (tmp, db_path, conn) = setup_test_env();
        let notes_dir = tmp.path().join("notes");

        std::fs::write(notes_dir.join("test.md"), "Hello world this is a test note").unwrap();
        conn.execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at) \
             VALUES ('test.md', 'abc123', 100)",
            [],
        )
        .unwrap();
        drop(conn);

        let status = Arc::new(RwLock::new(IndexerStatus::default()));
        let config = IndexerConfig {
            db_path: db_path.clone(),
            notes_dir,
            status: status.clone(),
        };

        let tx = spawn_indexer(config, Some(Box::new(MockEmbedder)));

        tx.send(IndexerCommand::Reindex).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let conn = Connection::open(&db_path).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_chunks WHERE filename = 'test.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            count >= 1,
            "should have indexed at least 1 chunk, got {count}"
        );

        let indexed: i64 = conn
            .query_row("SELECT COUNT(*) FROM index_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(indexed, 1);

        let s = status.read().unwrap();
        assert_eq!(s.phase, IndexerPhase::Idle);
        assert!(s.model_ready);
        drop(s);

        tx.send(IndexerCommand::Shutdown).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    #[tokio::test]
    async fn test_indexer_runs_initial_pass_on_startup() {
        let (tmp, db_path, conn) = setup_test_env();
        let notes_dir = tmp.path().join("notes");

        std::fs::write(notes_dir.join("boot.md"), "Index me during startup").unwrap();
        conn.execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at) \
             VALUES ('boot.md', 'hash-startup', 100)",
            [],
        )
        .unwrap();
        drop(conn);

        let status = Arc::new(RwLock::new(IndexerStatus::default()));
        let config = IndexerConfig {
            db_path: db_path.clone(),
            notes_dir,
            status: status.clone(),
        };

        let tx = spawn_indexer(config, Some(Box::new(MockEmbedder)));

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let conn = Connection::open(&db_path).unwrap();
        let indexed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM index_state WHERE filename = 'boot.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1, "startup pass should index dirty notes");

        let s = status.read().unwrap();
        assert_eq!(s.phase, IndexerPhase::Idle);
        assert!(s.model_ready);
        drop(s);

        tx.send(IndexerCommand::Shutdown).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    #[tokio::test]
    async fn test_embed_query_returns_vector() {
        let (_tmp, db_path, _conn) = setup_test_env();
        let notes_dir = _tmp.path().join("notes");

        let status = Arc::new(RwLock::new(IndexerStatus::default()));
        let config = IndexerConfig {
            db_path,
            notes_dir,
            status: status.clone(),
        };

        let tx = spawn_indexer(config, Some(Box::new(MockEmbedder)));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(IndexerCommand::EmbedQuery {
            text: "test query".to_string(),
            reply: reply_tx,
        })
        .await
        .unwrap();

        let result = reply_rx.await.unwrap().unwrap();
        assert_eq!(result.len(), 4);

        tx.send(IndexerCommand::Shutdown).await.unwrap();
    }

    #[tokio::test]
    async fn test_indexer_disabled_without_model() {
        let (_tmp, db_path, _conn) = setup_test_env();
        let notes_dir = _tmp.path().join("notes");

        let status = Arc::new(RwLock::new(IndexerStatus::default()));
        let config = IndexerConfig {
            db_path,
            notes_dir,
            status: status.clone(),
        };

        let tx = spawn_indexer(config, None);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let s = status.read().unwrap();
        assert_eq!(s.phase, IndexerPhase::Disabled);
        assert!(!s.model_ready);
        drop(s);

        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(IndexerCommand::EmbedQuery {
            text: "test".to_string(),
            reply: reply_tx,
        })
        .await
        .unwrap();

        let result = reply_rx.await.unwrap();
        assert!(result.is_err());

        tx.send(IndexerCommand::Shutdown).await.unwrap();
    }
}
