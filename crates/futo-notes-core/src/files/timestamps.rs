use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use filetime::{set_file_mtime, FileTime};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub fn file_mtime_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_else(now_ms)
}

pub fn set_file_mtime_ms(path: &Path, modified_at_ms: i64) -> Result<(), String> {
    let milliseconds = modified_at_ms.max(0);
    let time = FileTime::from_unix_time(
        milliseconds / 1000,
        ((milliseconds % 1000) * 1_000_000) as u32,
    );
    set_file_mtime(path, time).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-timestamps-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn modification_time_round_trips_in_milliseconds() {
        let root = temp_dir();
        let path = root.join("note.md");
        fs::write(&path, "body").unwrap();
        set_file_mtime_ms(&path, 1_700_000_123_000).unwrap();
        let actual = file_mtime_ms(&fs::metadata(path).unwrap());
        assert!((actual - 1_700_000_123_000).abs() < 2_000);
        fs::remove_dir_all(root).unwrap();
    }
}
