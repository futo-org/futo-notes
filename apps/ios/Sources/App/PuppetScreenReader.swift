#if DEBUG
    import UIKit
    import WebKit

    /// What a person can see and touch on screen, read from the app's own accessibility
    /// tree: the listener's `GET /tree`, the same shape the Android listener answers with, so
    /// `futo-puppet` (crates/futo-puppet/src/native.rs) reads both phones one way.
    ///
    /// Read in-process rather than from outside through the simulator: it costs milliseconds,
    /// not the ~0.3 s an outside reader spends starting up, and the app can answer what the
    /// tree alone cannot. An element is on screen only when the windows' own hit test at its
    /// point reaches it, so a row slid under a bar, behind a sheet or a dialog's dimming, or
    /// under the keyboard is not. Each element names the part of the screen it is in (a bar,
    /// a list, a sheet, a menu, the keyboard's toolbar), and each list that scrolls says how
    /// far and how many rows it holds. The editor web view's content is left to the page,
    /// which reports it with its handlers.
    @MainActor
    enum PuppetScreenReader {
        struct Node {
            let role: String
            let text: String
            let id: String?
            let frame: CGRect
            /// Where a touch activates it: a switch row's is its switch, which the label beside
            /// it does not flip.
            let aim: CGPoint
            let actions: [String]
            let flags: [String]
            let section: String
        }

        /// A scrolling container's state, gathered across the rows listed in it.
        struct Scroll {
            let section: String
            let view: UIScrollView
            var first = Int.max
            var last = -1
        }

        static func tree() -> [String: Any] {
            var reader = Reader(
                UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let screen = reader.screen
            let windows = reader.windows
            for window in windows { reader.walk(window, clip: screen) }
            return [
                "screen": ["w": Int(screen.width.rounded()), "h": Int(screen.height.rounded())],
                "scale": 1,
                "nodes": reader.nodes.map { node in
                    var entry: [String: Any] = [
                        "role": node.role, "text": node.text, "id": node.id ?? NSNull(),
                        "x": Int(node.frame.minX.rounded()), "y": Int(node.frame.minY.rounded()),
                        "w": Int(node.frame.width.rounded()), "h": Int(node.frame.height.rounded()),
                        "actions": node.actions, "flags": node.flags, "section": node.section,
                    ]
                    // Only where it is not the middle, which is where a touch goes by default.
                    if abs(node.aim.x - node.frame.midX) > 1
                        || abs(node.aim.y - node.frame.midY) > 1
                    {
                        entry["aim"] = [
                            "x": Int(node.aim.x.rounded()), "y": Int(node.aim.y.rounded()),
                        ]
                    }
                    return entry
                },
                "scroll": reader.scrolls.map(describe),
                "moving": transitioning(windows),
            ]
        }

        /// Whether a push, pop, presentation or dismissal is in flight. UIKit stops a screen
        /// taking touches while one runs, so every element reads as covered until it ends; a
        /// reader waiting for the screen to hold still has to wait for this too.
        private static func transitioning(_ windows: [UIWindow]) -> Bool {
            func moving(_ controller: UIViewController) -> Bool {
                controller.transitionCoordinator != nil
                    || controller.children.contains(where: moving)
                    || controller.presentedViewController.map(moving) == true
            }
            return windows.compactMap(\.rootViewController).contains(where: moving)
        }

        /// Whether a touch at the view's centre lands on it, or is taken by something drawn
        /// over it: the editor web view under a sheet or a dialog is not there to aim at.
        static func reaches(_ view: UIView) -> Bool {
            guard let window = view.window, let scene = window.windowScene else { return false }
            let reader = Reader(scene)
            let centre = view.convert(
                CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: window.screen.coordinateSpace
            )
            guard let hit = reader.hit(centre) else { return false }
            return hit === view || hit.isDescendant(of: view)
        }

        /// `{section, up, down, left, right}` for where more content is, plus `first`, `last`
        /// (1-based) and `total` when the container is a list whose rows can be counted.
        private static func describe(_ scroll: Scroll) -> [String: Any] {
            let view = scroll.view
            let inset = view.adjustedContentInset
            let offset = view.contentOffset
            var entry: [String: Any] = [
                "section": scroll.section,
                "up": offset.y > -inset.top + 1,
                "down": offset.y + view.bounds.height < view.contentSize.height + inset.bottom - 1,
                "left": offset.x > -inset.left + 1,
                "right": offset.x + view.bounds.width < view.contentSize.width + inset.right - 1,
            ]
            if let list = view as? UICollectionView, scroll.last >= 0 {
                let total = (0..<list.numberOfSections).reduce(0) {
                    $0 + list.numberOfItems(inSection: $1)
                }
                entry["first"] = scroll.first + 1
                entry["last"] = scroll.last + 1
                entry["total"] = total
            }
            return entry
        }

        @MainActor
        struct Reader {
            let screen: CGRect
            let windows: [UIWindow]
            let statusBar: CGRect
            var nodes: [Node] = []
            var scrolls: [Scroll] = []

            init(_ scene: UIWindowScene?) {
                screen = scene?.screen.bounds ?? .zero
                // Bottom to top, so what is drawn over something comes after it.
                windows = (scene?.windows ?? []).filter { !$0.isHidden && $0.alpha > 0.01 }
                    .sorted { $0.windowLevel < $1.windowLevel }
                statusBar = scene?.statusBarManager?.statusBarFrame ?? .zero
            }

            /// VoiceOver's own walk: an element's children are its label; a container's are its
            /// `accessibilityElements`, else its indexed elements, else (a view) its subviews.
            /// `clip` is what the scrolling containers it is in leave of the screen.
            mutating func walk(_ object: NSObject, clip: CGRect) {
                if let view = object as? UIView, view.isHidden || view.alpha < 0.01 { return }
                // The editor's page reports its own content, with the handlers behind it.
                if object is WKWebView { return }
                if object.accessibilityElementsHidden { return }
                if object.isAccessibilityElement {
                    read(object, clip: clip)
                    return
                }
                var clip = clip
                if let view = object as? UIView {
                    clip = clip.intersection(PuppetScreenReader.shown(view))
                }
                for child in PuppetScreenReader.children(of: object) { walk(child, clip: clip) }
            }

            /// Where a touch lands: the topmost window whose hit test takes the point, and there
            /// the view it hits. The status bar is another process's; a touch there scrolls
            /// the list to the top instead of reaching what is under it.
            func hit(_ point: CGPoint) -> UIView? {
                if statusBar.contains(point) { return nil }
                for window in windows.reversed() where window.isUserInteractionEnabled {
                    let local = window.convert(point, from: window.screen.coordinateSpace)
                    if let view = window.hitTest(local, with: nil) { return view }
                }
                return nil
            }

            /// Only the part a person sees: a scrolling container the walk or the element's
            /// own view is in clips away the rest, and the touch aims at what is left.
            private mutating func read(_ object: NSObject, clip: CGRect) {
                guard let host = PuppetScreenReader.hostView(of: object) else { return }
                var frame = object.accessibilityFrame.intersection(clip)
                var ancestor: UIView? = host
                while let current = ancestor {
                    frame = frame.intersection(PuppetScreenReader.shown(current))
                    ancestor = current.superview
                }
                guard !frame.isNull, frame.width >= 1, frame.height >= 1 else { return }
                let point = object.accessibilityActivationPoint
                let aim = frame.contains(point) ? point : CGPoint(x: frame.midX, y: frame.midY)
                // Reached when the touch lands on the element's view, inside it, or on a view
                // holding it that takes the touch for it (a label's cell, a segment's control).
                // A touch that lands in another branch (a bar, a sheet, a dialog's dimming)
                // means something else is on top.
                guard let hit = hit(aim),
                    hit === host || hit.isDescendant(of: host) || host.isDescendant(of: hit),
                    let place = PuppetScreenReader.place(of: host, frame: frame, screen: screen),
                    let node = PuppetScreenReader.node(
                        object, frame: frame, host: host, aim: aim, section: place.section)
                else { return }
                nodes.append(node)
                if let view = place.scroll {
                    if !scrolls.contains(where: { $0.view === view }) {
                        scrolls.append(Scroll(section: place.section, view: view))
                    }
                    let index = scrolls.firstIndex { $0.view === view } ?? 0
                    if let row = place.row {
                        scrolls[index].first = min(scrolls[index].first, row)
                        scrolls[index].last = max(scrolls[index].last, row)
                    }
                }
            }
        }

        static func children(of object: NSObject) -> [NSObject] {
            if let elements = object.accessibilityElements as? [NSObject], !elements.isEmpty {
                return elements
            }
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 {
                return (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject }
            }
            return (object as? UIView)?.subviews ?? []
        }

        /// A property SwiftUI's accessibility nodes answer without declaring the protocol
        /// that names it (`accessibilityIdentifier`, `accessibilityContainer`).
        private static func property(_ object: NSObject, _ name: String) -> Any? {
            object.responds(to: NSSelectorFromString(name)) ? object.value(forKey: name) : nil
        }

        /// What a scrolling view shows of its content, in screen points; everything for any
        /// other view, or one that draws its content past its edges.
        static func shown(_ view: UIView) -> CGRect {
            guard let scroll = view as? UIScrollView, scroll.clipsToBounds,
                let window = scroll.window
            else { return .infinite }
            return scroll.convert(scroll.bounds, to: window.screen.coordinateSpace)
        }

        /// The view an element lives in: itself, or the first view up its container chain.
        static func hostView(of object: NSObject) -> UIView? {
            var current: Any? = object
            for _ in 0..<12 {
                if let view = current as? UIView { return view }
                guard let next = current as? NSObject else { return nil }
                current = property(next, "accessibilityContainer")
            }
            return nil
        }

        static func node(
            _ object: NSObject, frame: CGRect, host: UIView, aim: CGPoint, section: String
        ) -> Node? {
            let traits = object.accessibilityTraits
            let label = oneLine(object.accessibilityLabel)
            let value = oneLine(object.accessibilityValue)
            let id = (property(object, "accessibilityIdentifier") as? String)
                .flatMap { $0.isEmpty ? nil : $0 }
            let field = object is UIKeyInput || traits.contains(.searchField)
            let role: String
            if let id, id.hasPrefix("note:") || id.hasPrefix("folder:") {
                role = "row"
            } else if field {
                role = "field"
            } else if traits.contains(.toggleButton) {
                role = "switch"
            } else if traits.contains(.adjustable) {
                role = "slider"
            } else if traits.contains(.button) || traits.contains(.link) {
                role = "button"
            } else if traits.contains(.header) {
                role = "heading"
            } else if traits.contains(.image) {
                role = "image"
            } else {
                role = "text"
            }
            var actions: [String] = []
            if ["row", "field", "switch", "slider", "button"].contains(role) {
                actions.append("tap")
            }
            if hasMenu(host, at: aim) { actions.append("hold") }
            let custom = (object.accessibilityCustomActions ?? []).map(\.name)
            if !custom.isEmpty { actions.append("actions=" + custom.joined(separator: "|")) }
            var flags: [String] = []
            if traits.contains(.notEnabled) { flags.append("disabled") }
            if traits.contains(.selected) {
                flags.append(role == "switch" ? "checked" : "selected")
            }
            if role == "switch", value == "1", !flags.contains("checked") {
                flags.append("checked")
            }
            if field, host.isFirstResponder { flags.append("focused") }
            let text = field ? (value.isEmpty ? label : value) : (label.isEmpty ? value : label)
            if role == "text" || role == "heading" || role == "image", text.isEmpty { return nil }
            return Node(
                role: role, text: text, id: id, frame: frame, aim: aim, actions: actions,
                flags: flags, section: section)
        }

        /// Whether a long press here opens a menu: a list row's, which its collection view's
        /// delegate builds, or a context-menu interaction on the element's own view. A row's
        /// swipe actions are not readable in-process (UIKit's accessibility bundle adds them,
        /// loaded only for an outside reader); a swipe's receipt shows them.
        private static func hasMenu(_ host: UIView, at point: CGPoint) -> Bool {
            if host.interactions.contains(where: { $0 is UIContextMenuInteraction }) { return true }
            // A list row: its collection view owns the menu interaction for every cell and
            // asks its delegate per row. Anything else is not a row, and a menu further up
            // (a bar's, the window's) is not this element's.
            var view = host.superview
            var cell = host as? UICollectionViewCell
            while let current = view {
                if let collection = current as? UICollectionView {
                    guard let cell, let index = collection.indexPath(for: cell),
                        let screen = collection.window?.screen
                    else { return false }
                    let local = collection.convert(point, from: screen.coordinateSpace)
                    return collection.delegate?.collectionView?(
                        collection, contextMenuConfigurationForItemsAt: [index], point: local)
                        != nil
                }
                if cell == nil { cell = current as? UICollectionViewCell }
                view = current.superview
            }
            return false
        }

        private static func oneLine(_ text: String?) -> String {
            (text ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        }
    }
#endif
