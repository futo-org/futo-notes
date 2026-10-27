//! Every action's record, appended to `.puppet/trace.jsonl` in the repo.

use super::*;

const TRACE_FILE: &str = ".puppet/trace.jsonl";

/// Milliseconds since the Unix epoch: a trace record's time, a screenshot's name.
pub(crate) fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

pub(crate) fn append_trace(kind: &str, record: &Value) {
    let path = repo_root().join(TRACE_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let at = now_millis();
    // One write per record: formatting a Value into the file writes it token by token, and
    // two `just puppet` calls appending at once interleaved their records mid-line.
    let mut line = json!({ "at": at, "kind": kind, "record": record }).to_string();
    line.push('\n');
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        file.write_all(line.as_bytes()).ok();
    }
}
