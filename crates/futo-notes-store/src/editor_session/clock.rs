use std::time::{Duration, Instant};

/// Monotonic elapsed time. Hosts schedule the reported deadline on a background
/// worker; advancing the clock alone never acknowledges durable storage.
pub trait RecoveryClock: Send + Sync {
    fn now(&self) -> Duration;
}

pub(super) struct MonotonicClock(Instant);

impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}

impl RecoveryClock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}
