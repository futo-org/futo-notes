//! A test-only point on either side of the push's (unguarded) vault scan, so
//! a test can land a concurrent store operation exactly around it.

use std::cell::RefCell;

type Hook = Box<dyn FnMut(&str)>;
thread_local! {
    static AROUND_SCAN: RefCell<Option<Hook>> = RefCell::new(None);
}

/// Runs on this thread with `before` and `after` around every push scan.
pub(in crate::sync) fn on_scan(hook: impl FnMut(&str) + 'static) {
    AROUND_SCAN.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

pub(in crate::sync) fn clear() {
    AROUND_SCAN.with(|slot| *slot.borrow_mut() = None);
}

pub(super) fn around(point: &str) {
    AROUND_SCAN.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(point);
        }
    });
}
