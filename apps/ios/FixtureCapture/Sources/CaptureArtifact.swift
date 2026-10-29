import Foundation

/// Declared destination is correlation metadata. Only the later Puppet receipt can
/// bind it to an actual device; this fixture never labels itself accepted OS evidence.
struct CaptureLaunch: Codable, Equatable {
    let runID: UUID
    let nonce: UUID
    let destination: String
    let seconds: Int

    static func decode(_ data: Data) throws -> Self {
        let plan = try JSONDecoder().decode(Self.self, from: data)
        guard !plan.destination.isEmpty, plan.destination.utf8.count <= 128,
            (1...120).contains(plan.seconds)
        else { throw CaptureError.invalidLaunch }
        return plan
    }
}

enum CaptureError: Error {
    case invalidLaunch
}

/// Owns exactly one newly created UUID directory. There is no caller-supplied vault
/// path, default-vault resolver, or automatic cleanup of retained capture evidence.
struct CaptureWorkspace {
    let launch: CaptureLaunch
    let root: URL
    var vault: URL { root.appendingPathComponent("vault", isDirectory: true) }
    var artifact: URL { root.appendingPathComponent("capture.json") }

    init(launch: CaptureLaunch) throws {
        self.launch = try CaptureLaunch.decode(JSONEncoder().encode(launch))
        root = FileManager.default.temporaryDirectory.appendingPathComponent(
            "editor294-\(launch.runID.uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: false)
    }

    func write(
        provenance: [String: Any], source: String, opening: [String: Any],
        current: [String: Any], events: [[String: Any]], lifecycle: [[String: Any]],
        traits: [String: Any], status: String
    ) throws {
        let object: [String: Any] = [
            "formatVersion": 1, "runID": launch.runID.uuidString,
            "nonce": launch.nonce.uuidString, "declaredDestination": launch.destination,
            "destinationBinding": "declared-only", "acceptance": "unreviewed-raw-capture",
            "maximumDurationSeconds": launch.seconds, "provenance": provenance,
            "sourceUTF16": Array(source.utf16), "opening": opening, "current": current,
            "events": events, "lifecycle": lifecycle, "traits": traits, "status": status,
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try data.write(to: artifact, options: .atomic)
    }
}
