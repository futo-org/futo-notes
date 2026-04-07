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

/// Entry for the version_log: (filename, action, hash).
struct VersionLogEntry {
    filename: String,
    action: &'static str, // "upsert" or "delete"
    hash: Option<String>,
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
        oldest_retained_version: None,
    };

    // Track filenames already queued in response.update to avoid O(n²) linear scans
    let mut update_set: HashSet<String> = HashSet::new();

    let mut mutated = false;

    // Track all mutations for version_log
    let mut version_log_entries: Vec<VersionLogEntry> = Vec::new();

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::internal(e.to_string()))?;

    // Load all server state into memory
    let mut note_meta: HashMap<String, NoteMetaRow> = load_note_meta(&tx)?;
    let mut tombstones: HashSet<String> = load_tombstones(&tx)?;

    // Pre-pass: capture hashes of files being deleted (for rename detection).
    // Use client-sent baselines first, fall back to server note_meta.
    let mut deleted_file_hashes: HashMap<String, String> = HashMap::new();
    for deleted in &req.deleted {
        if let Some(h) = req.deleted_baselines.get(deleted) {
            deleted_file_hashes.insert(deleted.clone(), h.clone());
        } else if let Some(meta) = note_meta.get(deleted) {
            deleted_file_hashes.insert(deleted.clone(), meta.content_hash.clone());
        }
    }

    // Unwrap inventory (None = dirty-only upload, no full vault walk)
    let inventory = req.inventory.as_deref().unwrap_or(&[]);

    // Build a set of all filenames the client knows about
    let client_inventory: HashSet<String> =
        inventory.iter().map(|i| i.filename.clone()).collect();

    // Also build a lookup from inventory filename -> hash
    let client_inventory_hashes: HashMap<String, String> = inventory
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
            // Use client-sent baseline hash for delete-vs-edit detection
            let baseline_hash = req
                .deleted_baselines
                .get(filename)
                .map(|s| s.as_str())
                .unwrap_or("");
            if server_note.content_hash == baseline_hash {
                // Server unchanged since device last saw — accept deletion
                delete_note_file(notes_dir, filename);
                delete_note_meta(&tx, filename)?;
                create_tombstone(&tx, filename)?;
                tombstones.insert(filename.clone());
                active_filenames.remove(filename);
                mutated = true;
                version_log_entries.push(VersionLogEntry {
                    filename: filename.clone(),
                    action: "delete",
                    hash: None,
                });
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
            version_log_entries.push(VersionLogEntry {
                filename: filename.clone(),
                action: "delete",
                hash: None,
            });
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
    // Only applicable when client sent inventory (full sync path).

    if req.inventory.is_some() {
        for tombstoned in &tombstones {
            if client_inventory.contains(tombstoned) {
                response.delete.push(tombstoned.clone());
            }
        }
    }

    // ── 3. Process client changes ──────────────────────────────────

    for changed in &req.changed {
        // Skip if we just deleted or tombstoned this
        if tombstones.contains(&changed.filename) {
            continue;
        }

        if let Some(server_note) = note_meta.get(&changed.filename) {
            // Use client-sent baseline hash instead of device_snapshots
            let baseline_hash = changed
                .baseline_hash
                .as_deref()
                .unwrap_or("");

            let direction = sync::determine_sync_direction(
                &changed.hash,
                &server_note.content_hash,
                baseline_hash,
            );

            match direction {
                sync::SyncDirection::ClientChanged => {
                    maybe_store_ancestor_content(
                        &tx,
                        notes_dir,
                        &changed.filename,
                        baseline_hash,
                        server_note.is_blob,
                    );

                    // Accept client version
                    write_note_file(notes_dir, &changed.filename, &changed.content);
                    let mtime = files::mtime_or_now(changed.modified_at);
                    upsert_note_meta(&tx, &changed.filename, &changed.hash, mtime, false)?;
                    // Keep in-memory note_meta in sync so version_log
                    // records the correct hash at end-of-sync
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
                    version_log_entries.push(VersionLogEntry {
                        filename: changed.filename.clone(),
                        action: "upsert",
                        hash: Some(changed.hash.clone()),
                    });
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
                        // Use client-sent baseline hash for ancestor lookup
                        if let Some(merged) = attempt_three_way_merge(
                            conn,
                            notes_dir,
                            &changed.filename,
                            baseline_hash,
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
                                hash: merged_hash.clone(),
                                modified_at: mtime,
                            });

                            mutated = true;
                            version_log_entries.push(VersionLogEntry {
                                filename: changed.filename.clone(),
                                action: "upsert",
                                hash: Some(merged_hash),
                            });
                        } else {
                            // Merge failed or base unavailable — fall back to conflict copy
                            let conflict_entries = create_conflict_copy(
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
                            version_log_entries.extend(conflict_entries);
                        }
                    } else {
                        // Blob files — always create conflict copy
                        let conflict_entries = create_conflict_copy(
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
                        version_log_entries.extend(conflict_entries);
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
            version_log_entries.push(VersionLogEntry {
                filename: created.filename.clone(),
                action: "upsert",
                hash: Some(changed.hash.clone()),
            });
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
        version_log_entries.push(VersionLogEntry {
            filename: created.filename.clone(),
            action: "upsert",
            hash: Some(new_note.hash.clone()),
        });
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

    // ── 5. Download path — inventory-based or changelog-based ─────

    if req.inventory.is_some() {
        // Full inventory provided — use traditional diffing (sections 2 + 5 from old code)
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
                    // Only send if this file wasn't already handled in changed[]
                    if !changed_filenames.contains(filename) {
                        // Without device_snapshots, we treat inventory hash mismatches
                        // as server-changed (server's version wins for download)
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
    } else if let Some(client_version) = req.last_version {
        // No inventory — use changelog-based download path
        let server_version =
            db::get_sync_version(&tx).map_err(|e| AppError::internal(e.to_string()))?;

        let oldest_retained = db::get_oldest_retained_version(&tx)
            .map_err(|e| AppError::internal(e.to_string()))?;
        response.oldest_retained_version = oldest_retained;

        if client_version < server_version {
            // Check if client is within the changelog retention window
            let can_use_changelog = oldest_retained
                .map(|oldest| client_version >= oldest.saturating_sub(1))
                .unwrap_or(true); // No entries yet = nothing to download

            if can_use_changelog {
                let changelog = db::query_changelog(&tx, client_version, server_version)
                    .map_err(|e| AppError::internal(e.to_string()))?;

                // Build upload set for exclusion (files already handled in upload path)
                let upload_filenames: HashSet<&str> = req
                    .changed
                    .iter()
                    .map(|c| c.filename.as_str())
                    .chain(req.new.iter().map(|n| n.filename.as_str()))
                    .chain(req.deleted.iter().map(|d| d.as_str()))
                    .collect();

                for (filename, (action, _hash)) in &changelog {
                    // Skip files already handled in the upload resolution
                    if upload_filenames.contains(filename.as_str()) {
                        continue;
                    }
                    if update_set.contains(filename) {
                        continue;
                    }

                    match action.as_str() {
                        "upsert" => {
                            if let Some(server_note) = note_meta.get(filename) {
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
                        }
                        "delete" => {
                            response.delete.push(filename.clone());
                        }
                        _ => {}
                    }
                }

                // Also propagate tombstones that the changelog might have missed
                // (tombstones created before the changelog window)
                // This is handled by the "delete" action in the changelog.
            }
            // If client is beyond retention, oldest_retained_version is set in the response.
            // The client detects this and falls back to full sync.
        }
    }

    // ── 6. Store content for future three-way merges ──────────────

    store_sync_content(&tx, req, &response);

    // ── 7. Version tracking + version_log ─────────────────────────

    if mutated {
        let new_version =
            db::increment_sync_version(&tx).map_err(|e| AppError::internal(e.to_string()))?;
        response.version = new_version;

        // Write version_log entries for this version
        if !version_log_entries.is_empty() {
            let entries: Vec<(String, &str, Option<String>)> = version_log_entries
                .iter()
                .map(|e| (e.filename.clone(), e.action, e.hash.clone()))
                .collect();
            db::insert_version_log_entries(&tx, new_version, &entries)
                .map_err(|e| AppError::internal(e.to_string()))?;
        }
    } else {
        response.version =
            db::get_sync_version(&tx).map_err(|e| AppError::internal(e.to_string()))?;
    }

    // Set oldest_retained_version in all responses
    if response.oldest_retained_version.is_none() {
        response.oldest_retained_version = db::get_oldest_retained_version(&tx)
            .map_err(|e| AppError::internal(e.to_string()))?;
    }

    // ── 8. Prune content_store ────────────────────────────────────

    prune_content_store(&tx)?;

    // ── 9. Post-sync invariant checks ─────────────────────────────

    run_invariants(&tx, notes_dir, &tombstones, response.version);

    // ── 10. Populate timestamps for all active notes ──────────────

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
/// Returns version_log entries for the conflict copy creation.
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
) -> Result<Vec<VersionLogEntry>, AppError> {
    let mut entries = Vec::new();
    let date = chrono_date();
    let conflict_name = sync::conflict_filename(filename, &date, active_filenames);

    // Write the client's version as a conflict copy on the server
    write_note_file(notes_dir, &conflict_name, client_content);
    let conflict_hash = hash_sha256(client_content);
    upsert_note_meta(conn, &conflict_name, &conflict_hash, files::now_ms(), false)?;
    active_filenames.insert(conflict_name.clone());

    response.conflicts.push(ConflictNote {
        filename: conflict_name.clone(),
        content: client_content.to_string(),
    });

    entries.push(VersionLogEntry {
        filename: conflict_name,
        action: "upsert",
        hash: Some(conflict_hash),
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
    Ok(entries)
}

/// Store content from sync request/response in content_store for future three-way merges.
fn store_sync_content(conn: &Connection, req: &SyncRequest, response: &SyncResponse) {
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
}

/// Prune content_store: remove entries not referenced by note_meta or version_log.
fn prune_content_store(conn: &Connection) -> Result<(), AppError> {
    conn.execute(
        "DELETE FROM content_store WHERE hash NOT IN \
         (SELECT content_hash FROM note_meta) \
         AND hash NOT IN \
         (SELECT hash FROM version_log WHERE hash IS NOT NULL)",
        [],
    )
    .map_err(|e| AppError::internal(e.to_string()))?;
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
