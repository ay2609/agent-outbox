import Foundation
import CryptoKit

/// How a test signs like the Agent Outbox app's Secure Enclave key. A software P-256 key stands in for the SE (CI has no SE):
/// the executor only ever sees an x963 public key and a DER signature, so the verification path is identical.
struct SEOpts {
    enum Message { case proper, rawManifest, digestOnly }
    var key = P256.Signing.PrivateKey()
    var tag: String?                    // nil: the tag the approval kind calls for
    var message = Message.proper
    var authB64 = ""                    // WebAuthn field that must stay empty
    var cdjB64 = ""
    var credentialId: Data?             // nil: sha256(x963)

    var x963: Data { key.publicKey.x963Representation }
    var keyId: Data { Data(SHA256.hash(data: x963)) }

    func fields(manifest: String, defaultTag: String) -> (cred: String, auth: String, cdj: String, sig: String) {
        let bytes = Data(manifest.utf8)
        let digest = Hex.sha256(bytes)
        let signed: Data
        switch message {
        case .proper: signed = SESig.message(tag: tag ?? defaultTag, digest: digest)
        case .rawManifest: signed = bytes
        case .digestOnly: signed = digest
        }
        let sig = (try? key.signature(for: signed).derRepresentation) ?? Data()
        return (B64.encodeURL(credentialId ?? keyId), authB64, cdjB64, B64.encodeURL(sig))
    }
}

extension Harness {
    /// Writes a pin of any version with any mix of keys, as raw JSON. `keys` entries are fully specified so a test can build bad ones.
    func writeRawPin(to path: String, mode: mode_t, version: Int, keys: [[String: Any]], policy: [String: Any]? = ["live_allowed": false]) throws {
        var obj: [String: Any] = ["v": version, "rp_id": rpId, "origin": origin, "keys": keys]
        if let policy { obj["policy"] = policy }
        try? FileManager.default.removeItem(atPath: path)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try JSON.data(obj)!.write(to: URL(fileURLWithPath: path))
        chmod(path, mode)
    }

    var webauthnPinKey: [String: Any] {
        ["kind": "webauthn", "credential_id": B64.encodeURL(credId), "x963": B64.encodeURL(key.publicKey.x963Representation), "label": "selftest key"]
    }
    func sePinKey(_ se: SEOpts) -> [String: Any] {
        ["kind": "secure-enclave", "credential_id": B64.encodeURL(se.keyId), "x963": B64.encodeURL(se.x963), "label": "This Mac (Touch ID)"]
    }

    /// Simple mode: user pin v3 holding the passkey and the SE key.
    func pinWithSE(_ se: SEOpts, live: Bool = false, contactsLive: Bool = false) throws {
        try writeRawPin(to: config.userPinPath, mode: 0o600, version: 3, keys: [webauthnPinKey, sePinKey(se)],
                        policy: ["live_allowed": live, "contacts_live_allowed": contactsLive])
    }

    /// Hardened mode: a root-style pin (our uid, 0444) with the given version and keys.
    func hardenedPin(version: Int, keys: [[String: Any]], live: Bool = false) throws {
        let root = dir + "/rootpin/passkeys.json"
        try writeRawPin(to: root, mode: 0o444, version: version, keys: keys, policy: ["live_allowed": live])
        config.rootPinPath = root; config.rootExpectedUid = getuid(); config.checkPinAncestors = false
        try rebuild()
    }
}

extension SelfTest {
    static func seOpts(_ se: SEOpts, transport: String = "dry") -> ApprovalOpts {
        var o = ApprovalOpts(); o.se = se; o.transport = transport; return o
    }

    static func registerNativeCases(_ test: Reg) {
        // 1
        test("native 1: a secure-enclave key in a v3 pin signs a send approval: sends (dry), signer kind reported") { h in
            let se = SEOpts()
            try h.pinWithSE(se)
            let (_, d, a) = try single(h, seOpts(se))
            let (ok, lines) = try CLI.verifyReport(db: h.db, approvalId: a, pin: try PinFileLoader.load(path: h.config.userPinPath, mode: .simple), now: h.clock.now)
            try expect(ok && lines.first?.contains("signer secure-enclave") == true, "verify report: \(lines)")
            let r = try h.tick()
            try expect(r == .processed(draftId: d.draftId, result: "sent") && h.dryLines().count == 1 && h.live.calls.isEmpty, "tick returned \(r)")
        }
        // 2
        test("native 2: the same approval, live, goes to the live lane when the simple pin allows live") { h in
            let se = SEOpts()
            try h.pinWithSE(se, live: true)
            let (_, d, _) = try single(h, seOpts(se, transport: "live"))
            let r = try h.tick()
            try expect(r == .processed(draftId: d.draftId, result: "sent") && h.live.calls.count == 1 && h.dryLines().isEmpty, "live send: \(r)")
            // and a live approval is refused when the policy forbids live
            let h2 = try Harness(schema: h.schema, name: "native2b", parent: (h.dir as NSString).deletingLastPathComponent)
            try h2.pinWithSE(se, live: false)
            let (_, d2, _) = try single(h2, seOpts(se, transport: "live"))
            try expectRefused(h2, draft: d2, reason: "pin policy")
        }
        // 3
        test("native 3: a signature with tag contacts on a send manifest is refused") { h in
            var se = SEOpts(); se.tag = "contacts"
            try h.pinWithSE(se)
            let (_, d, _) = try single(h, seOpts(se))
            try expectRefused(h, draft: d, reason: "secure-enclave signature does not verify")
        }
        // 4
        test("native 4: a signature over the raw manifest bytes (no prefix) is refused") { h in
            var se = SEOpts(); se.message = .rawManifest
            try h.pinWithSE(se)
            let (_, d, _) = try single(h, seOpts(se))
            try expectRefused(h, draft: d, reason: "secure-enclave signature does not verify")
        }
        // 5
        test("native 5: a signature over sha256(manifest) alone is refused") { h in
            var se = SEOpts(); se.message = .digestOnly
            try h.pinWithSE(se)
            let (_, d, _) = try single(h, seOpts(se))
            try expectRefused(h, draft: d, reason: "secure-enclave signature does not verify")
        }
        // 6
        test("native 6: a secure-enclave row with non-empty authenticator data (or client data) is refused") { h in
            var se = SEOpts(); se.authB64 = B64.encodeURL(Data(repeating: 1, count: 37))
            try h.pinWithSE(se)
            let (_, d, _) = try single(h, seOpts(se))
            try expectRefused(h, draft: d, reason: "carries WebAuthn fields")
            var se2 = se; se2.authB64 = ""; se2.cdjB64 = B64.encodeURL(Data("{}".utf8))
            let h2 = try Harness(schema: h.schema, name: "native6b", parent: (h.dir as NSString).deletingLastPathComponent)
            try h2.pinWithSE(se2)
            let (_, d2, _) = try single(h2, seOpts(se2))
            try expectRefused(h2, draft: d2, reason: "carries WebAuthn fields")
        }
        // 7
        test("native 7: a WebAuthn-kind key with empty authenticator/client data is refused") { h in
            let se = SEOpts()
            try h.pinWithSE(se)
            let (_, d, a) = try single(h)           // an ordinary passkey approval ...
            try h.db.exec("UPDATE approvals SET authenticator_data_b64 = '', client_data_json_b64 = '' WHERE id = ?", [.text(a)])   // ... stripped
            try expectRefused(h, draft: d, reason: "clientDataJSON")
        }
        // 8
        test("native 8: an SE key that exists only in the DB native_keys table, not in the pin, is refused") { h in
            let se = SEOpts()
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 2, keys: [["credential_id": B64.encodeURL(h.credId), "x963": B64.encodeURL(h.key.publicKey.x963Representation), "label": "k"]])
            let t = Time.iso(h.clock.now)
            try h.db.exec("INSERT INTO native_keys(key_id, public_key_x963_b64, label, status, enroll_challenge, enroll_expires_at, created_at, activated_at) VALUES(?, ?, 'db only', 'active', 'c', ?, ?, ?)",
                          [.text(B64.encodeURL(se.keyId)), .text(B64.encodeURL(se.x963)), .text(t), .text(t), .text(t)])
            let (_, d, _) = try single(h, seOpts(se))
            try expectRefused(h, draft: d, reason: "not in the pin file")
        }
        // 9
        test("native 9: a copied SE approval row with a new id is refused (approval_id binding)") { h in
            let se = SEOpts()
            try h.pinWithSE(se)
            let (_, d, a) = try single(h, seOpts(se))
            try h.db.exec("UPDATE approvals SET id = ? WHERE id = ?", [.text(newId()), .text(a)])
            try expectRefused(h, draft: d, reason: "approval_id does not match")
        }
        // 10
        test("native 10: an expired or revoked SE approval is refused") { h in
            let se = SEOpts()
            try h.pinWithSE(se)
            var o = seOpts(se); o.notAfter = h.clock.now.addingTimeInterval(-60)
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "expired")
            let h2 = try Harness(schema: h.schema, name: "native10b", parent: (h.dir as NSString).deletingLastPathComponent)
            try h2.pinWithSE(se)
            var o2 = seOpts(se); o2.revoked = true
            let (_, d2, a2) = try single(h2, o2)
            // the loop never even loads a revoked row; the verifier refuses it too, were one handed to it
            let row = try h2.db.one("SELECT * FROM approvals WHERE id = ?", [.text(a2)])!
            do { _ = try Verifier.verifyApproval(ApprovalRecord(row: row), pin: try PinFileLoader.load(path: h2.config.userPinPath, mode: .simple), now: h2.clock.now); throw CaseFailure(message: "revoked row verified") }
            catch let r as Rejection { try expect(r.reason.contains("revoked"), "reason \(r.reason)") }
            try expect(try h2.tick() == .idle && h2.dryLines().isEmpty && h2.sendRows(d2.draftId).isEmpty, "a revoked SE approval sent something")
        }
        // 11
        test("native 11: an SE contacts approval applies (dry); a send-tag signature on a contacts manifest is refused") { h in
            ready(h)
            let se = SEOpts()
            try h.pinWithSE(se)
            let set = try h.makeSet(status: "drafting")
            let c = try h.addChange(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            let ap = try h.approveContacts(set: set, items: [c], seOpts(se))
            _ = try h.tick()
            try expect(h.chgStatus(c.id) == "applied" && h.applyRows(c.id).first?.str("approval_id") == ap && h.contacts.writeCount == 0, "contacts apply: \(h.chgDesc(c.id))")
            // wrong tag
            let h2 = try Harness(schema: h.schema, name: "native11b", parent: (h.dir as NSString).deletingLastPathComponent)
            ready(h2)
            try h2.pinWithSE(se)
            let set2 = try h2.makeSet(status: "drafting")
            let c2 = try h2.addChange(set: set2, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            var bad = seOpts(se); bad.se!.tag = "send"
            try h2.approveContacts(set: set2, items: [c2], bad)
            _ = try h2.tick()
            try expect(h2.chgStatus(c2.id) != "applied" && h2.applyRows(c2.id).isEmpty && hasRefusal(h2, "secure-enclave signature does not verify"), "send-tag contacts approval was accepted: \(h2.contactRejections())")
        }
        // 12
        test("native 12: v3 pin parsing: mixed kinds load; unknown/missing kind, v2 with an SE kind, bad SE id and duplicate ids are rejected") { h in
            let se = SEOpts(), se2 = SEOpts()
            let p = h.config.userPinPath
            func load() throws -> PinFile { try PinFileLoader.load(path: p, mode: .simple) }
            func rejects(_ why: String, _ reason: String) throws {
                do { _ = try load(); throw CaseFailure(message: "accepted: \(why)") }
                catch let e as ExecError { try expect("\(e)".contains(reason), "\(why): wrong error \(e)") }
            }
            try h.writeRawPin(to: p, mode: 0o600, version: 3, keys: [h.webauthnPinKey, h.sePinKey(se), h.sePinKey(se2)])
            let pf = try load()
            try expect(pf.version == 3 && pf.keys.map(\.kind) == [.webauthn, .secureEnclave, .secureEnclave], "mixed kinds: \(pf.keys.map(\.kind))")
            try expect(pf.key(forCredentialId: B64.encodeURL(se.keyId))?.kind == .secureEnclave, "lookup")
            var unknown = h.sePinKey(se); unknown["kind"] = "yubikey"
            try h.writeRawPin(to: p, mode: 0o600, version: 3, keys: [h.webauthnPinKey, unknown])
            try rejects("unknown kind", "valid kind")
            var missing = h.webauthnPinKey; missing.removeValue(forKey: "kind")
            try h.writeRawPin(to: p, mode: 0o600, version: 3, keys: [missing])
            try rejects("v3 without kind", "valid kind")
            try h.writeRawPin(to: p, mode: 0o600, version: 2, keys: [h.webauthnPinKey, h.sePinKey(se)])
            try rejects("v2 with a secure-enclave kind", "kind secure-enclave")
            var wrongId = h.sePinKey(se); wrongId["credential_id"] = B64.encodeURL(Data(repeating: 7, count: 32))
            try h.writeRawPin(to: p, mode: 0o600, version: 3, keys: [h.webauthnPinKey, wrongId])
            try rejects("SE id != sha256(x963)", "not sha256(x963)")
            try h.writeRawPin(to: p, mode: 0o600, version: 3, keys: [h.webauthnPinKey, h.sePinKey(se), h.sePinKey(se)])
            try rejects("duplicate ids", "duplicate credential_id")
            // v3 needs the policy like v2
            try h.writeRawPin(to: p, mode: 0o600, version: 3, keys: [h.webauthnPinKey], policy: nil)
            try rejects("v3 without policy", "policy")
            // an unsupported version is still refused
            try h.writeRawPin(to: p, mode: 0o600, version: 4, keys: [h.webauthnPinKey])
            try rejects("v4", "unsupported version")
        }
        // 13
        test("native 13: a v2 pin without kinds still loads (keys are webauthn) and approves as before") { h in
            let pf = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            try expect(pf.version == 2 && pf.keys.allSatisfy { $0.kind == .webauthn }, "v2 keys: \(pf.keys.map(\.kind))")
            var withKind = h.webauthnPinKey; withKind["kind"] = "webauthn"
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 2, keys: [withKind])
            try expect(try PinFileLoader.load(path: h.config.userPinPath, mode: .simple).keys.first?.kind == .webauthn, "v2 with explicit webauthn kind")
            let (_, d, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "webauthn approval on a v2 pin")
        }
        // 14
        test("native 14: hardened: a v2 root pin refuses an SE approval; a v3 root pin containing the key accepts it") { h in
            let se = SEOpts()
            try h.pinWithSE(se)             // the user pin has it, but the root pin wins and has not
            try h.hardenedPin(version: 2, keys: [["credential_id": B64.encodeURL(h.credId), "x963": B64.encodeURL(h.key.publicKey.x963Representation), "label": "k"]])
            let (_, d, _) = try single(h, seOpts(se))
            try expectRefused(h, draft: d, reason: "not in the pin file")
            let h2 = try Harness(schema: h.schema, name: "native14b", parent: (h.dir as NSString).deletingLastPathComponent)
            try h2.hardenedPin(version: 3, keys: [h2.webauthnPinKey, h2.sePinKey(se)])
            let (_, d2, _) = try single(h2, seOpts(se))
            try expect(try h2.tick() == .processed(draftId: d2.draftId, result: "sent") && h2.dryLines().count == 1, "root v3 should accept the SE key")
        }
        // 15
        test("native 15: the same SE signature replayed on another batch is refused") { h in
            let se = SEOpts()
            try h.pinWithSE(se)
            let (_, dA, a) = try single(h, seOpts(se))
            let batchB = try h.makeBatch()
            let dB = try h.makeDraft(batch: batchB)
            try h.db.exec("UPDATE drafts SET status = 'review' WHERE id = ?", [.text(dA.draftId)])
            try h.db.exec("UPDATE approvals SET batch_id = ? WHERE id = ?", [.text(batchB), .text(a)])
            try expectRefused(h, draft: dB, reason: "batch_id does not match")
        }
    }
}
