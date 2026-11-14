// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OutboxExec",
    platforms: [.macOS(.v13)],
    targets: [
        // All logic lives here so selftest and unit tests share it.
        .target(name: "OutboxExecCore", path: "Sources/OutboxExecCore"),
        // Thin entry point; the binary inside OutboxExec.app.
        .executableTarget(
            name: "outbox-exec",
            dependencies: ["OutboxExecCore"],
            path: "Sources/outbox-exec"
        ),
        .testTarget(
            name: "OutboxExecCoreTests",
            dependencies: ["OutboxExecCore"],
            path: "Tests/OutboxExecCoreTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
