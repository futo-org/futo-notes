//! Minimal test worker for the compiled WASM consumer; not a production shell.
use std::io::{self, BufRead, Write};

use futo_notes_editor::{HostRequest, SessionToken};
use futo_notes_store::{LocalNoteStore, StoreBoundedEditorHost, StoreEditorHost};
enum TestHost<'a> {
    Full(StoreEditorHost<'a>),
    Bounded(StoreBoundedEditorHost<'a>),
}
impl TestHost<'_> {
    fn id(&self) -> String {
        match self {
            Self::Full(host) => host.id(),
            Self::Bounded(host) => host.id(),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args_os().nth(1).ok_or("scratch vault required")?;
    let store = LocalNoteStore::new(root.into());
    // The lifecycle fixture, captured literal sources and reopen mode all
    // use the same public store open/recovery workflow.
    let fixture = std::env::args().nth(2);
    let reopen_id = fixture
        .as_deref()
        .and_then(|fixture| fixture.strip_prefix("--reopen:"));
    if fixture.as_deref() != Some("--reopen") && reopen_id.is_none() {
        let source = match fixture.as_deref() {
            Some("lifecycle") => "[[plain]]",
            Some(source) => source,
            None => "__a__\r\n",
        };
        store.create("", "plain", source)?;
    }
    let session = store.open_editor(reopen_id.unwrap_or("plain"))?;
    let mut output = io::stdout().lock();
    let host = session.into_portable_host(SessionToken(17))?;
    serde_json::to_writer(&mut output, &host.snapshot())?;
    output.write_all(b"\n")?;
    output.flush()?;
    let mut host = Some(TestHost::Full(host));
    for line in io::stdin().lock().lines() {
        let value: serde_json::Value = serde_json::from_str(&line?)?;
        let response = if let Some(entry) = value.get("bounded_entry") {
            let Some(TestHost::Full(full)) = host.take() else {
                return Err("full host required".into());
            };
            let bounded = full
                .begin_bounded_entry(serde_json::from_value(entry.clone())?)
                .map_err(|failure| failure.error)?;
            let ready = serde_json::to_value(bounded.ready())?;
            host = Some(TestHost::Bounded(bounded));
            ready
        } else if value.get("bounded_full").is_some() || value.get("bounded_cancel").is_some() {
            let Some(TestHost::Bounded(bounded)) = host.take() else {
                return Err("bounded host required".into());
            };
            let full = if value.get("bounded_cancel").is_some() {
                bounded.cancel_bounded_entry()
            } else {
                bounded.into_full()
            }
            .map_err(|failure| failure.error)?;
            let snapshot = serde_json::to_value(full.snapshot())?;
            host = Some(TestHost::Full(full));
            snapshot
        } else if value.get("bounded_source").is_some() {
            match host.as_ref().unwrap() {
                TestHost::Full(full) => serde_json::json!({"source": full.snapshot().source}),
                TestHost::Bounded(bounded) => serde_json::json!({"source": bounded.source_text()}),
            }
        } else if let Some(destination) = value.get("rename").and_then(|value| value.as_str()) {
            let mutation = store.rename(&host.as_ref().unwrap().id(), destination)?;
            serde_json::json!({"id": mutation.final_id})
        } else if value.get("checkpoint").is_some() {
            let Some(TestHost::Full(full)) = host.as_mut() else {
                return Err("materialize host before checkpoint".into());
            };
            full.checkpoint()?;
            serde_json::json!({"id": full.id()})
        } else {
            match host.as_mut().unwrap() {
                TestHost::Full(full) => {
                    let request: HostRequest = serde_json::from_value(value)?;
                    serde_json::to_value(full.handle(request))?
                }
                TestHost::Bounded(bounded) => {
                    serde_json::to_value(bounded.handle(serde_json::from_value(value)?))?
                }
            }
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
