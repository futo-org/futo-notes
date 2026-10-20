//! Tests for filesystem watcher event handling and suppression.
use super::*;

#[derive(Clone, Default)]
struct Recorder(Arc<Mutex<Vec<String>>>);

impl ChangeSink for Recorder {
    fn change(&self, kind: &str, relative_path: &str) {
        self.0
            .lock()
            .unwrap()
            .push(format!("{kind} {relative_path}"));
    }

    fn rename(&self, from: &str, to: &str) {
        self.0
            .lock()
            .unwrap()
            .push(format!("rename {from} -> {to}"));
    }
}

impl Recorder {
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }

    fn wait_for(&self, wanted: &str, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if self.0.lock().unwrap().iter().any(|seen| seen == wanted) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }
}

static VAULT_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn temp_vault(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "futo-watch-{label}-{}-{}",
        std::process::id(),
        VAULT_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn recording_processor(root: &Path) -> (EventProcessor<Recorder>, Recorder) {
    let recorder = Recorder::default();
    let processor = EventProcessor::new(
        watch_bases(root),
        Arc::default(),
        recorder.clone(),
        WatchMode::Inotify,
    );
    (processor, recorder)
}

fn rename_half(mode: RenameMode, path: PathBuf) -> Event {
    Event::new(EventKind::Modify(ModifyKind::Name(mode))).add_path(path)
}

mod classification_and_polling;
mod native_backend;
mod rename_pairing;
mod suppression_and_paths;
