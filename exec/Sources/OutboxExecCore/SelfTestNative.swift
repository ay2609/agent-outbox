import Foundation
import CryptoKit

/// Pin v4 and Secure Enclave approvals (APP-SECURITY-APPONLY §3). A software P-256 key stands in for the SE (CI has no SE): the
/// executor only ever sees an x963 public key and a DER signature, so the verification path is identical.
extension Harness {
    /// Writes a pin of any version with any keys, as raw JSON. `keys` entries are fully specified so a test can build bad ones.
    /// `extraTop` adds top-level fields (a v4 pin must refuse them).
    func writeRawPin(to path: String, mode: mode_t, version: Int, keys: [[String: Any]], policy: [String: Any]? = ["live_allowed": false, "contacts_live_allowed": false],
                     extraTop: [String: Any] = [:]) throws {
        var obj: [String: Any] = ["v": version, "keys": keys]
        if let policy { obj["policy"] = policy }
        for (k, v) in extraTop { obj[k] = v }
        try? FileManager.default.removeItem(atPath: path)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try JSON.data(obj)!.write(to: URL(fileURLWithPath: path))
        chmod(path, mode)
    }

    /// Hardened mode: a root-style pin (our uid, 0444) with the given version and keys.
    func hardenedPin(version: Int, keys: [[String: Any]], live: Bool = false) throws {
        let root = dir + "/rootpin/passkeys.json"
        try writeRawPin(to: root, mode: 0o444, version: version, keys: keys, policy: ["live_allowed": live, "contacts_live_allowed": false])
        config.rootPinPath = root; config.rootExpectedUid = getuid(); config.checkPinAncestors = false
        try rebuild()
    }
}

extension SelfTest {
    static func registerNativeCases(_ test: Reg) {
        func sibling(_ h: Harness, _ name: String) throws -> Harness {
            try Harness(schema: h.schema, name: name, parent: (h.dir as NSString).deletingLastPathComponent)
        }
        func loads(_ h: Harness) throws -> PinFile { try PinFileLoader.load(path: h.config.userPinPath, mode: .simple) }
        func refuses(_ h: Harness, _ why: String, _ reason: String) throws {
            do { _ = try loads(h); throw CaseFailure(message: "accepted: \(why)") }
            catch let e as ExecError { try expect("\(e)".contains(reason), "\(why): wrong error \(e)") }
        }

        test("v4: a valid SE approval sends (dry) and the verify report names the signer") { h in
            let (_, d, a) = try single(h)
            let (ok, lines) = try CLI.verifyReport(db: h.db, approvalId: a, pin: try loads(h), now: h.clock.now)
            try expect(ok && lines.first?.contains("signer secure-enclave") == true, "verify report: \(lines)")
            let r = try h.tick()
            try expect(r == .processed(draftId: d.draftId, result: "sent") && h.dryLines().count == 1 && h.live.calls.isEmpty, "tick returned \(r)")
        }
        test("v4: the same approval, live, goes to the live lane when the pin allows live; refused when it does not") { h in
            try h.goLiveSimple(allowed: true)
            let (_, d, _) = try single(h, liveOpts())
            let r = try h.tick()
            try expect(r == .processed(draftId: d.draftId, result: "sent") && h.live.calls.count == 1 && h.dryLines().isEmpty, "live send: \(r)")
            let h2 = try sibling(h, "v4live2")
            let (_, d2, _) = try single(h2, liveOpts())
            try expectRefused(h2, draft: d2, reason: "pin policy")
        }
        test("v4: a signature with tag contacts on a send manifest is refused") { h in
            var o = ApprovalOpts(); o.tag = "contacts"
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "secure-enclave signature does not verify")
        }
        test("v4: a signature over the raw manifest bytes (no prefix) is refused") { h in
            var o = ApprovalOpts(); o.message = .rawManifest
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "secure-enclave signature does not verify")
        }
        test("v4: a signature over sha256(manifest) alone is refused") { h in
            var o = ApprovalOpts(); o.message = .digestOnly
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "secure-enclave signature does not verify")
        }
        test("v4: a row with non-empty authenticator data or client data is refused (WebAuthn fields)") { h in
            var o = ApprovalOpts(); o.authB64 = B64.encodeURL(Data(repeating: 1, count: 37))
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "carries WebAuthn fields")
            let h2 = try sibling(h, "v4wa2")
            var o2 = ApprovalOpts(); o2.cdjB64 = B64.encodeURL(Data("{}".utf8))
            let (_, d2, _) = try single(h2, o2)
            try expectRefused(h2, draft: d2, reason: "carries WebAuthn fields")
        }
        test("v4: a key that exists only in the DB native_keys table, not in the pin, is refused") { h in
            let other = P256.Signing.PrivateKey()
            let x = other.publicKey.x963Representation
            let t = Time.iso(h.clock.now)
            try h.db.exec("INSERT INTO native_keys(key_id, public_key_x963_b64, label, status, enroll_challenge, enroll_expires_at, created_at, activated_at) VALUES(?, ?, 'db only', 'active', 'c', ?, ?, ?)",
                          [.text(B64.encodeURL(Data(SHA256.hash(data: x)))), .text(B64.encodeURL(x)), .text(t), .text(t), .text(t)])
            var o = ApprovalOpts(); o.signer = other
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "not in the pin file")
        }
        test("v4: a copied approval row with a new id is refused (approval_id binding)") { h in
            let (_, d, a) = try single(h)
            try h.db.exec("UPDATE approvals SET id = ? WHERE id = ?", [.text(newId()), .text(a)])
            try expectRefused(h, draft: d, reason: "approval_id does not match")
        }
        test("v4: an expired or revoked approval is refused") { h in
            var o = ApprovalOpts(); o.notAfter = h.clock.now.addingTimeInterval(-60)
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "expired")
            let h2 = try sibling(h, "v4rev2")
            var o2 = ApprovalOpts(); o2.revoked = true
            let (_, d2, a2) = try single(h2, o2)
            let row = try h2.db.one("SELECT * FROM approvals WHERE id = ?", [.text(a2)])!
            do { _ = try Verifier.verifyApproval(ApprovalRecord(row: row), pin: try loads(h2), now: h2.clock.now); throw CaseFailure(message: "revoked row verified") }
            catch let r as Rejection { try expect(r.reason.contains("revoked"), "reason \(r.reason)") }
            try expect(try h2.tick() == .idle && h2.dryLines().isEmpty && h2.sendRows(d2.draftId).isEmpty, "a revoked approval sent something")
        }
        test("v4: an SE contacts approval applies (dry); a send-tag signature on a contacts manifest is refused") { h in
            ready(h)
            let set = try h.makeSet(status: "drafting")
            let c = try h.addChange(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            let ap = try h.approveContacts(set: set, items: [c])
            _ = try h.tick()
            try expect(h.chgStatus(c.id) == "applied" && h.applyRows(c.id).first?.str("approval_id") == ap && h.contacts.writeCount == 0, "contacts apply: \(h.chgDesc(c.id))")
            let h2 = try sibling(h, "v4c2")
            ready(h2)
            let set2 = try h2.makeSet(status: "drafting")
            let c2 = try h2.addChange(set: set2, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            var bad = ApprovalOpts(); bad.tag = "send"
            try h2.approveContacts(set: set2, items: [c2], bad)
            _ = try h2.tick()
            try expect(h2.chgStatus(c2.id) != "applied" && h2.applyRows(c2.id).isEmpty && hasRefusal(h2, "secure-enclave signature does not verify"), "send-tag contacts approval was accepted: \(h2.contactRejections())")
        }
        test("v4: the same signature replayed on another batch is refused") { h in
            let (_, dA, a) = try single(h)
            let batchB = try h.makeBatch()
            let dB = try h.makeDraft(batch: batchB)
            try h.db.exec("UPDATE drafts SET status = 'review' WHERE id = ?", [.text(dA.draftId)])
            try h.db.exec("UPDATE approvals SET batch_id = ? WHERE id = ?", [.text(batchB), .text(a)])
            try expectRefused(h, draft: dB, reason: "batch_id does not match")
        }

        // ---- pin v4 parsing --------------------------------------------------------------------------------------------------------
        test("v4 pin: the exact shape loads (several keys, label up to 200), rp_id/origin are the fixed constants") { h in
            let k2 = P256.Signing.PrivateKey()
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key, label: "MacBook Pro"), Harness.pinKey(k2, label: String(repeating: "x", count: 200))])
            let pf = try loads(h)
            try expect(pf.version == 4 && pf.keys.count == 2 && pf.keys[0].label == "MacBook Pro" && pf.keys.allSatisfy { $0.kind == .secureEnclave }, "keys: \(pf.keys.count)")
            try expect(pf.rpId == "agent-outbox" && pf.origin == "agent-outbox:app", "constants: \(pf.rpId) \(pf.origin)")
            try expect(pf.key(forCredentialId: B64.encodeURL(Data(SHA256.hash(data: k2.publicKey.x963Representation)))) != nil, "lookup")
        }
        test("v4 pin: an extra top-level key (rp_id / origin) is refused") { h in
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key)], extraTop: ["rp_id": "localhost"])
            try refuses(h, "rp_id", "exactly v, keys and policy")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key)], extraTop: ["origin": "http://localhost:7477"])
            try refuses(h, "origin", "exactly v, keys and policy")
        }
        test("v4 pin: an extra or missing field in a key object is refused") { h in
            var extra = Harness.pinKey(h.key); extra["purpose"] = "approve"
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [extra])
            try refuses(h, "extra key field", "exactly kind, credential_id, x963 and label")
            var missing = Harness.pinKey(h.key); missing.removeValue(forKey: "label")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [missing])
            try refuses(h, "missing label", "exactly kind, credential_id, x963 and label")
            var missingKind = Harness.pinKey(h.key); missingKind.removeValue(forKey: "kind")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [missingKind])
            try refuses(h, "missing kind", "exactly kind")
        }
        test("v4 pin: kind webauthn is refused; so is any other kind") { h in
            var wa = Harness.pinKey(h.key); wa["kind"] = "webauthn"
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(P256.Signing.PrivateKey()), wa])
            try refuses(h, "webauthn kind", PinFileLoader.Refusal.webauthnKey)
            var yk = Harness.pinKey(h.key); yk["kind"] = "yubikey"
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [yk])
            try refuses(h, "unknown kind", "is not \"secure-enclave\"")
        }
        test("v4 pin: a policy missing contacts_live_allowed, or with a non-boolean, is refused") { h in
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key)], policy: ["live_allowed": true])
            try refuses(h, "missing contacts_live_allowed", "exactly live_allowed and contacts_live_allowed")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key)], policy: ["live_allowed": 1, "contacts_live_allowed": false])
            try refuses(h, "live_allowed = 1", "not a boolean")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key)], policy: nil)
            try refuses(h, "no policy", "exactly v, keys and policy")
        }
        test("v4 pin: more than 32 keys, a bad id, a duplicate id, a bad point and a long label are refused; 32 are fine") { h in
            let many = (0..<33).map { _ in Harness.pinKey(P256.Signing.PrivateKey()) }
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: Array(many.prefix(32)))
            try expect(try loads(h).keys.count == 32, "32 keys")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: many)
            try refuses(h, "33 keys", "too many keys")
            var wrongId = Harness.pinKey(h.key); wrongId["credential_id"] = B64.encodeURL(Data(repeating: 7, count: 32))
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [wrongId])
            try refuses(h, "id != sha256(x963)", "not sha256(x963)")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key), Harness.pinKey(h.key)])
            try refuses(h, "duplicate ids", "duplicate credential_id")
            var badPoint = Harness.pinKey(h.key); badPoint["x963"] = B64.encodeURL(Data([4] + [UInt8](repeating: 1, count: 64)))
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [badPoint])
            try refuses(h, "off-curve point", "bad x963")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 4, keys: [Harness.pinKey(h.key, label: String(repeating: "x", count: 201))])
            try refuses(h, "long label", "label is longer")
        }
        test("pin versions: v1 / v2 / v3 give the browser-passkeys message, anything else is unsupported") { h in
            for v in [1, 2, 3] {
                try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: v, keys: [Harness.pinKey(h.key)])
                try refuses(h, "v\(v)", PinFileLoader.Refusal.browserPasskeys(v))
            }
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 5, keys: [Harness.pinKey(h.key)])
            try refuses(h, "v5", "unsupported version 5")
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 0, keys: [Harness.pinKey(h.key)])
            try refuses(h, "v0", "unsupported version 0")
            try? FileManager.default.removeItem(atPath: h.config.userPinPath)
            try Data("{\"v\":\"4\",\"keys\":[],\"policy\":{\"live_allowed\":false,\"contacts_live_allowed\":false}}".utf8).write(to: URL(fileURLWithPath: h.config.userPinPath))
            chmod(h.config.userPinPath, 0o600)
            try refuses(h, "v as string", "unsupported version")
        }
        test("v4 pin with empty keys loads and refuses every approval (send and contacts): nothing approvable") { h in
            try h.writePin(to: h.config.userPinPath, mode: 0o600, noKeys: true)
            try expect(try loads(h).keys.isEmpty, "empty keys must load")
            let (_, d, _) = try single(h)
            try expectRefused(h, draft: d, reason: "not in the pin file")
            let h2 = try sibling(h, "v4empty2")
            ready(h2)
            try h2.writePin(to: h2.config.userPinPath, mode: 0o600, noKeys: true)
            let set = try h2.makeSet(status: "drafting")
            let c = try h2.addChange(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            try h2.approveContacts(set: set, items: [c])
            _ = try h2.tick()
            try expect(h2.chgStatus(c.id) != "applied" && h2.applyRows(c.id).isEmpty && hasRefusal(h2, "not in the pin file"), "contacts approved with no key: \(h2.contactRejections())")
        }
        test("v3 pin (user, simple): hold, nothing sent, reason is the browser-passkeys message") { h in
            let (_, d, _) = try single(h)
            try h.writeRawPin(to: h.config.userPinPath, mode: 0o600, version: 3, keys: [Harness.pinKey(h.key)])
            let r = try h.tick()
            try expect(isHeld(r) && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "v3 pin: \(r)")
            try expect(h.lastError().contains(PinFileLoader.Refusal.browserPasskeys(3)), "last_error '\(h.lastError())'")
        }
        test("v4 hardened: a root pin that is invalid holds with no fallback to a good user pin") { h in
            try h.writePin(to: h.config.userPinPath, mode: 0o600)
            try h.hardenedPin(version: 4, keys: [Harness.pinKey(h.key)])
            let root = h.dir + "/rootpin/passkeys.json"
            try h.writeRawPin(to: root, mode: 0o444, version: 4, keys: [Harness.pinKey(h.key)], policy: ["live_allowed": true])   // missing field
            let (_, d, _) = try single(h)
            let r = try h.tick()
            try expect(isHeld(r) && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "invalid root pin must hold: \(r)")
        }
        test("v4 hardened: a v2 root pin holds even with a valid SE approval; a v4 root pin with the key accepts; the user pin is ignored while a root pin exists") { h in
            // the user pin is good, the root pin is the old v2 one: hold, no fallback
            try h.hardenedPin(version: 2, keys: [["credential_id": B64.encodeURL(h.credId), "x963": B64.encodeURL(h.key.publicKey.x963Representation), "label": "k"]])
            let (_, d, _) = try single(h)
            let r = try h.tick()
            try expect(isHeld(r) && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "v2 root pin: \(r)")
            try expect(h.lastError().contains(PinFileLoader.Refusal.browserPasskeys(2)), "last_error '\(h.lastError())'")
            // a v4 root pin that has the key accepts
            let h2 = try sibling(h, "v4hard2")
            try h2.hardenedPin(version: 4, keys: [Harness.pinKey(h2.key)])
            let (_, d2, _) = try single(h2)
            try expect(try h2.tick() == .processed(draftId: d2.draftId, result: "sent") && h2.dryLines().count == 1, "root v4 should accept the key")
            // the user pin holds the key but the root v4 pin does not: refused
            let h3 = try sibling(h, "v4hard3")
            try h3.writePin(to: h3.config.userPinPath, mode: 0o600)
            try h3.hardenedPin(version: 4, keys: [Harness.pinKey(P256.Signing.PrivateKey())])
            let (_, d3, _) = try single(h3)
            try expectRefused(h3, draft: d3, reason: "not in the pin file")
        }
        test("v4: manifest rp_id / origin different from the fixed constants are refused (contacts too)") { h in
            ready(h)
            var o = ApprovalOpts(); o.manifestRpId = "localhost"
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "manifest.rp_id")
            let h2 = try sibling(h, "v4const2")
            ready(h2)
            let set = try h2.makeSet(status: "drafting")
            let c = try h2.addChange(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            var oc = ApprovalOpts(); oc.manifestOrigin = "http://localhost:7477"
            try h2.approveContacts(set: set, items: [c], oc)
            _ = try h2.tick()
            try expect(h2.chgStatus(c.id) != "applied" && hasRefusal(h2, "origin"), "contacts manifest with the old origin accepted: \(h2.contactRejections())")
        }
    }
}
