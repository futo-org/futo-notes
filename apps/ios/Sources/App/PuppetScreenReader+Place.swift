#if DEBUG
    import UIKit
    import WebKit

    @MainActor
    extension PuppetScreenReader {
        /// The part of the screen a view is in, the scrolling container holding it, and its
        /// row in that container when it is a list's cell.
        struct Place {
            let section: String
            let scroll: UIScrollView?
            let row: Int?
        }

        /// A presented surface (`sheet`, `dialog`, `menu`) prefixes the region inside it (`top
        /// bar`, `list`, `bottom bar`, `keyboard toolbar`, else `content`). Regions come from
        /// the views UIKit builds them from; a bar SwiftUI floats at the bottom (the search
        /// field) has none, so the bottom fifth of the screen is the bottom bar.
        static func place(of host: UIView, frame: CGRect, screen: CGRect) -> Place? {
            var region: String?
            var scroll: UIScrollView?
            var cell: UICollectionViewCell?
            var menu = false
            var view: UIView? = host
            while let current = view {
                if current is WKWebView { return nil }
                let name = "\(type(of: current))"
                if name.contains("ContextMenuContainerView") { menu = true }
                if region == nil, scroll == nil {
                    if current is UINavigationBar || name.contains("NavigationBarLargeTitle") {
                        region = "top bar"
                    } else if current is UIToolbar || current is UITabBar {
                        region = "bottom bar"
                    }
                }
                if cell == nil, scroll == nil { cell = current as? UICollectionViewCell }
                if scroll == nil, region == nil { scroll = current as? UIScrollView }
                view = current.superview
            }
            if menu { return Place(section: "menu", scroll: nil, row: nil) }
            let windowName = host.window.map { "\(type(of: $0))" } ?? ""
            let keyboard = windowName.contains("TextEffects") || windowName.contains("Keyboard")
            if keyboard { region = "keyboard toolbar" }
            var row: Int?
            if let list = scroll as? UICollectionView, let cell,
                let index = list.indexPath(for: cell)
            {
                row = (0..<index.section).reduce(index.item) {
                    $0 + list.numberOfItems(inSection: $1)
                }
            }
            if region == nil {
                if let scroll {
                    region = scroll is UICollectionView || scroll is UITableView ? "list" : "scroll"
                } else if frame.midY > screen.height * 0.8 {
                    region = "bottom bar"
                }
            }
            let surface = presentedSurface(of: host)
            let section =
                switch (surface, region) {
                case (nil, nil): "content"
                case (nil, let region?): region
                case (let surface?, nil): surface
                case (let surface?, let region?): "\(surface) · \(region)"
                }
            return Place(section: section, scroll: scroll, row: row)
        }

        /// `sheet` or `dialog` when the view belongs to a presented view controller: an alert,
        /// or a full-screen cover (this app's dialogs), is a dialog; anything else a sheet.
        private static func presentedSurface(of view: UIView) -> String? {
            var responder: UIResponder? = view
            while let current = responder, !(current is UIViewController) {
                responder = current.next
            }
            guard var root = responder as? UIViewController else { return nil }
            while let parent = root.parent { root = parent }
            guard root.presentingViewController != nil else { return nil }
            if root is UIAlertController { return "dialog" }
            switch root.modalPresentationStyle {
            case .fullScreen, .overFullScreen, .custom, .currentContext, .overCurrentContext:
                return "dialog"
            default:
                return "sheet"
            }
        }
    }
#endif
