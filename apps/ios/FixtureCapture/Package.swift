// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EditorCaptureArtifact",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EditorCaptureArtifact", targets: ["EditorCaptureArtifact"])],
    targets: [
        .target(
            name: "EditorCaptureArtifact", path: "Sources",
            exclude: ["FixtureApp.swift", "FixtureProjection.swift"],
            sources: ["CaptureArtifact.swift"]),
        .testTarget(
            name: "EditorCaptureArtifactTests", dependencies: ["EditorCaptureArtifact"],
            path: "Tests"),
    ]
)
