#if DEBUG
    import UIKit

    /// The editor's own touch targets: task checkboxes and links are drawn into the text, not
    /// accessibility elements, so the screen reader cannot see them. Each is reported where a
    /// real tap reaches it (`/tree`'s nodes, section `editor`), and `at` names the one under a
    /// point. The convenience verbs `ToggleTask` and `OpenLink` act on the same targets.
    extension PuppetNativeEditor.Document {
        struct Link {
            let range: NSRange
            let target: TextFirstLinkTarget?
        }

        /// The line's task item, if it is one.
        func task(_ line: Line) -> TextFirstListRow? {
            guard line.range.location < text.length,
                let block = controller.storage.attribute(
                    .tfBlock, at: line.range.location, effectiveRange: nil)
                    as? TextFirstBlockAttribute,
                let list = block.list, block.showsMarker, list.marker == .task
            else { return nil }
            return list
        }

        /// Every link run on screen, with what a tap on it opens (nil: nothing). A link in a
        /// table cell is left out: a tap there opens the cell's editor, not the link.
        func links() -> [Link] {
            guard canReach, visible.length > 0 else { return [] }
            var found: [Link] = []
            controller.storage.enumerateAttributes(in: visible) { attributes, run, _ in
                if cell(containing: run) != nil { return }
                if let raw = attributes[.tfLinkURL] as? String {
                    found.append(
                        Link(range: run, target: controller.linkTarget(forDestination: raw)))
                } else if let note = attributes[.tfWikilink] as? String {
                    found.append(Link(range: run, target: .note(note)))
                }
            }
            return found
        }

        static func describe(_ target: TextFirstLinkTarget) -> String {
            switch target {
            case .note(let id): "note:\(id)"
            case .url(let url): url
            }
        }

        /// The task's checkbox as drawn, in screen points, when a tap there reaches it.
        func checkboxRect(_ line: Line) -> CGRect? {
            let tv = controller.textView
            guard let manager = tv.textLayoutManager,
                let location = manager.location(
                    manager.documentRange.location, offsetBy: line.range.location),
                let fragment = manager.textLayoutFragment(for: location)
                    as? TextFirstLayoutFragment,
                let box = fragment.checkboxRect, let window = tv.window
            else { return nil }
            let inset = tv.textContainerInset
            let local = box.offsetBy(
                dx: inset.left, dy: fragment.layoutFragmentFrame.minY + inset.top)
            return reachable(tv.convert(local, to: window.screen.coordinateSpace))
        }

        /// What a tap at `point` (screen points) lands on: a checkbox or a link.
        func control(atScreen point: CGPoint) -> [String: Any]? {
            let c = controller
            guard let window = c.textView.window else { return nil }
            let local = c.textView.convert(point, from: window.screen.coordinateSpace)
            if let fragment = c.checkboxFragment(at: local),
                let manager = c.textView.textLayoutManager
            {
                let offset = manager.offset(
                    from: manager.documentRange.location, to: fragment.rangeInElement.location)
                let row = line(at: offset)
                return [
                    "kind": "checkbox", "line": row.number,
                    "checked": task(row)?.checked ?? false,
                ]
            }
            if let target = c.linkTarget(at: local) {
                return ["kind": "link", "opens": Self.describe(target)]
            }
            return nil
        }

        /// A rect on screen, cut to the editor's visible frame, when a touch at its middle
        /// lands on the text view rather than on whatever covers it.
        func reachable(_ screen: CGRect) -> CGRect? {
            let rect = screen.intersection(frame)
            guard !rect.isNull, rect.width >= 1, rect.height >= 1,
                let scene = controller.textView.window?.windowScene,
                let hit = PuppetScreenReader.Reader(scene).hit(CGPoint(x: rect.midX, y: rect.midY)),
                hit === controller.textView || hit.isDescendant(of: controller.textView)
            else { return nil }
            return rect
        }
    }

    extension PuppetNativeEditor {
        /// `/tree` nodes for the editor's checkboxes and links on screen, in screen points.
        func controls() -> [[String: Any]] {
            guard let c = controller, ready else { return [] }
            let document = Document(c)
            guard document.canReach else { return [] }
            func node(_ role: String, _ text: String, _ rect: CGRect, id: String?, flags: [String])
                -> [String: Any]
            {
                [
                    "role": role, "text": text, "id": id ?? NSNull(),
                    "x": Int(rect.minX.rounded()), "y": Int(rect.minY.rounded()),
                    "w": Int(rect.width.rounded()), "h": Int(rect.height.rounded()),
                    "actions": ["tap"], "flags": flags, "section": "editor",
                ]
            }
            var nodes: [[String: Any]] = []
            for line in document.shown {
                guard let task = document.task(line), let rect = document.checkboxRect(line)
                else { continue }
                nodes.append(
                    node(
                        "checkbox", document.rendered(line.range), rect, id: nil,
                        flags: task.checked ? ["checked"] : []))
            }
            for link in document.links() {
                guard let shown = document.rect(link.range), let rect = document.reachable(shown)
                else { continue }
                nodes.append(
                    node(
                        "link", document.rendered(link.range), rect,
                        id: link.target.map { "editor-link:" + Document.describe($0) },
                        flags: link.target == nil ? ["broken"] : []))
            }
            return nodes
        }
    }
#endif
