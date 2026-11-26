import Combine
import SwiftUI
import NativeApproval
import OwnerAPI
import CryptoKit

// The only file that touches NativeApproval's types. Views use ApprovalBridge, BridgeNativeStatus, ApprovalSheet and
// ApprovalError. The app never builds its own signing UI and never calls SecureEnclave / LocalAuthentication outside
// NativeApproval.

struct BridgeNativeStatus: Equatable {
    /// This Mac can enroll a Secure Enclave key with Touch ID (NativeApprover decides).
    var touchIDAvailable = false
    /// Active Secure Enclave keys known to the server.
    var keysActive = 0
    /// Touch ID here, a key on this Mac that the server has active, and the effective pin trusts it (hardened: after sudo).
    var canApproveInApp = false
    /// Why Touch ID can't be used here, in plain words (nil when it can). There is no password fallback.
    var touchIDReason: String?
    /// The fingerprint set changed since the key was made: the key is dead; set up approval again.
    var touchIDChanged = false
    /// An active key on the server whose blob is on this Mac.
    var hasLocalKey = false
}

enum ApprovalError: LocalizedError {
    case failed(String)
    var errorDescription: String? {
        switch self {
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

    /// Dev only (AGENT_OUTBOX_DEV_SHEET): shows the confirm sheet for a made-up approval, to look at it without Touch ID.
    func devPreview(kind: String) {
        func sha(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
        let exp = ISO8601DateFormatter().string(from: Date().addingTimeInterval(600))
        let live = kind.hasSuffix("live")
        let c = coordinator
        do {
            let p: ApprovalPayload
            if kind.hasPrefix("contacts") {
                let pay = "{\"given_name\":\"Maya\",\"family_name\":\"Okafor\",\"phones\":[{\"e164\":\"+14155550142\"}]}"
                let m = "{\"v\":1,\"kind\":\"contacts\",\"set_id\":\"s1\",\"approval_id\":\"a1\",\"transport\":\"\(live ? "live" : "dry")\",\"not_after\":\"\(exp)\",\"contact_items\":[{\"change_id\":\"c1\",\"kind\":\"create\",\"payload_sha256\":\"\(sha(pay))\"}]}"
                p = try ApprovalPayload.contacts(manifestBytes: m, setId: "s1", requestedChangeIds: ["c1"], payloads: ["c1": pay])
            } else {
                let b1 = "Hi Maya, the workshop moved to Thursday at 6. Same room. Bring the sketches!"
                let b2 = "Hey Jonas, are you still up for Saturday? I can pick you up at 10."
                let items = [("d1", "Maya Okafor", "+14155550142", b1), ("d2", "Jonas Reyes", "+14155550177", b2)]
                    .map { "{\"draft_id\":\"\($0.0)\",\"name\":\"\($0.1)\",\"to\":\"\($0.2)\",\"service\":\"auto\",\"body_sha256\":\"\(sha($0.3))\"}" }.joined(separator: ",")
                let m = "{\"v\":2,\"batch_id\":\"b1\",\"approval_id\":\"a1\",\"transport\":\"\(live ? "live" : "dry")\",\"not_after\":\"\(exp)\",\"items\":[\(items)]}"
                p = try ApprovalPayload.send(manifestBytes: m, batchId: "b1", requestedDraftIds: ["d1", "d2"], bodies: ["d1": b1, "d2": b2])
            }
            sheet = ApprovalSheet(view: AnyView(ApprovalConfirmView(payload: p, onApprove: { c.approve() }, onCancel: { c.cancel() })))
        } catch { print("dev preview failed: \(error)") }
    }

    func nativeStatus() async -> BridgeNativeStatus {
        let s = await approver.status()
        let ok = s.touchIDAvailable && s.secureEnclaveAvailable
        return BridgeNativeStatus(touchIDAvailable: ok, keysActive: s.keysActive, canApproveInApp: s.canApproveInApp,
                                  touchIDReason: ok ? nil : (s.touchIDReason ?? "This Mac has no Secure Enclave."),
                                  touchIDChanged: s.touchIDChanged || changedByError, hasLocalKey: s.localKeyId != nil)
    }
    /// Set when a signature failed because Touch ID's fingerprint set changed.
    private var changedByError = false

    /// Enrolls this Mac's Touch ID key. The proof of owner (setup token, recovery token, or an existing key) is chosen by the server.
    func enroll(label: String) async throws -> String {
        do {
            let info = try await approver.enroll(label: label)
            changedByError = false
            return info.keyId
        } catch { throw map(error) }
    }

    /// True = approved, false = the owner cancelled.
    func approveBatch(_ batchId: String, draftIds: [String], includeAnyway: [String]) async throws -> Bool {
        do { _ = try await approver.approveBatch(batchId, draftIds: draftIds, includeAnyway: includeAnyway); return true }
        catch let e as NativeError where e == .cancelled || e == .notConfirmed { return false }
        catch { throw map(error) }
    }

    func approveContacts(_ setId: String, changeIds: [String]) async throws -> Bool {
        do { _ = try await approver.approveContacts(setId, changeIds: changeIds); return true }
        catch let e as NativeError where e == .cancelled || e == .notConfirmed { return false }
        catch { throw map(error) }
    }

    /// The `se_reauth` object ({challenge_id, key_id, signature}) for a live switch.
    func seReauth(action: String) async throws -> [String: Any] {
        do {
            let r = try await approver.seReauth(action: action)
            return ["challenge_id": r.challengeId, "key_id": r.keyId, "signature": r.signature]
        } catch { throw map(error) }
    }

    func revoke(keyId: String) async throws {
        do { try await approver.revoke(keyId: keyId) } catch { throw map(error) }
    }

    private func map(_ error: Error) -> Error {
        if case NativeError.keyInvalidated = error { changedByError = true }
        return ApprovalError.failed(error.localizedDescription)
    }
}
