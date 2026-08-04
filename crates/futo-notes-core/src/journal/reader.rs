use std::fs;
use std::path::Path;

use super::segments::{existing_segments, segment_path};

/// One journal line, parsed. `data` stays a `serde_json::Value` because the
/// payload shape belongs to whichever crate recorded the event, not to the
/// journal.
#[derive(Debug, Clone)]
pub struct RecordedEvent {
    pub schema_version: u32,
    pub recorded_at_ms: u64,
    pub event_type: String,
    pub data: serde_json::Value,
}

/// Every event currently in `directory`, oldest first. A line that will not
/// parse is skipped rather than failing the read: a torn final line after a
/// crash is exactly when the rest of the journal matters most.
pub fn read_events(directory: impl AsRef<Path>) -> Result<Vec<RecordedEvent>, String> {
    let directory = directory.as_ref();
    let mut events = Vec::new();
    for (index, _) in existing_segments(directory) {
        let path = segment_path(directory, index);
        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("{error} (reading journal segment {})", path.display()))?;
        events.extend(contents.lines().filter_map(parse_event));
    }
    Ok(events)
}

fn parse_event(line: &str) -> Option<RecordedEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    Some(RecordedEvent {
        schema_version: value.get("v")?.as_u64()? as u32,
        recorded_at_ms: value.get("ts")?.as_u64()?,
        event_type: value.get("type")?.as_str()?.to_owned(),
        data: value
            .get("data")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_torn_line_does_not_hide_the_events_around_it() {
        let parsed: Vec<RecordedEvent> = [
            r#"{"v":1,"ts":10,"type":"sync_run","data":{"pushed":1}}"#,
            r#"{"v":1,"ts":20,"type":"sync_ru"#,
            r#"{"v":1,"ts":30,"type":"sync_run","data":{"pushed":2}}"#,
        ]
        .into_iter()
        .filter_map(parse_event)
        .collect();

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].recorded_at_ms, 10);
        assert_eq!(parsed[1].recorded_at_ms, 30);
    }

    #[test]
    fn reading_a_directory_that_has_never_been_journaled_is_empty_not_an_error() {
        let events = read_events(std::env::temp_dir().join("futo-notes-journal-absent")).unwrap();
        assert!(events.is_empty());
    }
}
