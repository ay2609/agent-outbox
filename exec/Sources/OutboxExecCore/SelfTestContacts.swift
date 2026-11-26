import Foundation
import CryptoKit

// Selftest cases for native contact management. Everything runs on the in-memory FakeContacts; the real
// Contacts framework is never touched.

struct ChangeSpec {
    var id: String, setId: String, kind: String, target: String?, payloadJson: String
    /// Overrides for what the manifest signs (to build mismatches). nil = sign the truth.
    var signedKind: String?
    var signedTarget: String?
    var signedSha: String?
}

enum CP {
    static func phoneObj(_ p: String, _ label: String) -> [String: Any] { ["e164": p, "label": label] }
    static func create(given: String, family: String, phones: [String] = [], emails: [String] = [], groups: [String] = [], extra: [String: Any] = [:]) -> [String: Any] {
        var o: [String: Any] = ["given_name": given, "family_name": family, "phones": phones.map { phoneObj($0, "mobile") },
                                "emails": emails.map { ["email": $0, "label": "home"] as [String: Any] }]
        if !groups.isEmpty { o["groups"] = groups }
        for (k, v) in extra { o[k] = v }
        return o
    }
    static func update(set: [String: String] = [:], phones: [String] = [], emails: [String] = [], groups: [String] = []) -> [String: Any] {
        var o: [String: Any] = [:]
        if !set.isEmpty { o["set"] = set }
        if !phones.isEmpty { o["add_phones"] = phones.map { phoneObj($0, "") } }
        if !emails.isEmpty { o["add_emails"] = emails.map { ["email": $0, "label": ""] as [String: Any] } }
        if !groups.isEmpty { o["add_groups"] = groups }
        return o
    }
}

extension Harness {
    func makeSet(status: String = "review", title: String = "selftest set", source: String = "mcp") throws -> String {
        let id = newId()
        let t = Time.iso(clock.now)
        try db.exec("INSERT INTO contact_change_sets(id, title, created_by, source, status, created_at, updated_at) VALUES(?, ?, 'selftest', ?, ?, ?, ?)",
                    [.text(id), .text(title), .text(source), .text(status), .text(t), .text(t)])
        return id
    }

    @discardableResult
    func addChange(set: String, kind: String = "create", target: String? = nil, payload: [String: Any]? = nil, payloadJson: String? = nil,
                   auto: Bool = false, status: String? = nil, position: Int = 0, undoOf: String? = nil) throws -> ChangeSpec {
        let id = newId()
        let json = payloadJson ?? JSON.string(payload ?? [:])
        let st = status ?? (auto ? "auto_queued" : "review")
        try db.exec("INSERT INTO contact_changes(id, set_id, position, kind, target_macos_id, payload_json, requires_approval, status, created_at, undo_of) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [.text(id), .text(set), .num(position), .text(kind), .opt(target), .text(json), .num(auto ? 0 : 1), .text(st), .text(Time.iso(clock.now)), .opt(undoOf)])
        return ChangeSpec(id: id, setId: set, kind: kind, target: target, payloadJson: json)
    }

    /// Fabricates a Secure Enclave signature over a contacts manifest, exactly as the app does, and stores the approval.
    /// `v` / `kind` let a test build a manifest of the wrong flavour; items are marked `approved` like the dashboard API does.
    @discardableResult
    func approveContacts(set: String, items: [ChangeSpec], _ o: ApprovalOpts = ApprovalOpts(), v: Int = 1, kind: String? = "contacts", markApproved: Bool = true) throws -> String {
        let notAfter = o.notAfter ?? clock.now.addingTimeInterval(86_400)
        let itemObjs: [[String: Any]] = items.map { i in
            ["change_id": i.id, "kind": i.signedKind ?? i.kind, "target_macos_id": (i.signedTarget ?? i.target).map { $0 as Any } ?? NSNull(),
             "payload_sha256": i.signedSha ?? Hex.sha256Hex(i.payloadJson)]
        }
        var m: [String: Any] = ["v": v, "transport": o.transport, "approval_id": o.approvalId, "set_id": set, "created_at": Time.iso(clock.now),
                                "not_after": Time.iso(notAfter), "rp_id": o.manifestRpId ?? rpId, "origin": o.manifestOrigin ?? origin, "contact_items": itemObjs]
        if let kind { m["kind"] = kind }
        let manifest = o.rawManifest ?? JSON.string(m)
        let digest = Hex.sha256(Data(manifest.utf8))
        let (cred, sigD) = try o.sign(manifest: manifest, defaultTag: "contacts", harnessKey: key)
        let fields = (cred: B64.encodeURL(cred), auth: o.authB64, cdj: o.cdjB64, sig: o.enc(sigD))
        try db.exec("""
            INSERT INTO contact_approvals(id, set_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at, revoked_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, [.text(o.approvalId), .text(set), .text(manifest), .text(o.manifestShaColumn ?? Hex.encode(digest)), .text(fields.cred),
                  .text(fields.auth), .text(fields.cdj), .text(fields.sig), .text(Time.iso(notAfter)), .text(Time.iso(clock.now)),
                  o.revoked ? .text(Time.iso(clock.now)) : .null])
        if markApproved {
            for i in items { try db.exec("UPDATE contact_changes SET status = 'approved' WHERE id = ?", [.text(i.id)]) }
            try db.exec("UPDATE contact_change_sets SET status = 'approved' WHERE id = ?", [.text(set)])
        }
        return o.approvalId
    }

    // MARK: observations
    func chg(_ id: String) throws -> Row { try db.one("SELECT * FROM contact_changes WHERE id = ?", [.text(id)])! }
    func chgDesc(_ id: String) -> String { ((try? chg(id)).map { "\($0.values)" }) ?? "?" }
    func chgStatus(_ id: String) -> String { ((try? db.one("SELECT status FROM contact_changes WHERE id = ?", [.text(id)])) ?? nil)?.str("status") ?? "?" }
    func applyRows(_ changeId: String) -> [Row] { (try? db.query("SELECT * FROM contact_applies WHERE change_id = ?", [.text(changeId)])) ?? [] }
    func setStatus(_ id: String) -> String { ((try? db.one("SELECT status FROM contact_change_sets WHERE id = ?", [.text(id)])) ?? nil)?.str("status") ?? "?" }
    func dryContactLines() -> [[String: Any]] {
        guard let s = try? String(contentsOfFile: config.dryContactsLogPath, encoding: .utf8) else { return [] }
        return s.split(separator: "\n").compactMap { JSON.object(Data($0.utf8)) }
    }
    func contactRejections() -> [String] {
        let rows = (try? db.query("SELECT details_json FROM audit_log WHERE action IN ('contact_approval_rejected','contact_item_rejected')")) ?? []
        return rows.compactMap { JSON.object(Data($0.str("details_json").utf8))?["reason"] as? String }
    }
    /// A (hardened-mode) root pin that allows contact changes live (and optionally message sending live).
    func goContactsLive(messagesLive: Bool = false) throws { try goLive(allowed: messagesLive, policy: ["contacts_live_allowed": true]) }
    /// A create in review that is then approved with a fabricated Touch ID signature, like the dashboard does. The manifest asks for
    /// the transport the `contacts_transport` setting says (what the server signs); the pin policy still decides the lane.
    @discardableResult
    func approvedCreate(set: String, payload: [String: Any]? = nil, payloadJson: String? = nil, position: Int = 0) throws -> ChangeSpec {
        let c = try addChange(set: set, payload: payload, payloadJson: payloadJson, position: position)
        var o = ApprovalOpts()
        o.transport = (try db.one("SELECT value FROM settings WHERE key = 'contacts_transport'")?.str("value")) == "live" ? "live" : "dry"
        try approveContacts(set: set, items: [c], o)
        return c
    }
}

extension SelfTest {
    static func ready(_ h: Harness) { h.contacts.accessGranted = true }

    /// The reason in the newest contact_apply_released audit row.
    static func lastRelease(_ h: Harness) -> String {
        ((try? h.db.one("SELECT details_json FROM audit_log WHERE action = 'contact_apply_released' ORDER BY id DESC LIMIT 1")) ?? nil)?.str("details_json") ?? ""
    }

    static func hasRefusal(_ h: Harness, _ s: String) -> Bool { h.contactRejections().contains { $0.lowercased().contains(s.lowercased()) } }

    static func registerContactCases(_ test: Reg) {
        // ---- pure rules -------------------------------------------------------------------------------------------------
        test("contacts: payload validation (names, control and bidi characters, handle counts, duplicates, unknown keys)") { _ in
            func bad(_ kind: String, _ o: [String: Any], target: String? = "T", _ why: String) throws {
                do { _ = try ContactPayloadParser.parse(kind: kind, json: JSON.string(o), targetMacosId: target); throw CaseFailure(message: "accepted: \(why)") }
                catch is Rejection { }
            }
            func good(_ kind: String, _ o: [String: Any], target: String? = "T", _ why: String) throws {
                do { _ = try ContactPayloadParser.parse(kind: kind, json: JSON.string(o), targetMacosId: target) }
                catch { throw CaseFailure(message: "refused \(why): \(error)") }
            }
            let ph = ["+15551234567"]
            try good("create", CP.create(given: "Sam🐚", family: "Lee", phones: ph), "emoji name")
            try good("create", CP.create(given: String(repeating: "a", count: 100), family: "", phones: ph), "100-char name")
            try bad("create", CP.create(given: String(repeating: "a", count: 101), family: "", phones: ph), "101-char name")
            try bad("create", CP.create(given: "Sam\u{0007}", family: "L", phones: ph), "C0 control")
            try bad("create", CP.create(given: "Sa\u{0085}m", family: "L", phones: ph), "C1 control")
            try bad("create", CP.create(given: "Sam\u{202E}", family: "L", phones: ph), "bidi override")
            try bad("create", CP.create(given: "Sam\u{2067}", family: "L", phones: ph), "bidi isolate")
            try bad("create", CP.create(given: "Sa\u{2028}m", family: "L", phones: ph), "line separator")
            // exact bytes: nothing is trimmed silently, a string that would change when trimmed is refused
            try bad("create", CP.create(given: "  Sam  ", family: "L", phones: ph), "surrounding whitespace")
            try bad("create", CP.create(given: "Sam", family: "L ", phones: ph), "trailing space in family")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ph, groups: [" Team"]), "leading space in a group")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ph, groups: ["Team\n"]), "trailing newline in a group")
            try bad("update", CP.update(set: ["nickname": " S"]), "leading space in an update value")
            try good("create", CP.create(given: "Sam Jr", family: "van  Lee", phones: ph), "inner whitespace is left alone")
            // invisible and default-ignorable code points are refused (a name that prints like another one), except ZWJ and VS16
            let invisibles: [UInt32] = [0x00AD, 0x034F, 0x061C, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x180B, 0x180D, 0x180F, 0x200B, 0x200C, 0x200E, 0x200F,
                                        0x2060, 0x2064, 0x206F, 0x3164, 0xFE00, 0xFE0E, 0xFEFF, 0xFFA0, 0xE0000, 0xE0001, 0xE01EF, 0xE0FFF]
            for v in invisibles {
                let ch = String(Unicode.Scalar(v)!)
                try bad("create", CP.create(given: "Al" + ch + "ice", family: "Smith", phones: ph), "U+" + String(v, radix: 16, uppercase: true) + " in given_name")
            }
            try bad("create", CP.create(given: "Alice", family: "Sm\u{200B}ith", phones: ph), "invisible in family_name")
            try bad("create", CP.create(given: "Alice", family: "Smith", phones: ph, extra: ["nickname": "Al\u{FEFF}"]), "invisible in nickname")
            try bad("create", CP.create(given: "Alice", family: "Smith", phones: ph, extra: ["org": "Ac\u{2060}me"]), "invisible in org")
            try bad("create", CP.create(given: "Alice", family: "Smith", phones: ph, groups: ["Fam\u{200B}ily"]), "invisible in a group")
            try bad("update", CP.update(set: ["given_name": "Al\u{034F}ice"]), "invisible in an update set value")
            try bad("update", CP.update(groups: ["Fam\u{00AD}ily"]), "invisible in an update group")
            try good("create", CP.create(given: "Sam", family: "L\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", phones: ph), "ZWJ emoji sequence")
            try good("create", CP.create(given: "Sam\u{2764}\u{FE0F}", family: "L", phones: ph), "VS16 emoji")
            try bad("create", CP.create(given: "", family: "", phones: ph), "no name")
            try bad("create", CP.create(given: "Sam", family: "L"), "no handle")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ["5551234567"]), "phone not E.164")
            try bad("create", CP.create(given: "Sam", family: "L", emails: ["Sam@Example.com"]), "email not lowercased")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ph + ph), "duplicate phone")
            try bad("create", CP.create(given: "Sam", family: "L", emails: ["a@b.co", "a@b.co"]), "duplicate email")
            try bad("create", CP.create(given: "Sam", family: "L", phones: (0..<6).map { "+1555123456\($0)" }), "6 phones")
            try good("create", CP.create(given: "Sam", family: "L", phones: (0..<5).map { "+1555123456\($0)" }), "5 phones")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ph, groups: (0..<6).map { "g\($0)" }), "6 groups")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ph, groups: ["bad\u{0001}group"]), "control char in group")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ph, extra: ["notes": "x"]), "unknown key")
            try bad("create", CP.create(given: "Sam", family: "L", phones: ph, extra: ["phones": [["e164": "+15551234567", "label": "m", "extra": 1]]]), "unknown nested key")
            try bad("create", ["given_name": 5, "phones": [["e164": "+15551234567", "label": "m"]]], "wrong type")
            try good("update", CP.update(set: ["given_name": "Sam🐚"]), "update set")
            try bad("update", CP.update(set: ["given_name": "Sam"]), target: nil, "update without target")
            try bad("update", CP.update(set: ["notes": "x"]), "set key outside the four")
            try bad("update", [:], "update that changes nothing")
            try bad("update", ["set": [String: String](), "evil": 1], "update unknown key")
            try good("update", CP.update(set: ["nickname": ""]), "clearing a field is a change")
            let sha = String(repeating: "a", count: 64)
            try good("undo", ["undo_of": "x", "undo_kind": "update", "before_vcard_sha256": sha, "after_fingerprint": sha], "undo of update")
            try good("undo", ["undo_of": "x", "undo_kind": "create", "before_vcard_sha256": NSNull(), "after_fingerprint": sha], "undo of create")
            try bad("undo", ["undo_of": "x", "undo_kind": "update", "before_vcard_sha256": NSNull(), "after_fingerprint": sha], "undo of update without snapshot hash")
            try bad("undo", ["undo_of": "x", "undo_kind": "delete", "after_fingerprint": sha], "unknown undo kind")
        }
        test("contacts: canonical fingerprint is the documented JSON, sorted, phones normalised, groups left out") { _ in
            var c = ContactCard(identifier: "x")
            c.given = "Sam"; c.family = "Lee"; c.nickname = "S"; c.org = "Acme"
            c.phones = [LabeledValue("(555) 987-6543", "home"), LabeledValue("+15551234567", "mobile")]
            c.emails = [LabeledValue("Z@B.co", "home"), LabeledValue("a@b.co", "work")]
            c.groups = ["one"]
            let expected = "{\"e\":[\"a@b.co\",\"z@b.co\"],\"f\":\"Lee\",\"g\":\"Sam\",\"n\":\"S\",\"o\":\"Acme\",\"p\":[\"+15551234567\",\"+15559876543\"]}"
            try expect(ContactMath.fingerprint(c) == Hex.sha256Hex(expected), "fingerprint is not sha256 of the canonical JSON")
            c.groups = []
            c.phones.reverse()
            try expect(ContactMath.fingerprint(c) == Hex.sha256Hex(expected), "order or groups changed the fingerprint")
            c.phones.append(LabeledValue("ext. 12", "other"))
            try expect(ContactMath.fingerprint(c) != Hex.sha256Hex(expected), "an unparseable phone must still count (kept raw)")
        }
        test("contacts: the before snapshot is canonical JSON (sorted keys, e164 or raw, groups sorted), round-trips, and holds no note") { _ in
            var c = ContactCard(identifier: "x")
            c.given = "Sam"; c.family = "Lee"; c.nickname = "S"; c.org = "Acme"
            c.phones = [LabeledValue("(555) 987-6543", "home"), LabeledValue("ext. 12", "other")]
            c.emails = [LabeledValue("a@b.co", "work")]
            c.groups = ["Team \u{1F41A}", "Friends"]
            let j = ContactSnapshot.json(c)
            let expected = "{\"emails\":[{\"email\":\"a@b.co\",\"label\":\"work\"}],\"family_name\":\"Lee\",\"given_name\":\"Sam\",\"groups\":[\"Friends\",\"Team \u{1F41A}\"],"
                + "\"nickname\":\"S\",\"org\":\"Acme\",\"phones\":[{\"e164\":\"+15559876543\",\"label\":\"home\"},{\"label\":\"other\",\"raw\":\"ext. 12\"}],\"v\":1}"
            try expect(j == expected, "snapshot JSON differs: \(j)")
            try expect(ContactSnapshot.json(c) == j, "snapshot is not stable")
            try expect(!j.lowercased().contains("note") && !j.contains("VCARD"), "snapshot must not mention a note or a vCard")
            guard let back = ContactSnapshot.parse(j) else { throw CaseFailure(message: "snapshot did not parse") }
            try expect(back.given == "Sam" && back.family == "Lee" && back.nickname == "S" && back.org == "Acme" && back.emails == c.emails
                       && back.phones == [LabeledValue("+15559876543", "home"), LabeledValue("ext. 12", "other")] && back.groups == ["Friends", "Team \u{1F41A}"], "round trip: \(back)")
            try expect(ContactSnapshot.parse("BEGIN:VCARD\r\nEND:VCARD") == nil && ContactSnapshot.parse("{\"v\":2}") == nil, "only v1 JSON is a snapshot")
        }
        test("contacts: pin policy contacts_live_allowed is a mandatory boolean (wrong type refuses the whole pin) and independent of live_allowed") { h in
            let p = h.dir + "/pins/p.json"
            try h.writePin(to: p, mode: 0o600)
            var pf = try PinFileLoader.load(path: p, mode: .simple)
            try expect(!pf.policy.contactsLiveAllowed && !pf.policy.liveAllowed, "default pin reads false/false")
            try h.writePin(to: p, mode: 0o600, policy: ["live_allowed": true, "contacts_live_allowed": true])
            pf = try PinFileLoader.load(path: p, mode: .simple)
            try expect(pf.policy.contactsLiveAllowed && pf.policy.liveAllowed, "both true")
            for bad: Any in ["yes", 1, NSNull(), ["x": 1]] {
                try h.writePin(to: p, mode: 0o600, policy: ["live_allowed": true, "contacts_live_allowed": bad])
                do { _ = try PinFileLoader.load(path: p, mode: .simple); throw CaseFailure(message: "wrong type \(bad) accepted") }
                catch let e as ExecError { try expect("\(e)".contains("not a boolean"), "wrong type \(bad): \(e)") }
            }
            try h.writePin(to: p, mode: 0o600, rawPolicy: ["live_allowed": true] as [String: Any])
            do { _ = try PinFileLoader.load(path: p, mode: .simple); throw CaseFailure(message: "missing contacts_live_allowed accepted") }
            catch let e as ExecError { try expect("\(e)".contains("exactly live_allowed and contacts_live_allowed"), "missing field: \(e)") }
            try h.writePin(to: p, mode: 0o600, policy: ["live_allowed": false, "contacts_live_allowed": true])
            pf = try PinFileLoader.load(path: p, mode: .simple)
            try expect(pf.policy.contactsLiveAllowed && !pf.policy.liveAllowed, "contacts live is independent of message live")
        }

        // ---- creates (never automatic) -----------------------------------------------------------------------------------------------
        test("contacts: an approved create applies (dry): apply row with the approval, dry log, fingerprint, nothing written to Contacts") { h in
            ready(h)
            let set = try h.makeSet(status: "drafting")
            let c = try h.addChange(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            let ap = try h.approveContacts(set: set, items: [c])
            _ = try h.tick()
            let r = try h.chg(c.id)
            try expect(r.str("status") == "applied" && r.str("transport") == "dry" && r.str("result_macos_id") == "dry:" + c.id && !r.isNull("applied_at"), "change row: \(r.values)")
            let expected = "{\"e\":[],\"f\":\"Lee\",\"g\":\"Sam\",\"n\":\"\",\"o\":\"\",\"p\":[\"+15551234567\"]}"
            try expect(r.str("after_fingerprint") == Hex.sha256Hex(expected), "after_fingerprint wrong: \(r.str("after_fingerprint"))")
            let a = h.applyRows(c.id)
            try expect(a.count == 1 && a[0].str("approval_id") == ap && a[0].str("transport") == "dry" && a[0].str("result") == "applied" && !a[0].isNull("finished_at"), "apply row wrong")
            let lines = h.dryContactLines()
            try expect(lines.count == 1 && lines[0]["change_id"] as? String == c.id && lines[0]["kind"] as? String == "create" && lines[0]["approval_id"] as? String == ap
                       && lines[0]["target_macos_id"] is NSNull && (lines[0]["payload"] as? [String: Any])?["given_name"] as? String == "Sam" && lines[0]["at"] != nil, "dry log line wrong: \(lines)")
            try expect(h.contacts.writeCount == 0 && h.contacts.exportCalls <= 1, "dry mode wrote to Contacts")
            try expect(h.setStatus(set) == "done", "set should be done, is \(h.setStatus(set))")
            try expect(h.audit("contact_applied") == 1 && h.contacts.promptAsks == 0, "audit / prompt")
        }
        test("contacts: an invalid approved create fails and writes nothing (no handle, long name, bidi character)") { h in
            ready(h)
            let set = try h.makeSet()
            let a = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee"), position: 0)
            let b = try h.approvedCreate(set: set, payload: CP.create(given: String(repeating: "x", count: 101), family: "", phones: ["+15551234567"]), position: 1)
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Sam\u{202E}", family: "Lee", phones: ["+15551234568"]), position: 2)
            let d = try h.approvedCreate(set: set, payloadJson: "not json", position: 3)
            _ = try h.tick()
            for x in [a, b, c, d] {
                let r = try h.chg(x.id)
                try expect(r.str("status") == "failed" && r.str("error").hasPrefix("invalid payload"), "\(x.id): \(r.values)")
            }
            try expect(h.contacts.writeCount == 0 && h.dryContactLines().isEmpty && h.setStatus(set) == "done", "nothing should have been written")
        }
        test("contacts: an unknown payload key is refused (create and approved update)") { h in
            ready(h)
            let set = try h.makeSet()
            let a = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"], extra: ["note": "smuggled"]))
            let card = h.contacts.add(given: "Kim", phones: ["+15550001111"])
            var o = CP.update(set: ["given_name": "Kim🐚"]); o["evil"] = true
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: o, position: 1)
            try h.approveContacts(set: set, items: [u])
            _ = try h.tick()
            let ra = try h.chg(a.id), ru = try h.chg(u.id)
            try expect(ra.str("status") == "failed" && ra.str("error").contains("unknown key"), "create: \(ra.values)")
            try expect(ru.str("status") == "failed" && ru.str("error").contains("unknown key"), "update: \(ru.values)")
            try expect(h.contacts.writeCount == 0, "nothing may be written")
        }
        test("contacts: a failed write is consumed, never retried") { h in
            ready(h)
            try h.goContactsLive(); try h.set("contacts_transport", "live")
            h.contacts.failNextWrite = true
            let set = try h.makeSet()
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            _ = try h.tick()
            let r = try h.chg(c.id), a = h.applyRows(c.id)
            try expect(r.str("status") == "failed" && r.str("error").contains("simulated") && a.count == 1 && a[0].str("result") == "failed", "failure: \(r.values)")
            try h.db.exec("UPDATE contact_changes SET status = 'approved' WHERE id = ?", [.text(c.id)])   // an agent re-opens it
            _ = try h.tick()
            try expect(h.contacts.writeCount == 0 && h.chgStatus(c.id) == "failed", "a consumed change was retried")
        }

        // ---- transports -------------------------------------------------------------------------------------------------
        test("contacts: approved creates are live only when signed live AND a trusted pin has contacts_live_allowed") { h in
            ready(h)
            let set = try h.makeSet()
            // 1. setting live, user pin only (its policy forbids contacts live): dry
            try h.set("contacts_transport", "live")
            let a = try h.approvedCreate(set: set, payload: CP.create(given: "A", family: "One", phones: ["+15551110001"]))
            _ = try h.tick()
            try expect(h.chg(a.id).str("transport") == "dry" && h.contacts.writeCount == 0, "setting live without a pin must stay dry")
            // 2. pin allows messages live but not contacts: dry
            try h.goLive(allowed: true)
            let b = try h.approvedCreate(set: set, payload: CP.create(given: "B", family: "Two", phones: ["+15551110002"]))
            _ = try h.tick()
            try expect(h.chg(b.id).str("transport") == "dry" && h.contacts.writeCount == 0, "live_allowed alone must not enable live contacts")
            // 3. pin allows contacts live, setting dry: dry
            try h.goContactsLive(); try h.set("contacts_transport", "dry")
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "C", family: "Three", phones: ["+15551110003"]))
            _ = try h.tick()
            try expect(h.chg(c.id).str("transport") == "dry" && h.contacts.writeCount == 0, "pin alone must not enable live contacts")
            // 4. both: live
            try h.set("contacts_transport", "live")
            let d = try h.approvedCreate(set: set, payload: CP.create(given: "D", family: "Four", phones: ["+15551110004"], groups: ["Team"]))
            _ = try h.tick()
            let r = try h.chg(d.id)
            try expect(r.str("transport") == "live" && h.contacts.creates.count == 1 && r.str("result_macos_id") == "FAKE-NEW-1", "live create: \(r.values)")
            try expect(h.contacts.creates[0].groups == ["Outbox imports", "Team"] && h.contacts.creates[0].phones == [LabeledValue("+15551110004", "mobile")], "new contact: groups/labels wrong")
            let stored = h.contacts.current("FAKE-NEW-1")!
            try expect(r.str("after_fingerprint") == ContactMath.fingerprint(stored), "after_fingerprint is not the stored card's")
            try expect(h.dryContactLines().count == 3, "the three dry creates should each have logged")
        }
        test("contacts: a live approved create re-exports Contacts (and dry ones don't)") { h in
            ready(h)
            try h.exec.state.set("last_contacts_export", Time.iso(h.clock.now))
            let set = try h.makeSet()
            try h.approvedCreate(set: set, payload: CP.create(given: "A", family: "One", phones: ["+15551110001"]))
            _ = try h.tick()
            try expect(h.contacts.exportCalls == 0, "dry apply must not force an export")
            try h.goContactsLive(); try h.set("contacts_transport", "live")
            try h.approvedCreate(set: set, payload: CP.create(given: "B", family: "Two", phones: ["+15551110002"]))
            _ = try h.tick()
            try expect(h.contacts.exportCalls == 1 && h.contacts.creates.count == 1, "live apply should export once (\(h.contacts.exportCalls))")
        }

        // ---- approved updates -------------------------------------------------------------------------------------------
        test("contacts: approved update (live) applies, stores before_vcard + fingerprint, consumes the change, exports") { h in
            ready(h)
            try h.goContactsLive()
            try h.exec.state.set("last_contacts_export", Time.iso(h.clock.now))
            let card = h.contacts.add(given: "Sam", family: "Lee", phones: ["+15551234567"], groups: ["Friends"])
            let set = try h.makeSet()
            let u = try h.addChange(set: set, kind: "update", target: card.identifier,
                                    payload: CP.update(set: ["given_name": "Sam🐚"], phones: ["+15559990000"], emails: ["sam@example.com"], groups: ["Team"]))
            var o = ApprovalOpts(); o.transport = "live"
            let ap = try h.approveContacts(set: set, items: [u], o)
            _ = try h.tick()
            let now = h.contacts.current(card.identifier)!
            try expect(now.given == "Sam🐚" && now.phones.map { $0.value } == ["+15551234567", "+15559990000"] && now.phones[1].label == "mobile" && now.emails == [LabeledValue("sam@example.com", "home")]
                       && Set(now.groups) == ["Friends", "Team"], "card after update: \(now)")
            let r = try h.chg(u.id)
            try expect(r.str("status") == "applied" && r.str("transport") == "live" && r.str("result_macos_id") == card.identifier && r.str("after_fingerprint") == ContactMath.fingerprint(now), "change row: \(r.values)")
            guard let beforeCard = ContactSnapshot.parse(r.str("before_vcard")) else { throw CaseFailure(message: "before_vcard is not a JSON snapshot: \(r.str("before_vcard"))") }
            try expect(beforeCard.given == "Sam" && beforeCard.phones.count == 1 && beforeCard.groups == ["Friends"], "before_vcard should hold the card as it was")
            let a = h.applyRows(u.id)
            try expect(a.count == 1 && a[0].str("approval_id") == ap && a[0].str("transport") == "live" && a[0].str("result") == "applied" && !a[0].isNull("finished_at"), "apply row wrong")
            try expect(h.setStatus(set) == "done" && h.contacts.exportCalls == 1 && h.dryContactLines().isEmpty, "set \(h.setStatus(set)), exports \(h.contacts.exportCalls)")
        }
        test("contacts: a manifest asking for live on a pin without contacts_live_allowed is applied dry (not refused)") { h in
            ready(h)
            try h.goLive(allowed: true)                                  // messages live, contacts not
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]))
            var o = ApprovalOpts(); o.transport = "live"
            try h.approveContacts(set: set, items: [u], o)
            _ = try h.tick()
            let r = try h.chg(u.id)
            try expect(r.str("status") == "applied" && r.str("transport") == "dry" && h.contacts.writeCount == 0 && h.contacts.current(card.identifier)!.given == "Sam", "should be dry: \(r.values)")
            try expect(h.dryContactLines().count == 1 && !r.isNull("before_vcard"), "dry log / snapshot missing")
            // and the dry fingerprint is what the live write would have produced
            var predicted = h.contacts.current(card.identifier)!; predicted.given = "Sam🐚"
            try expect(r.str("after_fingerprint") == ContactMath.fingerprint(predicted), "dry fingerprint should predict the result")
        }
        test("contacts: a dry-signed manifest stays dry even on a pin that allows contacts live") { h in
            ready(h)
            try h.goContactsLive(); try h.set("contacts_transport", "live")   // the DB setting is ignored for a signed manifest
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]))
            try h.approveContacts(set: set, items: [u])                      // transport dry
            _ = try h.tick()
            try expect(h.chg(u.id).str("transport") == "dry" && h.contacts.writeCount == 0, "dry manifest went live")
        }
        test("contacts: tampered payload_json after approval is refused and goes back to review") { h in
            ready(h)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]))
            try h.approveContacts(set: set, items: [u])
            try h.db.exec("UPDATE contact_changes SET payload_json = ? WHERE id = ?", [.text(JSON.string(CP.update(phones: ["+15559999999"]))), .text(u.id)])
            _ = try h.tick()
            let r = try h.chg(u.id)
            try expect(r.str("status") == "review" && r.str("error").contains("payload changed") && h.applyRows(u.id).isEmpty && h.contacts.writeCount == 0 && h.dryContactLines().isEmpty, "tamper: \(r.values)")
            try expect(hasRefusal(h, "payload changed") && h.lastError().contains("returned to review") && h.audit("contact_changes_returned_to_review") == 1, "no visible refusal")
        }
        test("contacts: kind or target that differ from the signed item are refused") { h in
            ready(h)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let other = h.contacts.add(given: "Kim", phones: ["+15550001111"])
            let set = try h.makeSet()
            var a = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]), position: 0)
            var b = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["nickname": "S"]), position: 1)
            a.signedTarget = other.identifier       // the user signed a different contact
            b.signedKind = "create"
            try h.approveContacts(set: set, items: [a, b])
            _ = try h.tick()
            try expect(h.chgStatus(a.id) == "review" && h.chg(a.id).str("error").contains("target contact changed"), "target mismatch: \(h.chgDesc(a.id))")
            try expect(h.chgStatus(b.id) == "review" && h.chg(b.id).str("error").contains("kind changed"), "kind mismatch: \(h.chgDesc(b.id))")
            try expect(h.contacts.writeCount == 0 && h.dryContactLines().isEmpty, "nothing may be applied")
        }
        test("contacts: one bad item does not stop the others in the same approval") { h in
            ready(h)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let good = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]), position: 0)
            let bad = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["nickname": "S"]), position: 1)
            try h.approveContacts(set: set, items: [good, bad])
            try h.db.exec("UPDATE contact_changes SET payload_json = ? WHERE id = ?", [.text(JSON.string(CP.update(set: ["nickname": "evil"]))), .text(bad.id)])
            _ = try h.tick()
            try expect(h.chgStatus(good.id) == "applied" && h.chgStatus(bad.id) == "review" && h.dryContactLines().count == 1, "good \(h.chgStatus(good.id)), bad \(h.chgStatus(bad.id))")
            try expect(h.setStatus(set) == "review", "set with a change back in review is review, is \(h.setStatus(set))")
        }
        test("contacts: an applied change is never applied again, even if its status is reset") { h in
            ready(h)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]))
            try h.approveContacts(set: set, items: [u])
            _ = try h.tick()
            try expect(h.chgStatus(u.id) == "applied" && h.dryContactLines().count == 1, "first apply")
            try h.db.exec("UPDATE contact_changes SET status = 'approved' WHERE id = ?", [.text(u.id)])
            let ap2 = ApprovalOpts()
            try h.approveContacts(set: set, items: [u], ap2, markApproved: false)       // even a second, fresh signature
            _ = try h.tick(); _ = try h.tick()
            try expect(h.dryContactLines().count == 1 && h.applyRows(u.id).count == 1 && h.chgStatus(u.id) == "applied", "re-applied or not repaired: \(h.chgStatus(u.id))")
        }
        test("contacts: revoked or expired contacts approvals return their changes to review, visibly") { h in
            ready(h)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let a = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]))
            var o = ApprovalOpts(); o.revoked = true
            try h.approveContacts(set: set, items: [a], o)
            _ = try h.tick()
            try expect(h.chgStatus(a.id) == "review" && h.chg(a.id).str("error").contains("revoked") && h.lastError().contains("returned to review") && h.dryContactLines().isEmpty, "revoked: \(h.chgDesc(a.id))")
            // expired
            let set2 = try h.makeSet()
            let b = try h.addChange(set: set2, kind: "update", target: card.identifier, payload: CP.update(set: ["nickname": "S"]))
            var o2 = ApprovalOpts(); o2.notAfter = h.clock.now.addingTimeInterval(-60)
            try h.approveContacts(set: set2, items: [b], o2)
            _ = try h.tick()
            try expect(h.chgStatus(b.id) == "review" && h.chg(b.id).str("error").contains("expired") && h.contacts.writeCount == 0, "expired: \(h.chgDesc(b.id))")
            // a later revocation, after a valid approval: the next tick returns the change to review
            let set3 = try h.makeSet()
            let c = try h.addChange(set: set3, kind: "update", target: card.identifier, payload: CP.update(set: ["org": "Acme"]))
            let ap = try h.approveContacts(set: set3, items: [c])
            try h.set("kill_switch", "1")
            _ = try h.tick()
            try expect(h.chgStatus(c.id) == "approved", "kill switch must hold a valid approval where it is")
            try h.db.exec("UPDATE contact_approvals SET revoked_at = ? WHERE id = ?", [.text(Time.iso(h.clock.now)), .text(ap)])
            _ = try h.tick()
            try expect(h.chgStatus(c.id) == "review", "Stop revokes: the change goes back to review even with the kill switch on")
        }
        test("contacts: the kill switch blocks approved creates and edits, which then apply once it is off") { h in
            ready(h)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Kim", family: "Park", phones: ["+15550001111"]))
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]), position: 1)
            try h.approveContacts(set: set, items: [u])
            try h.set("kill_switch", "1")
            let r = try h.tick()
            try expect(r == .held("kill switch is on") && h.chgStatus(c.id) == "approved" && h.chgStatus(u.id) == "approved"
                       && h.dryContactLines().isEmpty && h.applyRows(c.id).isEmpty && h.applyRows(u.id).isEmpty && h.contacts.lookups == 0, "applied with the kill switch on")
            try h.set("kill_switch", "0")
            _ = try h.tick()
            try expect(h.chgStatus(c.id) == "applied" && h.chgStatus(u.id) == "applied", "should apply once the switch is off")
        }
        test("contacts: without Contacts access the changes wait (visible note), nothing prompts, messages still send") { h in
            h.contacts.accessGranted = false
            let set = try h.makeSet()
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Kim", family: "Park", phones: ["+15550001111"]))
            let (_, d, _) = try single(h)
            let r = try h.tick()
            try expect(r == .processed(draftId: d.draftId, result: "sent"), "contacts trouble must not hold back messages: \(r)")
            try expect(h.chgStatus(c.id) == "approved" && h.applyRows(c.id).isEmpty, "change should wait")
            try expect(h.lastError().contains("Contacts access") && h.contacts.promptAsks == 0 && h.contacts.lookups == 0, "last_error '\(h.lastError())', prompts \(h.contacts.promptAsks)")
            ready(h)
            _ = try h.tick()
            try expect(h.chgStatus(c.id) == "applied" && !h.lastError().contains("Contacts access"), "should apply once access exists, and the note should clear")
        }
        test("contacts: an approved create re-runs the live lookup (a hit fails it, never a duplicate) and applies otherwise") { h in
            ready(h)
            let set = try h.makeSet()
            let a = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            let existing = h.contacts.add(given: "Someone", phones: ["+15551234567"])        // the number appeared in Contacts after the user looked
            _ = try h.tick()
            try expect(h.chgStatus(a.id) == "failed" && h.chg(a.id).str("error") == "already in Contacts" && h.dryContactLines().isEmpty && h.contacts.writeCount == 0, "hit: \(h.chgDesc(a.id))")
            try expect(h.chg(a.id).str("kind") == "create" && h.contacts.cards.count == 1 && h.contacts.current(existing.identifier)?.given == "Someone", "a hit must neither convert the create nor touch the card")
            try expect(h.applyRows(a.id).count == 1 && h.applyRows(a.id)[0].str("result") == "failed", "the failed create is consumed")
            // a hit on an email of a second contact, and on both of two contacts: still a failure
            h.contacts.add(given: "Other", emails: ["o@example.com"])
            let set2 = try h.makeSet()
            let b = try h.approvedCreate(set: set2, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551110009"], emails: ["o@example.com"]))
            _ = try h.tick()
            try expect(h.chgStatus(b.id) == "failed" && h.chg(b.id).str("error") == "already in Contacts" && h.contacts.writeCount == 0, "email hit: \(h.chgDesc(b.id))")
            // a clean one applies dry with the approval recorded
            let set3 = try h.makeSet()
            let c = try h.addChange(set: set3, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15557770000"]))
            let ap = try h.approveContacts(set: set3, items: [c])
            _ = try h.tick()
            let ac = h.applyRows(c.id)
            try expect(h.chgStatus(c.id) == "applied" && ac.count == 1 && ac[0].str("approval_id") == ap && h.dryContactLines().count == 1, "approved create: \(h.chgDesc(c.id))")
        }
        test("contacts: an auto_queued row (or one with requires_approval = 0) is never applied: it goes to review, in any lane") { h in
            ready(h)
            try h.goContactsLive(); try h.set("contacts_transport", "live")          // the most permissive setup there is
            let set = try h.makeSet(status: "drafting")
            let a = try h.addChange(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]), auto: true, position: 0)
            let b = try h.addChange(set: set, payload: CP.create(given: "Kim", family: "Park", phones: ["+15550001111"]), position: 1)
            try h.db.exec("UPDATE contact_changes SET requires_approval = 0 WHERE id = ?", [.text(b.id)])     // review, but claims no approval is needed
            // a row that says no approval is needed, with a perfectly valid signature over it: the signature cannot vouch for it
            let c = try h.addChange(set: set, payload: CP.create(given: "Eve", family: "Ng", phones: ["+15552223333"]), position: 2)
            try h.approveContacts(set: set, items: [c])
            try h.db.exec("UPDATE contact_changes SET requires_approval = 0 WHERE id = ?", [.text(c.id)])
            _ = try h.tick(); _ = try h.tick()
            for x in [a, b, c] {
                let r = try h.chg(x.id)
                try expect(r.str("status") == "review" && r.i("requires_approval") == 1 && h.applyRows(x.id).isEmpty && !r.str("note").isEmpty, "\(x.id): \(r.values)")
            }
            try expect(h.contacts.writeCount == 0 && h.dryContactLines().isEmpty && h.contacts.lookups == 0, "nothing may be written or even looked up")
            try expect(h.setStatus(set) == "review" && h.audit("contact_applied") == 0 && h.audit("contact_sent_to_review") >= 3, "set \(h.setStatus(set))")
            // it also holds when the kill switch is on (database only), and a consumed row is left alone
            try h.set("kill_switch", "1")
            let d = try h.addChange(set: set, payload: CP.create(given: "Ann", family: "Bo", phones: ["+15554445555"]), auto: true, position: 3)
            _ = try h.tick()
            try expect(h.chgStatus(d.id) == "review" && h.applyRows(d.id).isEmpty, "held while stopped: \(h.chgDesc(d.id))")
            // once approved with Touch ID it applies (live), exactly once
            try h.set("kill_switch", "0")
            var o = ApprovalOpts(); o.transport = "live"
            try h.approveContacts(set: set, items: [a], o)
            _ = try h.tick()
            try expect(h.chgStatus(a.id) == "applied" && h.contacts.creates.count == 1 && h.applyRows(a.id).count == 1 && !h.applyRows(a.id)[0].isNull("approval_id"), "approved: \(h.chgDesc(a.id))")
        }

        // ---- undo -------------------------------------------------------------------------------------------------------
        /// Applies an update live and returns (card id, the applied change, its set).
        func liveUpdate(_ h: Harness) throws -> (card: ContactCard, change: ChangeSpec, set: String) {
            ready(h)
            try h.goContactsLive()
            let card = h.contacts.add(given: "Sam", family: "Lee", phones: ["+15551234567"], groups: ["Friends"])
            let set = try h.makeSet(title: "the update")
            let u = try h.addChange(set: set, kind: "update", target: card.identifier,
                                    payload: CP.update(set: ["given_name": "Sam🐚"], phones: ["+15551234567", "+15559990000"], emails: ["sam@example.com"], groups: ["Team", "Friends"]))
            var o = ApprovalOpts(); o.transport = "live"
            try h.approveContacts(set: set, items: [u], o)
            _ = try h.tick()
            try expect(h.chgStatus(u.id) == "applied" && h.contacts.updates.count == 1, "setup: update not applied (\(h.chgStatus(u.id)))")
            return (card, u, set)
        }
        func undoChange(_ h: Harness, of orig: ChangeSpec, kind: String, target: String, afterFp: String? = nil, signedKind: String? = nil) throws -> (ChangeSpec, String) {
            let r = try h.chg(orig.id)
            let payload: [String: Any] = ["undo_of": orig.id, "undo_kind": signedKind ?? kind,
                                          "before_vcard_sha256": kind == "update" ? Hex.sha256Hex(r.str("before_vcard")) as Any : NSNull(),
                                          "after_fingerprint": afterFp ?? r.str("after_fingerprint")]
            let set = try h.makeSet(title: "Undo: the update", source: "undo")
            let c = try h.addChange(set: set, kind: "undo", target: target, payload: payload, undoOf: orig.id)
            var o = ApprovalOpts(); o.transport = "live"
            try h.approveContacts(set: set, items: [c], o)
            return (c, set)
        }
        test("contacts: undo of an update restores the fields and removes only the handles and groups it added") { h in
            let (card, u, _) = try liveUpdate(h)
            let original = ContactMath.fingerprint({ var c = ContactCard(identifier: ""); c.given = "Sam"; c.family = "Lee"; c.phones = [LabeledValue("+15551234567", "mobile")]; return c }())
            let (undo, uset) = try undoChange(h, of: u, kind: "update", target: card.identifier)
            _ = try h.tick()
            let now = h.contacts.current(card.identifier)!
            try expect(now.given == "Sam" && now.phones.map { $0.value } == ["+15551234567"] && now.emails.isEmpty && now.groups == ["Friends"], "card after undo: \(now)")
            try expect(ContactMath.fingerprint(now) == original, "fingerprint should equal the pre-update card's")
            try expect(h.chgStatus(u.id) == "undone" && h.chgStatus(undo.id) == "applied" && h.setStatus(uset) == "done", "statuses: \(h.chgStatus(u.id)) \(h.chgStatus(undo.id))")
            let r = try h.chg(undo.id)
            try expect(r.str("transport") == "live" && !r.isNull("before_vcard") && r.str("after_fingerprint") == ContactMath.fingerprint(now), "undo row: \(r.values)")
        }
        test("contacts: undo is refused when the contact was edited since (fingerprint mismatch)") { h in
            let (card, u, _) = try liveUpdate(h)
            let i = h.contacts.cards.firstIndex { $0.identifier == card.identifier }!
            h.contacts.cards[i].nickname = "edited by the user"
            let before = h.contacts.current(card.identifier)!
            let (undo, _) = try undoChange(h, of: u, kind: "update", target: card.identifier)
            _ = try h.tick()
            let r = try h.chg(undo.id)
            try expect(r.str("status") == "failed" && r.str("error").contains("edited since") && h.chgStatus(u.id) == "applied", "undo should fail: \(r.values)")
            try expect(h.contacts.current(card.identifier)! == before && h.contacts.updates.count == 1, "the contact must not be touched")
        }
        test("contacts: undo refused when the signed hashes don't match what the executor holds") { h in
            let (card, u, _) = try liveUpdate(h)
            let (undo, _) = try undoChange(h, of: u, kind: "update", target: card.identifier, afterFp: String(repeating: "0", count: 64))
            _ = try h.tick()
            try expect(h.chgStatus(undo.id) == "failed" && h.chg(undo.id).str("error").contains("after_fingerprint"), "wrong fingerprint: \(h.chgDesc(undo.id))")
            // before snapshot edited after signing
            let (undo2, _) = try undoChange(h, of: u, kind: "update", target: card.identifier)
            try h.db.exec("UPDATE contact_changes SET before_vcard = before_vcard || ' ' WHERE id = ?", [.text(u.id)])
            _ = try h.tick()
            try expect(h.chgStatus(undo2.id) == "failed" && h.chg(undo2.id).str("error").contains("before snapshot"), "edited snapshot: \(h.chgDesc(undo2.id))")
            try expect(h.contacts.updates.count == 1, "nothing may be restored")
        }
        test("contacts: undo of a create deletes only an outbox-created, unedited contact") { h in
            ready(h)
            try h.goContactsLive(); try h.set("contacts_transport", "live")
            let mine = h.contacts.add(given: "Old", family: "Friend", phones: ["+15550000009"])      // not created by the outbox
            let set = try h.makeSet()
            let a = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]), position: 0)
            let b = try h.approvedCreate(set: set, payload: CP.create(given: "Kim", family: "Park", phones: ["+15550001111"]), position: 1)
            _ = try h.tick()
            let ra = try h.chg(a.id), rb = try h.chg(b.id)
            try expect(ra.str("transport") == "live" && rb.str("transport") == "live" && h.contacts.creates.count == 2, "setup")
            // 1. a signed undo that names a contact the outbox did not create: refused, nothing deleted
            let (wrong, _) = try undoChange(h, of: a, kind: "create", target: mine.identifier)
            _ = try h.tick()
            try expect(h.chgStatus(wrong.id) == "failed" && h.chg(wrong.id).str("error").contains("not the contact that change touched") && h.contacts.deletes.isEmpty, "wrong target: \(h.chgDesc(wrong.id))")
            // 2. an undo claiming an update is a create: refused
            let (kindMix, _) = try undoChange(h, of: a, kind: "create", target: ra.str("result_macos_id"), signedKind: "update")
            _ = try h.tick()
            try expect(h.chgStatus(kindMix.id) == "failed" && h.contacts.deletes.isEmpty, "kind mix-up: \(h.chgDesc(kindMix.id))")
            // 3. edited since: refused
            let bi = h.contacts.cards.firstIndex { $0.identifier == rb.str("result_macos_id") }!
            h.contacts.cards[bi].org = "Added by hand"
            let (edited, _) = try undoChange(h, of: b, kind: "create", target: rb.str("result_macos_id"))
            _ = try h.tick()
            try expect(h.chgStatus(edited.id) == "failed" && h.chg(edited.id).str("error").contains("edited since") && h.contacts.deletes.isEmpty, "edited: \(h.chgDesc(edited.id))")
            // 4. the clean one is deleted, and only it
            let (ok, _) = try undoChange(h, of: a, kind: "create", target: ra.str("result_macos_id"))
            _ = try h.tick()
            try expect(h.chgStatus(ok.id) == "applied" && h.chgStatus(a.id) == "undone" && h.contacts.deletes == [ra.str("result_macos_id")], "undo of create: \(h.chgDesc(ok.id))")
            try expect(h.contacts.current(mine.identifier) != nil && h.contacts.current(rb.str("result_macos_id")) != nil && h.contacts.current(ra.str("result_macos_id")) == nil, "only the unedited outbox contact may go")
            try expect(!(try h.chg(ok.id)).isNull("before_vcard"), "a snapshot of the deleted contact should be kept")
        }
        test("contacts: undo of a create refuses to delete a card that gained details the executor never wrote") { h in
            ready(h)
            try h.goContactsLive(); try h.set("contacts_transport", "live")
            let set = try h.makeSet()
            let a = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            _ = try h.tick()
            let ra = try h.chg(a.id)
            let id = ra.str("result_macos_id")
            try expect(ra.str("transport") == "live" && h.contacts.current(id) != nil, "setup")
            h.contacts.extraDetails.insert(id)                                  // the user added a birthday or an address by hand
            let (undo, _) = try undoChange(h, of: a, kind: "create", target: id)
            _ = try h.tick()
            let r = try h.chg(undo.id)
            try expect(r.str("status") == "failed" && r.str("error") == "the card has details added since; delete it by hand if you want" && h.contacts.deletes.isEmpty
                       && h.contacts.current(id) != nil && h.chgStatus(a.id) == "applied", "extra details: \(r.values)")
            h.contacts.extraDetails.remove(id)
            let (undo2, _) = try undoChange(h, of: a, kind: "create", target: id)
            _ = try h.tick()
            try expect(h.chgStatus(undo2.id) == "applied" && h.contacts.deletes == [id] && h.chgStatus(a.id) == "undone", "a plain card is still deleted: \(h.chgDesc(undo2.id))")
        }
        test("contacts: a revocation, expiry or cancellation between the claim and the write stops the write") { h in
            ready(h)
            func scenario(_ what: String, _ stop: @escaping (_ approval: String, _ set: String, _ notAfter: Date) throws -> Void) throws {
                let card = h.contacts.add(given: what, phones: ["+1555000\(Int.random(in: 1000...9999))"])
                let set = try h.makeSet()
                let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": what + "\u{1F41A}"]))
                let notAfter = h.clock.now.addingTimeInterval(86_400)
                var o = ApprovalOpts(); o.notAfter = notAfter
                let ap = try h.approveContacts(set: set, items: [u], o)
                var fired = false
                h.exec.beforeContactWriteHook = {
                    if fired { return }
                    fired = true
                    try? stop(ap, set, notAfter)
                }
                _ = try h.tick()
                h.exec.beforeContactWriteHook = nil
                try expect(fired && h.contacts.writeCount == 0 && h.dryContactLines().isEmpty, "\(what): the write was not stopped (\(h.chgDesc(u.id)))")
                try expect(h.applyRows(u.id).isEmpty && h.chgStatus(u.id) == "approved", "\(what): the claim should be given back, the change left approved (\(h.chgDesc(u.id)))")
                try expect(h.audit("contact_apply_released") >= 1, "\(what): no release audit")
            }
            try scenario("Revoked") { ap, _, _ in try h.db.exec("UPDATE contact_approvals SET revoked_at = ? WHERE id = ?", [.text(Time.iso(h.clock.now)), .text(ap)]) }
            try expect(lastRelease(h).contains("the approval was revoked"), "revoked reason: \(lastRelease(h))")
            try scenario("Expired") { _, _, na in h.clock.now = na.addingTimeInterval(60) }
            try expect(lastRelease(h).contains("the approval has expired"), "expired reason: \(lastRelease(h))")
            try scenario("Cancelled") { _, set, _ in try h.db.exec("UPDATE contact_change_sets SET status = 'cancelled' WHERE id = ?", [.text(set)]) }
            try expect(lastRelease(h).contains("the change set was cancelled"), "cancelled reason: \(lastRelease(h))")
        }
        test("contacts: undo of a dry change is applied dry whatever the manifest says; undo of a live change cannot be downgraded to dry") { h in
            ready(h)
            let set = try h.makeSet()
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            _ = try h.tick()                                                   // dry create
            let r = try h.chg(c.id)
            try expect(r.str("transport") == "dry", "setup")
            try h.goContactsLive()                                              // now live is possible
            let (undo, _) = try undoChange(h, of: c, kind: "create", target: r.str("result_macos_id"))   // manifest says live
            _ = try h.tick()
            let u = try h.chg(undo.id)
            try expect(u.str("status") == "applied" && u.str("transport") == "dry" && h.chgStatus(c.id) == "undone" && h.contacts.writeCount == 0, "dry undo: \(u.values)")
            try expect(h.dryContactLines().count == 2 && h.dryContactLines()[1]["kind"] as? String == "undo", "undo should be logged")
            // a live change whose undo would run dry is refused instead of being marked undone
            let (card, up, _) = try liveUpdate(h)
            let set2 = try h.makeSet(source: "undo")
            let r2 = try h.chg(up.id)
            let payload: [String: Any] = ["undo_of": up.id, "undo_kind": "update", "before_vcard_sha256": Hex.sha256Hex(r2.str("before_vcard")), "after_fingerprint": r2.str("after_fingerprint")]
            let d = try h.addChange(set: set2, kind: "undo", target: card.identifier, payload: payload, undoOf: up.id)
            try h.approveContacts(set: set2, items: [d])                       // manifest dry
            _ = try h.tick()
            try expect(h.chgStatus(d.id) == "failed" && h.chg(d.id).str("error").contains("live lane") && h.chgStatus(up.id) == "applied", "downgrade: \(h.chgDesc(d.id))")
        }

        // ---- crash recovery, tamper, domain separation --------------------------------------------------------------------
        test("contacts: crash recovery marks an unfinished apply unknown and its change failed 'interrupted', never retried") { h in
            ready(h)
            let set = try h.makeSet()
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            try h.db.exec("INSERT INTO contact_applies(id, change_id, approval_id, transport, started_at) VALUES(?, ?, NULL, 'dry', ?)", [.text(newId()), .text(c.id), .text(Time.iso(h.clock.now))])
            try expect(try h.exec.recoverInterrupted() == 1, "one interrupted apply")
            let a = h.applyRows(c.id)[0]
            try expect(a.str("result") == "unknown" && !a.isNull("finished_at"), "apply row: \(a.values)")
            let r = try h.chg(c.id)
            try expect(r.str("status") == "failed" && r.str("error") == "interrupted" && h.setStatus(set) == "done", "change: \(r.values)")
            _ = try h.tick()
            try expect(h.contacts.writeCount == 0 && h.dryContactLines().isEmpty && h.chgStatus(c.id) == "failed", "an interrupted apply must not be retried")
        }
        test("contacts: a trigger on a contact table, or a view shadowing one, makes the executor refuse to run; missing contacts tables only switch contacts off") { h in
            ready(h)
            let set = try h.makeSet()
            let c = try h.approvedCreate(set: set, payload: CP.create(given: "Sam", family: "Lee", phones: ["+15551234567"]))
            try h.db.runSchemaScript("CREATE TRIGGER sneaky AFTER UPDATE ON contact_changes BEGIN UPDATE contact_changes SET status = 'review'; END;")
            let r = try h.tick()
            try expect(isHeld(r) && heldText(r).contains("trigger sneaky on contact_changes") && h.chgStatus(c.id) == "approved" && h.dryContactLines().isEmpty, "got \(r)")
            try h.db.runSchemaScript("DROP TRIGGER sneaky;")
            try h.db.runSchemaScript("DROP TABLE contact_applies; CREATE VIEW contact_applies AS SELECT 'x' AS id, 'y' AS change_id, NULL AS approval_id, 'dry' AS transport, 'z' AS started_at, 'z' AS finished_at, 'applied' AS result, NULL AS error, NULL AS macos_id;")
            let r2 = try h.tick()
            try expect(isHeld(r2) && heldText(r2).contains("view contact_applies") && h.chgStatus(c.id) == "approved", "view: \(r2)")
            // 2. missing v4 tables (an old outboxd): start-up does not throw, messages still send, contacts wait with a visible note
            try h.db.runSchemaScript("DROP VIEW contact_applies; DROP TABLE contact_approvals;")
            try h.rebuild()
            let (_, d, _) = try single(h)
            let r3 = try h.tick()
            try expect(r3 == .processed(draftId: d.draftId, result: "sent"), "a missing contacts table must not stop messages: \(r3)")
            try expect(h.lastError() == "contacts tables missing: restart outboxd" && h.chgStatus(c.id) == "approved" && h.dryContactLines().isEmpty && h.contacts.writeCount == 0,
                       "last_error '\(h.lastError())', change \(h.chgStatus(c.id))")
            // 3. outboxd restarts and creates the tables: the next tick notices, clears the note and goes on
            try h.db.runSchemaScript(h.schema)
            try h.approveContacts(set: set, items: [c])                       // the approvals table was dropped with the rest: sign again
            _ = try h.tick()
            try expect(h.chgStatus(c.id) == "applied" && !h.lastError().contains("contacts tables missing"), "contacts should resume: \(h.chgDesc(c.id)), last_error '\(h.lastError())'")
        }
        test("contacts: base message tables are still required at start-up") { h in
            try h.db.runSchemaScript("DROP TABLE exec_requests;")
            try expect(throwsError { try h.rebuild() }, "start-up must fail when a message table is missing")
        }
        test("contacts: a contacts manifest is refused on the send path, and a send manifest on the contacts path") { h in
            ready(h)
            // 1. a contacts manifest copied into `approvals` can't send a draft
            let b = try h.makeBatch()
            let d = try h.makeDraft(batch: b)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let set = try h.makeSet()
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]), position: 0)
            var asSend = ApprovalOpts(); asSend.tag = "send"      // signed with the send tag so only the manifest-kind check can refuse it
            let ap = try h.approveContacts(set: set, items: [u], asSend, markApproved: false)
            try h.db.exec("""
                INSERT INTO approvals(id, batch_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at)
                SELECT id, ?, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at FROM contact_approvals WHERE id = ?
                """, [.text(b), .text(ap)])
            let pin = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            let sendRec = ApprovalRecord(row: try h.db.one("SELECT * FROM approvals WHERE id = ?", [.text(ap)])!)
            do { _ = try Verifier.verifyApproval(sendRec, pin: pin, now: h.clock.now); throw CaseFailure(message: "a contacts manifest verified as a send approval") }
            catch let r as Rejection { try expect(r.reason.contains("kind"), "reason should name the kind: \(r.reason)") }
            let r = try h.tick()
            try expect(r == .idle && h.dryLines().isEmpty && h.sendRows(d.draftId).isEmpty && h.draftStatus(d.draftId) == "review", "draft was sent (or not returned) under a contacts manifest: \(r)")
            try expect(h.rejectionReasons().contains { $0.contains("kind") }, "audit reasons: \(h.rejectionReasons())")
            // 2. a send manifest copied into `contact_approvals` can't apply a change
            let b2 = try h.makeBatch()
            let d2 = try h.makeDraft(batch: b2, handle: "+15550002222")
            var asContacts = ApprovalOpts(); asContacts.tag = "contacts"
            let sendAp = try h.approve(batch: b2, items: [d2], asContacts)
            try h.db.exec("UPDATE drafts SET status = 'review' WHERE id = ?", [.text(d2.draftId)])    // this test is about contacts, not about sending it
            let set2 = try h.makeSet()
            let u2 = try h.addChange(set: set2, kind: "update", target: card.identifier, payload: CP.update(set: ["nickname": "S"]), status: "approved")
            try h.db.exec("""
                INSERT INTO contact_approvals(id, set_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at)
                SELECT id, ?, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at FROM approvals WHERE id = ?
                """, [.text(set2), .text(sendAp)])
            let rec = ContactApprovalRecord(row: try h.db.one("SELECT * FROM contact_approvals WHERE id = ?", [.text(sendAp)])!)
            do { _ = try Verifier.verifyContactApproval(rec, pin: pin, now: h.clock.now); throw CaseFailure(message: "a send manifest verified as a contacts approval") }
            catch let r as Rejection { try expect(r.reason.contains("kind"), "reason should name the kind: \(r.reason)") }
            _ = try h.tick()
            try expect(h.chgStatus(u2.id) == "review" && h.dryContactLines().isEmpty && h.contacts.writeCount == 0, "a send manifest applied a contact change")
            // 3. a send-shaped manifest (v 2, items) with a stray `kind` is also refused, and so is one without items
            var o = ApprovalOpts(); o.rawManifest = "{\"v\":2,\"kind\":\"contacts\",\"transport\":\"dry\",\"approval_id\":\"\(o.approvalId)\",\"items\":[]}"
            let (_, d3, _) = try single(h, o)
            try expectRefused(h, draft: d3, reason: "kind")
            var o2 = ApprovalOpts(); o2.rawManifest = "{\"v\":2,\"transport\":\"dry\",\"approval_id\":\"\(o2.approvalId)\"}"
            let (_, d4, _) = try single(h, o2)
            _ = try h.tick()
            try expect(h.draftStatus(d4.draftId) == "review" && h.rejectionReasons().contains { $0.contains("no items") }, "a manifest without items must be refused: \(h.rejectionReasons())")
        }
        test("contacts: a contacts approval needs every contacts field (v 1, set_id, items) and the pinned key") { h in
            ready(h)
            let card = h.contacts.add(given: "Sam", phones: ["+15551234567"])
            let pin = try PinFileLoader.load(path: h.config.userPinPath, mode: .simple)
            func verdict(_ mutate: (inout ApprovalOpts) -> Void, v: Int = 1, kind: String? = "contacts", items: Bool = true) throws -> String? {
                let set = try h.makeSet()
                let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["given_name": "Sam🐚"]))
                var o = ApprovalOpts(); mutate(&o)
                let id = try h.approveContacts(set: set, items: items ? [u] : [], o, v: v, kind: kind, markApproved: false)
                do { _ = try Verifier.verifyContactApproval(ContactApprovalRecord(row: try h.db.one("SELECT * FROM contact_approvals WHERE id = ?", [.text(id)])!), pin: pin, now: h.clock.now); return nil }
                catch let r as Rejection { return r.reason }
            }
            try expect(try verdict({ _ in }) == nil, "a good contacts approval must verify")
            try expect(try verdict({ _ in }, v: 2)?.contains("manifest.v is not 1") == true, "v 2")
            try expect(try verdict({ _ in }, kind: nil)?.contains("kind") == true, "no kind")
            try expect(try verdict({ _ in }, items: false)?.contains("contact_items") == true, "no items")
            try expect(try verdict({ $0.signer = P256.Signing.PrivateKey() })?.contains("not in the pin file") == true, "unpinned key")
            try expect(try verdict({ $0.manifestOrigin = "https://evil.example" })?.contains("origin") == true, "wrong origin")
            try expect(try verdict({ $0.authB64 = "AAAA" })?.contains("WebAuthn fields") == true, "webauthn fields")
            try expect(try verdict({ $0.transport = "maybe" })?.contains("transport") == true, "bad transport")
            // a manifest naming another set than the row
            let set = try h.makeSet(), other = try h.makeSet()
            let u = try h.addChange(set: set, kind: "update", target: card.identifier, payload: CP.update(set: ["nickname": "S"]))
            let id = try h.approveContacts(set: set, items: [u], markApproved: false)
            try h.db.exec("UPDATE contact_approvals SET set_id = ? WHERE id = ?", [.text(other), .text(id)])
            do { _ = try Verifier.verifyContactApproval(ContactApprovalRecord(row: try h.db.one("SELECT * FROM contact_approvals WHERE id = ?", [.text(id)])!), pin: pin, now: h.clock.now); throw CaseFailure(message: "set mismatch accepted") }
            catch let r as Rejection { try expect(r.reason.contains("set_id"), "set mismatch reason: \(r.reason)") }
        }
    }
}
