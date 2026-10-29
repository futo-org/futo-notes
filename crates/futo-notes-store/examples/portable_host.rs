//! Minimal test worker for the compiled WASM consumer; not a production shell.
use std::io::{self, BufRead, Write};

use futo_notes_editor::{HostRequest, SessionToken};
use futo_notes_store::LocalNoteStore;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args_os().nth(1).ok_or("scratch vault required")?;
    let store = LocalNoteStore::new(root.into());
    let lifecycle = std::env::args().nth(2).as_deref() == Some("lifecycle");
    store.create(
        "",
        "plain",
        if lifecycle { "[[plain]]" } else { "__a__\r\n" },
    )?;
    let session = store.open_editor("plain")?;
    let mut output = io::stdout().lock();
    let mut host = session.into_portable_host(SessionToken(17));
    serde_json::to_writer(&mut output, &host.snapshot())?;
    output.write_all(b"\n")?;
    output.flush()?;
    for line in io::stdin().lock().lines() {
        let value: serde_json::Value = serde_json::from_str(&line?)?;
        let response =
            if let Some(destination) = value.get("rename").and_then(|value| value.as_str()) {
                let mutation = store.rename(&host.id(), destination)?;
                serde_json::json!({"id": mutation.final_id})
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
    Ok(())
}
