use std::sync::{Mutex, MutexGuard};

static VAULT_MUTATION_LOCK: Mutex<()> = Mutex::new(());

/// Process-wide serialization for one vault check-and-mutate span.
///
/// Lock order is store gate -> vault guard -> suppression/search notification.
/// Code holding a suppression or search lock must never acquire this guard.
pub fn vault_mutation_guard() -> Result<MutexGuard<'static, ()>, String> {
    VAULT_MUTATION_LOCK
        .lock()
        .map_err(|_| "vault mutation lock poisoned".to_owned())
}
