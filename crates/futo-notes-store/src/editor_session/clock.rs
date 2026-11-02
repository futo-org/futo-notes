use std::time::{Duration, Instant};

/// Monotonic elapsed time. Hosts schedule the reported save deadline on a
/// background worker; no timer runs inside the session.
pub trait EditorClock: Send + Sync {
    fn now(&self) -> Duration;
}

pub(super) struct MonotonicClock(Instant);

impl Default for MonotonicClock {
    fn default() -> Self {
        Self(Instant::now())
    }
}

impl EditorClock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// One injected monotonic source governs history boundaries and save
/// deadlines, while each policy remains in its owning layer.
pub(super) struct GroupingClock(pub std::sync::Arc<dyn EditorClock>);
impl futo_notes_editor::HistoryClock for GroupingClock {
    fn now(&self) -> Duration {
        self.0.now()
    }
}
