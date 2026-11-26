import SwiftUI
import OwnerAPI

// THE ONLY FILE THAT TOUCHES TRACK C's TYPES (NativeApproval.NativeApprover, ApprovalConfirmView).
// This is a TEMPORARY STUB: every call reports "not available", so the windows use the browser approval.
//
// AT MERGE with track C:
//   1. Replace the body of `ApprovalBridge` below with the real adapter (keep the public surface of this file as is):
//        import NativeApproval
//        private let approver: NativeApprover            // NativeApprover(api: api)
//        nativeStatus()      -> map `approver.status()` to BridgeNativeStatus (touchIDAvailable, keysActive)
//        enroll(label:)      -> `try await approver.enroll(label:)`, return the key id
//        approveBatch(...)   -> present C's `ApprovalConfirmView` through `sheet` (wrap it in `ApprovalSheet(view: AnyView(...))`),
//                               call `approver.approveBatch(_:draftIds:includeAnyway:)`, return true when approved, false when cancelled
//        approveContacts(...) -> same with `approver.approveContacts(_:changeIds:)`
//        seReauth(action:)   -> `approver.seReauth(action:)`, return its {challenge_id, key_id, signature} as a dictionary
//        revoke(keyId:)      -> `approver.revoke(keyId:)`
//   2. Nothing outside this file changes: views only use `ApprovalBridge`, `BridgeNativeStatus`, `ApprovalSheet`, `ApprovalError`.
//   3. Keep this file's rule: the app never builds its own signing UI and never calls SecureEnclave / LocalAuthentication.

struct BridgeNativeStatus: Equatable {
    /// This Mac can enroll a Secure Enclave key with Touch ID (C decides).
    var touchIDAvailable = false
    /// Active Secure Enclave keys known to the server.
    var keysActive = 0
}

enum ApprovalError: LocalizedError {
    case unavailable
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Touch ID approval in the app isn't available in this build."
        case .failed(let m): return m
        }
    }
}

/// What the bridge asks a window to show as a sheet (C's confirm view, wrapped).
struct ApprovalSheet: Identifiable {
    let id = UUID()
    let view: AnyView
}

@MainActor
final class ApprovalBridge: ObservableObject {
    /// The confirm sheet to present, if any. Windows attach `.sheet(item: $bridge.sheet) { $0.view }`.
    @Published var sheet: ApprovalSheet?
    private let api: OwnerAPIClient

    init(api: OwnerAPIClient) { self.api = api }

    func nativeStatus() async -> BridgeNativeStatus { BridgeNativeStatus() }
    func enroll(label: String) async throws -> String { throw ApprovalError.unavailable }
    /// True = approved, false = the owner cancelled.
    func approveBatch(_ batchId: String, draftIds: [String], includeAnyway: [String]) async throws -> Bool { throw ApprovalError.unavailable }
    func approveContacts(_ setId: String, changeIds: [String]) async throws -> Bool { throw ApprovalError.unavailable }
    /// The `se_reauth` object ({challenge_id, key_id, signature}) for a live switch.
    func seReauth(action: String) async throws -> [String: Any] { throw ApprovalError.unavailable }
    func revoke(keyId: String) async throws { throw ApprovalError.unavailable }
}
