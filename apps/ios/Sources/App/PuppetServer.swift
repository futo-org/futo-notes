#if DEBUG
    import Foundation
    import Network
    import SwiftUI

    /// The debug-only listener `futo-puppet` (crates/futo-puppet) drives the iOS
    /// app through. Loopback HTTP on `FUTO_PUPPET_PORT`; no port, no listener.
    ///
    /// Three kinds of verb arrive here. The shell's own (`OpenNote`, `GoBack`, the root
    /// list's and Settings' values: PuppetServerContract+NativeVerbs) run on the main actor
    /// against the same `NavigationStack` path the user taps through; so do the verbs a
    /// SwiftUI screen registers for its own controls (PuppetVerbs). The editor's are
    /// forwarded verbatim to the editor webview's `window.__futoPuppet.run(command,
    /// argsJson)` (src/app/puppet), which answers with the `{status, body}` this server
    /// relays unchanged.
    ///
    /// Wire: `GET /actions` · `GET /tree` (what is on screen, from the app's own
    /// accessibility: PuppetScreenReader; with where the editor webview sits when it is up,
    /// and the simulator: the CLI aims real touches with them) · `POST /do/<Verb>`
    /// (body = args) · `POST /<query>` (body = args): the shell answers state, notes,
    /// search, observe and touches, the page elements, doc, at, show, events, diff, trace
    /// and clipboard. A request over 256 KB is answered 413.
    /// Design record: docs/research/agent-native-app-design.md.
    final class PuppetServer {
        let navigation: AppNavigation
        let store: NotesStore
        let sync: SyncManager
        private let port: UInt16
        private var listener: NWListener?
        @MainActor private var pendingMutation: Task<Void, Never>?
        private let queue = DispatchQueue(label: "com.futo.notes.puppet-server")

        init(navigation: AppNavigation, store: NotesStore, sync: SyncManager, port: UInt16) {
            self.navigation = navigation
            self.store = store
            self.sync = sync
            self.port = port
        }

        /// Whether the software keyboard is up, for `state`'s `keyboard`. UIKit says so only by
        /// notification, so the listener follows it from the moment it starts.
        @MainActor static var keyboardUp = false
        private static let keyboardObservers: [NSObjectProtocol] = {
            func follow(_ name: Notification.Name, up: Bool) -> NSObjectProtocol {
                NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
                    _ in
                    MainActor.assumeIsolated { PuppetServer.keyboardUp = up }
                }
            }
            return [
                follow(UIResponder.keyboardDidShowNotification, up: true),
                follow(UIResponder.keyboardWillHideNotification, up: false),
            ]
        }()

        func start() {
            _ = Self.keyboardObservers
            guard listener == nil, let nwPort = NWEndpoint.Port(rawValue: port) else { return }
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = NWEndpoint.hostPort(
                host: .ipv4(.loopback),
                port: nwPort
            )
            guard let listener = try? NWListener(using: parameters) else {
                print("[futo-puppet] could not create a listener for 127.0.0.1:\(port)")
                return
            }
            self.listener = listener
            listener.stateUpdateHandler = { [port, weak self] state in
                switch state {
                case .ready:
                    print("[futo-puppet] listening on 127.0.0.1:\(port)")
                case .failed(let error):
                    print("[futo-puppet] FAILED to bind 127.0.0.1:\(port): \(error)")
                    self?.stop()
                case .cancelled:
                    print("[futo-puppet] stopped listening on 127.0.0.1:\(port)")
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else {
                    connection.cancel()
                    return
                }
                connection.start(queue: self.queue)
                self.receive(connection, buffer: Data())
            }
            listener.start(queue: queue)
        }

        private func stop() {
            listener?.cancel()
            listener = nil
        }

        private func receive(_ connection: NWConnection, buffer: Data) {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
                [weak self] chunk, _, isComplete, error in
                guard let self else {
                    connection.cancel()
                    return
                }
                if error != nil {
                    connection.cancel()
                    return
                }
                var accumulated = buffer
                if let chunk { accumulated.append(chunk) }
                if let request = PuppetHTTPRequest(accumulated) {
                    self.handle(request, on: connection)
                    return
                }
                if isComplete {
                    connection.cancel()
                    return
                }
                if accumulated.count > PuppetServerContract.maximumRequestBytes {
                    // Read the rest before answering: closing on unread bytes resets the
                    // connection, and the reset can reach the CLI before the answer does.
                    let declared = PuppetHTTPRequest.declaredSize(accumulated) ?? 0
                    self.refuseOversized(connection, unread: declared - accumulated.count)
                    return
                }
                self.receive(connection, buffer: accumulated)
            }
        }

        /// Drops the rest of a request over the size limit, then answers 413.
        private func refuseOversized(_ connection: NWConnection, unread: Int) {
            guard unread > 0 else {
                let (status, body) = PuppetServerContract.refusal(
                    413,
                    "a request is at most \(PuppetServerContract.maximumRequestBytes / 1024) KB")
                send(status: status, body: body, on: connection)
                return
            }
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
                [weak self] chunk, _, isComplete, error in
                guard let self, error == nil, let chunk else {
                    connection.cancel()
                    return
                }
                self.refuseOversized(connection, unread: isComplete ? 0 : unread - chunk.count)
            }
        }

        private func handle(_ request: PuppetHTTPRequest, on connection: NWConnection) {
            guard
                let route = PuppetServerContract.route(
                    method: request.method, path: request.path)
            else {
                let (status, body) = PuppetServerContract.refusal(
                    404, "no such route: \(request.method) \(request.path)")
                send(status: status, body: body, on: connection)
                return
            }
            // Serialised on the main actor: one command at a time, in arrival order.
            Task { @MainActor [weak self] in
                guard let self else {
                    connection.cancel()
                    return
                }
                let previous = self.pendingMutation
                let current = Task { @MainActor in
                    _ = await previous?.value
                    let (status, body) = await self.perform(route, body: request.body)
                    self.send(status: status, body: body, on: connection)
                }
                self.pendingMutation = current
                await current.value
            }
        }

        private func send(status: Int, body: Data, on connection: NWConnection) {
            let phrase = PuppetServerContract.reasonPhrase(for: status)
            let header =
                "HTTP/1.1 \(status) \(phrase)\r\n"
                + "Content-Type: application/json\r\n"
                + "Content-Length: \(body.count)\r\n"
                + "Connection: close\r\n\r\n"
            var response = Data(header.utf8)
            response.append(body)
            connection.send(
                content: response,
                completion: .contentProcessed { _ in connection.cancel() }
            )
        }
    }

    struct PuppetHTTPRequest {
        let method: String
        let path: String
        let body: Data

        init?(_ raw: Data) {
            guard let head = Self.head(raw) else { return nil }
            let requestLine = head.lines.first?.components(separatedBy: " ") ?? []
            guard requestLine.count >= 2 else { return nil }
            method = requestLine[0]
            path = requestLine[1]

            let available = raw[head.bodyStart..<raw.endIndex]
            guard available.count >= head.contentLength else { return nil }
            body = Data(available.prefix(head.contentLength))
        }

        /// The whole request's size in bytes as its header declares it; nil until the header
        /// is in.
        static func declaredSize(_ raw: Data) -> Int? {
            head(raw).map { $0.bodyStart - raw.startIndex + $0.contentLength }
        }

        private static func head(_ raw: Data) -> (
            lines: [String], bodyStart: Data.Index, contentLength: Int
        )? {
            guard let headerEnd = raw.range(of: Data("\r\n\r\n".utf8)),
                let header = String(
                    data: raw[raw.startIndex..<headerEnd.lowerBound], encoding: .utf8)
            else { return nil }
            let lines = header.components(separatedBy: "\r\n")
            let field = "content-length:"
            let contentLength =
                lines
                .first { $0.lowercased().hasPrefix(field) }
                .flatMap {
                    Int($0.dropFirst(field.count).trimmingCharacters(in: .whitespaces))
                } ?? 0
            return (lines, headerEnd.upperBound, contentLength)
        }
    }

    struct PuppetServerStart: ViewModifier {
        let navigation: AppNavigation
        let store: NotesStore
        let sync: SyncManager

        @State private var server: PuppetServer?

        func body(content: Content) -> some View {
            content.task {
                guard server == nil else { return }
                switch PuppetServerContract.resolvePort() {
                case .absent:
                    return
                case .invalid(let raw):
                    print(
                        "[futo-puppet] refusing to start: "
                            + "\(PuppetServerContract.portEnvironmentKey)='\(raw)' "
                            + "is not a port in 1-65535"
                    )
                    return
                case .port(let port):
                    let started = PuppetServer(
                        navigation: navigation, store: store, sync: sync, port: port)
                    started.start()
                    server = started
                }
            }
        }
    }
#endif
