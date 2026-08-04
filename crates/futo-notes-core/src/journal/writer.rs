use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use super::segments::JournalSegments;
use super::{encode_event, WriteGate, DROPS_EVENT_TYPE};

/// Starts the one thread that owns the segment ring. It exits when every sender
/// is gone, after flushing the last pressure report — so dropping the last
/// `Journal` handle is a clean shutdown, not a truncation.
pub(super) fn spawn(
    mut segments: JournalSegments,
    receiver: Receiver<String>,
    dropped: Arc<AtomicU64>,
    gate: Option<WriteGate>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("futo-journal".to_owned())
        .spawn(move || {
            let mut failures = FailureReporter::default();
            while let Ok(line) = receiver.recv() {
                if let Some(gate) = gate.as_ref() {
                    gate();
                }
                report_drops(&mut segments, &dropped, &mut failures);
                failures.check(segments.append(&line));
            }
            report_drops(&mut segments, &dropped, &mut failures);
        })
        .map_err(|error| format!("{error} (starting the journal writer thread)"))
}

/// Writes how many records the queue lost since the last report. Emitting it
/// from the writer rather than the producer means queue pressure can never
/// suppress the record of that pressure.
fn report_drops(
    segments: &mut JournalSegments,
    dropped: &AtomicU64,
    failures: &mut FailureReporter,
) {
    let count = dropped.swap(0, Ordering::Relaxed);
    if count == 0 {
        return;
    }
    let line = encode_event(DROPS_EVENT_TYPE, &serde_json::json!({ "dropped": count }));
    failures.check(segments.append(&line));
}

/// A journal write failure has no caller to return to — the producer is long
/// gone. Reporting the first one to stderr keeps a broken journal (full disk,
/// vanished directory) from being silently invisible, while staying quiet
/// afterwards so a persistent failure cannot itself become the noise.
#[derive(Default)]
struct FailureReporter {
    reported: bool,
}

impl FailureReporter {
    fn check(&mut self, result: Result<(), String>) {
        if let Err(error) = result {
            if !self.reported {
                self.reported = true;
                eprintln!("[journal] writing stopped being possible: {error}");
            }
        }
    }
}
