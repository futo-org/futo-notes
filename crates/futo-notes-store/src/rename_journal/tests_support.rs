//! A test-only fault point at each durable step of a journaled move.

use std::cell::RefCell;

type Hook = Box<dyn FnMut(&str) -> Result<(), String>>;
thread_local! {
    static BEFORE_STEP: RefCell<Option<Hook>> = RefCell::new(None);
}

/// Runs on this thread before each step: `move <from> -> <to>` for every file
/// or folder move, `stage` once every source is staged but before that is
/// recorded, `commit` before the committed record is written, and
/// `recovered` before recovery records what it did. An
/// `Err` fails that step.
pub fn on_step(hook: impl FnMut(&str) -> Result<(), String> + 'static) {
    BEFORE_STEP.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

pub fn clear() {
    BEFORE_STEP.with(|slot| *slot.borrow_mut() = None);
}

pub fn before_step(step: &str) -> Result<(), String> {
    BEFORE_STEP.with(|slot| match slot.borrow_mut().as_mut() {
        Some(hook) => hook(step),
        None => Ok(()),
    })
}
