use rusqlite::{params, Connection};
use zerocopy::IntoBytes;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS auth (
    id            INTEGER PRIMARY KEY CHECK(id = 1),
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    device_info TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS note_meta (
    filename     TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    modified_at  INTEGER NOT NULL,
    is_blob      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tombstones (
    filename   TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_snapshots (
    device_id TEXT NOT NULL,
    filename  TEXT NOT NULL,
    hash      TEXT NOT NULL,
    PRIMARY KEY (device_id, filename)
);

CREATE TABLE IF NOT EXISTS sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_store (
    hash    TEXT PRIMARY KEY,
    content TEXT NOT NULL
);
";

const SEARCH_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS note_chunks (
    chunk_id     INTEGER PRIMARY KEY,
    filename     TEXT NOT NULL,
    chunk_text   TEXT NOT NULL,
    start_offset INTEGER NOT NULL DEFAULT 0,
    end_offset   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS index_state (
    filename     TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    indexed_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS search_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

const SEARCH_FTS: &str = "
CREATE VIRTUAL TABLE IF NOT EXISTS note_chunks_fts USING fts5(
    filename, chunk_text,
    content='note_chunks', content_rowid='chunk_id'
);
";

const SEED: &str = "INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('sync_version', '0');";

/// Register sqlite-vec as an auto-extension. Must be called once before opening any connection.
pub fn register_sqlite_vec() {
    type SqliteVecInit = unsafe extern "C" fn(
        *mut rusqlite::ffi::sqlite3,
        *mut *mut i8,
        *const rusqlite::ffi::sqlite3_api_routines,
    ) -> i32;

    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(
            std::mem::transmute::<*const (), SqliteVecInit>(
                sqlite_vec::sqlite3_vec_init as *const (),
            ),
        ));
    }
}

/// Initialize the database schema. Safe to call multiple times (uses IF NOT EXISTS).
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    conn.execute_batch(SEED)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// Initialize search-related tables (note_chunks, index_state, search_config, FTS5).
/// Call after `init_schema` and after sqlite-vec is registered.
pub fn init_search_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SEARCH_SCHEMA)?;
    conn.execute_batch(SEARCH_FTS)?;
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;

    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }

    Ok(false)
}

#[cfg(test)]
fn table_row_count(conn: &Connection, table: &str) -> rusqlite::Result<i64> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
}

fn create_canonical_tombstones_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE tombstones (
            filename   TEXT PRIMARY KEY,
            deleted_at INTEGER NOT NULL
        );",
    )
}

fn migrate_legacy_schema(conn: &Connection) -> rusqlite::Result<()> {
    if table_exists(conn, "tombstones")?
        && table_has_column(conn, "tombstones", "uuid")?
        && !table_has_column(conn, "tombstones", "filename")?
    {
        conn.execute_batch(
            "DROP TABLE IF EXISTS tombstones_legacy;
             ALTER TABLE tombstones RENAME TO tombstones_legacy;",
        )?;
        create_canonical_tombstones_table(conn)?;
    }

    if !table_exists(conn, "tombstones")? {
        create_canonical_tombstones_table(conn)?;
    }

    if table_exists(conn, "tombstones_v2")? && table_has_column(conn, "tombstones_v2", "filename")?
    {
        conn.execute(
            "INSERT OR IGNORE INTO tombstones (filename, deleted_at)
             SELECT filename, deleted_at FROM tombstones_v2",
            [],
        )?;
    }

    if table_exists(conn, "note_meta_v2")? && table_has_column(conn, "note_meta_v2", "filename")? {
        conn.execute(
            "INSERT OR IGNORE INTO note_meta (filename, content_hash, modified_at, is_blob)
             SELECT filename, content_hash, modified_at, is_blob FROM note_meta_v2",
            [],
        )?;
    }

    if table_exists(conn, "notes")? && table_has_column(conn, "notes", "filename")? {
        if table_has_column(conn, "notes", "is_blob")? {
            conn.execute(
                "INSERT OR IGNORE INTO note_meta (filename, content_hash, modified_at, is_blob)
                 SELECT filename, content_hash, modified_at, is_blob FROM notes",
                [],
            )?;
        } else {
            conn.execute(
                "INSERT OR IGNORE INTO note_meta (filename, content_hash, modified_at, is_blob)
                 SELECT filename, content_hash, modified_at, 0 FROM notes",
                [],
            )?;
        }
    }

    Ok(())
}

/// Open a file-backed database, creating it if needed, and initialize all schemas.
pub fn open_db(path: &std::path::Path) -> rusqlite::Result<Connection> {
    register_sqlite_vec();
    let conn = Connection::open(path)?;
    init_schema(&conn)?;
    migrate_legacy_schema(&conn)?;
    init_search_schema(&conn)?;
    Ok(conn)
}

/// Open an in-memory database for testing.
pub fn open_memory_db() -> rusqlite::Result<Connection> {
    register_sqlite_vec();
    let conn = Connection::open_in_memory()?;
    init_schema(&conn)?;
    init_search_schema(&conn)?;
    Ok(conn)
}

// ── Query helpers ──────────────────────────────────────────────────────

pub fn is_setup_complete(conn: &Connection) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM auth", [], |row| row.get(0))?;
    Ok(count > 0)
}

pub fn insert_initial_password_hash(
    conn: &Connection,
    password_hash: &str,
) -> rusqlite::Result<bool> {
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO auth (id, password_hash) VALUES (1, ?1)",
        [password_hash],
    )?;
    Ok(inserted > 0)
}

pub fn get_sync_version(conn: &Connection) -> rusqlite::Result<u64> {
    let val: String = conn.query_row(
        "SELECT value FROM sync_meta WHERE key = 'sync_version'",
        [],
        |row| row.get(0),
    )?;
    Ok(val.parse::<u64>().unwrap_or(0))
}

/// Store content by hash (idempotent — ignores if hash already exists).
pub fn store_content(conn: &Connection, hash: &str, content: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO content_store (hash, content) VALUES (?1, ?2)",
        rusqlite::params![hash, content],
    )?;
    Ok(())
}

/// Look up content by hash. Returns None if not found.
pub fn get_content(conn: &Connection, hash: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT content FROM content_store WHERE hash = ?1")?;
    let mut rows = stmt.query(rusqlite::params![hash])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub fn increment_sync_version(conn: &Connection) -> rusqlite::Result<u64> {
    let current = get_sync_version(conn)?;
    let next = current + 1;
    conn.execute(
        "UPDATE sync_meta SET value = ?1 WHERE key = 'sync_version'",
        [next.to_string()],
    )?;
    Ok(next)
}

// ── Search helpers ─────────────────────────────────────────────────────

/// Create the vec0 virtual table with the given embedding dimensions.
/// Drops and recreates if it already exists (for model change).
pub fn create_vec_table(conn: &Connection, dims: usize) -> rusqlite::Result<()> {
    conn.execute_batch("DROP TABLE IF EXISTS note_chunks_vec;")?;
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE note_chunks_vec USING vec0(\
         chunk_id INTEGER PRIMARY KEY, \
         embedding float[{dims}] distance_metric=cosine\
         );"
    ))?;
    Ok(())
}

/// Wipe all search index data (for model change reindex).
pub fn clear_all_index_data(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM note_chunks;
         DELETE FROM note_chunks_fts;
         DELETE FROM index_state;",
    )?;
    // vec0 table may or may not exist
    let _ = conn.execute_batch("DELETE FROM note_chunks_vec;");
    Ok(())
}

pub fn search_index_counts(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    let notes_total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM note_meta WHERE is_blob = 0",
        [],
        |row| row.get(0),
    )?;
    let notes_indexed: i64 =
        conn.query_row("SELECT COUNT(*) FROM index_state", [], |row| row.get(0))?;
    Ok((notes_total as usize, notes_indexed as usize))
}

pub fn search_index_storage_counts(conn: &Connection) -> rusqlite::Result<(i64, i64, i64)> {
    let note_chunks: i64 =
        conn.query_row("SELECT COUNT(*) FROM note_chunks", [], |row| row.get(0))?;
    let index_state: i64 =
        conn.query_row("SELECT COUNT(*) FROM index_state", [], |row| row.get(0))?;
    let vec_rows: i64 = if table_exists(conn, "note_chunks_vec")? {
        conn.query_row("SELECT COUNT(*) FROM note_chunks_vec", [], |row| row.get(0))?
    } else {
        0
    };
    Ok((note_chunks, index_state, vec_rows))
}

/// Get filenames that need (re-)indexing.
///
/// Returns three lists:
/// - dirty: files whose content hash changed or are new
/// - orphaned: files in index_state but no longer in note_meta
pub fn get_dirty_filenames(conn: &Connection) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
    // New or changed: in note_meta but missing/mismatched in index_state, .md only
    let mut dirty_stmt = conn.prepare(
        "SELECT nm.filename FROM note_meta nm
         LEFT JOIN index_state idx ON nm.filename = idx.filename
         WHERE nm.is_blob = 0
           AND (idx.filename IS NULL OR idx.content_hash != nm.content_hash)",
    )?;
    let dirty: Vec<String> = dirty_stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // Orphaned: in index_state but not in note_meta
    let mut orphan_stmt = conn.prepare(
        "SELECT idx.filename FROM index_state idx
         LEFT JOIN note_meta nm ON idx.filename = nm.filename
         WHERE nm.filename IS NULL",
    )?;
    let orphaned: Vec<String> = orphan_stmt
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok((dirty, orphaned))
}

/// Atomically replace all chunks for a filename across note_chunks, FTS5, and vec0.
///
/// Each chunk is `(text, start_offset, end_offset, embedding)`.
pub fn replace_chunks_for_filename(
    conn: &Connection,
    filename: &str,
    chunks: &[(String, usize, usize, Vec<f32>)],
) -> rusqlite::Result<()> {
    // Delete old data
    let old_ids: Vec<i64> = conn
        .prepare("SELECT chunk_id FROM note_chunks WHERE filename = ?1")?
        .query_map(params![filename], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    for id in &old_ids {
        conn.execute(
            "INSERT INTO note_chunks_fts(note_chunks_fts, rowid, filename, chunk_text) \
             VALUES('delete', ?1, ?2, \
             (SELECT chunk_text FROM note_chunks WHERE chunk_id = ?1))",
            params![id, filename],
        )?;
    }
    conn.execute(
        "DELETE FROM note_chunks WHERE filename = ?1",
        params![filename],
    )?;
    for id in &old_ids {
        let _ = conn.execute(
            "DELETE FROM note_chunks_vec WHERE chunk_id = ?1",
            params![id],
        );
    }

    // Insert new chunks
    for (text, start, end, embedding) in chunks {
        conn.execute(
            "INSERT INTO note_chunks (filename, chunk_text, start_offset, end_offset) \
             VALUES (?1, ?2, ?3, ?4)",
            params![filename, text, *start as i64, *end as i64],
        )?;
        let chunk_id = conn.last_insert_rowid();

        conn.execute(
            "INSERT INTO note_chunks_fts(rowid, filename, chunk_text) VALUES (?1, ?2, ?3)",
            params![chunk_id, filename, text],
        )?;

        let emb_bytes = embedding.as_bytes();
        conn.execute(
            "INSERT INTO note_chunks_vec (chunk_id, embedding) VALUES (?1, ?2)",
            params![chunk_id, emb_bytes],
        )?;
    }

    Ok(())
}

/// Mark a filename as indexed with the given content hash.
pub fn mark_indexed(conn: &Connection, filename: &str, content_hash: &str) -> rusqlite::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO index_state (filename, content_hash, indexed_at) \
         VALUES (?1, ?2, ?3)",
        params![filename, content_hash, now],
    )?;
    Ok(())
}

/// Remove index data for a filename (when note is deleted).
pub fn remove_index_for_filename(conn: &Connection, filename: &str) -> rusqlite::Result<()> {
    replace_chunks_for_filename(conn, filename, &[])?;
    conn.execute(
        "DELETE FROM index_state WHERE filename = ?1",
        params![filename],
    )?;
    Ok(())
}

/// BM25 keyword search via FTS5. Returns (chunk_id, filename, chunk_text, bm25_score).
pub fn bm25_search(
    conn: &Connection,
    query: &str,
    limit: usize,
) -> rusqlite::Result<Vec<(i64, String, String, f64)>> {
    let Some(query) = normalize_fts_query(query) else {
        return Ok(vec![]);
    };
    let mut stmt = conn.prepare(
        "SELECT c.chunk_id, c.filename, c.chunk_text, fts.rank
         FROM note_chunks_fts fts
         JOIN note_chunks c ON c.chunk_id = fts.rowid
         WHERE note_chunks_fts MATCH ?1
         ORDER BY fts.rank
         LIMIT ?2",
    )?;
    let results = stmt
        .query_map(params![query, limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, f64>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(results)
}

fn normalize_fts_query(query: &str) -> Option<String> {
    let mut terms = Vec::new();
    let mut current = String::new();

    for ch in query.chars() {
        if ch.is_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            terms.push(std::mem::take(&mut current));
        }
    }

    if !current.is_empty() {
        terms.push(current);
    }

    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

/// Vector similarity search via sqlite-vec. Returns (chunk_id, filename, chunk_text, distance).
pub fn vector_search(
    conn: &Connection,
    query_embedding: &[f32],
    limit: usize,
) -> rusqlite::Result<Vec<(i64, String, String, f64)>> {
    let emb_bytes = query_embedding.as_bytes();
    let mut stmt = conn.prepare(
        "SELECT v.chunk_id, c.filename, c.chunk_text, v.distance
         FROM note_chunks_vec v
         JOIN note_chunks c ON c.chunk_id = v.chunk_id
         WHERE v.embedding MATCH ?1 AND k = ?2
         ORDER BY v.distance",
    )?;
    let results = stmt
        .query_map(params![emb_bytes, limit as i64], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, f64>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(results)
}

/// Get a search config value.
pub fn get_search_config(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM search_config WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

/// Set a search config value.
pub fn set_search_config(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    if table_has_column(conn, "search_config", "updated_at")? {
        conn.execute(
            "INSERT INTO search_config (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
               value = excluded.value,
               updated_at = excluded.updated_at",
            params![key, value, stonefruit_core::files::now_ms()],
        )?;
    } else {
        conn.execute(
            "INSERT INTO search_config (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn schema_initializes() {
        let conn = open_memory_db().unwrap();
        assert!(!is_setup_complete(&conn).unwrap());
        assert_eq!(get_sync_version(&conn).unwrap(), 0);
    }

    #[test]
    fn sync_version_increments() {
        let conn = open_memory_db().unwrap();
        assert_eq!(increment_sync_version(&conn).unwrap(), 1);
        assert_eq!(increment_sync_version(&conn).unwrap(), 2);
        assert_eq!(get_sync_version(&conn).unwrap(), 2);
    }

    #[test]
    fn schema_is_idempotent() {
        let conn = open_memory_db().unwrap();
        // Running init_schema again should not fail
        init_schema(&conn).unwrap();
        assert_eq!(get_sync_version(&conn).unwrap(), 0);
    }

    #[test]
    fn tables_exist() {
        let conn = open_memory_db().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.contains(&"auth".to_string()));
        assert!(tables.contains(&"sessions".to_string()));
        assert!(tables.contains(&"note_meta".to_string()));
        assert!(tables.contains(&"tombstones".to_string()));
        assert!(tables.contains(&"device_snapshots".to_string()));
        assert!(tables.contains(&"sync_meta".to_string()));
        assert!(tables.contains(&"content_store".to_string()));
    }

    #[test]
    fn search_tables_exist() {
        let conn = open_memory_db().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(tables.contains(&"note_chunks".to_string()));
        assert!(tables.contains(&"index_state".to_string()));
        assert!(tables.contains(&"search_config".to_string()));
    }

    #[test]
    fn open_db_migrates_legacy_v1_tables() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("legacy.db");

        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                "
                CREATE TABLE notes (
                    uuid TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    modified_at INTEGER NOT NULL,
                    is_blob INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE tombstones (
                    uuid TEXT PRIMARY KEY,
                    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE note_meta (
                    filename     TEXT PRIMARY KEY,
                    content_hash TEXT NOT NULL,
                    modified_at  INTEGER NOT NULL,
                    is_blob      INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE tombstones_v2 (
                    filename TEXT PRIMARY KEY,
                    deleted_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE sync_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT INTO sync_meta (key, value) VALUES ('sync_version', '0');
                INSERT INTO notes (uuid, filename, content_hash, modified_at, is_blob)
                    VALUES ('note-1', 'legacy.md', 'abc123', 42, 0);
                INSERT INTO tombstones_v2 (filename, deleted_at)
                    VALUES ('deleted.md', '2026-03-30 12:00:00');
                ",
            )
            .unwrap();
        drop(legacy);

        let conn = open_db(&path).unwrap();

        let note_meta_count = table_row_count(&conn, "note_meta").unwrap();
        assert_eq!(note_meta_count, 1);

        let filename: String = conn
            .query_row("SELECT filename FROM note_meta LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(filename, "legacy.md");

        assert!(table_exists(&conn, "tombstones_legacy").unwrap());
        assert!(table_has_column(&conn, "tombstones", "filename").unwrap());
        assert!(!table_has_column(&conn, "tombstones", "uuid").unwrap());

        let tombstone_filename: String = conn
            .query_row("SELECT filename FROM tombstones LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(tombstone_filename, "deleted.md");
    }

    #[test]
    fn open_db_migrates_legacy_notes_without_is_blob_column() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("legacy-no-is-blob.db");

        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch(
                "
                CREATE TABLE notes (
                    uuid TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    modified_at INTEGER NOT NULL
                );
                CREATE TABLE sync_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT INTO sync_meta (key, value) VALUES ('sync_version', '0');
                INSERT INTO notes (uuid, filename, content_hash, modified_at)
                    VALUES ('note-1', 'legacy.md', 'abc123', 42);
                ",
            )
            .unwrap();
        drop(legacy);

        let conn = open_db(&path).unwrap();

        let row: (String, String, i64, i64) = conn
            .query_row(
                "SELECT filename, content_hash, modified_at, is_blob FROM note_meta LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();

        assert_eq!(row.0, "legacy.md");
        assert_eq!(row.1, "abc123");
        assert_eq!(row.2, 42);
        assert_eq!(row.3, 0);
    }

    #[test]
    fn vec_table_create_and_roundtrip() {
        let conn = open_memory_db().unwrap();
        create_vec_table(&conn, 4).unwrap();

        // Insert a chunk + vector
        conn.execute(
            "INSERT INTO note_chunks (chunk_id, filename, chunk_text) VALUES (1, 'test.md', 'hello')",
            [],
        )
        .unwrap();
        let emb: Vec<f32> = vec![0.1, 0.2, 0.3, 0.4];
        conn.execute(
            "INSERT INTO note_chunks_vec (chunk_id, embedding) VALUES (?1, ?2)",
            params![1_i64, emb.as_bytes()],
        )
        .unwrap();

        // Query
        let query: Vec<f32> = vec![0.1, 0.2, 0.3, 0.4];
        let results = vector_search(&conn, &query, 5).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].1, "test.md");
        assert!(
            results[0].3 < 0.01,
            "distance should be ~0 for identical vector"
        );
    }

    #[test]
    fn replace_chunks_atomic() {
        let conn = open_memory_db().unwrap();
        create_vec_table(&conn, 2).unwrap();

        let chunks = vec![
            ("chunk one".to_string(), 0, 9, vec![1.0f32, 0.0]),
            ("chunk two".to_string(), 10, 19, vec![0.0f32, 1.0]),
        ];
        replace_chunks_for_filename(&conn, "note.md", &chunks).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_chunks WHERE filename = 'note.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);

        // Replace with one chunk
        let chunks2 = vec![("replaced".to_string(), 0, 8, vec![0.5f32, 0.5])];
        replace_chunks_for_filename(&conn, "note.md", &chunks2).unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_chunks WHERE filename = 'note.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);

        let text: String = conn
            .query_row(
                "SELECT chunk_text FROM note_chunks WHERE filename = 'note.md'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(text, "replaced");
    }

    #[test]
    fn bm25_search_basic() {
        let conn = open_memory_db().unwrap();
        create_vec_table(&conn, 2).unwrap();

        let chunks = vec![
            (
                "meeting notes for monday".to_string(),
                0,
                24,
                vec![1.0f32, 0.0],
            ),
            (
                "grocery shopping list".to_string(),
                25,
                46,
                vec![0.0f32, 1.0],
            ),
        ];
        replace_chunks_for_filename(&conn, "work.md", &chunks).unwrap();

        let results = bm25_search(&conn, "meeting", 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].1, "work.md");
        assert!(results[0].2.contains("meeting"));
    }

    #[test]
    fn bm25_search_ignores_punctuation_only_queries() {
        let conn = open_memory_db().unwrap();
        create_vec_table(&conn, 2).unwrap();

        let results = bm25_search(&conn, "\"", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn bm25_search_sanitizes_punctuation_without_error() {
        let conn = open_memory_db().unwrap();
        create_vec_table(&conn, 2).unwrap();

        let chunks = vec![
            (
                "notes about c plus plus".to_string(),
                0,
                23,
                vec![1.0f32, 0.0],
            ),
            ("foo bar baz".to_string(), 24, 35, vec![0.0f32, 1.0]),
        ];
        replace_chunks_for_filename(&conn, "work.md", &chunks).unwrap();

        assert!(bm25_search(&conn, "C++", 10).is_ok());
        assert!(bm25_search(&conn, "foo-bar", 10).is_ok());
    }

    #[test]
    fn dirty_filenames_detection() {
        let conn = open_memory_db().unwrap();

        // Add a note to note_meta
        conn.execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at) VALUES ('a.md', 'hash1', 100)",
            [],
        )
        .unwrap();

        // Not yet indexed — should be dirty
        let (dirty, orphaned) = get_dirty_filenames(&conn).unwrap();
        assert_eq!(dirty, vec!["a.md"]);
        assert!(orphaned.is_empty());

        // Mark as indexed
        mark_indexed(&conn, "a.md", "hash1").unwrap();
        let (dirty, orphaned) = get_dirty_filenames(&conn).unwrap();
        assert!(dirty.is_empty());
        assert!(orphaned.is_empty());

        // Change the hash — should be dirty again
        conn.execute(
            "UPDATE note_meta SET content_hash = 'hash2' WHERE filename = 'a.md'",
            [],
        )
        .unwrap();
        let (dirty, _) = get_dirty_filenames(&conn).unwrap();
        assert_eq!(dirty, vec!["a.md"]);

        // Delete from note_meta — index_state becomes orphaned
        conn.execute("DELETE FROM note_meta WHERE filename = 'a.md'", [])
            .unwrap();
        let (dirty, orphaned) = get_dirty_filenames(&conn).unwrap();
        assert!(dirty.is_empty());
        assert_eq!(orphaned, vec!["a.md"]);
    }

    #[test]
    fn search_config_roundtrip() {
        let conn = open_memory_db().unwrap();
        assert_eq!(get_search_config(&conn, "model_id").unwrap(), None);
        set_search_config(&conn, "model_id", "qwen3-0.6b").unwrap();
        assert_eq!(
            get_search_config(&conn, "model_id").unwrap(),
            Some("qwen3-0.6b".to_string())
        );
        // Overwrite
        set_search_config(&conn, "model_id", "new-model").unwrap();
        assert_eq!(
            get_search_config(&conn, "model_id").unwrap(),
            Some("new-model".to_string())
        );
    }

    #[test]
    fn search_config_roundtrip_with_updated_at_column() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE search_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ",
        )
        .unwrap();

        set_search_config(&conn, "model_id", "qwen3-0.6b").unwrap();
        assert_eq!(
            get_search_config(&conn, "model_id").unwrap(),
            Some("qwen3-0.6b".to_string())
        );

        let first_updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM search_config WHERE key = 'model_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(first_updated_at > 0);

        set_search_config(&conn, "model_id", "new-model").unwrap();
        assert_eq!(
            get_search_config(&conn, "model_id").unwrap(),
            Some("new-model".to_string())
        );

        let second_updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM search_config WHERE key = 'model_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(second_updated_at >= first_updated_at);
    }

    #[test]
    fn clear_all_index_data_works() {
        let conn = open_memory_db().unwrap();
        create_vec_table(&conn, 2).unwrap();

        let chunks = vec![("test".to_string(), 0, 4, vec![1.0f32, 0.0])];
        replace_chunks_for_filename(&conn, "a.md", &chunks).unwrap();
        mark_indexed(&conn, "a.md", "hash1").unwrap();

        clear_all_index_data(&conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM index_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn content_store_roundtrip() {
        let conn = open_memory_db().unwrap();
        assert_eq!(get_content(&conn, "hash1").unwrap(), None);

        store_content(&conn, "hash1", "hello world").unwrap();
        assert_eq!(
            get_content(&conn, "hash1").unwrap(),
            Some("hello world".to_string())
        );

        // Idempotent — second insert ignored
        store_content(&conn, "hash1", "different content").unwrap();
        assert_eq!(
            get_content(&conn, "hash1").unwrap(),
            Some("hello world".to_string())
        );
    }
}
