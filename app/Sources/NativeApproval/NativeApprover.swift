import Foundation
import CryptoKit
import LocalAuthentication
import OwnerAPI

/// Touch ID approval, end to end, over the owner API's app channel (`OwnerAPIClient`).
///
/// The flow for an approval: ask the server for options (`signer: "secure-enclave"`) -> parse and CHECK the manifest it returned
/// (`ApprovalPayload`) -> ask the owner through the confirm sheet (`confirmer`, which track B implements with `ApprovalConfirmView`)
/// -> only if she pressed Approve in the last 60 seconds, sign M(tag, sha256(manifest_bytes)) with Touch ID -> `se-verify`.
/// One signature at a time. The key never leaves the Secure Enclave.
public final class NativeApprover: @unchecked Sendable {
    private let api: OwnerAPIClient
    private let keys: KeyProviding
    private let now: @Sendable () -> Date
    private let stateDir: URL
    private let lock = NSLock()
    private var signing = false
    private var _confirmer: ApprovalConfirming?

    /// How long a press of Approve stays good for signing.
    public static let confirmationWindow: TimeInterval = 60

    /// Set by the app: shows `ApprovalConfirmView` for a payload and returns true only if the owner pressed Approve.
    public var confirmer: ApprovalConfirming? {
        get { lock.lock(); defer { lock.unlock() }; return _confirmer }
        set { lock.lock(); _confirmer = newValue; lock.unlock() }
    }

    public init(api: OwnerAPIClient, keyStore: KeyProviding = SEKeyStore(), confirmer: ApprovalConfirming? = nil, stateDir: URL? = nil,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.api = api
        self.keys = keyStore
        self._confirmer = confirmer
        self.now = now
        if let s = stateDir { self.stateDir = s } else {
            let env = ProcessInfo.processInfo.environment["OUTBOX_HOME"]
            self.stateDir = (env?.isEmpty == false) ? URL(fileURLWithPath: env!, isDirectory: true)
                : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/agent-outbox", isDirectory: true)
        }
    }

    // MARK: Touch ID availability

    /// Is there a Touch ID sensor with enrolled fingerprints? When false, create() would fail (LAError -1000 / -7 / -12) and the app
    /// should use the browser approval instead. Cheap; safe to call from a view.
    public static var touchIDAvailable: Bool {
        let ctx = LAContext()
        var err: NSError?
        let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        return ok
    }

    // MARK: HTTP helpers

    private func json(_ obj: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) }

    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        let data = try body.map(json)
        let (status, raw) = try await api.request(method, path, json: data)
        let obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] ?? [:]
        guard (200..<300).contains(status) else {
            throw NativeError.server(status: status, code: (obj["error"] as? String) ?? "error", message: (obj["message"] as? String) ?? "The server refused (\(status)).")
        }
        return obj
    }

    // MARK: status

    /// What the app needs to choose between Touch ID approval and the browser. Never throws: an unreachable server just says so.
    /// Also removes blobs of keys the server no longer knows as active or pending (expired, refused, revoked).
    public func status() async -> NativeStatus {
        let touch = Self.touchIDAvailable
        let se = SecureEnclave.isAvailable
        var s = NativeStatus(touchIDAvailable: touch, secureEnclaveAvailable: se, keysActive: 0, approveInApp: false, pinNeedsUpdate: false,
                             localKeyId: nil, needsReenroll: false, serverReachable: false)
        guard let st = try? await call("GET", "/api/status"), let native = st["native"] as? [String: Any] else { return s }
        s.serverReachable = true
        s.keysActive = (native["keys_active"] as? Int) ?? 0
        s.approveInApp = (native["approve_in_app"] as? Bool) ?? false
        s.pinNeedsUpdate = (native["pin_needs_update"] as? Bool) ?? false
        let local = keys.localKeyIds()
        if let list = try? await call("GET", "/api/native-keys"), let arr = list["keys"] as? [[String: Any]] {
            let live = Set(arr.compactMap { k -> String? in
                guard let id = k["key_id"] as? String, let status = k["status"] as? String, status == "active" || status == "pending" else { return nil }
                return id
            })
            for id in local where !live.contains(id) { keys.delete(keyId: id) }          // expired, refused or revoked: the blob is useless
            let active = Set(arr.compactMap { k -> String? in (k["status"] as? String) == "active" ? k["key_id"] as? String : nil })
            s.localKeyId = keys.localKeyIds().first { active.contains($0) }
            s.needsReenroll = s.localKeyId == nil && !local.isEmpty
        }
        return s
    }

    // MARK: enrolment

    /// Makes a Secure Enclave key and enrols it. Throws `.touchIDNotAvailable` on a Mac without Touch ID (use the browser). Proof of owner,
    /// in the server's order of preference: the first-run setup token, a recovery token from Terminal, an existing key's Touch ID, or the
    /// browser (the result is then `status: "pending"` with a `confirmURL` to open).
    public func enroll(label: String) async throws -> NativeKeyInfo {
        let handle = try keys.create()                      // no prompt; fails cleanly without Touch ID
        do {
            let o = try await call("POST", "/api/native-keys/enroll/options", ["x963": B64.encode(handle.x963), "label": label])
            guard (o["key_id"] as? String) == handle.keyId, let challengeB64 = o["challenge"] as? String, let challenge = B64.decode(challengeB64), challenge.count == 32,
                  let fp = o["fingerprint"] as? String else { throw NativeError.mismatch("The server's setup answer doesn't match this key.") }
            let proof = (o["proof"] as? String) ?? "browser"
            let sig = try await SESig.sign(handle: handle, message: SESig.enrollMessage(challenge: challenge, x963: handle.x963), reason: ApprovalReason.enroll)
            var body: [String: Any] = ["key_id": handle.keyId, "signature": B64.encode(sig)]
            switch proof {
            case "setup_token": if let t = readSecret(named: "setup-token") { body["setup_token"] = t }
            case "recovery_token": if let t = readSecret(named: "recovery-token") { body["recovery_token"] = t }
            case "se_reauth":
                // an existing active key on this Mac confirms adding another
                if let old = keys.localKeyIds().first(where: { $0 != handle.keyId }) {
                    let r = try await seReauth(action: "native_key_add", keyId: old)
                    body["se_reauth"] = ["challenge_id": r.challengeId, "key_id": r.keyId, "signature": r.signature]
                }
            default: break
            }
            let v = try await call("POST", "/api/native-keys/enroll/verify", body)
            let status = (v["status"] as? String) ?? "pending"
            return NativeKeyInfo(keyId: handle.keyId, label: label, fingerprint: fp, status: status == "active" ? "active" : "pending",
                                 confirmURL: v["confirm_url"] as? String)
        } catch {
            keys.delete(keyId: handle.keyId)                // a key that never became active leaves nothing behind
            throw error
        }
    }

    /// Polls a pending enrolment (the browser confirms it): "pending", "active", "revoked" or throws when unknown/expired.
    public func enrollmentStatus(keyId: String) async throws -> NativeKeyInfo {
        let o = try await call("GET", "/api/native-keys/enroll/\(keyId)")
        let st = (o["status"] as? String) ?? "pending"
        if st == "revoked" { keys.delete(keyId: keyId) }
        return NativeKeyInfo(keyId: keyId, label: (o["label"] as? String) ?? "", fingerprint: (o["fingerprint"] as? String) ?? "", status: st, confirmURL: nil)
    }

    /// The first-run setup token / recovery token written by the server or `agent-outbox recover`: a plain file we own, 0600, one token.
    func readSecret(named name: String) -> String? {
        let path = stateDir.appendingPathComponent(name).path
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), st.st_mode & 0o077 == 0, st.st_size > 0, st.st_size <= 256 else { return nil }
        var buf = [UInt8](repeating: 0, count: Int(st.st_size))
        guard read(fd, &buf, buf.count) == buf.count else { return nil }
        let text = String(decoding: buf, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return (text.count == 43 && B64.decode(text) != nil) ? text : nil
    }

    // MARK: revoke

    /// Revokes a key (no proof needed: it only removes power). The local blob goes too.
    public func revoke(keyId: String) async throws {
        _ = try await call("POST", "/api/native-keys/\(keyId)/revoke", [:])
        keys.delete(keyId: keyId)
    }

    // MARK: reauth

    /// A Touch ID confirmation for a sensitive change; put the result in the request as `se_reauth`. `action` is one of mode_live,
    /// policy_live, passkey_add, native_key_add, browser_link.
    public func seReauth(action: String) async throws -> SEReauth { try await seReauth(action: action, keyId: nil) }

    func seReauth(action: String, keyId: String?) async throws -> SEReauth {
        guard let reason = ApprovalReason.reauth(action: action) else { throw NativeError.unsupported("Unknown confirmation \(action).") }
        let o = try await call("POST", "/api/native-keys/reauth/options", ["action": action])
        guard let cid = o["challenge_id"] as? String, let chB64 = o["challenge"] as? String, let challenge = B64.decode(chB64), challenge.count == 32 else {
            throw NativeError.mismatch("The server's confirmation request is malformed.")
        }
        let handle = try localHandle(preferring: keyId.map { [$0] } ?? [])
        try beginSigning(); defer { endSigning() }
        let sig = try await SESig.sign(handle: handle, message: SESig.reauthMessage(challenge: challenge), reason: reason)
        return SEReauth(challengeId: cid, keyId: handle.keyId, signature: B64.encode(sig))
    }

    // MARK: approvals

    public func approveBatch(_ batchId: String, draftIds: [String], includeAnyway: [String] = []) async throws -> ApproveVerifyResult {
        var body: [String: Any] = ["draft_ids": draftIds, "signer": "secure-enclave"]
        if !includeAnyway.isEmpty { body["include_anyway"] = includeAnyway }
        let o = try await call("POST", "/api/batches/\(batchId)/approve/options", body)
        let (bytes, challengeId, keyIds) = try optionsCore(o, tag: "send")
        var bodies: [String: String] = [:]
        for d in (o["drafts"] as? [[String: Any]]) ?? [] { if let id = d["draft_id"] as? String, let b = d["body"] as? String { bodies[id] = b } }
        let payload = try ApprovalPayload.send(manifestBytes: bytes, batchId: batchId, requestedDraftIds: draftIds, bodies: bodies, now: now())
        let sig = try await confirmAndSign(payload, keyIds: keyIds)
        let v = try await call("POST", "/api/batches/\(batchId)/approve/se-verify", ["challenge_id": challengeId, "key_id": sig.keyId, "signature": B64.encode(sig.der)])
        return try decodeResult(v)
    }

    public func approveContacts(_ setId: String, changeIds: [String]) async throws -> ApproveVerifyResult {
        let o = try await call("POST", "/api/contact-changes/\(setId)/approve/options", ["change_ids": changeIds, "signer": "secure-enclave"])
        let (bytes, challengeId, keyIds) = try optionsCore(o, tag: "contacts")
        let payloads = (o["payloads"] as? [String: String]) ?? [:]
        let payload = try ApprovalPayload.contacts(manifestBytes: bytes, setId: setId, requestedChangeIds: changeIds, payloads: payloads, now: now())
        let sig = try await confirmAndSign(payload, keyIds: keyIds)
        let v = try await call("POST", "/api/contact-changes/\(setId)/approve/se-verify", ["challenge_id": challengeId, "key_id": sig.keyId, "signature": B64.encode(sig.der)])
        return try decodeResult(v)
    }

    /// The pieces every `approve/options` answer must carry for the Secure Enclave signer.
    private func optionsCore(_ o: [String: Any], tag: String) throws -> (bytes: String, challengeId: String, keyIds: [String]) {
        guard let bytes = o["manifest_bytes"] as? String, let cid = o["challenge_id"] as? String,
              let se = o["se"] as? [String: Any], (se["tag"] as? String) == tag, let ids = se["key_ids"] as? [String]
        else { throw NativeError.mismatch("The server's approval isn't a Touch ID approval for this.") }
        return (bytes, cid, ids)
    }

    private struct Signed { let keyId: String; let der: Data }

    /// The confirm sheet, then (and only then) Touch ID. The window between the press of Approve and the signature is checked here.
    private func confirmAndSign(_ payload: ApprovalPayload, keyIds: [String]) async throws -> Signed {
        guard let confirmer = self.confirmer else { throw NativeError.notConfirmed }
        let handle = try localHandle(preferring: keyIds, onlyThese: keyIds)
        try beginSigning(); defer { endSigning() }
        guard await confirmer.confirm(payload) else { throw NativeError.cancelled }
        let pressedAt = now()
        // sign off the main thread; M is built from the SAME bytes the sheet was built from
        let message = payload.signedMessage
        guard now().timeIntervalSince(pressedAt) <= Self.confirmationWindow else { throw NativeError.confirmationExpired }
        let der = try await SESig.sign(handle: handle, message: message, reason: payload.reasonText)
        guard now().timeIntervalSince(pressedAt) <= Self.confirmationWindow else { throw NativeError.confirmationExpired }
        return Signed(keyId: handle.keyId, der: der)
    }

    private func localHandle(preferring: [String], onlyThese: [String]? = nil) throws -> SEKeyHandle {
        let local = keys.localKeyIds()
        let candidates = preferring.filter { local.contains($0) } + (onlyThese == nil ? local : [])
        for id in candidates {
            if let allowed = onlyThese, !allowed.contains(id) { continue }
            return try keys.load(keyId: id)
        }
        throw NativeError.noLocalKey
    }

    private func beginSigning() throws {
        lock.lock(); defer { lock.unlock() }
        if signing { throw NativeError.busy }
        signing = true
    }
    private func endSigning() { lock.lock(); signing = false; lock.unlock() }

    private func decodeResult(_ v: [String: Any]) throws -> ApproveVerifyResult {
        let data = try JSONSerialization.data(withJSONObject: v)
        do { return try JSONDecoder().decode(ApproveVerifyResult.self, from: data) }
        catch { throw NativeError.mismatch("The server's answer couldn't be read.") }
    }
}
