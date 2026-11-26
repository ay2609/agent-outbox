// swift-tools-version:5.9
// Agent Outbox.app: SwiftUI shell (AgentOutbox), owner-API client (OwnerAPI), Secure Enclave approval (NativeApproval).
// Assembled into a bundle by scripts/build-app.sh. Apple silicon, macOS 13+.
import PackageDescription

let package = Package(
    name: "AgentOutboxApp",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "AgentOutbox", dependencies: ["OwnerAPI", "NativeApproval"]),
        .target(name: "OwnerAPI"),
        .target(name: "NativeApproval", dependencies: ["OwnerAPI"]),
        .testTarget(name: "NativeApprovalTests", dependencies: ["NativeApproval"]),
    ]
)
