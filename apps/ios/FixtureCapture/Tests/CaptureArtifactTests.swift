import Foundation
import Testing

@testable import EditorCaptureArtifact

@Suite("Task-only capture artifact")
struct CaptureArtifactTests {
    @Test("launch plan refuses malformed identity and unbounded capture")
    func boundedPlan() throws {
        let plan = CaptureLaunch(
            runID: UUID(), nonce: UUID(), destination: "declared-test-device", seconds: 15)
        let data = try JSONEncoder().encode(plan)
        #expect(try CaptureLaunch.decode(data) == plan)
        #expect(throws: (any Error).self) {
            try CaptureLaunch.decode(Data("{}".utf8))
        }
        for seconds in [0, 121] {
            let invalid = CaptureLaunch(
                runID: UUID(), nonce: UUID(), destination: "device", seconds: seconds)
            #expect(throws: (any Error).self) {
                try CaptureLaunch.decode(JSONEncoder().encode(invalid))
            }
        }
    }
}

extension CaptureArtifactTests {
    @Test("exclusive UUID workspace preserves raw UTF16 and refuses another run's output")
    func artifactRoundTrip() throws {
        let plan = CaptureLaunch(
            runID: UUID(), nonce: UUID(), destination: "synthetic-unit-test", seconds: 1)
        let workspace = try CaptureWorkspace(launch: plan)
        defer { try? FileManager.default.removeItem(at: workspace.root) }
        #expect(workspace.vault.deletingLastPathComponent() == workspace.root)
        #expect(throws: (any Error).self) { try CaptureWorkspace(launch: plan) }
        let snapshot: [String: Any] = [
            "textUTF16": [97, 0xD83D, 0xDE00, 0xD800, 13, 10], "marked": NSNull(),
        ]
        try workspace.write(
            provenance: ["sourceSHA": "unit-only"], source: "__a😀__\r\n", opening: snapshot,
            current: snapshot, events: [["id": 1, "parent": NSNull(), "method": "synthetic"]],
            lifecycle: [["event": "unit-test"]], traits: [:], status: "unit-test")
        let artifact = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: workspace.artifact))
                as? [String: Any])
        #expect(artifact["nonce"] as? String == plan.nonce.uuidString)
        #expect(artifact["destinationBinding"] as? String == "declared-only")
        #expect(artifact["acceptance"] as? String == "unreviewed-raw-capture")
        // Foundation host tests have no app data container. They must never
        // assert the physical app's relative artifact destination from a guess.
        #expect(artifact["artifactRelativePath"] is NSNull)
        #expect(
            (artifact["current"] as? [String: Any])?["textUTF16"] as? [Int] == [
                97, 0xD83D, 0xDE00, 0xD800, 13, 10,
            ])
        #expect(artifact["sourceUTF16"] as? [Int] == [95, 95, 97, 0xD83D, 0xDE00, 95, 95, 13, 10])
        #expect(
            try FileManager.default.contentsOfDirectory(atPath: workspace.root.path).sorted() == [
                "capture.json", "vault",
            ])
    }
}
