import ObjectiveC
import ObjectiveC.runtime
import UIKit
import WebKit
import os

// MARK: - keyboardDisplayRequiresUserAction = false

/// Forces the iOS software keyboard to appear when a contenteditable / input
/// inside a WKWebView is focused — including the EMPTY-contenteditable case
/// (a brand-new note) that iOS otherwise suppresses. No public API exists; we
/// swizzle the private WKContentView focus method to force its
/// `userIsInteracting` argument to true. Selector verified stable iOS 13–27:
///   _elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:
/// From iOS 27 WebKit only calls it while the web view is first responder, so a
/// programmatic focus must take first responder first (`startAutoFocus`).
extension WKWebView {
    private static let keyboardLog =
        Logger(subsystem: "com.futo.notes", category: "wkwebview-keyboard")

    /// Runs exactly once per process (replaces the IMP on the shared
    /// WKContentView class, not per instance).
    private static let installKeyboardFix: Void = {
        guard let contentViewClass = NSClassFromString("WKContentView") else {
            WKWebView.keyboardLog.error("WKContentView not found; keyboard fix skipped")
            return
        }

        // ABI of _elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:
        //   arg0 information          const FocusedElementInformation&  -> UnsafeRawPointer
        //   arg1 userIsInteracting    BOOL                              -> Bool  (forced true)
        //   arg2 blurPreviousNode     BOOL                              -> Bool
        //   arg3 activityStateChanges OptionSet<ActivityState>          -> UInt
        //   arg4 userObject           NSObject<NSSecureCoding>*         -> Any?
        typealias FocusIMP13 =
            @convention(c) (Any, Selector, UnsafeRawPointer, Bool, Bool, UInt, Any?) -> Void
        typealias FocusBlock13 =
            @convention(block) (Any, UnsafeRawPointer, Bool, Bool, UInt, Any?) -> Void

        let selector = sel_getUid(
            "_elementDidFocus:userIsInteracting:blurPreviousNode:activityStateChanges:userObject:")
        guard let method = class_getInstanceMethod(contentViewClass, selector) else {
            WKWebView.keyboardLog.error("focus selector not found; keyboard fix NOT applied")
            return
        }
        let original = method_getImplementation(method)
        let orig = unsafeBitCast(original, to: FocusIMP13.self)
        let block: FocusBlock13 = { me, arg0, userInteracting, blurPrev, activity, userObject in
            // Force the keyboard ONLY when we intend to (new-note auto-focus);
            // otherwise pass the real userIsInteracting through, so opening an
            // existing note does not pop the keyboard.
            orig(
                me, selector, arg0, futoForceKeyboardOnFocus || userInteracting,
                blurPrev, activity, userObject)
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
        WKWebView.keyboardLog.info("keyboard fix installed")
    }()

    /// Call once, early. Safe to call repeatedly — the work runs exactly once.
    // swift-format-ignore: AlwaysUseLowerCamelCase
    static func futo_allowKeyboardWithoutUserInteraction() {
        _ = WKWebView.installKeyboardFix
    }
}

/// When true, the focus swizzle forces the keyboard up even for programmatic /
/// empty-contenteditable focus. We only flip it on for the brand-new-note
/// auto-focus, so opening an existing note never pops the keyboard.
nonisolated(unsafe) var futoForceKeyboardOnFocus = false
