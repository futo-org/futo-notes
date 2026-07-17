use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT_TEMP_DIR: AtomicU32 = AtomicU32::new(0);

pub struct TempTree {
    root: PathBuf,
}

impl TempTree {
    pub fn new() -> Self {
        let suffix = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "futo-notes-ffi-contract-{}-{suffix}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        Self { root }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
