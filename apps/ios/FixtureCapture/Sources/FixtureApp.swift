import UIKit

@main
final class FixtureApp: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication, configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = FixtureScene.self
        return configuration
    }
}

final class FixtureScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene, willConnectTo session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = FixtureController()
        window.makeKeyAndVisible()
        self.window = window
    }
}

/// No defaults, sync, license, keychain, or shipping-app startup is compiled here.
/// No first-responder or dictation call is made: later input belongs to Puppet.
@MainActor
final class FixtureController: UIViewController {
    private let control = NativeInputRecorder()
    private var workspace: CaptureWorkspace?
    private var projection: FixtureProjection?
    private var provenance: [String: Any] = [:]
    private var opening: [String: Any] = [:]
    private var lifecycle: [[String: Any]] = []
    private var timer: Timer?
    private var deadline = 0.0
    private var status = "preparing"

    override func loadView() {
        view = control
        control.isEditable = false
        control.font = .systemFont(ofSize: 22)
        control.autocorrectionType = .yes
        control.autocapitalizationType = .sentences
        control.spellCheckingType = .no
        control.accessibilityIdentifier = "native-input-recorder"
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        for name in [
            UIApplication.didEnterBackgroundNotification,
            UIApplication.willEnterForegroundNotification,
            UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification,
            UIApplication.willTerminateNotification,
        ] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(changedLifecycle(_:)), name: name, object: nil)
        }
        // Hosted unit tests must not initialize a live capture or read launch plans.
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else {
            return
        }
        Task {
            do {
                let env = ProcessInfo.processInfo.environment
                guard let raw = env["FUTO_EDITOR_CAPTURE_LAUNCH"],
                    let url = Bundle.main.url(
                        forResource: "build-provenance", withExtension: "json"),
                    let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
                        as? [String: Any]
                else { throw CaptureError.invalidLaunch }
                provenance = metadata
                let workspace = try CaptureWorkspace(launch: CaptureLaunch.decode(Data(raw.utf8)))
                self.workspace = workspace
                let projection = try await FixtureProjection.open(workspace: workspace)
                self.projection = projection
                control.text = projection.display
                control.beginCapture()
                opening = control.snapshot()
                control.isEditable = true
                status = "capturing"
                deadline = ProcessInfo.processInfo.systemUptime + Double(workspace.launch.seconds)
                lifecycle.append(stamp("ready"))
                try persist()
                timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) {
                    [weak self] _ in
                    MainActor.assumeIsolated { self?.tick() }
                }
            } catch { fail(error) }
        }
    }

    @objc private func changedLifecycle(_ notification: Notification) {
        lifecycle.append(stamp(notification.name.rawValue))
        if status == "capturing", ProcessInfo.processInfo.systemUptime >= deadline {
            tick()
        } else {
            do { try persist() } catch { fail(error) }
        }
    }

    private func stamp(_ event: String) -> [String: Any] {
        [
            "event": event, "uptime": ProcessInfo.processInfo.systemUptime,
            "time": ISO8601DateFormatter().string(from: Date()),
        ]
    }

    private func tick() {
        if ProcessInfo.processInfo.systemUptime >= deadline {
            timer?.invalidate()
            control.endCapture()
            control.isEditable = false
            status = "capture-window-ended"
            lifecycle.append(stamp(status))
        }
        do { try persist() } catch { fail(error) }
    }

    private func persist() throws {
        guard let workspace, let projection else { return }
        try workspace.write(
            provenance: provenance, source: projection.source, opening: opening,
            current: control.snapshot(), events: control.events, lifecycle: lifecycle,
            traits: [
                "autocorrection": control.autocorrectionType.rawValue,
                "autocapitalization": control.autocapitalizationType.rawValue,
                "spellChecking": control.spellCheckingType.rawValue,
                "keyboard": control.keyboardType.rawValue,
                "deviceModel": UIDevice.current.model,
                "systemName": UIDevice.current.systemName,
                "systemVersion": UIDevice.current.systemVersion,
            ], status: status)
    }

    private func fail(_ error: Error) {
        timer?.invalidate()
        control.endCapture()
        control.isEditable = false
        // Technical diagnostic only: never render errors as authored fixture UI.
        print("Editor294Fixture failed: \(error)")
    }
}
