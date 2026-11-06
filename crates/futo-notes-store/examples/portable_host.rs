//! Minimal test worker for the compiled WASM consumer; not a production shell.
use std::io::{self, BufRead, Write};

use futo_notes_editor::{HostRequest, SessionToken};
use futo_notes_store::LocalNoteStore;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args_os().nth(1).ok_or("scratch vault required")?;
    let store = LocalNoteStore::new(root.into());
    // The lifecycle fixture, captured literal sources and reopen mode all
    // use the same public store open workflow. A literal source is planted
    // byte for byte: `create` is an authored write, which would append the
    // final line ending a captured source may deliberately lack.
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
        store.create("", "plain", "")?;
        std::fs::write(
            futo_notes_core::files::safe_note_path(store.root(), "plain")?,
            source,
        )?;
    }
    let session = store.open_editor(reopen_id.unwrap_or("plain"))?;
    let mut output = io::stdout().lock();
    let mut host = session.into_portable_host(SessionToken(17))?;
    serde_json::to_writer(&mut output, &host.snapshot())?;
    output.write_all(b"\n")?;
    output.flush()?;
    for line in io::stdin().lock().lines() {
        let value: serde_json::Value = serde_json::from_str(&line?)?;
        let response = if let Some(destination) =
            value.get("rename").and_then(|value| value.as_str())
        {
            let mutation = store.rename(&host.id(), destination)?;
            serde_json::json!({"id": mutation.final_id})
        } else if let Some(destination) = value.get("external_rename").and_then(|v| v.as_str()) {
            let from = host.id();
            let root = store.root();
            // Test input representing the sync writer's committed move.
            std::fs::rename(
                futo_notes_core::files::safe_note_path(root, &from)?,
                futo_notes_core::files::safe_note_path(root, destination)?,
            )?;
            let mutation = store.refresh_external_changes(
                &[],
                &[],
                &[futo_notes_store::NoteRename {
                    from,
                    to: destination.to_owned(),
                }],
            )?;
            serde_json::json!({"id": host.id(), "renamed": mutation.renamed})
        } else if let Some(merge) = value.get("merge") {
            let remote = merge
                .get("remote")
                .and_then(|value| value.as_str())
                .ok_or("merge source missing")?;
            store.write(&host.id(), remote, None)?;
            serde_json::to_value(host.checkpoint_merged()?)?
        } else if value.get("checkpoint").is_some() {
            host.checkpoint()?;
            serde_json::json!({"id": host.id()})
        } else {
            let request: HostRequest = serde_json::from_value(value)?;
            serde_json::to_value(host.handle(request))?
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    // A clean shutdown (stdin closed) saves the draft like a real host's close.
    host.close()?;
    Ok(())
}
