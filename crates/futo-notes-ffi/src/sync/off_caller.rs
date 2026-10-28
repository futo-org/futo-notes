//! Keeps the work behind an async export off the thread that called it.
//!
//! A UniFFI future is polled by the *foreign* side: Kotlin and Swift call
//! `rust_future_poll` from whatever thread their coroutine or task is on, and
//! re-poll from that same thread after every wake-up. For a call made from the
//! UI's executor that means the whole body of the export runs on the UI thread
//! between awaits — the rustls handshake, and on Android the JNI call out to
//! the platform certificate verifier with it, plus disk I/O and the vault's
//! crypto. Android's StrictMode rightly refuses a network request there
//! (`NetworkOnMainThreadException`, which 1.9.0 hit on a CRL fetch), and
//! anything slower than that janks the UI.
//!
//! Every `async` export in this crate therefore runs its body through
//! [`off_caller`], which hands it to the Tokio runtime and leaves the foreign
//! poll with nothing to do but wait for the result. Doing it here, once, fixes
//! every shell at the same time.
//!
//! The body runs on its own task, in no fixed order with the caller's next
//! export, so anything a later export is measured against (a `WaitRequest`)
//! is taken before the hand-off.

use std::future::Future;

use tokio::task::JoinHandle;

/// Aborts the task when the foreign side drops the future, so cancelling the
/// caller (a dismissed auth sheet, a cancelled coroutine) still cancels the
/// work, exactly as it did when the body was polled in place.
struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Runs `work` on the runtime's own threads and resolves with its output.
///
/// Must be awaited from inside the context UniFFI polls exports in (the
/// `async_runtime = "tokio"` wrapper enters it), as `tokio::spawn` needs one.
/// A panic in `work` is re-raised in the caller, as if it had run there.
pub(crate) async fn off_caller<T, F>(work: F) -> T
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let mut task = AbortOnDrop(tokio::spawn(work));
    match (&mut task.0).await {
        Ok(output) => output,
        Err(error) => match error.try_into_panic() {
            Ok(panic) => std::panic::resume_unwind(panic),
            Err(error) => panic!("an async export was cancelled underneath its caller: {error}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    use super::off_caller;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("runtime")
    }

    /// The point of the helper: whoever polls the export (the UI thread, in the
    /// shells) is not the thread its body runs on.
    #[test]
    fn the_body_does_not_run_on_the_polling_thread() {
        runtime().block_on(async {
            let polling = thread::current().id();
            let running = off_caller(async { thread::current().id() }).await;
            assert_ne!(polling, running);
        });
    }

    /// Cancelling the caller must still cancel the work: an abandoned
    /// `await_sign_in` or `await_pairing` cannot be left polling a server.
    #[test]
    fn dropping_the_caller_cancels_the_body() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let rt = runtime();
        rt.block_on(async {
            let dropped = Arc::new(AtomicBool::new(false));
            let guard = Dropped(dropped.clone());
            let call = off_caller(async move {
                let _guard = guard;
                std::future::pending::<()>().await;
            });
            // Poll once so the task is spawned, then abandon it.
            let _ = tokio::time::timeout(std::time::Duration::from_millis(50), call).await;
            for _ in 0..100 {
                if dropped.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("the body kept running after its caller was dropped");
        });
    }
}
