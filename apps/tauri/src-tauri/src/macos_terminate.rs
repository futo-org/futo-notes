//! macOS: route every AppKit `terminate:` through the window's close handler.
//!
//! Cmd-Q, Dock Quit, an AppleScript `quit` and logout/shutdown all reach the
//! process as `[NSApp terminate:]`. tao 0.34 answers that with
//! `applicationWillTerminate:` only (macos/app_delegate.rs), which tears the event
//! loop down without `CloseRequested` or `RunEvent::ExitRequested`, so the page's
//! close handler (`startNativeShell.ts`: flush the pending save, then exit) never
//! ran and an edit typed in the last ~0.5 s was lost (RC-85, 19 of 20 runs). The
//! Quit menu item is a custom item that closes the window (app_menu.rs); this
//! covers the callers that never touch the menu.
//!
//! tao's delegate has no `applicationShouldTerminate:`, so one is added to its
//! class at startup. It cancels the terminate and closes the main window instead;
//! the close handler flushes and exits through `app.exit`, which is how the app
//! has always ended. Cancel rather than `NSTerminateLater`: a later-reply terminate
//! runs AppKit's modal run-loop mode, in which the IPC the flush needs is not a
//! given. The price is that a logout or shutdown that raised the terminate is
//! cancelled once (the user retries; the app has closed itself by then), which is
//! what every Electron and Tauri app that flushes on quit does.

use std::ffi::c_char;
use std::sync::OnceLock;

use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{class, msg_send, sel};
use tauri::Manager;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// `NSApplicationTerminateReply` values.
const NS_TERMINATE_CANCEL: usize = 0;
const NS_TERMINATE_NOW: usize = 1;

extern "C" fn application_should_terminate(
    _this: *mut AnyObject,
    _cmd: Sel,
    _sender: *mut AnyObject,
) -> usize {
    match APP.get().and_then(|app| app.get_webview_window("main")) {
        Some(window) => {
            // The close handler saves, then exits the app itself.
            let _ = window.close();
            NS_TERMINATE_CANCEL
        }
        // No window, so no editor and nothing to flush.
        None => NS_TERMINATE_NOW,
    }
}

/// Adds the method to `class`. Split out so a test can aim it at a class of its own.
///
/// SAFETY: the runtime calls are plain; the method is added with the selector's
/// documented signature (`NSApplicationTerminateReply (id self, SEL, NSApplication *)`,
/// i.e. "Q@:@").
unsafe fn add_should_terminate(class: &AnyClass) -> Result<(), String> {
    let imp: Imp = std::mem::transmute::<
        extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
        Imp,
    >(application_should_terminate);
    let types = c"Q@:@";
    let added = class_addMethod(
        class as *const AnyClass as *mut AnyClass,
        sel!(applicationShouldTerminate:),
        imp,
        types.as_ptr() as *const c_char,
    );
    if added.as_bool() {
        Ok(())
    } else {
        Err("could not add applicationShouldTerminate: to the delegate".to_owned())
    }
}

/// Adds `applicationShouldTerminate:` to the application delegate's class.
/// Must run on the main thread after the delegate is installed (the setup hook).
pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    // SAFETY: plain Objective-C runtime calls on the main thread.
    unsafe {
        let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![ns_app, delegate];
        if delegate.is_null() {
            return Err("NSApplication has no delegate yet".to_owned());
        }
        let selector = sel!(applicationShouldTerminate:);
        let handled: Bool = msg_send![delegate, respondsToSelector: selector];
        if handled.as_bool() {
            return Err(
                "the application delegate already answers applicationShouldTerminate:".to_owned(),
            );
        }
        add_should_terminate((*delegate).class())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::ClassBuilder;

    /// The mechanism, without an app: a delegate class that lacks the method gains
    /// it, and calling it with no window to close answers "terminate now".
    #[test]
    fn adds_a_should_terminate_method_to_a_delegate_that_lacks_one() {
        let builder = ClassBuilder::new(c"FutoQuitFlushTestDelegate", class!(NSObject))
            .expect("the test class name is free");
        let class = builder.register();
        let instance: *mut AnyObject = unsafe { msg_send![class, new] };
        let selector = sel!(applicationShouldTerminate:);
        let before: Bool = unsafe { msg_send![instance, respondsToSelector: selector] };
        assert!(!before.as_bool());

        unsafe { add_should_terminate(class) }.expect("the method is added");
        let after: Bool = unsafe { msg_send![instance, respondsToSelector: selector] };
        assert!(after.as_bool());

        // No AppHandle is registered in a unit test, so there is no window to close.
        let reply: usize = unsafe { msg_send![instance, applicationShouldTerminate: instance] };
        assert_eq!(reply, NS_TERMINATE_NOW);

        // Adding twice is refused rather than silently replacing a method.
        assert!(unsafe { add_should_terminate(class) }.is_err());
    }
}
