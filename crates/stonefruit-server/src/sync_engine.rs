use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use stonefruit_core::files;
use stonefruit_core::hash::hash_sha256;
use stonefruit_core::invariants::{self, NoteRecord};
use stonefruit_core::sync::{self, ConflictNote, SyncRequest, SyncResponse, UpdateNote};

use crate::db;
use crate::error::AppError;

// ── DB row types ───────────────────────────────────────────────────────

struct NoteMetaRow {
    filename: String,
    content_hash: String,
    modified_at: i64,
    is_blob: bool,
}

struct ProcessedNote {
    filename: String,
    modified_at: i64,
    is_blob: bool,
}

// ── Sync engine ────────────────────────────────────────────────────────

/// Process a V2 sync request. Runs inside a single SQLite transaction.
///
/// The caller is responsible for wrapping this in `spawn_blocking`.
pub fn process_sync(
    conn: &Connection,
    notes_dir: &Path,
    req: &SyncRequest,
) -> Result<SyncResponse, AppError> {
    let mut response = SyncResponse {
        update: Vec::new(),
        delete: Vec::new(),
        conflicts: Vec::new(),
        version: 0,
        timestamps: HashMap::new(),
    };

    // Track filenames already queued in response.update to avoid O(n²) linear scans
    let mut update_set: HashSet<String> = HashSet::new();

    let mut mutated = false;

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::internal(e.to_string()))?;

    // Load all server state into memory
    let mut note_meta: HashMap<String, NoteMetaRow> = load_note_meta(&tx)?;
    let mut tombstones: HashSet<String> = load_tombstones(&tx)?;
    let device_snapshots: HashMap<String, String> = load_device_snapshots(&tx, &req.device_id)?;

    // Pre-pass: capture hashes of files being deleted (for rename detection)
    let mut deleted_file_hashes: HashMap<String, String> = HashMap::new();
    for deleted in &req.deleted {
        if let Some(h) = device_snapshots.get(deleted) {
            deleted_file_hashes.insert(deleted.clone(), h.clone());
        } else if let Some(meta) = note_meta.get(deleted) {
            deleted_file_hashes.insert(deleted.clone(), meta.content_hash.clone());
        }
    }

    // Build a set of all filenames the client knows about
    let client_inventory: HashSet<String> =
        req.inventory.iter().map(|i| i.filename.clone()).collect();

    // Also build a lookup from inventory filename -> hash
    let client_inventory_hashes: HashMap<String, String> = req
        .inventory
        .iter()
        .map(|i| (i.filename.clone(), i.hash.clone()))
        .collect();

    // Track all filenames currently in note_meta for collision detection
    let mut active_filenames: HashSet<String> = note_meta.keys().cloned().collect();

    // Pre-build set of changed filenames for O(1) lookups in section 5
    let changed_filenames: HashSet<String> =
        req.changed.iter().map(|c| c.filename.clone()).collect();

    // ── 1. Process client deletions ────────────────────────────────

    for filename in &req.deleted {
        if let Some(server_note) = note_meta.get(filename) {
            let device_last_hash = device_snapshots
                .get(filename)
                .map(|s| s.as_str())
                .unwrap_or("");
            if server_note.content_hash == device_last_hash {
                // Server unchanged since device last saw — accept deletion
                delete_note_file(notes_dir, filename);
                delete_note_meta(&tx, filename)?;
                create_tombstone(&tx, filename)?;
                tombstones.insert(filename.clone());
                active_filenames.remove(filename);
                mutated = true;
            } else {
                // Server changed — delete-vs-edit conflict: keep server version
                let content = read_note_file(notes_dir, filename);
                if let Some(content) = content {
                    update_set.insert(filename.clone());
                    response.update.push(UpdateNote {
                        filename: filename.clone(),
                        content,
                        hash: server_note.content_hash.clone(),
                        modified_at: server_note.modified_at,
                    });
                }
            }
        } else if !tombstones.contains(filename) {
            // Not in note_meta, ensure tombstone exists (idempotent)
            create_tombstone(&tx, filename)?;
            tombstones.insert(filename.clone());
            mutated = true;
        }
    }
    // Remove deleted notes from the in-memory map
    for filename in &req.deleted {
        note_meta.remove(filename);
    }

    // ── 1b. Un-tombstone files being re-uploaded as new ─────────────
    // Must run before section 2 so tombstone propagation skips these.

    for new_note in &req.new {
        if tombstones.remove(&new_note.filename) {
            remove_tombstone(&tx, &new_note.filename)?;
        }
    }

    // ── 2. Propagate server deletions ──────────────────────────────

    for tombstoned in &tombstones {
        if client_inventory.contains(tombstoned) {
            response.delete.push(tombstoned.clone());
        }
    }

    // ── 3. Process client changes ──────────────────────────────────

    for changed in &req.changed {
        // Skip if we just deleted or tombstoned this
        if tombstones.contains(&changed.filename) {
            continue;
        }

        if let Some(server_note) = note_meta.get(&changed.filename) {
            let device_last_hash = device_snapshots
                .get(&changed.filename)
                .map(|s| s.as_str())
                .unwrap_or("");

            let direction = sync::determine_sync_direction(
                &changed.hash,
                &server_note.content_hash,
                device_last_hash,
            );

            match direction {
                sync::SyncDirection::ClientChanged => {
                    maybe_store_ancestor_content(
                        &tx,
                        notes_dir,
                        &changed.filename,
                        device_last_hash,
                        server_note.is_blob,
                    );

                    // Accept client version
                    write_note_file(notes_dir, &changed.filename, &changed.content);
                    let mtime = files::mtime_or_now(changed.modified_at);
                    upsert_note_meta(&tx, &changed.filename, &changed.hash, mtime, false)?;
                    // Keep in-memory note_meta in sync so device_snapshots
                    // record the correct hash at end-of-sync
                    note_meta.insert(
                        changed.filename.clone(),
                        NoteMetaRow {
                            filename: changed.filename.clone(),
                            content_hash: changed.hash.clone(),
                            modified_at: mtime,
                            is_blob: false,
                        },
                    );
                    mutated = true;
                }
                sync::SyncDirection::ServerChanged => {
                    // Send server version to client
                    let content = read_note_file(notes_dir, &changed.filename);
                    if let Some(content) = content {
                        update_set.insert(changed.filename.clone());
                        response.update.push(UpdateNote {
                            filename: changed.filename.clone(),
                            content,
                            hash: server_note.content_hash.clone(),
                            modified_at: server_note.modified_at,
                        });
                    }
                }
                sync::SyncDirection::BothChanged => {
                    if sync::check_convergence(&changed.hash, &server_note.content_hash) {
                        // Both sides converged to the same content — no action needed
                    } else if !server_note.is_blob {
                        // Attempt three-way merge for text files
                        if let Some(merged) = attempt_three_way_merge(
                            conn,
                            notes_dir,
                            &changed.filename,
                            device_last_hash,
                            &changed.content,
                        ) {
                            // Clean merge — write merged content to disk
                            let merged_hash = hash_sha256(&merged);
                            let mtime = files::now_ms();
                            write_note_file(notes_dir, &changed.filename, &merged);
                            upsert_note_meta(&tx, &changed.filename, &merged_hash, mtime, false)?;
                            note_meta.insert(
                                changed.filename.clone(),
                                NoteMetaRow {
                                    filename: changed.filename.clone(),
                                    content_hash: merged_hash.clone(),
                                    modified_at: mtime,
                                    is_blob: false,
                                },
                            );

                            // Send merged content to client
                            update_set.insert(changed.filename.clone());
                            response.update.push(UpdateNote {
                                filename: changed.filename.clone(),
                                content: merged,
                                hash: merged_hash,
                                modified_at: mtime,
                            });

                            mutated = true;
                        } else {
                            // Merge failed or base unavailable — fall back to conflict copy
                            create_conflict_copy(
                                &tx,
                                notes_dir,
                                &changed.filename,
                                &changed.content,
                                server_note,
                                &mut active_filenames,
                                &mut update_set,
                                &mut response,
                                &mut mutated,
                            )?;
                        }
                    } else {
                        // Blob files — always create conflict copy
                        create_conflict_copy(
                            &tx,
                            notes_dir,
                            &changed.filename,
                            &changed.content,
                            server_note,
                            &mut active_filenames,
                            &mut update_set,
                            &mut response,
                            &mut mutated,
                        )?;
                    }
                }
                sync::SyncDirection::NeitherChanged => {
                    // No action needed
                }
            }
        } else {
            // Client changed a file the server doesn't know about — treat as new
            let created = process_new_note(
                &tx,
                notes_dir,
                &changed.filename,
                &changed.content,
                &changed.hash,
                changed.modified_at,
                &mut active_filenames,
                &mut mutated,
            )?;
            note_meta.insert(
                created.filename.clone(),
                NoteMetaRow {
                    filename: created.filename.clone(),
                    content_hash: changed.hash.clone(),
                    modified_at: created.modified_at,
                    is_blob: created.is_blob,
                },
            );
            if created.filename != changed.filename {
                response.delete.push(changed.filename.clone());
                update_set.insert(created.filename.clone());
                response.update.push(UpdateNote {
                    filename: created.filename,
                    content: changed.content.clone(),
                    hash: changed.hash.clone(),
                    modified_at: created.modified_at,
                });
            }
        }
    }

    // ── 4. Process new notes ───────────────────────────────────────

    // Build reverse lookup (content_hash → server filename) for rename detection
    let hash_to_server: HashMap<String, String> = note_meta
        .iter()
        .map(|(f, m)| (m.content_hash.clone(), f.clone()))
        .collect();

    for new_note in &req.new {
        // If server already has this exact filename + hash, skip (idempotent)
        if let Some(existing) = note_meta.get(&new_note.filename) {
            if existing.content_hash == new_note.hash {
                continue;
            }
        }

        // Rename heuristic: if this new note's hash matches a deleted file's hash,
        // and the server already has the content under a different name,
        // skip — server's name wins (rename-vs-rename).
        if deleted_file_hashes.values().any(|h| h == &new_note.hash) {
            if let Some(server_name) = hash_to_server.get(&new_note.hash) {
                if server_name != &new_note.filename {
                    // Tell client to drop the losing rename name
                    response.delete.push(new_note.filename.clone());
                    continue;
                }
            }
        }

        let created = process_new_note(
            &tx,
            notes_dir,
            &new_note.filename,
            &new_note.content,
            &new_note.hash,
            new_note.modified_at,
            &mut active_filenames,
            &mut mutated,
        )?;
        note_meta.insert(
            created.filename.clone(),
            NoteMetaRow {
                filename: created.filename.clone(),
                content_hash: new_note.hash.clone(),
                modified_at: created.modified_at,
                is_blob: created.is_blob,
            },
        );
        if created.filename != new_note.filename {
            response.delete.push(new_note.filename.clone());
            update_set.insert(created.filename.clone());
            response.update.push(UpdateNote {
                filename: created.filename,
                content: new_note.content.clone(),
                hash: new_note.hash.clone(),
                modified_at: created.modified_at,
            });
        }
    }

    // ── 5. Server-only notes ───────────────────────────────────────

    for (filename, server_note) in &note_meta {
        if update_set.contains(filename) {
            continue;
        }

        if client_inventory.contains(filename) {
            // Client already has it — check if they need an update
            let client_hash = client_inventory_hashes
                .get(filename)
                .map(|s| s.as_str())
                .unwrap_or("");
            if client_hash != server_note.content_hash {
                // Client's version differs from server — check via device snapshots
                let device_last_hash = device_snapshots
                    .get(filename)
                    .map(|s| s.as_str())
                    .unwrap_or("");
                // Only send if this file wasn't already handled in changed[]
                if !changed_filenames.contains(filename) {
                    let direction = sync::determine_sync_direction(
                        client_hash,
                        &server_note.content_hash,
                        device_last_hash,
                    );
                    match direction {
                        sync::SyncDirection::ServerChanged | sync::SyncDirection::BothChanged => {
                            if server_note.is_blob {
                                // Blobs don't send content in sync response —
                                // client downloads via GET /blob/{filename}
                                response.update.push(UpdateNote {
                                    filename: filename.clone(),
                                    content: String::new(),
                                    hash: server_note.content_hash.clone(),
                                    modified_at: server_note.modified_at,
                                });
                            } else {
                                let content = read_note_file(notes_dir, filename);
                                if let Some(content) = content {
                                    response.update.push(UpdateNote {
                                        filename: filename.clone(),
                                        content,
                                        hash: server_note.content_hash.clone(),
                                        modified_at: server_note.modified_at,
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            continue;
        }

        if tombstones.contains(filename) {
            continue;
        }

        // Client doesn't have this note — send it
        if server_note.is_blob {
            response.update.push(UpdateNote {
                filename: filename.clone(),
                content: String::new(),
                hash: server_note.content_hash.clone(),
                modified_at: server_note.modified_at,
            });
        } else {
            let content = read_note_file(notes_dir, filename);
            if let Some(content) = content {
                response.update.push(UpdateNote {
                    filename: filename.clone(),
                    content,
                    hash: server_note.content_hash.clone(),
                    modified_at: server_note.modified_at,
                });
            }
        }
    }

    // ── 6. Update device snapshots ─────────────────────────────────

    // After all processing, record what this device now has
    update_device_snapshots(&tx, &req.device_id, &response, req, &note_meta)?;

    // ── 7. Version tracking ────────────────────────────────────────

    if mutated {
        response.version =
            db::increment_sync_version(&tx).map_err(|e| AppError::internal(e.to_string()))?;
    } else {
        response.version =
            db::get_sync_version(&tx).map_err(|e| AppError::internal(e.to_string()))?;
    }

    // ── 8. Post-sync invariant checks ──────────────────────────────

    run_invariants(&tx, notes_dir, &tombstones, response.version);

    // ── 9. Populate timestamps for all active notes ───────────────

    let final_meta: HashMap<String, NoteMetaRow> = load_note_meta(&tx)?;
    for (filename, meta) in &final_meta {
        response
            .timestamps
            .insert(filename.clone(), meta.modified_at);
    }

    tx.commit().map_err(|e| AppError::internal(e.to_string()))?;

    Ok(response)
}

// ── Helpers ────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn process_new_note(
    conn: &Connection,
    notes_dir: &Path,
    filename: &str,
    content: &str,
    hash: &str,
    modified_at: i64,
    active_filenames: &mut HashSet<String>,
    mutated: &mut bool,
) -> Result<ProcessedNote, AppError> {
    // Sanitize the filename
    let stem = filename.strip_suffix(".md").unwrap_or(filename);
    let sanitized = files::sanitize_title(stem);
    let safe_filename = format!("{sanitized}.md");

    // Resolve collisions
    let final_filename = sync::resolve_filename_collision(active_filenames, &safe_filename);

    write_note_file(notes_dir, &final_filename, content);
    let final_modified_at = files::mtime_or_now(modified_at);
    upsert_note_meta(conn, &final_filename, hash, final_modified_at, false)?;
    active_filenames.insert(final_filename.clone());
    *mutated = true;
    Ok(ProcessedNote {
        filename: final_filename,
        modified_at: final_modified_at,
        is_blob: false,
    })
}

fn maybe_store_ancestor_content(
    conn: &Connection,
    notes_dir: &Path,
    filename: &str,
    ancestor_hash: &str,
    is_blob: bool,
) {
    if ancestor_hash.is_empty() || is_blob {
        return;
    }

    if db::get_content(conn, ancestor_hash)
        .ok()
        .flatten()
        .is_some()
    {
        return;
    }

    if let Some(content) = read_note_file(notes_dir, filename) {
        let _ = db::store_content(conn, ancestor_hash, &content);
    }
}

/// Attempt a three-way merge. Returns `Some(merged_content)` on clean merge,
/// `None` if merge fails or base content is unavailable.
fn attempt_three_way_merge(
    conn: &Connection,
    notes_dir: &Path,
    filename: &str,
    base_hash: &str,
    client_content: &str,
) -> Option<String> {
    use stonefruit_core::merge::{three_way_merge, MergeResult};

    // Look up the base content (common ancestor) from content_store
    let base_content = db::get_content(conn, base_hash).ok().flatten()?;

    // Read the server's current version from disk
    let server_content = read_note_file(notes_dir, filename)?;

    match three_way_merge(&base_content, &server_content, client_content) {
        MergeResult::Clean(merged) => Some(merged),
        MergeResult::Conflict => None,
    }
}

/// Create a conflict copy: write client's version as a separate file,
/// send server's version to the client.
#[allow(clippy::too_many_arguments)]
fn create_conflict_copy(
    conn: &Connection,
    notes_dir: &Path,
    filename: &str,
    client_content: &str,
    server_note: &NoteMetaRow,
    active_filenames: &mut HashSet<String>,
    update_set: &mut HashSet<String>,
    response: &mut SyncResponse,
    mutated: &mut bool,
) -> Result<(), AppError> {
    let date = chrono_date();
    let conflict_name = sync::conflict_filename(filename, &date, active_filenames);

    // Write the client's version as a conflict copy on the server
    write_note_file(notes_dir, &conflict_name, client_content);
    let conflict_hash = hash_sha256(client_content);
    upsert_note_meta(conn, &conflict_name, &conflict_hash, files::now_ms(), false)?;
    active_filenames.insert(conflict_name.clone());

    response.conflicts.push(ConflictNote {
        filename: conflict_name,
        content: client_content.to_string(),
    });

    // Send server's version to the client
    let content = read_note_file(notes_dir, filename);
    if let Some(content) = content {
        update_set.insert(filename.to_string());
        response.update.push(UpdateNote {
            filename: filename.to_string(),
            content,
            hash: server_note.content_hash.clone(),
            modified_at: server_note.modified_at,
        });
    }

    *mutated = true;
    Ok(())
}

fn chrono_date() -> String {
    // Simple date format without pulling in chrono crate
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // Days since epoch -> year/month/day (simplified)
    let days = now / 86400;
    // Use a simple calculation (good enough for conflict filenames)
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let days_in_year = if is_leap_year(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap_year(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 1;
    for &md in &month_days {
        if remaining < md {
            break;
        }
        remaining -= md;
        m += 1;
    }
    let d = remaining + 1;
    format!("{y:04}-{m:02}-{d:02}")
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ── File I/O ───────────────────────────────────────────────────────────

fn write_note_file(notes_dir: &Path, filename: &str, content: &str) {
    let path = notes_dir.join(filename);
    // Use atomic write for crash safety
    let _ = files::write_atomic_text(&path, content);
}

fn read_note_file(notes_dir: &Path, filename: &str) -> Option<String> {
    let path = notes_dir.join(filename);
    std::fs::read_to_string(path).ok()
}

fn delete_note_file(notes_dir: &Path, filename: &str) {
    let path = notes_dir.join(filename);
    let _ = std::fs::remove_file(path);
}

// ── DB operations ──────────────────────────────────────────────────────

fn load_note_meta(conn: &Connection) -> Result<HashMap<String, NoteMetaRow>, AppError> {
    let mut stmt = conn
        .prepare("SELECT filename, content_hash, modified_at, is_blob FROM note_meta")
        .map_err(|e| AppError::internal(e.to_string()))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(NoteMetaRow {
                filename: row.get(0)?,
                content_hash: row.get(1)?,
                modified_at: row.get(2)?,
                is_blob: row.get::<_, i32>(3)? != 0,
            })
        })
        .map_err(|e| AppError::internal(e.to_string()))?;

    let mut map = HashMap::new();
    for row in rows {
        let row = row.map_err(|e| AppError::internal(e.to_string()))?;
        map.insert(row.filename.clone(), row);
    }
    Ok(map)
}

fn load_tombstones(conn: &Connection) -> Result<HashSet<String>, AppError> {
    let mut stmt = conn
        .prepare("SELECT filename FROM tombstones")
        .map_err(|e| AppError::internal(e.to_string()))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| AppError::internal(e.to_string()))?;

    let mut set = HashSet::new();
    for row in rows {
        set.insert(row.map_err(|e| AppError::internal(e.to_string()))?);
    }
    Ok(set)
}

fn load_device_snapshots(
    conn: &Connection,
    device_id: &str,
) -> Result<HashMap<String, String>, AppError> {
    let mut stmt = conn
        .prepare("SELECT filename, hash FROM device_snapshots WHERE device_id = ?1")
        .map_err(|e| AppError::internal(e.to_string()))?;

    let rows = stmt
        .query_map([device_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| AppError::internal(e.to_string()))?;

    let mut map = HashMap::new();
    for row in rows {
        let (filename, hash) = row.map_err(|e| AppError::internal(e.to_string()))?;
        map.insert(filename, hash);
    }
    Ok(map)
}

fn upsert_note_meta(
    conn: &Connection,
    filename: &str,
    content_hash: &str,
    modified_at: i64,
    is_blob: bool,
) -> Result<(), AppError> {
    conn.execute(
        "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(filename) DO UPDATE SET \
         content_hash = excluded.content_hash, \
         modified_at = excluded.modified_at, \
         is_blob = excluded.is_blob",
        rusqlite::params![filename, content_hash, modified_at, is_blob as i32],
    )
    .map_err(|e| AppError::internal(e.to_string()))?;
    Ok(())
}

fn delete_note_meta(conn: &Connection, filename: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM note_meta WHERE filename = ?1", [filename])
        .map_err(|e| AppError::internal(e.to_string()))?;
    Ok(())
}

fn create_tombstone(conn: &Connection, filename: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR IGNORE INTO tombstones (filename, deleted_at) VALUES (?1, ?2)",
        rusqlite::params![filename, files::now_ms()],
    )
    .map_err(|e| AppError::internal(e.to_string()))?;
    Ok(())
}

fn remove_tombstone(conn: &Connection, filename: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM tombstones WHERE filename = ?1", [filename])
        .map_err(|e| AppError::internal(e.to_string()))?;
    Ok(())
}

fn update_device_snapshots(
    conn: &Connection,
    device_id: &str,
    response: &SyncResponse,
    req: &SyncRequest,
    note_meta: &HashMap<String, NoteMetaRow>,
) -> Result<(), AppError> {
    // Build the final set of what the device will have after applying the response:
    // Start with inventory, apply changes from the response
    let mut final_state: HashMap<String, String> = HashMap::new();

    // Everything from inventory that wasn't deleted
    let deleted_set: HashSet<&str> = response.delete.iter().map(|s| s.as_str()).collect();
    for item in &req.inventory {
        if !deleted_set.contains(item.filename.as_str()) {
            final_state.insert(item.filename.clone(), item.hash.clone());
        }
    }

    // Updates from server overwrite client state
    for update in &response.update {
        final_state.insert(update.filename.clone(), update.hash.clone());
    }

    // Client's changed notes (if accepted by server)
    for changed in &req.changed {
        if note_meta.contains_key(&changed.filename) {
            // Use the server's current hash (which may be the client's if accepted)
            if let Some(meta) = note_meta.get(&changed.filename) {
                final_state.insert(changed.filename.clone(), meta.content_hash.clone());
            }
        }
    }

    // Client's new notes
    for new_note in &req.new {
        final_state.insert(new_note.filename.clone(), new_note.hash.clone());
    }

    // Conflict copies
    for conflict in &response.conflicts {
        let hash = hash_sha256(&conflict.content);
        final_state.insert(conflict.filename.clone(), hash);
    }

    // Remove deleted
    for filename in &req.deleted {
        final_state.remove(filename);
    }
    for filename in &response.delete {
        final_state.remove(filename);
    }

    // ── Store content in content_store for future three-way merges ──
    // Content is available from the request (client) and response (server).
    for changed in &req.changed {
        let _ = db::store_content(conn, &changed.hash, &changed.content);
    }
    for new_note in &req.new {
        let _ = db::store_content(conn, &new_note.hash, &new_note.content);
    }
    for update in &response.update {
        let _ = db::store_content(conn, &update.hash, &update.content);
    }
    for conflict in &response.conflicts {
        let hash = hash_sha256(&conflict.content);
        let _ = db::store_content(conn, &hash, &conflict.content);
    }

    // Clear old snapshots for this device and write new ones
    conn.execute(
        "DELETE FROM device_snapshots WHERE device_id = ?1",
        [device_id],
    )
    .map_err(|e| AppError::internal(e.to_string()))?;

    let mut stmt = conn
        .prepare("INSERT INTO device_snapshots (device_id, filename, hash) VALUES (?1, ?2, ?3)")
        .map_err(|e| AppError::internal(e.to_string()))?;

    for (filename, hash) in &final_state {
        stmt.execute(rusqlite::params![device_id, filename, hash])
            .map_err(|e| AppError::internal(e.to_string()))?;
    }

    // Prune content_store: remove entries no longer referenced by any device snapshot
    conn.execute(
        "DELETE FROM content_store WHERE hash NOT IN (SELECT DISTINCT hash FROM device_snapshots)",
        [],
    )
    .map_err(|e| AppError::internal(e.to_string()))?;

    Ok(())
}

fn run_invariants(
    conn: &Connection,
    notes_dir: &Path,
    tombstones: &HashSet<String>,
    version_after: u64,
) {
    // Collect current note records from DB
    let note_records: Vec<NoteRecord> = match load_note_meta(conn) {
        Ok(meta) => meta
            .values()
            .map(|row| NoteRecord {
                filename: row.filename.clone(),
                content_hash: row.content_hash.clone(),
                is_blob: row.is_blob,
            })
            .collect(),
        Err(_) => return,
    };

    let active_filenames: HashSet<String> =
        note_records.iter().map(|r| r.filename.clone()).collect();

    let violations = invariants::run_all_invariants(
        &note_records,
        notes_dir,
        &active_filenames,
        tombstones,
        0, // We don't track version_before in this context
        version_after,
    );

    for v in &violations {
        // Filter out VersionRegression since we pass 0 as before
        if matches!(v, invariants::InvariantViolation::VersionRegression { .. }) {
            continue;
        }
        tracing::warn!("Post-sync invariant violation: {:?}", v);
    }
}
