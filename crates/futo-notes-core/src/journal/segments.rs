use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::JournalLimits;

const SEGMENT_PREFIX: &str = "journal-";
const SEGMENT_SUFFIX: &str = ".jsonl";

/// The journal's on-disk ring: numbered JSONL segments in one directory, rolled
/// at `max_file_bytes` and pruned oldest-segment-first so the set stays under
/// `max_total_bytes`. Only the writer thread owns one.
pub(super) struct JournalSegments {
    directory: PathBuf,
    limits: JournalLimits,
    current: File,
    /// `(index, byte length)` oldest first; the last entry is the open segment.
    /// Tracked here so an append never has to re-read the directory.
    segments: Vec<(u64, u64)>,
    total_bytes: u64,
}

impl JournalSegments {
    pub(super) fn open(directory: &Path, limits: JournalLimits) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|error| {
            format!(
                "{error} (creating journal directory {})",
                directory.display()
            )
        })?;

        let mut segments = existing_segments(directory);
        if segments.is_empty() {
            segments.push((1, 0));
        }
        let total_bytes = segments.iter().map(|(_, bytes)| bytes).sum();
        let current_index = segments.last().map_or(1, |(index, _)| *index);

        Ok(Self {
            current: open_segment(directory, current_index)?,
            directory: directory.to_path_buf(),
            limits,
            segments,
            total_bytes,
        })
    }

    /// Appends one line. Writes are unbuffered so a reader (a test, `just
    /// journal`, an agent mid-session) sees every event the writer has taken off
    /// the queue; they are deliberately not fsynced, because a journal lost to a
    /// power cut is not worth a sync per event.
    pub(super) fn append(&mut self, line: &str) -> Result<(), String> {
        let written = line.len() as u64 + 1;
        self.current
            .write_all(line.as_bytes())
            .and_then(|()| self.current.write_all(b"\n"))
            .map_err(|error| {
                format!(
                    "{error} (appending to journal segment {})",
                    segment_path(&self.directory, self.current_index()).display()
                )
            })?;

        if let Some(current) = self.segments.last_mut() {
            current.1 += written;
        }
        self.total_bytes += written;

        if self
            .segments
            .last()
            .is_some_and(|(_, bytes)| *bytes >= self.limits.max_file_bytes)
        {
            self.roll()?;
        }
        self.prune();
        Ok(())
    }

    fn current_index(&self) -> u64 {
        self.segments.last().map_or(1, |(index, _)| *index)
    }

    fn roll(&mut self) -> Result<(), String> {
        let next_index = self.current_index() + 1;
        self.current = open_segment(&self.directory, next_index)?;
        self.segments.push((next_index, 0));
        Ok(())
    }

    /// Drops whole oldest segments until the ring fits the total cap. The
    /// segment being written is never removed, so a cap smaller than one segment
    /// degrades to "keep the newest segment" instead of losing the live file. A
    /// segment that refuses to be removed stops the sweep and is retried on the
    /// next append rather than spinning here.
    fn prune(&mut self) {
        while self.total_bytes > self.limits.max_total_bytes && self.segments.len() > 1 {
            let (index, bytes) = self.segments[0];
            match fs::remove_file(segment_path(&self.directory, index)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return,
            }
            self.segments.remove(0);
            self.total_bytes = self.total_bytes.saturating_sub(bytes);
        }
    }
}

fn open_segment(directory: &Path, index: u64) -> Result<File, String> {
    let path = segment_path(directory, index);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("{error} (opening journal segment {})", path.display()))
}

/// `journal-000001.jsonl` — zero padded so a directory listing is already in
/// oldest-first order for a human reading it with `ls` or `cat`.
pub(super) fn segment_path(directory: &Path, index: u64) -> PathBuf {
    directory.join(format!("{SEGMENT_PREFIX}{index:06}{SEGMENT_SUFFIX}"))
}

/// Every segment currently in `directory` as `(index, byte length)`, oldest
/// first. Anything that is not a numbered segment is ignored, so an unrelated
/// file in the journal directory cannot confuse the ring.
pub(super) fn existing_segments(directory: &Path) -> Vec<(u64, u64)> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut segments: Vec<(u64, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let index = name
                .strip_prefix(SEGMENT_PREFIX)?
                .strip_suffix(SEGMENT_SUFFIX)?
                .parse::<u64>()
                .ok()?;
            Some((index, entry.metadata().map(|meta| meta.len()).unwrap_or(0)))
        })
        .collect();
    segments.sort_unstable_by_key(|(index, _)| *index);
    segments
}
