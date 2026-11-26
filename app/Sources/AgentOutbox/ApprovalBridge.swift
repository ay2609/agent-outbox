import Combine
import SwiftUI
import NativeApproval
import OwnerAPI

// The only file that touches NativeApproval's types. Views use ApprovalBridge, BridgeNativeStatus, ApprovalSheet and
// ApprovalError. The app never builds its own signing UI and never calls SecureEnclave / LocalAuthentication outside
// NativeApproval (local-docs/APP-SECURITY-C.md section 10).

struct BridgeNativeStatus: Equatable {
    /// This Mac can enroll a Secure Enclave key with Touch ID (C decides).
    var touchIDAvailable = false
    /// Active Secure Enclave keys known to the server.
    var keysActive = 0
    /// Touch ID here, a key on this Mac that the server has active, and the effective pin trusts it (hardened: after sudo).
    var canApproveInApp = false
}

enum ApprovalError: LocalizedError {
    case unavailable
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Touch ID isn't available on this Mac, so approvals use the browser."
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
    /// Dismissing it (set to nil by SwiftUI) cancels the pending approval; it is never treated as Approve.
    @Published var sheet: ApprovalSheet? {
        didSet { if sheet == nil, coordinator.pending != nil { coordinator.cancel() } }
    }
    private let approver: NativeApprover
    private let coordinator = ApprovalConfirmCoordinator()
    private var watch: AnyCancellable?

    init(api: OwnerAPIClient) {
        approver = NativeApprover(api: api)
        approver.confirmer = coordinator
        let c = coordinator
        watch = coordinator.$pending.receive(on: DispatchQueue.main).sink { [weak self] payload in
            guard let self else { return }
            if let payload {
                self.sheet = ApprovalSheet(view: AnyView(ApprovalConfirmView(payload: payload, onApprove: { c.approve() }, onCancel: { c.cancel() })))
            } else if self.sheet != nil {
                self.sheet = nil
            }
        }
    }

    func nativeStatus() async -> BridgeNativeStatus {
        let s = await approver.status()
        return BridgeNativeStatus(touchIDAvailable: s.touchIDAvailable && s.secureEnclaveAvailable, keysActive: s.keysActive,
                                  canApproveInApp: s.canApproveInApp)
    }

    /// Enrolls this Mac's Touch ID key. A "pending" result means the browser must confirm it: its page is opened.
    func enroll(label: String) async throws -> String {
        do {
            let info = try await approver.enroll(label: label)
            if info.status != "active", let u = info.confirmURL, let url = URL(string: u) { NSWorkspace.shared.open(url) }
            return info.keyId
        } catch { throw Self.map(error) }
    }

    /// True = approved, false = the owner cancelled.
    func approveBatch(_ batchId: String, draftIds: [String], includeAnyway: [String]) async throws -> Bool {
        do { _ = try await approver.approveBatch(batchId, draftIds: draftIds, includeAnyway: includeAnyway); return true }
        catch let e as NativeError where e == .cancelled || e == .notConfirmed { return false }
        catch { throw Self.map(error) }
    }

    func approveContacts(_ setId: String, changeIds: [String]) async throws -> Bool {
        do { _ = try await approver.approveContacts(setId, changeIds: changeIds); return true }
        catch let e as NativeError where e == .cancelled || e == .notConfirmed { return false }
        catch { throw Self.map(error) }
    }

    /// The `se_reauth` object ({challenge_id, key_id, signature}) for a live switch.
    func seReauth(action: String) async throws -> [String: Any] {
        do {
            let r = try await approver.seReauth(action: action)
            return ["challenge_id": r.challengeId, "key_id": r.keyId, "signature": r.signature]
        } catch { throw Self.map(error) }
    }

    func revoke(keyId: String) async throws {
        do { try await approver.revoke(keyId: keyId) } catch { throw Self.map(error) }
    }

    private static func map(_ error: Error) -> Error {
        if case NativeError.touchIDNotAvailable = error { return ApprovalError.unavailable }
        return ApprovalError.failed(error.localizedDescription)
    }
}
