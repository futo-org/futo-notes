use std::fs;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::atomic_write::write_atomic_bytes;

pub fn read_blob_as_base64(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| STANDARD.encode(bytes))
        .map_err(|error| error.to_string())
}

pub fn write_base64_as_blob(path: &Path, content: &str) -> Result<(), String> {
    let bytes = STANDARD
        .decode(content.as_bytes())
        .map_err(|error| format!("invalid base64 image content: {error}"))?;
    write_atomic_bytes(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static SEQUENCE: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "futo-notes-blob-file-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn binary_blob_round_trip_is_not_utf8_dependent() {
        let root = temp_dir();
        let source = root.join("source.png");
        let destination = root.join("destination.png");
        let bytes = [0, 159, 255, 13, 10, 42];
        write_atomic_bytes(&source, &bytes).unwrap();
        let encoded = read_blob_as_base64(&source).unwrap();
        write_base64_as_blob(&destination, &encoded).unwrap();
        assert_eq!(fs::read(destination).unwrap(), bytes);
        assert!(write_base64_as_blob(&root.join("bad.png"), "not base64!").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
