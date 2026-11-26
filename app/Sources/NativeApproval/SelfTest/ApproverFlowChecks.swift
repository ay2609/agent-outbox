import Foundation
import CryptoKit
import OwnerAPI

/// A scripted owner API. `respond` sees every request; the stub records them and can verify signatures like the server does.
final class StubAPI: OwnerAPIClient, @unchecked Sendable {
    typealias Handler = (String, String, [String: Any]) -> (Int, [String: Any])
    private let lock = NSLock()
    private(set) var calls: [(method: String, path: String, body: [String: Any])] = []
    let handler: Handler
    init(_ handler: @escaping Handler) { self.handler = handler }

    func request(_ method: String, _ path: String, json: Data?) async throws -> (status: Int, body: Data) {
        let body = (json.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        lock.lock(); calls.append((method, path, body)); lock.unlock()
        let (status, obj) = handler(method, path, body)
        return (status, try JSONSerialization.data(withJSONObject: obj))
    }
    func paths() -> [String] { lock.lock(); defer { lock.unlock() }; return calls.map { "\($0.method) \($0.path)" } }
    func last(_ suffix: String) -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return calls.last { $0.path.hasSuffix(suffix) }?.body }
}

struct ClosureConfirmer: ApprovalConfirming {
    let f: @Sendable (ApprovalPayload) async -> Bool
    func confirm(_ payload: ApprovalPayload) async -> Bool { await f(payload) }
}
final class Box<T>: @unchecked Sendable { var value: T; init(_ v: T) { value = v } }

final class ApproverFlowTests {
    let dir: URL
    init() throws {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("na-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        dir = d
    }
    deinit { try? FileManager.default.removeItem(at: dir) }

    /// Server answers for one send batch approval with the Secure Enclave signer. `tamper` lets a test lie about the manifest or bodies.
    func sendServer(keyIds: @escaping () -> [String], items: [MItem], transport: String = "dry", manifestOverride: String? = nil, bodiesOverride: [String: String]? = nil,
                    verifyWith: @escaping (String, String, Data) -> Bool) -> StubAPI {
        let manifest = manifestOverride ?? sendManifest(transport: transport, items: items)
        return StubAPI { method, path, body in
            switch (method, path) {
            case ("POST", "/api/batches/b1/approve/options"):
                expectEq(body["signer"] as? String, "secure-enclave")
                return (200, ["challenge_id": "ch1", "options": NSNull(), "manifest_bytes": manifest, "se": ["tag": "send", "key_ids": keyIds()],
                              "manifest": [:], "drafts": (bodiesOverride ?? Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0.body) })).map { ["draft_id": $0.key, "body": $0.value] }])
            case ("POST", "/api/batches/b1/approve/se-verify"):
                guard let sig = (body["signature"] as? String).flatMap(B64.decode), let keyId = body["key_id"] as? String,
                      verifyWith(keyId, manifest, sig) else { return (401, ["error": "approval_failed", "message": "The Touch ID signature didn't verify."]) }
                return (200, ["ok": true, "approval_id": "a1", "manifest_sha256": sha(manifest), "count": items.count, "not_after": "2099-01-01T00:00:00.000Z",
                              "credential_id": keyId, "transport": transport])
            default: return (404, ["error": "not_found", "message": "No such route."])
            }
        }
    }

    func approver(_ api: StubAPI, store: SoftwareKeyStore, now: @escaping @Sendable () -> Date = { Date() }, confirm: (@Sendable (ApprovalPayload) async -> Bool)? = nil) -> NativeApprover {
        NativeApprover(api: api, keyStore: store, confirmer: confirm.map { ClosureConfirmer(f: $0) }, stateDir: dir, now: now)
    }

    func testApproveBatchEndToEndSignsTheSameBytesTheSheetShows() async throws {
        let store = SoftwareKeyStore()
        let key = try store.create()
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana", name: "Ana"), MItem(id: "d2", to: "+14155550102", body: "Hi Ben")]
        // the "server" verifies exactly as the TS/executor sides: ECDSA over M("send", sha256(manifest_bytes))
        let api = sendServer(keyIds: { [key.keyId] }, items: items, transport: "live") { keyId, manifest, sig in
            guard keyId == key.keyId, let s = try? P256.Signing.ECDSASignature(derRepresentation: sig),
                  let pub = try? P256.Signing.PublicKey(x963Representation: key.x963) else { return false }
            return pub.isValidSignature(s, for: SESig.message(tag: "send", digest: SESig.sha256(Data(manifest.utf8))))
        }
        let shown = Box<ApprovalPayload?>(nil)
        let a = approver(api, store: store) { p in shown.value = p; return true }
        let r = try await a.approveBatch("b1", draftIds: ["d1", "d2"])
        expectEq(r.approvalId, "a1"); expectEq(r.count, 2); expectEq(r.credentialId, key.keyId); expectEq(r.transport, "live")
        // what the sheet showed came from the exact manifest string the server sent
        expectEq(shown.value?.manifestBytes, Data(sendManifest(transport: "live", items: items).utf8))
        expectEq(shown.value?.reasonText, "send 2 messages to 2 people")
        expectEq(api.paths(), ["POST /api/batches/b1/approve/options", "POST /api/batches/b1/approve/se-verify"])
        expectEq(api.last("se-verify")?["key_id"] as? String, key.keyId)
    }

    func testCancelAndMissingConfirmerSignNothing() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana")]
        let api = sendServer(keyIds: { [key.keyId] }, items: items) { _, _, _ in fail("signed although nothing was confirmed"); return true }
        do { _ = try await approver(api, store: store) { _ in false }.approveBatch("b1", draftIds: ["d1"]); fail("approved after Cancel") }
        catch let e as NativeError { expectEq(e, .cancelled) }
        do { _ = try await approver(api, store: store).approveBatch("b1", draftIds: ["d1"]); fail("approved without a sheet") }
        catch let e as NativeError { expectEq(e, .notConfirmed) }
        expectFalse(api.paths().contains("POST /api/batches/b1/approve/se-verify"))
    }

    func testALyingServerNeverReachesTheSheetOrTheKey() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana")]
        let shown = Box(false)
        let confirm: @Sendable (ApprovalPayload) async -> Bool = { _ in shown.value = true; return true }
        // the response's body doesn't hash to the manifest's body_sha256
        let api1 = sendServer(keyIds: { [key.keyId] }, items: items, bodiesOverride: ["d1": "Send me your password"]) { _, _, _ in fail("signed"); return true }
        do { _ = try await approver(api1, store: store, confirm: confirm).approveBatch("b1", draftIds: ["d1"]); fail("accepted a lying body") }
        catch let e as PayloadError { expectEq(e.errorDescription, "The server sent a message that doesn't match.") }
        // a manifest for another batch / with a draft the owner didn't pick
        let api2 = sendServer(keyIds: { [key.keyId] }, items: items, manifestOverride: sendManifest(batch: "other", items: items)) { _, _, _ in fail("signed"); return true }
        do { _ = try await approver(api2, store: store, confirm: confirm).approveBatch("b1", draftIds: ["d1"]); fail("accepted another batch") } catch is PayloadError { }
        let api3 = sendServer(keyIds: { [key.keyId] }, items: items + [MItem(id: "d9", to: "+1", body: "x")]) { _, _, _ in fail("signed"); return true }
        do { _ = try await approver(api3, store: store, confirm: confirm).approveBatch("b1", draftIds: ["d1"]); fail("accepted a draft not picked") } catch is PayloadError { }
        // an expired manifest, and one that is really a contacts approval
        let api4 = sendServer(keyIds: { [key.keyId] }, items: items, manifestOverride: sendManifest(notAfter: "2020-01-01T00:00:00.000Z", items: items)) { _, _, _ in fail("signed"); return true }
        do { _ = try await approver(api4, store: store, confirm: confirm).approveBatch("b1", draftIds: ["d1"]); fail("accepted expired") } catch is PayloadError { }
        expectFalse(shown.value, "the sheet must not open for a manifest that fails the checks")
    }

    func testNoLocalKeyAndServerKeyListMustMatch() async throws {
        let store = SoftwareKeyStore()                       // no key on this Mac
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana")]
        let api = sendServer(keyIds: { ["someone-elses-key"] }, items: items) { _, _, _ in true }
        do { _ = try await approver(api, store: store) { _ in true }.approveBatch("b1", draftIds: ["d1"]); fail("signed without a key") }
        catch let e as NativeError { expectEq(e, .noLocalKey) }
        let k = try store.create()                           // a key the server doesn't list as allowed for this approval
        let api2 = sendServer(keyIds: { ["someone-elses-key"] }, items: items) { _, _, _ in true }
        do { _ = try await approver(api2, store: store) { _ in true }.approveBatch("b1", draftIds: ["d1"]); fail("signed with a key the server didn't list (\(k.keyId))") }
        catch let e as NativeError { expectEq(e, .noLocalKey) }
    }

    func testPressOfApproveExpiresAfterSixtySeconds() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana")]
        let api = sendServer(keyIds: { [key.keyId] }, items: items) { _, _, _ in fail("signed late"); return true }
        // now() is read: 1 when parsing, 2 at the press, 3 just before signing, 4 right after. A clock that jumps 61 s at call 3 or 4 means
        // the press is too old to sign with / to send.
        for jumpAt in [3, 4] {
            let calls = Box(0)
            let t0 = Date()
            let a = approver(api, store: store, now: { calls.value += 1; return calls.value >= jumpAt ? t0.addingTimeInterval(61) : t0 }) { _ in true }
            do { _ = try await a.approveBatch("b1", draftIds: ["d1"]); fail("signed after the window (jump at \(jumpAt))") }
            catch let e as NativeError { expectEq(e, .confirmationExpired) }
        }
    }

    func testServerRefusalSurfacesItsMessage() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana")]
        let api = sendServer(keyIds: { [key.keyId] }, items: items) { _, _, _ in false }
        do { _ = try await approver(api, store: store) { _ in true }.approveBatch("b1", draftIds: ["d1"]); fail("expected a refusal") }
        catch let e as NativeError { expectEq(e, .server(status: 401, code: "approval_failed", message: "The Touch ID signature didn't verify.")) }
    }

    func testApproveContactsUsesTheContactsTag() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let ch = [(id: "c1", kind: "create", payload: #"{"given_name":"Sam","family_name":"Lee","phones":[{"e164":"+14155550123","label":"mobile"}]}"#)]
        let manifest = contactsManifest(changes: ch)
        let api = StubAPI { method, path, body in
            if path == "/api/contact-changes/s1/approve/options" {
                return (200, ["challenge_id": "ch1", "options": NSNull(), "manifest_bytes": manifest, "se": ["tag": "contacts", "key_ids": [key.keyId]], "payloads": ["c1": ch[0].payload]])
            }
            if path == "/api/contact-changes/s1/approve/se-verify" {
                let pub = try! P256.Signing.PublicKey(x963Representation: key.x963)
                let sig = try! P256.Signing.ECDSASignature(derRepresentation: B64.decode(body["signature"] as! String)!)
                guard pub.isValidSignature(sig, for: SESig.message(tag: "contacts", digest: SESig.sha256(Data(manifest.utf8)))) else { return (401, ["error": "approval_failed", "message": "no"]) }
                return (200, ["ok": true, "approval_id": "a1", "manifest_sha256": sha(manifest), "count": 1, "not_after": "2099-01-01T00:00:00.000Z", "credential_id": key.keyId, "transport": "dry"])
            }
            return (404, [:])
        }
        let reason = Box("")
        let a = approver(api, store: store) { p in reason.value = p.reasonText; return true }
        let r = try await a.approveContacts("s1", changeIds: ["c1"])
        expectEq(r.count, 1)
        expectEq(reason.value, "approve a dry run of 1 contact change")
    }

    func testEnrollFirstRunWithSetupTokenSignsPossessionProof() async throws {
        let store = SoftwareKeyStore()
        let token = B64.encode(Data((0..<32).map { UInt8($0 &+ 1) }))
        let f = dir.appendingPathComponent("setup-token")
        try (token + "\n").write(to: f, atomically: true, encoding: .utf8)
        chmod(f.path, 0o600)
        let challenge = Data((0..<32).map { UInt8(255 - $0) })
        let api = StubAPI { method, path, body in
            switch path {
            case "/api/native-keys/enroll/options":
                let x = B64.decode(body["x963"] as! String)!
                return (200, ["key_id": B64.encode(SESig.sha256(x)), "challenge": B64.encode(challenge), "fingerprint": "AAAA-BBBB-CCCC-DDDD-EEEE", "expires_at": "2099", "proof": "setup_token"])
            case "/api/native-keys/enroll/verify":
                let x = store.localKeyIds().first.flatMap { try? store.load(keyId: $0).x963 }!
                let pub = try! P256.Signing.PublicKey(x963Representation: x)
                let sig = try! P256.Signing.ECDSASignature(derRepresentation: B64.decode(body["signature"] as! String)!)
                expectTrue(pub.isValidSignature(sig, for: SESig.message(tag: "enroll", digest: SESig.sha256(challenge + x))))
                expectEq(body["setup_token"] as? String, token)
                return (200, ["status": "active"])
            default: return (404, [:])
            }
        }
        let info = try await approver(api, store: store).enroll(label: "This Mac (Touch ID)")
        expectEq(info.status, "active"); expectEq(info.fingerprint, "AAAA-BBBB-CCCC-DDDD-EEEE")
        expectEq(store.localKeyIds(), [info.keyId])
    }

    func testEnrollFallsBackToTheBrowserAndCleansUpOnFailure() async throws {
        let store = SoftwareKeyStore()
        let api = StubAPI { _, path, body in
            switch path {
            case "/api/native-keys/enroll/options":
                let x = B64.decode(body["x963"] as! String)!
                return (200, ["key_id": B64.encode(SESig.sha256(x)), "challenge": B64.encode(Data(repeating: 9, count: 32)), "fingerprint": "F", "expires_at": "2099", "proof": "browser"])
            case "/api/native-keys/enroll/verify": return (200, ["status": "awaiting_browser", "confirm_url": "http://localhost:7477/#/native-enroll/x"])
            default: return (404, [:])
            }
        }
        let info = try await approver(api, store: store).enroll(label: "Mac")
        expectEq(info.status, "pending"); expectEq(info.confirmURL, "http://localhost:7477/#/native-enroll/x")
        // a refused enrolment leaves no key behind
        let store2 = SoftwareKeyStore()
        let bad = StubAPI { _, path, body in
            if path.hasSuffix("/options") { return (409, ["error": "key_exists", "message": "exists"]) }
            return (404, [:])
        }
        do { _ = try await approver(bad, store: store2).enroll(label: "Mac"); fail("expected an error") } catch { }
        expectTrue(store2.localKeyIds().isEmpty)
        // a server answer for a different key id is refused too
        let liar = StubAPI { _, _, _ in (200, ["key_id": "x", "challenge": B64.encode(Data(repeating: 1, count: 32)), "fingerprint": "F", "proof": "browser"]) }
        let store3 = SoftwareKeyStore()
        do { _ = try await approver(liar, store: store3).enroll(label: "Mac"); fail("accepted another key id") } catch let e as NativeError { guard case .mismatch = e else { return fail("\(e)") } }
        expectTrue(store3.localKeyIds().isEmpty)
    }

    func testEnrollWithoutTouchIDIsACleanBrowserFallback() async throws {
        struct NoTouchID: KeyProviding {
            func create() throws -> SEKeyHandle { throw NativeError.touchIDNotAvailable("Failed to get bio database hash.") }
            func load(keyId: String) throws -> SEKeyHandle { throw NativeError.noLocalKey }
            func delete(keyId: String) {}
            func localKeyIds() -> [String] { [] }
        }
        let api = StubAPI { _, _, _ in fail("no request should be made"); return (500, [:]) }
        let a = NativeApprover(api: api, keyStore: NoTouchID(), stateDir: dir)
        do { _ = try await a.enroll(label: "Mac"); fail("enrolled without Touch ID") }
        catch let e as NativeError {
            guard case .touchIDNotAvailable = e else { return fail("\(e)") }
            expectEq(e.errorDescription, "Touch ID isn't available on this Mac, so approval has to happen in the browser.")
        }
        expectTrue(api.paths().isEmpty)
    }

    func testSeReauthSignsTheChallengeAndRejectsUnknownActions() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let challenge = Data((0..<32).map { UInt8($0 &* 3) })
        let api = StubAPI { _, path, body in
            if path == "/api/native-keys/reauth/options" { expectEq(body["action"] as? String, "mode_live"); return (200, ["challenge_id": "rc1", "challenge": B64.encode(challenge)]) }
            return (404, [:])
        }
        let a = approver(api, store: store)
        let r = try await a.seReauth(action: "mode_live")
        expectEq(r.challengeId, "rc1"); expectEq(r.keyId, key.keyId)
        let pub = try P256.Signing.PublicKey(x963Representation: key.x963)
        try expectTrue(pub.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: B64.decode(r.signature)!), for: SESig.reauthMessage(challenge: challenge)))
        // encodes in the server's shape
        let enc = try JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as! [String: Any]
        expectEq(Set(enc.keys), ["challenge_id", "key_id", "signature"])
        do { _ = try await a.seReauth(action: "make_coffee"); fail("unknown action") } catch let e as NativeError { guard case .unsupported = e else { return fail("\(e)") } }
    }

    func testStatusPicksTheLocalActiveKeyAndRemovesDeadBlobs() async throws {
        let store = SoftwareKeyStore()
        let mine = try store.create(), dead = try store.create()
        let api = StubAPI { _, path, _ in
            if path == "/api/status" { return (200, ["native": ["keys_active": 1, "approve_in_app": true, "pin_needs_update": false]]) }
            if path == "/api/native-keys" { return (200, ["keys": [["key_id": mine.keyId, "status": "active"], ["key_id": dead.keyId, "status": "revoked"]]]) }
            return (404, [:])
        }
        let s = await approver(api, store: store).status()
        expectTrue(s.serverReachable); expectEq(s.keysActive, 1); expectTrue(s.approveInApp)
        expectEq(s.localKeyId, mine.keyId)
        expectEq(store.localKeyIds(), [mine.keyId])               // the revoked key's blob is gone
        expectFalse(s.needsReenroll)
        expectEq(s.canApproveInApp, s.touchIDAvailable && s.secureEnclaveAvailable)   // Touch ID decides: the CI/mini case falls back to the browser
        // server down
        let down = StubAPI { _, _, _ in (503, [:]) }
        let d = await approver(down, store: store).status()
        expectFalse(d.serverReachable); expectFalse(d.canApproveInApp)
        // the active key lost on this Mac (Touch ID changed, blob removed): needs re-enrolment
        let store2 = SoftwareKeyStore(); let stale = try store2.create()
        let api2 = StubAPI { _, path, _ in
            if path == "/api/status" { return (200, ["native": ["keys_active": 1, "approve_in_app": true, "pin_needs_update": false]]) }
            return (200, ["keys": [["key_id": stale.keyId, "status": "revoked"]]])
        }
        let s2 = await approver(api2, store: store2).status()
        expectNil(s2.localKeyId); expectTrue(s2.needsReenroll)   // a blob existed, the server revoked it: its blob is dropped and the app says "set up approval again"
    }

    func testRevokeDeletesTheBlob() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let api = StubAPI { _, path, _ in path.hasSuffix("/revoke") ? (200, ["revoked_approvals": 0, "revoked_contact_approvals": 0]) : (404, [:]) }
        try await approver(api, store: store).revoke(keyId: key.keyId)
        expectTrue(store.localKeyIds().isEmpty)
        expectEq(api.paths(), ["POST /api/native-keys/\(key.keyId)/revoke"])
    }

    func testOnlyOneSignatureInFlight() async throws {
        let store = SoftwareKeyStore(); let key = try store.create()
        let items = [MItem(id: "d1", to: "+14155550101", body: "Hi Ana")]
        let api = sendServer(keyIds: { [key.keyId] }, items: items) { _, _, _ in true }
        let gate = Box<CheckedContinuation<Void, Never>?>(nil)
        let a = approver(api, store: store) { _ in await withCheckedContinuation { gate.value = $0 }; return true }
        let first = Task { try await a.approveBatch("b1", draftIds: ["d1"]) }
        while gate.value == nil { try await Task.sleep(nanoseconds: 5_000_000) }
        do { _ = try await a.approveBatch("b1", draftIds: ["d1"]); fail("a second approval started while one waited") }
        catch let e as NativeError { expectEq(e, .busy) }
        gate.value!.resume()
        _ = try await first.value
    }

    /// The real Secure Enclave. Skipped unless AO_SE_TESTS=1 (CI VMs and the Claude sandbox have no usable SE; this Mac mini has no Touch ID).
    func testRealSecureEnclaveCreateIsACleanFailureWithoutTouchID() throws {
        guard ProcessInfo.processInfo.environment["AO_SE_TESTS"] == "1" else { return }       // needs a real Mac: AO_SE_TESTS=1
        let store = SEKeyStore(directory: dir.appendingPathComponent("native-keys"))
        do {
            let h = try store.create()
            print("        real Secure Enclave key created: \(h.keyId.prefix(8))…")
            expectEq(store.localKeyIds(), [h.keyId])
            try expectEq((try store.load(keyId: h.keyId)).x963, h.x963)
            store.delete(keyId: h.keyId)
        } catch let e as NativeError {
            print("        real Secure Enclave refused cleanly: \(e)")
            switch e { case .touchIDNotAvailable, .secureEnclaveUnavailable: break; default: fail("unexpected \(e)") }
        }
    }
}
