import ObjectiveC
import ObjectiveC.runtime
import UIKit
import WebKit

// MARK: - Input-accessory override

/// Cache of runtime-generated subclasses, keyed by the base class name, so we
/// only build each one once. Single-threaded use (main actor / UI) only.
private nonisolated(unsafe) var futoAccessoryClasses: [String: AnyClass] = [:]

/// The view the swizzled `inputAccessoryView` getter returns. nil = no bar at
/// all (the original behavior of this hack, which only STRIPPED Apple's
/// prev/next/Done bar); EditorHost sets the native markdown toolbar here.
/// One global is enough: the app has exactly one editor WKWebView (EditorHost
/// is a singleton).
private nonisolated(unsafe) var futoAccessoryOverrideView: UIView?

extension WKWebView {
    /// Replaces the keyboard input-accessory bar (the prev / next / Done
    /// toolbar shown above the keyboard for web content) with `view` — or
    /// with nothing when `view` is nil. There is no public API for this: the
    /// bar belongs to the private `WKContentView` that is the actual first
    /// responder, not to the `WKWebView`. We give that view a runtime
    /// subclass whose `inputAccessoryView` getter returns our override.
    // swift-format-ignore: AlwaysUseLowerCamelCase
    func futo_overrideInputAccessoryView(_ view: UIView?) {
        futoAccessoryOverrideView = view
        guard
            let contentView = scrollView.subviews.first(where: {
                let name = String(describing: type(of: $0))
                return name.hasPrefix("WKContentView") || name.contains("ContentView")
            })
        else { return }

        defer {
            // If the keyboard is already up, make it re-query the accessory.
            if contentView.isFirstResponder { contentView.reloadInputViews() }
        }

        let baseClass: AnyClass = type(of: contentView)
        let newName = "FutoAccessoryOverride_" + NSStringFromClass(baseClass)

        if let cached = futoAccessoryClasses[newName] {
            object_setClass(contentView, cached)
            return
        }
        guard let subclass = objc_allocateClassPair(baseClass, newName, 0) else { return }
        let sel = #selector(getter: UIResponder.inputAccessoryView)
        let block: @convention(block) (AnyObject) -> UIView? = { _ in
            futoAccessoryOverrideView
        }
        let imp = imp_implementationWithBlock(block)
        // method_getTypeEncoding returns UnsafePointer<CChar>?; pass it through
        // directly (a Swift String literal auto-bridges for the fallback).
        if let method = class_getInstanceMethod(baseClass, sel),
            let types = method_getTypeEncoding(method)
        {
            class_addMethod(subclass, sel, imp, types)
        } else {
            class_addMethod(subclass, sel, imp, "@@:")
        }
        objc_registerClassPair(subclass)
        futoAccessoryClasses[newName] = subclass
        object_setClass(contentView, subclass)
    }
}
