//! The instance journal: a local, size-capped JSONL record of what this app
//! instance actually did at runtime.
//!
//! One event per line — `{"v":1,"ts":<ms>,"type":"<event>","data":{…}}` — so
//! `jq` is a first-class query tool and a reader can skip payloads it does not
//! understand. The journal is diagnostic data for whoever is running the app:
//! it lives in the app data directory, never inside a note vault (it must not
//! sync and must not pollute notes), and is never uploaded anywhere.
//!
//! Recording never blocks the caller (AGENTS.md M5). Events cross a bounded
//! queue to a background writer thread; a full queue drops the event and counts
//! it, and the writer reports the count as a `journal_drops` event as soon as it
//! can write again. Losing diagnostics under pressure is always preferable to
//! stalling sync or the editor, so there is no backpressure path.
//!
//! `Journal::default()` is a no-op sink, which is what a caller that has not
//! been given a data directory holds.

mod reader;
mod segments;
mod writer;

pub use reader::{read_events, RecordedEvent};

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Stamped on every line as `v`. Bump it when the envelope or a payload changes
/// shape in a way a reader has to know about.
pub const JOURNAL_SCHEMA_VERSION: u32 = 1;

/// What a full queue eventually produces: how many records were lost since the
/// last report. The writer thread emits it, so pressure can never suppress the
/// report of that pressure.
pub const DROPS_EVENT_TYPE: &str = "journal_drops";

/// Retention and queue sizing. The defaults are the shipped policy: a ~20 MB
/// ring of 4 MB segments, and a queue deep enough to absorb a sync run's burst
/// without ever making a caller wait.
#[derive(Debug, Clone, Copy)]
pub struct JournalLimits {
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub queue_capacity: usize,
}

impl Default for JournalLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 4 * 1024 * 1024,
            max_total_bytes: 20 * 1024 * 1024,
            queue_capacity: 512,
        }
    }
}

/// A cheap, cloneable handle to one instance journal. Clones share the queue and
/// the writer thread; the writer is shut down and joined when the last clone is
/// dropped, so a process that exits cleanly loses nothing already recorded.
#[derive(Clone, Default)]
pub struct Journal {
    sink: Option<Arc<JournalSink>>,
}

impl Journal {
    /// A journal that discards everything. The default for a caller with no
    /// resolved data directory — every shell that has not been wired up yet
    /// keeps working, and instrumentation costs a null check.
    pub fn disabled() -> Self {
        Self::default()
    }

    /// Opens (creating if needed) the segment ring in `directory` and starts its
    /// writer thread. `directory` must be inside the app data dir, never a note
    /// vault.
    pub fn open(directory: impl AsRef<Path>, limits: JournalLimits) -> Result<Self, String> {
        Self::spawn(directory.as_ref(), limits, None)
    }

    pub fn is_enabled(&self) -> bool {
        self.sink.is_some()
    }

    /// Queues one event. Returns immediately whether or not the event is kept:
    /// serialization happens here (pure CPU, no I/O), the write happens on the
    /// writer thread, and a full queue drops the event rather than waiting.
    pub fn record<T: Serialize + ?Sized>(&self, event_type: &str, data: &T) {
        let Some(sink) = self.sink.as_ref() else {
            return;
        };
        sink.send(encode_event(event_type, data));
    }

    fn spawn(
        directory: &Path,
        limits: JournalLimits,
        gate: Option<WriteGate>,
    ) -> Result<Self, String> {
        let segments = segments::JournalSegments::open(directory, limits)?;
        let dropped = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = sync_channel(limits.queue_capacity.max(1));
        let worker = writer::spawn(segments, receiver, Arc::clone(&dropped), gate)?;
        Ok(Self {
            sink: Some(Arc::new(JournalSink {
                sender: Some(sender),
                dropped,
                worker: Some(worker),
            })),
        })
    }
}

/// Lets a test hold the writer thread still so the queue provably fills. Only
/// `Journal::open_gated` (test-only) ever supplies one.
type WriteGate = Arc<dyn Fn() + Send + Sync>;

struct JournalSink {
    // `Option` so `Drop` can disconnect the channel before joining the writer.
    sender: Option<SyncSender<String>>,
    dropped: Arc<AtomicU64>,
    worker: Option<JoinHandle<()>>,
}

impl JournalSink {
    fn send(&self, line: String) {
        let Some(sender) = self.sender.as_ref() else {
            return;
        };
        // A disconnected channel means the writer thread is already gone, so
        // there is nothing left that could report a count.
        if let Err(TrySendError::Full(_)) = sender.try_send(line) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Drop for JournalSink {
    fn drop(&mut self) {
        // Disconnecting first tells the writer to flush and exit; joining then
        // guarantees every queued line reached disk before the caller moves on.
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Builds one JSONL line. Encoding the payload separately keeps this infallible:
/// a payload that cannot serialize is recorded as an error line instead of
/// silently vanishing, and the envelope is built as a `Value`, whose `Display`
/// cannot fail — a diagnostics sink must never panic its caller.
fn encode_event<T: Serialize + ?Sized>(event_type: &str, data: &T) -> String {
    let payload = serde_json::to_value(data)
        .unwrap_or_else(|error| serde_json::json!({ "journal_encode_error": error.to_string() }));
    serde_json::json!({
        "v": JOURNAL_SCHEMA_VERSION,
        "ts": now_ms(),
        "type": event_type,
        "data": payload,
    })
    .to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since_epoch| since_epoch.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;
    use std::sync::mpsc::{channel, Sender};
    use std::time::Duration;

    fn temp_dir() -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-journal-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    impl Journal {
        /// Opens a journal whose writer runs `gate` before each write, so a test
        /// can hold it still and fill the queue deterministically.
        fn open_gated(
            directory: &Path,
            limits: JournalLimits,
            gate: WriteGate,
        ) -> Result<Self, String> {
            Self::spawn(directory, limits, Some(gate))
        }
    }

    #[derive(Serialize)]
    struct SampleEvent {
        note_id: String,
        pushed: u32,
    }

    /// A ring small enough that a few hundred events roll and prune it, with a
    /// queue deep enough that nothing is dropped — these tests are about the
    /// files, not about pressure.
    fn small_ring() -> JournalLimits {
        JournalLimits {
            max_file_bytes: 256,
            max_total_bytes: 1024,
            queue_capacity: 1024,
        }
    }

    fn recorded_pushed_values(events: &[RecordedEvent]) -> Vec<u64> {
        events
            .iter()
            .filter(|event| event.event_type == "sync_run")
            .map(|event| event.data["pushed"].as_u64().unwrap())
            .collect()
    }

    #[test]
    fn a_disabled_journal_records_nothing_and_costs_no_directory() {
        let journal = Journal::disabled();
        assert!(!journal.is_enabled());
        journal.record(
            "sync_run",
            &SampleEvent {
                note_id: "a".into(),
                pushed: 1,
            },
        );
    }

    #[test]
    fn a_recorded_event_round_trips_through_the_envelope() {
        let root = temp_dir();
        let journal = Journal::open(&root, JournalLimits::default()).unwrap();
        journal.record(
            "sync_run",
            &SampleEvent {
                note_id: "folder/Note".to_owned(),
                pushed: 3,
            },
        );
        drop(journal);

        let events = read_events(&root).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.schema_version, JOURNAL_SCHEMA_VERSION);
        assert_eq!(event.event_type, "sync_run");
        assert!(event.recorded_at_ms > 0);
        assert_eq!(event.data["note_id"], "folder/Note");
        assert_eq!(event.data["pushed"], 3);
    }

    #[test]
    fn events_stay_in_the_order_they_were_recorded_across_segments() {
        let root = temp_dir();
        let journal = Journal::open(&root, small_ring()).unwrap();
        for index in 0..12u32 {
            journal.record(
                "sync_run",
                &SampleEvent {
                    note_id: format!("note-{index}"),
                    pushed: index,
                },
            );
        }
        drop(journal);

        let events = read_events(&root).unwrap();
        let segment_count = fs::read_dir(&root).unwrap().count();
        fs::remove_dir_all(&root).unwrap();

        assert!(
            segment_count > 1,
            "12 events must not fit one 256-byte segment"
        );
        let recorded = recorded_pushed_values(&events);
        assert!(
            recorded.windows(2).all(|pair| pair[0] < pair[1]),
            "events must stay ordered oldest-first across the ring: {recorded:?}"
        );
    }

    #[test]
    fn the_ring_drops_the_oldest_segments_to_stay_under_the_total_cap() {
        let root = temp_dir();
        let limits = small_ring();
        let journal = Journal::open(&root, limits).unwrap();
        for index in 0..400u32 {
            journal.record(
                "sync_run",
                &SampleEvent {
                    note_id: format!("note-{index}"),
                    pushed: index,
                },
            );
        }
        drop(journal);

        let total_bytes: u64 = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.metadata().unwrap().len())
            .sum();
        let recorded = recorded_pushed_values(&read_events(&root).unwrap());
        fs::remove_dir_all(&root).unwrap();

        assert!(
            total_bytes <= limits.max_total_bytes,
            "ring grew to {total_bytes} bytes, cap is {}",
            limits.max_total_bytes
        );
        let first_kept = *recorded.first().unwrap();
        assert!(
            first_kept > 0,
            "the oldest events must have been dropped, kept from {first_kept}"
        );
        assert_eq!(
            *recorded.last().unwrap(),
            399,
            "the newest event must always survive"
        );
    }

    #[test]
    fn reopening_a_journal_keeps_the_events_already_on_disk() {
        let root = temp_dir();
        let first = Journal::open(&root, JournalLimits::default()).unwrap();
        first.record(
            "sync_run",
            &SampleEvent {
                note_id: "before".into(),
                pushed: 1,
            },
        );
        drop(first);

        let second = Journal::open(&root, JournalLimits::default()).unwrap();
        second.record(
            "sync_run",
            &SampleEvent {
                note_id: "after".into(),
                pushed: 2,
            },
        );
        drop(second);

        let events = read_events(&root).unwrap();
        fs::remove_dir_all(&root).unwrap();

        let ids: Vec<&str> = events
            .iter()
            .map(|event| event.data["note_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["before", "after"]);
    }

    // A stalled writer must never stall the caller: `record` returns, the queue
    // overflows, and every lost event is accounted for by a `journal_drops`
    // report rather than disappearing.
    #[test]
    fn a_stalled_writer_drops_events_instead_of_blocking_the_caller() {
        const RECORDED: u32 = 200;
        let root = temp_dir();
        let (release_sender, release_receiver) = channel::<()>();
        let release_sender: Sender<()> = release_sender;
        let gate_receiver = Arc::new(std::sync::Mutex::new(Some(release_receiver)));

        let journal = Journal::open_gated(
            &root,
            JournalLimits {
                queue_capacity: 4,
                ..small_ring()
            },
            Arc::new(move || {
                // Blocks the writer on its first write only; the test releases it.
                if let Some(receiver) = gate_receiver.lock().unwrap().take() {
                    let _ = receiver.recv();
                }
            }),
        )
        .unwrap();

        let started = std::time::Instant::now();
        for index in 0..RECORDED {
            journal.record(
                "sync_run",
                &SampleEvent {
                    note_id: format!("note-{index}"),
                    pushed: index,
                },
            );
        }
        let elapsed = started.elapsed();

        drop(release_sender); // releases the gate's `recv`
        drop(journal); // flushes and joins the writer

        let events = read_events(&root).unwrap();
        fs::remove_dir_all(&root).unwrap();

        assert!(
            elapsed < Duration::from_secs(5),
            "recording behind a stalled writer must not wait on it (took {elapsed:?})"
        );
        let dropped: u64 = events
            .iter()
            .filter(|event| event.event_type == DROPS_EVENT_TYPE)
            .map(|event| event.data["dropped"].as_u64().unwrap())
            .sum();
        let written = events
            .iter()
            .filter(|event| event.event_type == "sync_run")
            .count() as u64;
        assert!(
            dropped > 0,
            "a 4-deep queue behind a stalled writer must overflow"
        );
        assert_eq!(
            written + dropped,
            u64::from(RECORDED),
            "every recorded event is either written or reported as dropped"
        );
    }
}
