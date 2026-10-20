//! Rename pairing across backends: the processor between `notify` and the sink.

use super::*;

#[derive(Clone)]
pub(super) struct PendingRename {
    from_path: PathBuf,
    inserted_at: i64,
}

/// A cookieless rename's old name, waiting for the entry after its own.
struct OldHalf {
    path: PathBuf,
    entry: u64,
    at: i64,
}

/// What the processor carries between events.
#[derive(Default)]
struct RenameState {
    /// notify reports one backend entry as one event per flag, all with the
    /// entry's path, so a change of path starts the next entry. `entry`
    /// counts them.
    entry_path: Option<PathBuf>,
    entry: u64,
    old_half: Option<OldHalf>,
    /// Note paths a rename emptied, waiting to learn whether the note left
    /// the vault or was written again in place.
    vacated: Vec<PendingRename>,
    flusher_running: bool,
}

#[derive(Clone)]
pub(super) struct EventProcessor<S: ChangeSink> {
    bases: Vec<PathBuf>,
    pending_renames: Arc<Mutex<HashMap<u128, PendingRename>>>,
    renames: Arc<Mutex<RenameState>>,
    sink: S,
    mode: WatchMode,
}

impl<S: ChangeSink> EventProcessor<S> {
    pub(super) fn new(
        bases: Vec<PathBuf>,
        pending_renames: Arc<Mutex<HashMap<u128, PendingRename>>>,
        sink: S,
        mode: WatchMode,
    ) -> Self {
        Self {
            bases,
            pending_renames,
            renames: Arc::default(),
            sink,
            mode,
        }
    }

    /// Runs under the rename-state lock, as does the timer that resolves
    /// what it leaves waiting, so the two report in one order.
    pub(super) fn process(&self, event: Event) {
        let Ok(mut state) = self.renames.lock() else {
            return;
        };
        let now = futo_notes_core::files::now_ms();
        self.enter_entry(&mut state, event.paths.first(), now);
        let Some(kind) = classify(&event, self.mode) else {
            return;
        };
        self.flush_stale(&mut state, now);
        match kind {
            ChangeKind::RenameFrom => self.rename_from(&mut state, event, now),
            ChangeKind::RenameTo => self.rename_to(&mut state, event, now),
            ChangeKind::RenameEither => self.rename_either(&mut state, event, now),
            // FSEvents coalesces flags per path, so a rename's old name can also
            // carry its earlier create/write after the file is gone. A path that
            // no longer exists was not added or edited: the rename or removal
            // half reports it. Reporting it as an edit made the shell flush the
            // open note's pending save to that id and recreate it there.
            ChangeKind::Add => {
                for path in event.paths {
                    self.present(&mut state, &path, "add");
                }
            }
            ChangeKind::Change => {
                for path in event.paths {
                    self.present(&mut state, &path, "change");
                }
            }
            // Coalescing also leaves a removal on a path that was written again
            // since: a note that exists was not removed.
            ChangeKind::Unlink => {
                for path in event.paths {
                    if path_exists(&path) {
                        self.arrived(&mut state, &path, "change");
                    } else {
                        self.revisit(&mut state, &path);
                        self.emit_path("unlink", &path);
                    }
                }
            }
        }
    }

    /// Count backend entries, and give up on an old name that the entry
    /// straight after its own did not take.
    fn enter_entry(&self, state: &mut RenameState, path: Option<&PathBuf>, now: i64) {
        if state.entry_path.as_ref() != path {
            state.entry_path = path.cloned();
            state.entry += 1;
        }
        let entry = state.entry;
        if let Some(old) = state
            .old_half
            .take_if(|old| entry > old.entry + 1 || now - old.at > RENAME_HALF_GAP_MS)
        {
            self.vacate(state, old.path, old.at);
        }
    }

    /// Resolve what has waited out its window: a cookie rename whose new half
    /// never came, an old name nothing took, and a vacated note path, which
    /// is an edit if something is at the path again and a removal if not.
    fn flush_stale(&self, state: &mut RenameState, now: i64) {
        if let Ok(mut pending) = self.pending_renames.lock() {
            let stale = pending
                .iter()
                .filter_map(|(cookie, rename)| {
                    (now - rename.inserted_at > RENAME_PAIR_TIMEOUT_MS).then_some(*cookie)
                })
                .collect::<Vec<_>>();
            for cookie in stale {
                if let Some(rename) = pending.remove(&cookie) {
                    self.vacate(state, rename.from_path, rename.inserted_at);
                }
            }
        }
        if let Some(old) = state
            .old_half
            .take_if(|old| now - old.at > RENAME_HALF_GAP_MS)
        {
            self.vacate(state, old.path, old.at);
        }
        let (stale, waiting) = std::mem::take(&mut state.vacated)
            .into_iter()
            .partition::<Vec<_>, _>(|vacated| now - vacated.inserted_at > RENAME_PAIR_TIMEOUT_MS);
        state.vacated = waiting;
        for vacated in stale {
            let path = vacated.from_path;
            self.emit_path(
                if path_exists(&path) {
                    "change"
                } else {
                    "unlink"
                },
                &path,
            );
        }
    }

    /// Hold a note path a rename emptied until its window closes. Nothing may
    /// come to flush it, so a timer does.
    fn vacate(&self, state: &mut RenameState, path: PathBuf, at: i64) {
        if relative_note_path_any(&self.bases, &path).is_none() {
            return;
        }
        if !state
            .vacated
            .iter()
            .any(|vacated| vacated.from_path == path)
        {
            state.vacated.push(PendingRename {
                from_path: path,
                inserted_at: at,
            });
        }
        self.ensure_flusher(state);
    }

    /// Forget a waiting old name or vacated path that `path` fills again, and
    /// say whether there was one.
    fn revisit(&self, state: &mut RenameState, path: &Path) -> bool {
        let vacated = state.vacated.len();
        state.vacated.retain(|waiting| waiting.from_path != path);
        let old_half = state.old_half.take_if(|old| old.path == path).is_some();
        old_half || state.vacated.len() != vacated
    }

    /// Report `path` if something is there now.
    fn present(&self, state: &mut RenameState, path: &Path, kind: &str) {
        if path_exists(path) {
            self.arrived(state, path, kind);
        }
    }

    /// Report a name that exists: a note the vault just lost is back, which
    /// is an edit of it whatever `kind` the event had.
    fn arrived(&self, state: &mut RenameState, path: &Path, kind: &str) {
        let back = self.revisit(state, path);
        self.emit_path(if back { "change" } else { kind }, path);
    }

    fn ensure_flusher(&self, state: &mut RenameState) {
        if state.flusher_running {
            return;
        }
        let processor = self.clone();
        let started = crate::background_tasks::spawn("watcher-rename-pairing", move || loop {
            std::thread::sleep(std::time::Duration::from_millis(RENAME_HALF_GAP_MS as u64));
            let Ok(mut state) = processor.renames.lock() else {
                return;
            };
            processor.flush_stale(&mut state, futo_notes_core::files::now_ms());
            let cookies_waiting = processor
                .pending_renames
                .lock()
                .map(|pending| !pending.is_empty())
                .unwrap_or(false);
            if state.old_half.is_none() && state.vacated.is_empty() && !cookies_waiting {
                state.flusher_running = false;
                return;
            }
        });
        state.flusher_running = started.is_ok();
    }

    /// A rename half with no cookie that does not say which it is (FSEvents).
    /// The old name no longer exists; the new one does.
    fn rename_either(&self, state: &mut RenameState, event: Event, now: i64) {
        for path in event.paths {
            if path_exists(&path) {
                self.new_half(state, path, "change");
            } else {
                self.old_half(state, path, now);
            }
        }
    }

    /// Hold a cookieless old name for the entry after its own. Temp files
    /// count too: an atomic save's temp is what its destination pairs with.
    fn old_half(&self, state: &mut RenameState, path: PathBuf, now: i64) {
        if let Some(previous) = state.old_half.take() {
            self.vacate(state, previous.path, previous.at);
        }
        state.old_half = Some(OldHalf {
            path,
            entry: state.entry,
            at: now,
        });
        self.ensure_flusher(state);
    }

    /// Pair a cookieless new name with the old name of the entry just before
    /// it. Without one it keeps its unpaired meaning (`unpaired_kind`).
    fn new_half(&self, state: &mut RenameState, path: PathBuf, unpaired_kind: &str) {
        let entry = state.entry;
        match state
            .old_half
            .take_if(|old| old.entry + 1 == entry && old.path != path)
        {
            Some(old) => self.pair(state, old.path, path, unpaired_kind, old.at, false),
            None => self.arrived(state, &path, unpaired_kind),
        }
    }

    fn rename_from(&self, state: &mut RenameState, event: Event, now: i64) {
        let mut paths = event.paths.into_iter();
        let first = paths.next();
        if let (Some(cookie), Some(path)) = (event.attrs.tracker(), first.clone()) {
            if let Ok(mut pending) = self.pending_renames.lock() {
                pending.insert(
                    cookie as u128,
                    PendingRename {
                        from_path: path,
                        inserted_at: now,
                    },
                );
            }
            // A note moved out of the vault has no new half and may have no
            // later event to flush it either.
            self.ensure_flusher(state);
            return;
        }
        // No cookie (Windows): wait for the new half instead of reporting a
        // removal and an add.
        for path in first.into_iter().chain(paths) {
            self.old_half(state, path, now);
        }
    }

    fn rename_to(&self, state: &mut RenameState, event: Event, now: i64) {
        let mut paths = event.paths.into_iter();
        let first = paths.next();
        if let (Some(cookie), Some(to)) = (event.attrs.tracker(), first.clone()) {
            let from = self
                .pending_renames
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&(cookie as u128)))
                .map(|rename| rename.from_path);
            if let Some(from) = from {
                self.pair(state, from, to, "add", now, true);
                return;
            }
        } else if let Some(to) = first {
            self.new_half(state, to, "add");
            for path in paths {
                self.present(state, &path, "add");
            }
            return;
        }
        for path in first.into_iter().chain(paths) {
            self.present(state, &path, "add");
        }
    }

    /// Report the two names of one rename. It is a move only when both are
    /// notes and the old name stayed empty. Renaming a note to a non-note name
    /// (vim's backup before it writes the note again) empties the note's path
    /// for a moment, so that waits out the window like a move out of the vault.
    ///
    /// `by_cookie` says the backend itself matched the halves (inotify's
    /// cookie), so the pair is exact and the old name is not looked at again:
    /// it may already be occupied by a new note (a cloud client's conflict
    /// rename), and that does not undo the rename. Cookieless halves were
    /// matched by arrival order, and only the old name being gone confirms it.
    fn pair(
        &self,
        state: &mut RenameState,
        from: PathBuf,
        to: PathBuf,
        unpaired_kind: &str,
        at: i64,
        by_cookie: bool,
    ) {
        if from == to {
            self.present(state, &to, "change");
            return;
        }
        match (
            relative_note_path_any(&self.bases, &from),
            relative_note_path_any(&self.bases, &to),
        ) {
            (Some(from_relative), Some(to_relative)) if by_cookie || !path_exists(&from) => {
                self.revisit(state, &to);
                self.sink.rename(&from_relative, &to_relative);
            }
            (Some(_), Some(_)) => {
                self.arrived(state, &from, "change");
                self.arrived(state, &to, unpaired_kind);
            }
            (Some(_), None) => self.vacate(state, from, at),
            (None, Some(_)) => self.arrived(state, &to, unpaired_kind),
            (None, None) => {}
        }
    }

    fn emit_path(&self, kind: &str, path: &Path) {
        if let Some(relative) = relative_note_path_any(&self.bases, path) {
            self.sink.change(kind, &relative);
        }
    }
}
