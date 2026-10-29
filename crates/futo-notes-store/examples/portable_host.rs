//! Minimal test worker for the compiled WASM consumer; not a production shell.
use std::io::{self, BufRead, Write};

use futo_notes_editor::{HostRequest, SessionToken};
use futo_notes_store::LocalNoteStore;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args_os().nth(1).ok_or("scratch vault required")?;
    let store = LocalNoteStore::new(root.into());
    store.create("", "plain", "__a__\r\n")?;
    let session = store.open_editor("plain")?;
    let mut output = io::stdout().lock();
    let mut host = session.into_portable_host(SessionToken(17));
    serde_json::to_writer(&mut output, &host.snapshot())?;
    output.write_all(b"\n")?;
    output.flush()?;
    for line in io::stdin().lock().lines() {
        let request: HostRequest = serde_json::from_str(&line?)?;
        serde_json::to_writer(&mut output, &host.handle(request))?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}
