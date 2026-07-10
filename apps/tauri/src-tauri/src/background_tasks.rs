//! Background thread and blocking-task helpers for desktop commands.

pub(crate) fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

pub(crate) fn join_error(error: impl std::fmt::Display) -> String {
    format!("join error: {error}")
}

pub(crate) async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(join_error)?
}

pub(crate) fn spawn<F>(name: &str, work: F) -> Result<(), String>
where
    F: FnOnce() + Send + 'static,
{
    std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(work)
        .map(|_| ())
        .map_err(|error| format!("failed to start {name}: {error}"))
}

#[cfg(test)]
mod tests {
    //! Tests for desktop background-task error contracts.

    use super::*;

    #[test]
    fn join_errors_keep_the_existing_ipc_message_prefix() {
        assert_eq!(join_error("cancelled"), "join error: cancelled");
    }
}
