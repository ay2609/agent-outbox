// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OutboxExec",
    platforms: [.macOS(.v14)],
    targets: [
        // All logic lives here; `outbox-exec selftest` tests it.
        .target(name: "OutboxExecCore", path: "Sources/OutboxExecCore"),
        // Thin entry point; the binary inside OutboxExec.app.
        .executableTarget(
            name: "outbox-exec",
            dependencies: ["OutboxExecCore"],
            path: "Sources/outbox-exec"
        ),
    ],
    swiftLanguageModes: [.v6]
)
