import Foundation
import CryptoKit

struct CaseFailure: Error { let message: String }

func expect(_ cond: Bool, _ msg: @autoclosure () -> String) throws {
    if !cond { throw CaseFailure(message: msg()) }
}

public enum SelfTest {
    /// Where the schema came from, for the report.
    public static func loadSchema(explicit: String?) -> (sql: String, source: String) {
        if let p = explicit, let s = try? String(contentsOfFile: p, encoding: .utf8) { return (s, "file \(p)") }
        var starts: [String] = []
        if let exe = Bundle.main.executablePath { starts.append((exe as NSString).resolvingSymlinksInPath) }
        starts.append(FileManager.default.currentDirectoryPath + "/x")
        for start in starts {
            var dir = (start as NSString).deletingLastPathComponent
            for _ in 0..<8 {
                let cand = dir + "/src/db/schema.sql"
                if let s = try? String(contentsOfFile: cand, encoding: .utf8) { return (s, "repo file \(cand)") }
                dir = (dir as NSString).deletingLastPathComponent
            }
        }
        return (EmbeddedSchema.sql, "copy embedded at build time")
    }

    public static func run(keep: Bool, schemaPath: String?) -> Bool {
        setvbuf(stdout, nil, _IONBF, 0)
        let (schema, source) = loadSchema(explicit: schemaPath)
        guard !schema.isEmpty else { print("FAIL  no schema available"); return false }
        if !EmbeddedSchema.sql.isEmpty && Hex.sha256Hex(schema.trimmingCharacters(in: .whitespacesAndNewlines)) != Hex.sha256Hex(EmbeddedSchema.sql.trimmingCharacters(in: .whitespacesAndNewlines)) {
            print("WARN  schema in use differs from the copy embedded at build time: rebuild with exec/build.sh")
        }
        let tmpRoot = ProcessInfo.processInfo.environment["TMPDIR"].flatMap { $0.isEmpty ? nil : $0 } ?? NSTemporaryDirectory()
        let parent = (tmpRoot.hasSuffix("/") ? String(tmpRoot.dropLast()) : tmpRoot) + "/outbox-selftest-" + String(newId().suffix(12))
        try? FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        print("outbox-exec \(Version.current) selftest")
        print("schema: \(source)")
        print("temp OUTBOX_HOME root: \(parent) (the real ~/Library/Application Support/agent-outbox and /usr/local/etc are never read)\n")

        var passed = 0, failed = 0
        var n = 0
        func test(_ name: String, _ body: (Harness) throws -> Void) {
            n += 1
            do {
                let h = try Harness(schema: schema, name: String(format: "c%02d", n), parent: parent)
                try body(h)
                print("PASS  \(name)"); passed += 1
            } catch let f as CaseFailure {
                print("FAIL  \(name): \(f.message)"); failed += 1
            } catch {
                print("FAIL  \(name): unexpected error \(error)"); failed += 1
            }
        }

        registerGateCases(test)
        registerPolicyCases(test)
        registerFlowCases(test)
        registerUnitCases(test)
        registerV2Cases(test)
        registerContactCases(test)
        registerPinModeCases(test)

        if let ex = try? AppleScriptSource.script(handle: "+15551234567", body: "say \"hi\" \\ now\n\" & do shell script \"touch /tmp/pwned\" & \"", service: "iMessage") {
            print("\nexample generated AppleScript (generated only, never executed):\n\(ex)")
        }
        print("\n\(passed) passed, \(failed) failed")
        if keep { print("kept \(parent)") } else { try? FileManager.default.removeItem(atPath: parent) }
        return failed == 0
    }

    typealias Reg = (String, @escaping (Harness) throws -> Void) -> Void

    // MARK: helpers

    /// Valid-looking setup: one batch, one draft, one approval. Returns ids.
    static func single(_ h: Harness, _ o: ApprovalOpts = ApprovalOpts(), body: String = "Hello from the selftest", handle: String = "+15551234567",
                       service: String = "auto") throws -> (batch: String, draft: ItemSpec, approval: String) {
        let b = try h.makeBatch()
        let d = try h.makeDraft(batch: b, handle: handle, service: service, body: body)
        let a = try h.approve(batch: b, items: [d], o)
        return (b, d, a)
    }

    /// The approval must be refused: no send, draft returned to review, and an audit reason that contains `reason`.
    static func expectRefused(_ h: Harness, draft: ItemSpec, reason: String) throws {
        let r = try h.tick()
        try expect(r == .idle, "expected nothing to happen, got \(r)")
        try expect(h.dryLines().isEmpty, "a message was logged although the approval is invalid")
        try expect(h.sendRows(draft.draftId).isEmpty, "a sends row exists")
        // a refused approval hands its drafts back to the user (review) so they can be approved again
        try expect(h.draftStatus(draft.draftId) == "review", "draft status is \(h.draftStatus(draft.draftId)), expected review")
        let reasons = h.rejectionReasons()
        try expect(reasons.contains { $0.lowercased().contains(reason.lowercased()) }, "audit reasons \(reasons) do not mention '\(reason)'")
    }

    // MARK: the cases the contract lists

    static func registerGateCases(_ test: Reg) {
        test("valid approval sends (dry)") { h in
            let (b, d, a) = try single(h, body: "Hi Sam, see you at 5.")
            let r = try h.tick()
            try expect(r == .processed(draftId: d.draftId, result: "sent"), "tick returned \(r)")
            let lines = h.dryLines()
            try expect(lines.count == 1, "expected 1 dry-send line, got \(lines.count)")
            try expect(lines[0]["to"] as? String == "+15551234567" && lines[0]["body"] as? String == "Hi Sam, see you at 5.", "dry line content wrong: \(lines[0])")
            try expect(lines[0]["draft_id"] as? String == d.draftId && lines[0]["approval_id"] as? String == a, "ids missing from dry line")
            try expect(lines[0]["service"] as? String == "auto" && lines[0]["at"] != nil, "service/at missing")
            try expect(h.draftStatus(d.draftId) == "sent", "draft status \(h.draftStatus(d.draftId))")
            try expect(h.batchStatus(b) == "done", "batch status \(h.batchStatus(b))")
            let s = h.sendRows(d.draftId)
            try expect(s.count == 1 && s[0].str("result") == "sent" && s[0].str("transport") == "dry" && s[0].i("attempt") == 1 && !s[0].isNull("finished_at"), "sends row wrong")
            try expect(s[0].str("handle") == "+15551234567" && s[0].str("body_sha256") == Hex.sha256Hex("Hi Sam, see you at 5."), "sends.handle / body_sha256 snapshot missing")
            try expect(h.audit("send_start") == 1 && h.audit("send_sent") == 1, "audit rows missing (actor exec)")
            let hb = try h.db.one("SELECT * FROM exec_status WHERE id = 1")
            try expect(hb != nil && hb!.str("version") == Version.current && hb!.str("transport") == "dry" && hb!.i("sent_today") == 1, "heartbeat row wrong")
        }
        test("tampered body is refused") { h in
            let (_, d, _) = try single(h)
            try h.db.exec("UPDATE drafts SET body = 'send me your password' WHERE id = ?", [.text(d.draftId)])
            try expectRefused(h, draft: d, reason: "body changed")
        }
        test("changed handle is refused") { h in
            let (_, d, _) = try single(h)
            try h.db.exec("UPDATE drafts SET handle = '+15559990000' WHERE id = ?", [.text(d.draftId)])
            try expectRefused(h, draft: d, reason: "handle changed")
        }
        test("changed service is refused") { h in
            let (_, d, _) = try single(h, service: "iMessage")
            try h.db.exec("UPDATE drafts SET service = 'SMS' WHERE id = ?", [.text(d.draftId)])
            try expectRefused(h, draft: d, reason: "service changed")
        }
        test("wrong origin is refused") { h in
            var o = ApprovalOpts(); o.origin = "https://evil.example"
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "origin")
        }
        test("wrong rp_id is refused") { h in
            var o = ApprovalOpts(); o.rpIdForAuth = "evil.example"
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "rpIdHash")
        }
        test("manifest rp_id differing from the pin is refused") { h in
            var o = ApprovalOpts(); o.manifestRpId = "evil.example"
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "manifest.rp_id")
        }
        test("unpinned key is refused") { h in
            var o = ApprovalOpts(); o.signer = P256.Signing.PrivateKey(); o.credentialId = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "not in the pin file")
        }
        test("pinned credential id but another key's signature is refused") { h in
            var o = ApprovalOpts(); o.signer = P256.Signing.PrivateKey()   // credentialId stays the pinned one
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "does not verify")
        }
        test("agent-inserted key cannot approve (DB passkeys table is ignored)") { h in
            let rogue = P256.Signing.PrivateKey()
            let rogueId = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
            try h.db.exec("INSERT INTO passkeys(credential_id, public_key_cose_b64, public_key_x963_b64, created_at) VALUES(?, 'x', ?, ?)",
                          [.text(B64.encodeURL(rogueId)), .text(B64.encodeURL(rogue.publicKey.x963Representation)), .text(Time.iso(h.clock.now))])
            var o = ApprovalOpts(); o.signer = rogue; o.credentialId = rogueId
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "not in the pin file")
        }
        test("expired approval is refused") { h in
            var o = ApprovalOpts(); o.notAfter = h.clock.now.addingTimeInterval(-3600)
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "expired")
        }
        test("approval that expires between two ticks stops sending") { h in
            var o = ApprovalOpts(); o.notAfter = h.clock.now.addingTimeInterval(600)
            let b = try h.makeBatch()
            let d1 = try h.makeDraft(batch: b, position: 0), d2 = try h.makeDraft(batch: b, handle: "+15550001111", position: 1)
            try h.approve(batch: b, items: [d1, d2], o)
            try expect(try h.tick() == .processed(draftId: d1.draftId, result: "sent"), "first send should work")
            h.clock.now = h.clock.now.addingTimeInterval(601)
            try expect(try h.tick() == .idle && h.dryLines().count == 1, "second send must be refused after expiry")
        }
        test("revoked approval is refused") { h in
            var o = ApprovalOpts(); o.revoked = true
            let (_, d, a) = try single(h, o)
            let r = try h.tick()
            try expect(r == .idle && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "review", "revoked approval was acted on: \(r)")
            let pin = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            let (ok, lines) = try CLI.verifyReport(db: h.db, approvalId: a, pin: pin, now: h.clock.now)
            try expect(!ok && lines.joined().contains("revoked"), "verify should say revoked: \(lines)")
        }
        test("approval revoked after creation but before the tick is refused") { h in
            let (_, d, a) = try single(h)
            try h.db.exec("UPDATE approvals SET revoked_at = ? WHERE id = ?", [.text(Time.iso(h.clock.now)), .text(a)])
            try expect(try h.tick() == .idle && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "review", "revoked approval sent")
        }
        test("kill switch blocks sending") { h in
            let (_, d, _) = try single(h)
            try h.set("kill_switch", "1")
            let r = try h.tick()
            try expect(r == .held("kill switch is on"), "got \(r)")
            try expect(h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "sent while kill switch on")
            try h.set("kill_switch", "0")
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "should send once the switch is off")
        }
        test("missing kill_switch setting fails closed") { h in
            let (_, d, _) = try single(h)
            try h.db.exec("DELETE FROM settings WHERE key = 'kill_switch'")
            let r = try h.tick()
            try expect(r == .held("kill switch is on") && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "got \(r)")
        }
        test("consumed approval is not re-sent") { h in
            let (_, d, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "first send")
            try h.db.exec("UPDATE drafts SET status = 'approved' WHERE id = ?", [.text(d.draftId)])   // an agent resets the status
            try expect(try h.tick() == .idle, "status reset must not cause a re-send")
            try expect(h.dryLines().count == 1 && h.sendRows(d.draftId).count == 1, "second send happened")
        }
        test("a copied approval row (new id, same signature) cannot re-send a consumed draft") { h in
            let (b, d, a) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "first send")
            try h.db.exec("INSERT INTO approvals SELECT ?, batch_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at, revoked_at FROM approvals WHERE id = ?",
                          [.text("cloned-" + a), .text(a)])
            try h.db.exec("UPDATE drafts SET status = 'approved' WHERE id = ?", [.text(d.draftId)])
            try h.db.exec("UPDATE batches SET status = 'approved' WHERE id = ?", [.text(b)])
            try expect(try h.tick() == .idle && h.dryLines().count == 1, "clone re-sent the message")
            // the clone itself would also fail: its manifest.approval_id names the original row
            let pin = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            let (ok, lines) = try CLI.verifyReport(db: h.db, approvalId: "cloned-" + a, pin: pin, now: h.clock.now)
            try expect(!ok && lines.joined().contains("approval_id"), "clone should fail manifest.approval_id: \(lines)")
        }
        test("unknown outcome is consumed too") { h in
            let (_, d, _) = try single(h)
            try h.db.exec("INSERT INTO sends(id, draft_id, approval_id, attempt, transport, started_at, finished_at, result) SELECT ?, ?, id, 1, 'dry', ?, ?, 'unknown' FROM approvals",
                          [.text(newId()), .text(d.draftId), .text(Time.iso(h.clock.now)), .text(Time.iso(h.clock.now))])
            try expect(try h.tick() == .idle && h.dryLines().isEmpty, "an unknown send must never be retried")
        }
        test("bad signature (signed over other data) is refused") { h in
            var o = ApprovalOpts(); o.signOver = Data("not the assertion".utf8)
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "does not verify")
        }
        test("bad signature (garbage bytes) is refused") { h in
            var o = ApprovalOpts(); o.corruptSignature = true
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "signature")
        }
        test("UV flag missing is refused") { h in
            var o = ApprovalOpts(); o.flags = 0x01
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "UV")
        }
        test("UP flag missing is refused") { h in
            var o = ApprovalOpts(); o.flags = 0x04
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "UP")
        }
    }

    // MARK: more verifier cases

    static func registerPolicyCases(_ test: Reg) {
        test("clientData type webauthn.create is refused") { h in
            var o = ApprovalOpts(); o.type = "webauthn.create"
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "webauthn.get")
        }
        test("challenge that is not sha256(manifest) is refused") { h in
            var o = ApprovalOpts(); o.challenge = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "challenge")
        }
        test("crossOrigin=true is refused") { h in
            var o = ApprovalOpts(); o.crossOrigin = true
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "crossOrigin")
        }
        test("padded base64url fields are accepted") { h in
            var o = ApprovalOpts(); o.pad = true
            let (_, d, _) = try single(h, o)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "padded encoding should verify")
        }
        test("manifest edited after signing (hash column untouched) is refused") { h in
            let (_, d, a) = try single(h)
            try h.db.exec("UPDATE approvals SET manifest = replace(manifest, 'selftest', 'selftesT') WHERE id = ?", [.text(a)])
            try h.db.exec("UPDATE approvals SET manifest = manifest || ' ' WHERE id = ?", [.text(a)])
            try expectRefused(h, draft: d, reason: "manifest_sha256")
        }
        test("manifest edited and hash column recomputed is refused (challenge mismatch)") { h in
            let (_, d, a) = try single(h)
            let m = try h.db.one("SELECT manifest FROM approvals WHERE id = ?", [.text(a)])!.str("manifest") + " "
            try h.db.exec("UPDATE approvals SET manifest = ?, manifest_sha256 = ? WHERE id = ?", [.text(m), .text(Hex.sha256Hex(m)), .text(a)])
            try expectRefused(h, draft: d, reason: "challenge")
        }
        test("manifest that is not JSON (but correctly signed) is refused") { h in
            var o = ApprovalOpts(); o.rawManifest = "this is not json"
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "not a JSON object")
        }
        test("manifest batch_id differing from approvals.batch_id is refused") { h in
            var o = ApprovalOpts(); o.manifestBatchId = newId()
            let (_, d, _) = try single(h, o)
            try expectRefused(h, draft: d, reason: "batch_id")
        }
        test("manifest listing a draft twice is refused") { h in
            let b = try h.makeBatch()
            let d = try h.makeDraft(batch: b)
            try h.approve(batch: b, items: [d, d])
            try expectRefused(h, draft: d, reason: "twice")
        }
        test("draft from another batch is not covered by an approval") { h in
            let b1 = try h.makeBatch(), b2 = try h.makeBatch()
            let inA = try h.makeDraft(batch: b1), inB = try h.makeDraft(batch: b2, handle: "+15550002222")
            try h.approve(batch: b1, items: [inA, inB])        // lists a draft that lives in batch 2
            try h.db.exec("UPDATE drafts SET status = 'review' WHERE id = ?", [.text(inA.draftId)])  // only inB is a candidate
            try expect(try h.tick() == .idle && h.dryLines().isEmpty && h.draftStatus(inB.draftId) == "review", "cross-batch draft was sent")
        }
        test("approval that doesn't list a draft does not authorise it") { h in
            let b = try h.makeBatch()
            let listed = try h.makeDraft(batch: b, position: 0)
            let sneaked = try h.makeDraft(batch: b, handle: "+15550003333", body: "added later", position: 1)
            try h.approve(batch: b, items: [listed])
            try expect(try h.tick() == .processed(draftId: listed.draftId, result: "sent"), "listed draft sends")
            try expect(try h.tick() == .idle && h.dryLines().count == 1 && h.draftStatus(sneaked.draftId) == "review", "unlisted draft was sent")
        }
        test("two items: one tampered, the other still sends") { h in
            let b = try h.makeBatch()
            let d1 = try h.makeDraft(batch: b, position: 0), d2 = try h.makeDraft(batch: b, handle: "+15550001111", position: 1)
            try h.approve(batch: b, items: [d1, d2])
            try h.db.exec("UPDATE drafts SET body = 'changed' WHERE id = ?", [.text(d1.draftId)])
            try expect(try h.tick() == .processed(draftId: d2.draftId, result: "sent"), "untouched item should send")
            try expect(h.draftStatus(d1.draftId) == "review" && h.dryLines().count == 1, "tampered item must not send")
        }
        test("cancelled batch is not sent") { h in
            let b = try h.makeBatch(status: "cancelled")
            let d = try h.makeDraft(batch: b)
            try h.approve(batch: b, items: [d])
            try expect(try h.tick() == .idle && h.dryLines().isEmpty, "cancelled batch sent")
        }
        test("scheduled_for is ignored: a draft with a future scheduled_for sends at once") { h in
            let b = try h.makeBatch()
            let d = try h.makeDraft(batch: b, scheduledFor: Time.iso(h.clock.now.addingTimeInterval(3600)))
            try h.approve(batch: b, items: [d])
            try expect(try h.tickNow() == .processed(draftId: d.draftId, result: "sent") && h.dryLines().count == 1, "scheduled_for must not delay a send")
        }
        test("no pin file at all means nothing is sent") { h in
            let (_, d, _) = try single(h)
            try FileManager.default.removeItem(atPath: h.config.userPinPath)
            let r = try h.tick()
            try expect({ if case .held(let w) = r { return w.contains("pin file") } else { return false } }(), "got \(r)")
            try expect(h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "sent without a pin file")
        }
        test("verify report lists per-item verdicts") { h in
            let b = try h.makeBatch()
            let d1 = try h.makeDraft(batch: b, position: 0), d2 = try h.makeDraft(batch: b, handle: "+15550001111", position: 1)
            let a = try h.approve(batch: b, items: [d1, d2])
            try h.db.exec("UPDATE drafts SET body = 'changed' WHERE id = ?", [.text(d2.draftId)])
            let pin = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            let (ok, lines) = try CLI.verifyReport(db: h.db, approvalId: a, pin: pin, now: h.clock.now)
            try expect(!ok && lines.count == 3 && lines[1].contains("OK") && lines[2].contains("REJECT: body changed"), "report: \(lines)")
        }
    }

    // MARK: scheduling, transports, flow

    static func registerFlowCases(_ test: Reg) {
        test("an approved item sends at once, with no waits") { h in
            let b = try h.makeBatch()
            let d = try h.makeDraft(batch: b)
            try h.approve(batch: b, items: [d])
            let t0 = h.clock.now
            try expect(try h.tickNow() == .processed(draftId: d.draftId, result: "sent"), "first tick must send")
            try expect(h.clock.now == t0 && h.dryLines().count == 1 && h.draftStatus(d.draftId) == "sent", "no wait expected")
            try expect(h.audit("send_start") == 1, "send_start not audited")
        }
        test("consecutive sends are 2 s apart (injectable clock), any result counts") { h in
            try h.set("breaker_on_failure", "0")
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.sent(serviceUsed: "iMessage"), .failedBeforeHandoff("e")])
            try h.rebuild()
            let b = try h.makeBatch()
            let ds = try (0..<3).map { try h.makeDraft(batch: b, handle: "+1555000300\($0)", position: $0) }
            try h.approve(batch: b, items: ds)
            try expect(try h.tickNow() == .processed(draftId: ds[0].draftId, result: "sent"), "first send is immediate")
            try expect(isHeld(try h.tickNow()), "same instant: must hold for the gap")
            h.clock.now = h.clock.now.addingTimeInterval(1.9)
            try expect(isHeld(try h.tickNow()) && h.sendRows(ds[1].draftId).isEmpty, "1.9 s after: still inside the 2 s gap")
            h.clock.now = h.clock.now.addingTimeInterval(0.1)
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "failed"), "2 s after: next item goes out (and fails)")
            try expect(isHeld(try h.tickNow()), "a failed attempt also starts the gap")
            h.clock.now = h.clock.now.addingTimeInterval(2)
            try expect(try h.tickNow() == .processed(draftId: ds[1].draftId, result: "sent"), "the failed item retries after 2 s")
            try expect(isHeld(try h.tickNow()), "gap after the retry")
            h.clock.now = h.clock.now.addingTimeInterval(2)
            try expect(try h.tickNow() == .processed(draftId: ds[2].draftId, result: "sent"), "third item after another 2 s")
            let starts = try h.db.query("SELECT started_at FROM sends ORDER BY started_at").compactMap { Time.parse($0.str("started_at")) }
            try expect(starts.count == 4, "expected 4 attempts, got \(starts.count)")
            for i in 1..<starts.count { try expect(starts[i].timeIntervalSince(starts[i - 1]) >= 2, "attempts \(i - 1) and \(i) are less than 2 s apart: \(starts)") }
            try expect(starts[1].timeIntervalSince(starts[0]) == 2, "first gap should be exactly 2 s")
        }
        test("the gap is a constant, not a setting: DB rows for the old pacing settings change nothing") { h in
            for (k, v) in [("pace_min_s", "3600"), ("daily_cap", "0"), ("quiet_start", "00:00"), ("quiet_end", "23:59"), ("timezone", "Mars/Olympus")] {
                try h.db.exec("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [.text(k), .text(v)])
            }
            let b = try h.makeBatch()
            let d1 = try h.makeDraft(batch: b, position: 0), d2 = try h.makeDraft(batch: b, handle: "+15550001111", position: 1)
            try h.approve(batch: b, items: [d1, d2])
            try expect(try h.tickNow() == .processed(draftId: d1.draftId, result: "sent"), "stale pacing rows must not hold the first send")
            h.clock.now = h.clock.now.addingTimeInterval(SendGap.seconds)
            try expect(try h.tickNow() == .processed(draftId: d2.draftId, result: "sent"), "second send exactly one gap later")
        }
        test("run --once sends one item and returns") { h in
            let b = try h.makeBatch()
            let d1 = try h.makeDraft(batch: b, position: 0), d2 = try h.makeDraft(batch: b, handle: "+15550001111", position: 1)
            try h.approve(batch: b, items: [d1, d2])
            try h.exec.runLoop(once: true)
            try expect(h.dryLines().count == 1 && h.draftStatus(d1.draftId) == "sent" && h.draftStatus(d2.draftId) == "approved", "--once must send exactly one item")
        }
        test("failed send retries up to 3 attempts, then is consumed") { h in
            try h.set("breaker_on_failure", "0")
            let t = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("e1"), .failedBeforeHandoff("e2"), .failedBeforeHandoff("e3"), .sent(serviceUsed: "iMessage")])
            h.scriptedDry = t; try h.rebuild()
            let (_, d, _) = try single(h)
            for i in 1...3 {
                try expect(try h.tick() == .processed(draftId: d.draftId, result: "failed"), "attempt \(i) should fail")
                try expect(h.draftStatus(d.draftId) == "failed", "status after attempt \(i)")
            }
            try expect(try h.tick() == .idle && t.calls.count == 3, "no 4th attempt (calls \(t.calls.count))")
            let rows = h.sendRows(d.draftId)
            try expect(rows.count == 3 && rows.map { $0.i("attempt") } == [1, 2, 3] && rows.allSatisfy { $0.str("result") == "failed" }, "sends rows wrong")
        }
        test("failed then success on retry") { h in
            try h.set("breaker_on_failure", "0")
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("transient")]); try h.rebuild()
            let (b, d, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "failed"), "first fails")
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "retry succeeds")
            try expect(h.draftStatus(d.draftId) == "sent" && h.batchStatus(b) == "done" && h.sendRows(d.draftId).count == 2, "end state wrong")
        }
        test("breaker: a send error trips the kill switch") { h in
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("boom")]); try h.rebuild()
            let (_, d, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "failed"), "send fails")
            let ks = try h.db.one("SELECT value FROM settings WHERE key = 'kill_switch'")!.str("value")
            try expect(ks == "1" && h.audit("breaker_tripped") == 1, "kill switch not set (value \(ks))")
            try expect(h.setting("kill_reason") == "breaker", "kill_reason should be breaker, is '\(h.setting("kill_reason"))'")
            try expect(try h.db.one("SELECT COUNT(*) AS n FROM approvals WHERE revoked_at IS NOT NULL")!.i("n") == 0, "the breaker must not revoke approvals")

            try expect(try h.tick() == .held("kill switch is on"), "must stay stopped")
            try h.set("kill_switch", "0"); try h.set("kill_reason", "")
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "approvals survive the breaker: after resume the retry goes out")
        }
        test("unknown outcome is never retried") { h in
            try h.set("breaker_on_failure", "0")
            let t = ScriptedTransport(name: "dry", outcomes: [.unknown("timed out")])
            h.scriptedDry = t; try h.rebuild()
            let (_, d, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "unknown"), "unknown outcome")
            try expect(try h.tick() == .idle && t.calls.count == 1 && h.draftStatus(d.draftId) == "unknown", "unknown draft was retried")
        }
        test("crash mid-send: draft in 'sending' becomes unknown and is not retried") { h in
            let (_, d, a) = try single(h)
            try h.db.exec("UPDATE drafts SET status = 'sending' WHERE id = ?", [.text(d.draftId)])
            try h.db.exec("INSERT INTO sends(id, draft_id, approval_id, attempt, transport, started_at) VALUES(?, ?, ?, 1, 'dry', ?)",
                          [.text(newId()), .text(d.draftId), .text(a), .text(Time.iso(h.clock.now))])
            try expect(try h.exec.recoverInterrupted() == 1, "one open send expected")
            try expect(h.draftStatus(d.draftId) == "unknown", "status \(h.draftStatus(d.draftId))")
            let s = h.sendRows(d.draftId)
            try expect(s.count == 1 && s[0].str("result") == "unknown" && !s[0].isNull("finished_at"), "send row not closed as unknown")
            try expect(try h.tick() == .idle && h.dryLines().isEmpty, "unknown draft was sent again")
        }
        test("transport order: sending row exists before the transport is called") { h in
            final class Peek: Transport {
                let name = "dry"; let db: Database; var seen: [String] = []
                init(db: Database) { self.db = db }
                func send(_ r: SendRequest) -> SendOutcome {
                    let st = (try? db.one("SELECT status FROM drafts WHERE id = ?", [.text(r.draftId)]))??.str("status") ?? "?"
                    let open = (try? db.one("SELECT COUNT(*) AS n FROM sends WHERE draft_id = ? AND finished_at IS NULL", [.text(r.draftId)]))??.i("n") ?? -1
                    seen.append("\(st)/\(open)")
                    return .sent(serviceUsed: "iMessage")
                }
            }
            let p = Peek(db: h.db)
            h.scriptedDry = nil
            let (_, d, _) = try single(h)
            let exec2 = Executor(db: h.db, config: h.config, contacts: h.contacts, clock: { h.clock.now }) { _, _, _ in p }
            try exec2.prepare()
            _ = try exec2.tick()
            try expect(p.seen == ["sending/1"], "state during transport call was \(p.seen)")
            try expect(h.draftStatus(d.draftId) == "sent", "final status")
        }
        test("invalid handle or body is refused before the transport") { h in
            let t = ScriptedTransport(name: "dry"); h.scriptedDry = t; try h.rebuild()
            try h.set("breaker_on_failure", "0")
            let b = try h.makeBatch()
            let bad = try h.makeDraft(batch: b, handle: "+1555\" & do shell script \"x", body: "hi")
            try h.approve(batch: b, items: [bad])
            try expect(try h.tick() == .processed(draftId: bad.draftId, result: "failed") && t.calls.isEmpty, "bad handle reached the transport")
        }
        test("contact creation (dry): one contact_writes row, no Contacts call, never duplicated") { h in
            try h.set("breaker_on_failure", "0")
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("transient")]); try h.rebuild()
            let b = try h.makeBatch()
            let d0 = try h.makeDraft(batch: b, createContact: true)
            var d = d0
            d.createContact = ["given_name": "Sam", "family_name": "Lee", "phones": [["e164": "+15551234567", "label": "mobile"]], "emails": [] as [Any]]
            try h.approve(batch: b, items: [d])
            _ = try h.tick(); _ = try h.tick()                       // fail, then retry succeeds
            let cw = try h.db.query("SELECT * FROM contact_writes WHERE draft_id = ?", [.text(d.draftId)])
            try expect(cw.count == 1 && cw[0].str("transport") == "dry" && cw[0].str("result") == "skipped", "contact_writes rows: \(cw.count)")
            try expect(h.contacts.created.isEmpty, "Contacts was called in dry mode")
            try expect(h.draftStatus(d.draftId) == "sent", "message should still send")
            try expect(FileManager.default.fileExists(atPath: h.config.dryContactsLogPath), "dry contact log missing")
        }
        test("contact creation needs the signed manifest item AND the draft flag") { h in
            let b = try h.makeBatch()
            let noFlag = try h.makeDraft(batch: b, createContact: false, position: 0)
            var signed = noFlag
            signed.createContact = ["given_name": "A", "family_name": "B", "phones": [["e164": "+15551234567", "label": "mobile"]], "emails": [] as [Any]]
            let flagOnly = try h.makeDraft(batch: b, handle: "+15550001111", createContact: true, position: 1)   // manifest has no create_contact
            try h.approve(batch: b, items: [signed, flagOnly])
            _ = try h.tick(); _ = try h.tick()
            let n = try h.db.one("SELECT COUNT(*) AS n FROM contact_writes")!.i("n")
            try expect(n == 0, "contact written without both signed intent and flag (\(n))")
        }
        test("live approval: only a trusted pin whose policy has live_allowed enables the live transport (tripwire double, nothing real runs)") { h in
            var o = ApprovalOpts(); o.transport = "live"
            let (_, d, _) = try single(h, o)
            // 1. user pin only (simple mode, live_allowed false): a live-signed approval is refused and the live transport is never touched
            var r = try h.tick()
            try expect(r == .idle && h.live.calls.isEmpty && h.live.preflightCalls == 0 && h.dryLines().isEmpty, "live approval acted on although the pin policy forbids live: \(r)")
            try expect(h.rejectionReasons().contains { $0.contains("pin policy") && $0.contains("simple") }, "reason should name the pin policy and mode: \(h.rejectionReasons())")
            // 2. a root pin that is group-writable, or not owned by root, makes the executor hold
            let root = h.dir + "/rootpin/passkeys.json"
            try h.writePin(to: root, mode: 0o664, policy: ["live_allowed": true])
            h.config.rootPinPath = root; h.config.rootExpectedUid = getuid(); h.config.checkPinAncestors = false
            try h.rebuild()
            r = try h.tick()
            try expect({ if case .held = r { return true } else { return false } }() && h.live.calls.isEmpty, "group-writable root pin accepted: \(r)")
            h.config.rootExpectedUid = 0                                         // file is ours, not root's
            try h.rebuild()
            try chmodTo(root, 0o444)
            r = try h.tick()
            try expect({ if case .held = r { return true } else { return false } }() && h.live.calls.isEmpty, "non-root-owned pin accepted as root pin: \(r)")
            // 3. a valid root pin (uid matches, 0444) with live_allowed false: refused
            try h.goLive(allowed: false)
            try h.db.exec("UPDATE drafts SET status = 'approved' WHERE id = ?", [.text(d.draftId)])
            r = try h.tick()
            try expect(r == .idle && h.live.calls.isEmpty && h.rejectionReasons().contains { $0.contains("live_allowed") }, "live_allowed=false was ignored: \(r)")
            // 4. live_allowed true: the live transport (the tripwire double) is used
            let (_, d2, _) = try single(h, liveOpts())
            try h.goLive(allowed: true)
            r = try h.tick()
            try expect(r == .processed(draftId: d2.draftId, result: "sent") && h.live.calls.count == 1, "got \(r)")
            let s = h.sendRows(d2.draftId)
            try expect(s.count == 1 && s[0].str("transport") == "live", "sends row transport should be live")
            let hb = try h.db.one("SELECT * FROM exec_status WHERE id = 1")!
            try expect(hb.i("pin_file_ok") == 1, "heartbeat should report a good pin")
            try expect(h.dryLines().isEmpty, "dry log written for a live approval")
            try expect(h.live.preflightCalls == 1 && h.contacts.promptAsks == 1, "preflight / contacts prompt should each run once (\(h.live.preflightCalls), \(h.contacts.promptAsks))")
        }
        test("live preflight failure holds sends without burning the approval; recovers when fixed") { h in
            h.live.preflightError = "Automation permission for Messages has not been granted"
            try h.goLive()
            var o = ApprovalOpts(); o.transport = "live"
            let (_, d, _) = try single(h, o)
            let r = try h.tick()
            try expect({ if case .held(let w) = r { return w.contains("Automation") } else { return false } }(), "expected preflight hold, got \(r)")
            try expect(h.live.calls.isEmpty && h.sendRows(d.draftId).isEmpty && h.draftStatus(d.draftId) == "approved", "send attempted despite failed preflight")
            try expect(h.db.one("SELECT last_error FROM exec_status")?.text("last_error")?.contains("Automation") == true, "heartbeat should show the problem")
            h.live.preflightError = nil
            _ = try h.tick()                                          // inside the 30 s retry window: still held
            try expect(h.live.calls.isEmpty, "retry window ignored")
            h.clock.now = h.clock.now.addingTimeInterval(31)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "should send once the preflight passes")
        }
        test("dry mode never runs the live preflight or asks for Contacts access") { h in
            let (_, d, _) = try single(h)
            _ = try h.tick()
            try expect(h.live.preflightCalls == 0 && h.contacts.promptAsks == 0 && h.draftStatus(d.draftId) == "sent", "live-only code ran in dry mode")
        }
        test("live contact creation goes through the Contacts provider (fake)") { h in
            try h.goLive()
            let b = try h.makeBatch()
            var d = try h.makeDraft(batch: b, createContact: true)
            d.createContact = ["given_name": "Kim", "family_name": "Park", "phones": [["e164": "+15551234567", "label": "mobile"]], "emails": [] as [Any]]
            var o = ApprovalOpts(); o.transport = "live"
            try h.approve(batch: b, items: [d], o)
            _ = try h.tick()
            let cw = try h.db.query("SELECT * FROM contact_writes WHERE draft_id = ?", [.text(d.draftId)])
            try expect(h.contacts.created.count == 1 && h.contacts.created[0].givenName == "Kim", "fake provider not called")
            try expect(cw.count == 1 && cw[0].str("result") == "created" && cw[0].str("macos_id") == "FAKE-CN-ID-1" && cw[0].str("transport") == "live", "contact_writes row wrong")
        }
        test("contacts export request is answered (fake provider) and never prompts") { h in
            h.contacts.accessGranted = true
            let rid = newId()
            try h.db.exec("INSERT INTO exec_requests(id, kind, created_at) VALUES(?, 'contacts_export', ?)", [.text(rid), .text(Time.iso(h.clock.now))])
            _ = try h.tick()
            let r = try h.db.one("SELECT * FROM exec_requests WHERE id = ?", [.text(rid)])!
            try expect(!r.isNull("done_at") && r.str("result_json").contains("\"ok\":true"), "request not completed: \(r.str("result_json"))")
            try expect(FileManager.default.fileExists(atPath: h.config.contactsExportPath), "export file missing")
            let rid2 = newId()
            h.contacts.accessGranted = false
            try h.db.exec("INSERT INTO exec_requests(id, kind, created_at) VALUES(?, 'contacts_export', ?)", [.text(rid2), .text(Time.iso(h.clock.now))])
            _ = try h.tick()
            let r2 = try h.db.one("SELECT * FROM exec_requests WHERE id = ?", [.text(rid2)])!
            try expect(!r2.isNull("done_at") && r2.str("result_json").contains("\"ok\":false"), "denied request should complete with an error")
        }
    }

    static func chmodTo(_ path: String, _ mode: mode_t) throws {
        if chmod(path, mode) != 0 { throw CaseFailure(message: "chmod \(path) failed") }
    }

    // MARK: pure units

    static func registerUnitCases(_ test: Reg) {
        test("base64url decoding: with and without padding, strict alphabet") { _ in
            for len in 0...9 {
                let d = Data((0..<len).map { UInt8(truncatingIfNeeded: $0 &* 37 &+ 250) })
                let u = B64.encodeURL(d)
                try expect(B64.decodeURL(u) == d, "unpadded round trip failed for \(len) bytes")
                let padded = u + String(repeating: "=", count: (4 - u.count % 4) % 4)
                try expect(B64.decodeURL(padded) == d, "padded round trip failed for \(len) bytes")
            }
            try expect(B64.decodeURL("a+b/") == nil && B64.decodeURL("ab c") == nil && B64.decodeURL("a") == nil, "non-URL alphabet or bad length accepted")
            try expect(B64.decodeURL("YQ=") == nil && B64.decodeURL("YQ==") == Data("a".utf8) && B64.decodeURL("YQ") == Data("a".utf8), "padding rules wrong")
        }
        test("pin file: ownership, mode and symlink checks") { h in
            let p = h.dir + "/pins/passkeys.json"
            try h.writePin(to: p, mode: 0o444)
            try PinFileLoader.checkPathOwnership(p, expectedUid: getuid())
            var threw = false
            do { try PinFileLoader.checkPathOwnership(p, expectedUid: 0) } catch { threw = true }
            try expect(threw, "file owned by us passed as root-owned")
            try chmodTo(p, 0o666)
            threw = false
            do { try PinFileLoader.checkPathOwnership(p, expectedUid: getuid()) } catch { threw = true }
            try expect(threw, "world-writable pin file accepted")
            try chmodTo(p, 0o444)
            threw = false
            do { _ = try PinFileLoader.load(path: p, mode: .hardened, expectedUid: 0) } catch { threw = true }
            try expect(threw, "non-root file loaded as root pin file")
            let link = h.dir + "/pins/link.json"
            try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: p)
            threw = false
            do { _ = try PinFileLoader.load(path: link, mode: .simple) } catch { threw = true }
            try expect(threw, "symlinked pin file accepted")
            _ = try PinFileLoader.load(path: p, mode: .hardened, expectedUid: getuid(), checkAncestors: false)
            threw = false
            do { try PinFileLoader.checkAncestors(of: p, expectedUid: 0) } catch { threw = true }
            try expect(threw, "ancestor walk accepted user-owned directories")
            try expect(throwsNothing { try PinFileLoader.checkAncestors(of: "/usr/passkeys.json", expectedUid: 0) }, "/ and /usr should be root-owned and not group/world-writable")
        }
        test("pin file: malformed contents are rejected") { h in
            let p = h.dir + "/bad.json"
            for bad in ["{}", "[]", "{\"v\":3,\"rp_id\":\"a\",\"origin\":\"https://a\",\"keys\":[]}", "{\"v\":2,\"rp_id\":\"a\",\"origin\":\"https://a\",\"keys\":[]}",
                        "{\"v\":1,\"rp_id\":\"a\",\"origin\":\"https://a\",\"keys\":[{\"credential_id\":\"AAAA\",\"x963\":\"AAAA\"}]}"] {
                try Data(bad.utf8).write(to: URL(fileURLWithPath: p)); chmod(p, 0o600)
                var threw = false
                do { _ = try PinFileLoader.load(path: p, mode: .simple) } catch { threw = true }
                try expect(threw, "accepted \(bad)")
            }
        }
        test("AppleScript generation: nasty inputs stay inside string literals") { _ in
            let nasty = [
                "plain",
                "say \"hi\" to them",
                "back\\slash and \\\" mix",
                "line one\nline two\n\nline four",
                "emoji 😀👍🏽 and 日本語",
                "\" & do shell script \"touch /tmp/pwned\" & \"",
                "\\\" & do shell script \"id\" & \"",
                "tab\there",
                "windows\r\nnewlines\rand mac",
                "trailing newline\n",
            ]
            for body in nasty {
                let script = try AppleScriptSource.script(handle: "+15551234567", body: body, service: "iMessage")
                try AppleScriptCheck.verify(script: script, handle: "+15551234567", body: body, service: "iMessage")
            }
            let sms = try AppleScriptSource.script(handle: "a.b+c@example.com", body: "x", service: "SMS")
            try AppleScriptCheck.verify(script: sms, handle: "a.b+c@example.com", body: "x", service: "SMS")
            for h in ["+0123456789", "+123456", "+1234567890123456", "15551234567", "+1555\" & do shell script \"x", "+15551234567\n", "+1555 1234567", "a@b", "@example.com", "a b@example.com", "x@exa\"mple.com", ""] {
                try expect(AppleScriptSource.validateHandle(h) != nil, "handle accepted: \(h.debugDescription)")
            }
            for h in ["+15551234567", "+442079460958", "first.last+tag@example.co.uk", "o'brien@example.com"] {
                try expect(AppleScriptSource.validateHandle(h) == nil, "handle refused: \(h)")
            }
            for b in ["", "bell\u{07}", "nul\u{0}", "esc\u{1B}[0m", "del\u{7F}", "c1\u{85}"] {
                try expect(AppleScriptSource.validateBody(b) != nil, "body accepted: \(b.debugDescription)")
            }
            try expect(throwsError { _ = try AppleScriptSource.script(handle: "+15551234567", body: "x", service: "auto") }, "auto must be expanded by the transport")
            try expect(throwsError { _ = try AppleScriptSource.script(handle: "+15551234567\n", body: "x", service: "iMessage") }, "newline in handle accepted")
        }
    }


    // MARK: v2 fix round (manifest transport, pin policy, contact binding, reconcile, batch status, kill re-check, tamper, export)

    static func liveOpts() -> ApprovalOpts { var o = ApprovalOpts(); o.transport = "live"; return o }
    static func isHeld(_ r: TickResult) -> Bool { if case .held = r { return true } else { return false } }
    static func heldText(_ r: TickResult) -> String { if case .held(let w) = r { return w } else { return "" } }

    static func registerV2Cases(_ test: Reg) {
        // 1. the signed manifest decides the transport
        test("dry-signed approval + DB transport=live + valid live-allowed root pin still sends dry (transport double)") { h in
            let dry = ScriptedTransport(name: "dry"); h.scriptedDry = dry
            try h.set("transport", "live")
            try h.goLive()
            let (_, d, _) = try single(h)                                  // manifest says dry
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "should send")
            try expect(dry.calls.count == 1 && h.live.calls.isEmpty && h.live.preflightCalls == 0 && h.contacts.promptAsks == 0, "the live transport was touched for a dry approval")
            let s = h.sendRows(d.draftId)
            try expect(s.count == 1 && s[0].str("transport") == "dry", "sends.transport should be dry")
            try expect(try h.db.one("SELECT transport FROM exec_status WHERE id = 1")!.str("transport") == "live", "heartbeat shows the DB setting (live) for display only")
        }
        test("live-signed approval sends live even when the DB transport setting says dry") { h in
            try h.goLive()
            try h.set("transport", "dry")
            let (_, d, _) = try single(h, liveOpts())
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent") && h.live.calls.count == 1 && h.dryLines().isEmpty, "signed live manifest should use the live double")
        }
        test("manifest without transport, or still v1, is refused") { h in
            var o = ApprovalOpts(); o.omitTransport = true
            let (_, d1, _) = try single(h, o)
            try expectRefused(h, draft: d1, reason: "manifest.transport")
            var o2 = ApprovalOpts(); o2.manifestV = 1
            let (_, d2, _) = try single(h, o2)
            _ = try h.tick()
            try expect(h.draftStatus(d2.draftId) == "review" && h.dryLines().isEmpty && h.rejectionReasons().contains { $0.contains("manifest.v is not 2") }, "v1 manifest accepted")
        }

        // 2. pin policy
        test("policy missing or invalid in a v2 pin fails closed: hold with last_error, nothing sent") { h in
            let (_, d, _) = try single(h)
            let variants: [(String, () throws -> Void)] = [
                ("no policy", { try h.writePin(to: h.config.userPinPath, mode: 0o600, omitPolicy: true) }),
                ("empty policy", { try h.writePin(to: h.config.userPinPath, mode: 0o600, rawPolicy: [String: Any]()) }),
                ("policy is a string", { try h.writePin(to: h.config.userPinPath, mode: 0o600, rawPolicy: "yes") }),
                ("legacy fields but no live_allowed", { try h.writePin(to: h.config.userPinPath, mode: 0o600, rawPolicy: ["min_pace_s": 20, "max_daily_cap": 100, "require_quiet_hours": true] as [String: Any]) }),
                ("live_allowed not a bool", { try h.writePin(to: h.config.userPinPath, mode: 0o600, policy: ["live_allowed": "true"]) }),
            ]
            for (label, make) in variants {
                try? FileManager.default.removeItem(atPath: h.config.userPinPath)
                try make()
                let r = try h.tick()
                try expect(isHeld(r) && h.dryLines().isEmpty, "\(label): expected a hold, got \(r)")
                try expect(h.lastError().contains("policy"), "\(label): last_error should mention the policy, is '\(h.lastError())'")
                try expect(h.draftStatus(d.draftId) == "approved", "\(label): draft touched")
            }
            try? FileManager.default.removeItem(atPath: h.config.userPinPath)
            try h.writePin(to: h.config.userPinPath, mode: 0o600)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "a valid v2 pin works again")
        }
        test("a pin whose policy has the old pacing fields still loads; extra fields are ignored") { h in
            // like the installed root pin: v2 with live_allowed plus the retired fields (any value, even junk)
            for (label, extra) in [("old numeric fields", ["min_pace_s": 20, "min_burst_pause_s": 120, "max_burst_size": 10, "max_daily_cap": 100, "require_quiet_hours": true] as [String: Any]),
                                   ("junk values", ["min_pace_s": "fast", "max_daily_cap": -5, "require_quiet_hours": "maybe", "future_field": [1, 2]] as [String: Any]),
                                   ("no extra fields", [:])] {
                for allowed in [false, true] {
                    var pol = extra; pol["live_allowed"] = allowed
                    try? FileManager.default.removeItem(atPath: h.config.userPinPath)
                    try h.writePin(to: h.config.userPinPath, mode: 0o600, rawPolicy: pol)
                    let pf = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
                    try expect(pf.version == 2 && pf.policy == PinPolicy(liveAllowed: allowed), "\(label): policy not read as live_allowed=\(allowed)")
                }
            }
            try? FileManager.default.removeItem(atPath: h.config.userPinPath)
            try h.writePin(to: h.config.userPinPath, mode: 0o600)
            let (_, d, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "a pin with the old fields must still send dry")
        }
        test("a root pin with the old fields and live_allowed true sends live (no reinstall needed)") { h in
            try h.goLive(policy: ["min_pace_s": 20, "max_daily_cap": 100, "require_quiet_hours": true])
            let (_, d, _) = try single(h, liveOpts())
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent") && h.live.calls.count == 1, "live send with a legacy-field root pin")
        }
        test("a missing live_allowed fails closed for live: nothing is sent on any lane") { h in
            let root = h.dir + "/rootpin/passkeys.json"
            try h.writePin(to: root, mode: 0o444, rawPolicy: ["min_pace_s": 20, "max_daily_cap": 100] as [String: Any])
            h.config.rootPinPath = root; h.config.rootExpectedUid = getuid(); h.config.checkPinAncestors = false
            try h.rebuild()
            let (_, d, _) = try single(h, liveOpts())
            let r = try h.tick()
            try expect(isHeld(r) && h.live.calls.isEmpty && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "live send without live_allowed: \(r)")
            try expect(h.lastError().contains("live_allowed"), "last_error should name live_allowed, is '\(h.lastError())'")
            // and an explicit live_allowed=false pin refuses a live approval but loads fine
            try? FileManager.default.removeItem(atPath: root)
            try h.writePin(to: root, mode: 0o444, policy: ["live_allowed": false])
            try expect(isHeld(try h.tick()) || h.draftStatus(d.draftId) == "review", "live_allowed=false must not send live")
            try expect(h.live.calls.isEmpty, "live transport touched")
        }
        test("v1 pin file: accepted for dry with the default policy, never for live") { h in
            try? FileManager.default.removeItem(atPath: h.config.userPinPath)
            try h.writePin(to: h.config.userPinPath, mode: 0o600, version: 1)
            let pf = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            try expect(pf.version == 1 && pf.policy == .default && !pf.policy.liveAllowed, "v1 must load with the default policy")
            let (_, d, _) = try single(h)
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "dry sends with a v1 pin")
            // a v1 ROOT pin cannot enable live either
            let root = h.dir + "/rootpin/passkeys.json"
            try h.writePin(to: root, mode: 0o444, version: 1)
            h.config.rootPinPath = root; h.config.rootExpectedUid = getuid(); h.config.checkPinAncestors = false
            try h.rebuild()
            let (_, d2, _) = try single(h, liveOpts())
            try expect(try h.tick() == .idle && h.live.calls.isEmpty && h.draftStatus(d2.draftId) == "review", "v1 root pin allowed a live approval")
        }

        // 3. proposed contacts
        test("proposed contact must have exactly one handle, equal to the recipient") { h in
            let to = "+15551234567"
            let cases: [(String, [String: Any])] = [
                ("two phones", ["given_name": "A", "family_name": "B", "phones": [["e164": to, "label": "m"], ["e164": "+15559990000", "label": "m"]], "emails": [] as [Any]]),
                ("other phone", ["given_name": "A", "family_name": "B", "phones": [["e164": "+15559990000", "label": "m"]], "emails": [] as [Any]]),
                ("phone and email", ["given_name": "A", "family_name": "B", "phones": [["e164": to, "label": "m"]], "emails": [["email": "x@example.com", "label": "h"]]]),
                ("no handle", ["given_name": "A", "family_name": "B", "phones": [] as [Any], "emails": [] as [Any]]),
                ("email instead of the phone", ["given_name": "A", "family_name": "B", "phones": [] as [Any], "emails": [["email": "x@example.com", "label": "h"]]]),
            ]
            for (label, contact) in cases {
                let b = try h.makeBatch()
                var d = try h.makeDraft(batch: b, handle: to, createContact: true)
                d.createContact = contact
                try h.approve(batch: b, items: [d])
                let r = try h.tick()
                try expect(r == .idle && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "review", "\(label): item was not refused (\(r), \(h.draftStatus(d.draftId)))")
                try expect(h.sendRows(d.draftId).isEmpty, "\(label): a send was recorded")
            }
            try expect(try h.db.one("SELECT COUNT(*) AS n FROM contact_writes")!.i("n") == 0 && h.contacts.created.isEmpty, "a contact was written for a refused item")
            try expect(h.rejectionReasons().filter { $0.contains("proposed contact refused") }.count == cases.count, "every case needs its own audited reason: \(h.rejectionReasons())")
            // one email == to is fine
            let b = try h.makeBatch()
            var d = try h.makeDraft(batch: b, handle: "sam@example.com", createContact: true)
            d.createContact = ["given_name": "Sam", "family_name": "L", "phones": [] as [Any], "emails": [["email": "sam@example.com", "label": "home"]]]
            try h.approve(batch: b, items: [d])
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "a single matching email should be accepted")
        }
        test("handle and body are validated BEFORE a contact is created") { h in
            try h.goLive()
            try h.set("breaker_on_failure", "0")
            let b = try h.makeBatch()
            var d = try h.makeDraft(batch: b, body: "bell\u{07} in the body", createContact: true)
            d.createContact = ["given_name": "K", "family_name": "P", "phones": [["e164": "+15551234567", "label": "m"]], "emails": [] as [Any]]
            try h.approve(batch: b, items: [d], liveOpts())
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "failed"), "bad body should fail before hand-off")
            try expect(h.contacts.created.isEmpty && (try h.db.one("SELECT COUNT(*) AS n FROM contact_writes")!.i("n")) == 0 && h.live.calls.isEmpty, "contact created (or live touched) for an invalid message")
        }
        test("re-approval does not create a second contact for the same draft") { h in
            try h.goLive()
            try h.set("breaker_on_failure", "0")
            h.live.outcomes = [.failedBeforeHandoff("transient")]
            let b = try h.makeBatch()
            var d = try h.makeDraft(batch: b, createContact: true)
            d.createContact = ["given_name": "K", "family_name": "P", "phones": [["e164": "+15551234567", "label": "m"]], "emails": [] as [Any]]
            try h.approve(batch: b, items: [d], liveOpts())
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "failed"), "first attempt fails")
            try expect(h.contacts.created.count == 1, "first approval should create the contact")
            h.clock.now = h.clock.now.addingTimeInterval(1000)
            try h.approve(batch: b, items: [d], liveOpts())                  // the user approves again
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "second approval sends")
            try expect(h.contacts.created.count == 1, "contact created twice (\(h.contacts.created.count))")
            let rows = try h.db.query("SELECT result FROM contact_writes WHERE draft_id = ?", [.text(d.draftId)])
            try expect(rows.filter { $0.str("result") == "created" }.count == 1, "exactly one 'created' row expected, got \(rows.map { $0.str("result") })")
        }

        // 4. unusable approvals give their drafts back
        test("expired 24 h approval: all unconsumed drafts return to review once, with last_error and one audit row") { h in
            let b = try h.makeBatch()
            let ds = try (0..<5).map { try h.makeDraft(batch: b, handle: "+1555000100\($0)", position: $0) }
            try h.approve(batch: b, items: ds)
            try expect(try h.tick() == .processed(draftId: ds[0].draftId, result: "sent"), "first draft sends before expiry")
            h.clock.now = h.clock.now.addingTimeInterval(25 * 3600)
            try expect(try h.tick() == .idle, "nothing to send after expiry")
            for d in ds.dropFirst() { try expect(h.draftStatus(d.draftId) == "review", "draft \(d.draftId) is \(h.draftStatus(d.draftId))") }
            try expect(h.draftStatus(ds[0].draftId) == "sent", "a consumed draft must stay sent")
            try expect(h.batchStatus(b) == "review", "batch should be back in review, is \(h.batchStatus(b))")
            try expect(h.lastError().contains("expired") && h.lastError().contains("4 draft(s)"), "last_error should explain: '\(h.lastError())'")
            try expect(h.audit("drafts_returned_to_review") == 1, "one audit row expected")
            _ = try h.tick(); _ = try h.tick()
            try expect(h.audit("drafts_returned_to_review") == 1 && h.dryLines().count == 1, "must not repeat")
        }
        test("revoked approval returns its approved drafts to review in one transaction") { h in
            let b = try h.makeBatch()
            let ds = try (0..<3).map { try h.makeDraft(batch: b, handle: "+1555000200\($0)", position: $0) }
            let a = try h.approve(batch: b, items: ds)
            try h.db.exec("UPDATE approvals SET revoked_at = ? WHERE id = ?", [.text(Time.iso(h.clock.now)), .text(a)])
            _ = try h.tick()
            try expect(ds.allSatisfy { h.draftStatus($0.draftId) == "review" } && h.dryLines().isEmpty && h.audit("drafts_returned_to_review") == 1, "revoked approval's drafts not returned")
        }
        test("an approval that is still valid for a draft keeps it approved") { h in
            let b = try h.makeBatch()
            let d = try h.makeDraft(batch: b)
            try h.approve(batch: b, items: [d])
            try h.set("kill_switch", "1")                       // reconcile still runs, nothing is sent
            _ = try h.tick()
            try expect(h.draftStatus(d.draftId) == "approved" && h.audit("drafts_returned_to_review") == 0, "a live approval's draft must not be returned")
        }

        // 5. batch status
        test("batch is not done while a draft is in review/approved, and a dead approval's failed draft is not open") { h in
            try h.set("breaker_on_failure", "0")
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("e1")]); try h.rebuild()
            let b = try h.makeBatch()
            let sent = try h.makeDraft(batch: b, position: 0)
            let failing = try h.makeDraft(batch: b, handle: "+15550001111", position: 1)
            let pending = try h.makeDraft(batch: b, handle: "+15550002222", status: "review", position: 2)
            try h.approve(batch: b, items: [sent, failing])
            try expect(try h.tick() == .processed(draftId: sent.draftId, result: "failed"), "scripted outcome: first send fails")
            try expect(h.batchStatus(b) == "sending", "a failed draft with retries under a live approval keeps the batch open (\(h.batchStatus(b)))")
            try h.db.exec("UPDATE drafts SET status = 'skipped' WHERE id = ?", [.text(sent.draftId)])      // the user gives up on the first one
            try expect(try h.tick() == .processed(draftId: failing.draftId, result: "sent"), "second draft sends")
            try expect(h.batchStatus(b) == "review", "review draft still open: batch must not be done (\(h.batchStatus(b)))")
            try h.db.exec("UPDATE drafts SET status = 'skipped' WHERE id = ?", [.text(pending.draftId)])
            try h.exec.refreshBatch(b, now: Time.iso(h.clock.now))
            try expect(h.batchStatus(b) == "review" || h.batchStatus(b) == "done", "unexpected \(h.batchStatus(b))")
        }
        test("failed draft whose approval expired does not hold the batch open") { h in
            try h.set("breaker_on_failure", "0")
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("e1")]); try h.rebuild()
            let (_, d, _) = try single(h)
            _ = try h.tick()
            try expect(h.draftStatus(d.draftId) == "failed", "failed")
            let b = try h.db.one("SELECT batch_id FROM drafts WHERE id = ?", [.text(d.draftId)])!.str("batch_id")
            try expect(h.batchStatus(b) == "sending", "retries under a live approval: batch open")
            h.clock.now = h.clock.now.addingTimeInterval(25 * 3600)
            _ = try h.tick()
            try expect(h.batchStatus(b) == "done", "approval dead, batch should settle to done, is \(h.batchStatus(b))")
        }
        test("retry failures are counted per (approval, draft): a fresh approval gets fresh attempts") { h in
            try h.set("breaker_on_failure", "0")
            h.scriptedDry = ScriptedTransport(name: "dry", outcomes: [.failedBeforeHandoff("1"), .failedBeforeHandoff("2"), .failedBeforeHandoff("3")]); try h.rebuild()
            let (b, d, a) = try single(h)
            for _ in 0..<3 { _ = try h.tick() }
            try expect(try h.tick() == .idle && h.sendRows(d.draftId).count == 3 && h.batchStatus(b) == "done", "approval A is exhausted after 3 failures and its batch settles")
            let a2 = try h.approve(batch: b, items: [d])
            try h.db.exec("UPDATE drafts SET status = 'approved' WHERE id = ?", [.text(d.draftId)])
            try h.db.exec("UPDATE batches SET status = 'approved' WHERE id = ?", [.text(b)])
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "the new approval starts with zero failures")
            let rows = try h.db.query("SELECT approval_id, attempt FROM sends WHERE draft_id = ? ORDER BY started_at, attempt", [.text(d.draftId)])
            try expect(rows.filter { $0.str("approval_id") == a }.count == 3 && rows.filter { $0.str("approval_id") == a2 && $0.i("attempt") == 1 }.count == 1, "attempt numbering wrong: \(rows.map { "\($0.str("approval_id").prefix(4))#\($0.i("attempt"))" })")
            try expect(h.batchStatus(b) == "done", "batch done after the successful send")
        }

        // 6. kill switch re-checks
        test("kill switch re-read before the send: claim released, no attempt counted, nothing sent") { h in
            let dry = ScriptedTransport(name: "dry"); h.scriptedDry = dry; try h.rebuild()
            let (_, d, _) = try single(h)
            h.exec.beforeSendHook = { try? h.set("kill_switch", "1") }       // the user presses Stop right after the claim
            let r = try h.tick()
            try expect(r == .held("kill switch is on") && dry.calls.isEmpty, "got \(r), transport calls \(dry.calls.count)")
            try expect(h.draftStatus(d.draftId) == "approved" && h.sendRows(d.draftId).isEmpty, "claim not released (status \(h.draftStatus(d.draftId)), sends \(h.sendRows(d.draftId).count))")
            try expect(h.audit("send_released") == 1 && h.lastError().contains("kill switch"), "release not audited / explained")
            h.exec.beforeSendHook = nil
            try h.set("kill_switch", "0")
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "after resume it sends")
            try expect(h.sendRows(d.draftId).count == 1 && h.sendRows(d.draftId)[0].i("attempt") == 1, "the released claim must not count as an attempt")
        }
        test("kill switch re-read inside the claim transaction") { h in
            let (_, d, _) = try single(h)
            try h.set("kill_switch", "1")                                       // flipped after the tick loaded its settings
            let pin = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            let out = try h.exec.claimNext(now: h.clock.now, pin: pin)
            try expect(out.killed && out.claim == nil && h.sendRows(d.draftId).isEmpty && h.draftStatus(d.draftId) == "approved", "claim made despite the kill switch")
        }
        test("live eligibility re-checked before the send (pin policy turned off mid-flight)") { h in
            try h.goLive()
            let (_, d, _) = try single(h, liveOpts())
            h.exec.beforeSendHook = {
                let root = h.config.rootPinPath
                try? FileManager.default.removeItem(atPath: root)
                try? h.writePin(to: root, mode: 0o444, policy: ["live_allowed": false])
            }
            let r = try h.tick()
            try expect(isHeld(r) && heldText(r).contains("live") && h.live.calls.isEmpty, "got \(r), live calls \(h.live.calls.count)")
            try expect(h.draftStatus(d.draftId) == "approved" && h.sendRows(d.draftId).isEmpty, "claim not released")
        }

        // 7. + 8. breaker reason, heartbeat before send, send snapshot
        test("heartbeat is written before the send, and the sends row already holds handle + body hash") { h in
            final class Probe: Transport {
                let name = "dry"; let db: Database; var heartbeatSeen = false; var snapshot = ""
                init(db: Database) { self.db = db }
                func send(_ r: SendRequest) -> SendOutcome {
                    heartbeatSeen = ((try? db.one("SELECT heartbeat_at FROM exec_status WHERE id = 1")) ?? nil) != nil
                    if let row = (try? db.one("SELECT handle, body_sha256 FROM sends WHERE draft_id = ? AND finished_at IS NULL", [.text(r.draftId)])) ?? nil {
                        snapshot = row.str("handle") + "|" + row.str("body_sha256")
                    }
                    return .sent(serviceUsed: "iMessage")
                }
            }
            let p = Probe(db: h.db)
            let (_, d, _) = try single(h, body: "snapshot me")
            let ex = Executor(db: h.db, config: h.config, contacts: h.contacts, clock: { h.clock.now }) { _, _, _ in p }
            try ex.prepare()
            try expect(try h.db.one("SELECT 1 AS x FROM exec_status") == nil, "no heartbeat row yet")
            _ = try ex.tick()
            try expect(p.heartbeatSeen, "no heartbeat row existed when send() ran")
            try expect(p.snapshot == "+15551234567|" + Hex.sha256Hex("snapshot me"), "sends snapshot while sending: '\(p.snapshot)'")
            let s = h.sendRows(d.draftId)
            try expect(s.count == 1 && s[0].str("handle") == "+15551234567" && s[0].str("body_sha256") == Hex.sha256Hex("snapshot me"), "snapshot missing after the send")
        }

        // 9. tamper detection
        test("a trigger in the database makes the executor refuse to run (startup and every tick)") { h in
            let (_, d, _) = try single(h)
            try h.db.runSchemaScript("CREATE TRIGGER sneaky AFTER INSERT ON sends BEGIN UPDATE drafts SET status = 'approved'; END;")
            try h.rebuild()                                                  // start-up with a trigger present must not throw
            try expect(try h.exec.recoverInterrupted() == 0, "start-up recovery must not touch a tampered DB")
            let r = try h.tick()
            try expect(isHeld(r) && heldText(r).contains("trigger sneaky") && h.dryLines().isEmpty && h.sendRows(d.draftId).isEmpty, "got \(r)")
            try expect(h.lastError().contains("tampering") && h.lastError().contains("sneaky"), "last_error: '\(h.lastError())'")
            try h.db.runSchemaScript("DROP TRIGGER sneaky;")
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "runs again once the trigger is gone")
            try expect(!h.lastError().contains("tampering"), "tamper message should clear")
        }
        test("a view named after a gated table makes the executor refuse to run") { h in
            let (_, d, _) = try single(h)
            try h.db.runSchemaScript("DROP TABLE exec_state; CREATE VIEW exec_state AS SELECT 'next_send_at' AS key, '' AS value;")
            let r = try h.tick()
            try expect(isHeld(r) && heldText(r).contains("view exec_state") && h.dryLines().isEmpty && h.draftStatus(d.draftId) == "approved", "got \(r)")
            try h.db.runSchemaScript("DROP VIEW exec_state; CREATE TABLE exec_state (key TEXT PRIMARY KEY, value TEXT);")
            try expect(try h.tick() == .processed(draftId: d.draftId, result: "sent"), "runs again")
        }

        // 10. contacts export
        test("contacts export: field names, groups, city and birthday formats (pure, Contacts never touched)") { _ in
            try expect(ContactsExport.birthday(month: 3, day: 7, year: nil) == "03-07", "no year")
            try expect(ContactsExport.birthday(month: 12, day: 25, year: 1990) == "1990-12-25", "with year")
            try expect(ContactsExport.birthday(month: 1, day: 2, year: 1604) == "01-02", "Apple placeholder year")
            try expect(ContactsExport.birthday(month: nil, day: 5, year: 1990) == nil && ContactsExport.birthday(month: 13, day: 1, year: nil) == nil, "invalid dates")
            let e = ContactsExport.entry(macosId: "ID1", given: "Sam", family: "Lee", nickname: "S", org: "Acme",
                                         phones: [("(555) 123-4567", "mobile")], emails: [("sam@example.com", "home")],
                                         groups: ["College friends", "Outbox imports", "College friends"], city: "Boston", birthday: "03-07")
            try expect(Set(e.keys) == ["macos_id", "given_name", "family_name", "nickname", "org", "phones", "emails", "groups", "city", "birthday"], "keys: \(e.keys.sorted())")
            try expect((e["groups"] as? [String]) == ["College friends", "Outbox imports"], "groups should be sorted and unique")
            let bare = ContactsExport.entry(macosId: "ID2", given: "", family: "", nickname: "", org: "", phones: [], emails: [], groups: [], city: "", birthday: nil)
            try expect(bare["city"] == nil && bare["birthday"] == nil && (bare["groups"] as? [String]) == [], "city/birthday omitted when unknown, groups always present")
            try expect(JSON.data(["contacts": [e, bare]]) != nil, "export must be JSON-encodable")
        }
    }

    static func throwsError(_ f: () throws -> Void) -> Bool { do { try f(); return false } catch { return true } }
    static func throwsNothing(_ f: () throws -> Void) -> Bool { do { try f(); return true } catch { return false } }
}

/// Independent re-parse of generated AppleScript: the only text outside string literals must be the fixed template,
/// and the literals must decode back to exactly the handle and the (newline-normalised) body.
public enum AppleScriptCheck {
    public static func tokenise(_ script: String) throws -> (outside: String, literals: [String]) {
        var outside = "", literals: [String] = [], cur = ""
        var inLit = false, esc = false
        for ch in script {
            if inLit {
                if esc {
                    switch ch {
                    case "\\": cur.append("\\")
                    case "\"": cur.append("\"")
                    case "t": cur.append("\t")
                    case "n": cur.append("\n")
                    default: throw CaseFailure(message: "unexpected escape \\\(ch)")
                    }
                    esc = false
                } else if ch == "\\" { esc = true }
                else if ch == "\"" { inLit = false; literals.append(cur); cur = ""; outside += "<S>" }
                else { cur.append(ch) }
            } else if ch == "\"" { inLit = true } else { outside.append(ch) }
        }
        if inLit { throw CaseFailure(message: "unterminated string literal") }
        return (outside, literals)
    }

    public static func verify(script: String, handle: String, body: String, service: String) throws {
        let (outside, lits) = try tokenise(script)
        let lines = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        let expectedOutside = "tell application <S>\n\twith timeout of 60 seconds\n\t\tset theParticipant to participant <S> of (1st account whose service type = \(service))\n\t\tsend (\(Array(repeating: "<S>", count: lines.count).joined(separator: " & linefeed & "))) to theParticipant\n\tend timeout\nend tell"
        try expect(outside == expectedOutside, "text outside literals is not the fixed template:\n\(outside)")
        try expect(!outside.contains("do shell script"), "shell script text escaped its literal")
        try expect(lits.first == "Messages" && lits.dropFirst().first == handle, "handle literal wrong: \(lits.prefix(2))")
        try expect(Array(lits.dropFirst(2)) == lines, "body literals do not decode to the body: \(lits.dropFirst(2)) vs \(lines)")
    }
}
