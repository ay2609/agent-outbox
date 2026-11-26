// swift-tools-version:5.9
// Agent Outbox.app: SwiftUI shell (AgentOutbox), owner-API client (OwnerAPI), Secure Enclave approval (NativeApproval).
// Assembled into a bundle by scripts/build-app.sh. Apple silicon, macOS 13+.
// No Sparkle: see Sources/AgentOutbox/Updater.swift (library validation vs ad-hoc signing).
import PackageDescription

let package = Package(
    name: "AgentOutboxApp",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "AgentOutbox", dependencies: ["OwnerAPI", "NativeApproval"]),
        .target(name: "OwnerAPI"),
        .target(name: "NativeApproval", dependencies: ["OwnerAPI"]),
        // The NativeApproval checks without XCTest (see Sources/native-approval-selftest): `swift run native-approval-selftest`.
        .executableTarget(name: "native-approval-selftest", dependencies: ["NativeApproval"]),
        .testTarget(name: "NativeApprovalTests", dependencies: ["NativeApproval"]),
    ]
)
