use std::sync::{Mutex, MutexGuard};

static VAULT_MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Process-wide serialization for one vault check-and-mutate span.
///
/// This is a leaf lock: keep the span limited to one read/check followed by
/// its write, rename, or remove, and never acquire another lock while it is
/// held.
pub fn vault_mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    VAULT_MUTATION_LOCK
        .lock()
        .map_err(|_| "vault mutation lock poisoned".to_owned())
}
