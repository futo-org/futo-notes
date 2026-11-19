use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

static VAULT_MUTATION_LOCK: Mutex<()> = Mutex::new(());
static NOTE_MOVED: OnceLock<fn(&Path, &str, &str)> = OnceLock::new();

/// Process-wide serialization for one vault check-and-mutate span.
///
/// Lock order is store gate -> vault guard -> suppression/search notification.
/// Code holding a suppression or search lock must never acquire this guard.
pub fn vault_mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    VAULT_MUTATION_LOCK
        .lock()
        .map_err(|_| "vault mutation lock poisoned".to_owned())
}

/// Installs what hears [`note_moved`]: the note store, so an editor attached to
/// the moved note follows it. The first installation wins.
pub fn on_note_moved(observer: fn(&Path, &str, &str)) {
    let _ = NOTE_MOVED.set(observer);
}

/// A vault mutation moved the note file `from` to `to` (vault-relative
/// filenames). Call it while still holding the [`vault_mutation_guard`] the move
/// ran under, so no save of the note can land between the move and the follow.
pub fn note_moved(root: &Path, from: &str, to: &str) {
    if let Some(observer) = NOTE_MOVED.get() {
        observer(root, from, to);
    }
}
