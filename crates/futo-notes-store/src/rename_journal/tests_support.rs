use std::cell::RefCell;

type Hook = Box<dyn FnMut(&str, &str) -> Result<(), String>>;
thread_local! {
    static BEFORE_MOVE: RefCell<Option<Hook>> = RefCell::new(None);
}

/// Runs before every journaled move on this thread (source, destination).
/// An `Err` fails that move; a panic simulates a crash at that point.
pub(crate) fn on_move(hook: impl FnMut(&str, &str) -> Result<(), String> + 'static) {
    BEFORE_MOVE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

pub(crate) fn clear() {
    BEFORE_MOVE.with(|slot| *slot.borrow_mut() = None);
}

pub(crate) fn before_move(from: &str, to: &str) -> Result<(), String> {
    BEFORE_MOVE.with(|slot| match slot.borrow_mut().as_mut() {
        Some(hook) => hook(from, to),
        None => Ok(()),
    })
}
