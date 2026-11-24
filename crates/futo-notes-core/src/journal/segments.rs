use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
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
    /// The open segment's last line may lack its newline: a crash or a failed
    /// write tore it. The next append starts with a newline, so the torn line
    /// stays the only loss instead of swallowing the event written after it.
    unterminated: bool,
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
            unterminated: ends_mid_line(&segment_path(directory, current_index)),
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
    /// power cut is not worth a sync per event. The line and its newline go out
    /// in ONE write, so a failure or a crash cannot separate them.
    pub(super) fn append(&mut self, line: &str) -> Result<(), String> {
        let mut record = String::with_capacity(line.len() + 2);
        if self.unterminated {
            record.push('\n');
        }
        record.push_str(line);
        record.push('\n');
        let written = record.len() as u64;
        if let Err(error) = self.current.write_all(record.as_bytes()) {
            // How much of it landed is unknown; assume the tail is torn.
            self.unterminated = true;
            return Err(format!(
                "{error} (appending to journal segment {})",
                segment_path(&self.directory, self.current_index()).display()
            ));
        }
        self.unterminated = false;

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
        self.unterminated = false;
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

/// Whether `path` ends in the middle of a line: non-empty and not newline-last.
/// An unreadable segment counts as clean, since the append will report its own
/// failure.
fn ends_mid_line(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut last = [0u8; 1];
    file.seek(SeekFrom::End(-1))
        .and_then(|_| file.read_exact(&mut last))
        .is_ok_and(|()| last[0] != b'\n')
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::{encode_event, read_events};

    fn limits() -> JournalLimits {
        JournalLimits {
            max_file_bytes: 1024 * 1024,
            max_total_bytes: 4 * 1024 * 1024,
            queue_capacity: 8,
        }
    }

    fn event(pushed: u32) -> String {
        encode_event("sync_run", &serde_json::json!({ "pushed": pushed }))
    }

    /// A crash between a line and its newline leaves an unterminated tail. The
    /// next process appends to the same segment, and its first event must not be
    /// glued onto that tail: only the torn event is lost.
    #[test]
    fn an_event_after_a_torn_tail_is_not_glued_onto_it() {
        let directory = tempfile::tempdir().unwrap();
        let mut segments = JournalSegments::open(directory.path(), limits()).unwrap();
        segments.append(&event(1)).unwrap();
        drop(segments);
        let torn = &event(2)[..20];
        let path = segment_path(directory.path(), 1);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(torn.as_bytes()).unwrap();
        drop(file);

        let mut segments = JournalSegments::open(directory.path(), limits()).unwrap();
        segments.append(&event(3)).unwrap();
        segments.append(&event(4)).unwrap();
        drop(segments);

        let pushed: Vec<u64> = read_events(directory.path())
            .unwrap()
            .iter()
            .map(|event| event.data["pushed"].as_u64().unwrap())
            .collect();
        assert_eq!(pushed, [1, 3, 4]);
    }

    #[test]
    fn a_clean_tail_gets_no_separator() {
        let directory = tempfile::tempdir().unwrap();
        let mut segments = JournalSegments::open(directory.path(), limits()).unwrap();
        segments.append(&event(1)).unwrap();
        drop(segments);
        let mut segments = JournalSegments::open(directory.path(), limits()).unwrap();
        segments.append(&event(2)).unwrap();
        drop(segments);

        let text = fs::read_to_string(segment_path(directory.path(), 1)).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(!text.contains("\n\n"));
    }
}
