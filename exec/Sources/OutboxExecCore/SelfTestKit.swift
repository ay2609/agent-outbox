import Foundation
import CryptoKit

/// Test doubles and fabrication helpers shared by selftest and the unit tests. Nothing here can reach Messages or Contacts.

final class TestClock {
    var now: Date
    init(_ d: Date) { now = d }
}

/// Returns scripted outcomes (then `.sent`) and records calls. Used in place of the dry/live transports.
final class ScriptedTransport: Transport {
    let name: String
    var outcomes: [SendOutcome]
    private(set) var calls: [SendRequest] = []
    var preflightError: String?
    private(set) var preflightCalls = 0
    func preflight() -> String? { preflightCalls += 1; return preflightError }
    init(name: String, outcomes: [SendOutcome] = []) { self.name = name; self.outcomes = outcomes }
    func send(_ r: SendRequest) -> SendOutcome {
        calls.append(r)
        if outcomes.isEmpty { return .sent(serviceUsed: r.service == "auto" ? "iMessage" : r.service) }
        return outcomes.removeFirst()
    }
}

final class FakeContacts: ContactsProvider {
    var accessGranted = false
    private(set) var promptAsks = 0
    func requestAccessIfNeeded() { promptAsks += 1 }
    private(set) var created: [ProposedContactModel] = []
    var exportCalls = 0
    func exportAll(now: Date) throws -> Data { exportCalls += 1; return Data("{\"exported_at\":\"x\",\"contacts\":[]}".utf8) }
    func create(_ c: ProposedContactModel) throws -> String { created.append(c); return "FAKE-CN-ID-\(created.count)" }

    // v4: an in-memory address book. Every write is counted, so a test can prove a dry lane wrote nothing.
    var cards: [ContactCard] = []
    private(set) var creates: [NewContact] = []
    private(set) var updates: [(id: String, edit: ContactEdit)] = []
    private(set) var deletes: [String] = []
    private(set) var lookups = 0
    var failNextWrite = false
    /// Groups that exist without any member, and cards that hold details the executor never wrote (an address, a birthday, ...).
    var extraGroups: [String] = []
    var extraDetails = Set<String>()
    var writeCount: Int { creates.count + updates.count + deletes.count }

    @discardableResult
    func add(given: String = "", family: String = "", phones: [String] = [], emails: [String] = [], groups: [String] = [], nickname: String = "", org: String = "") -> ContactCard {
        var c = ContactCard(identifier: "FAKE-CARD-\(cards.count + 1)")
        c.given = given; c.family = family; c.nickname = nickname; c.org = org
        c.phones = phones.map { LabeledValue($0, "mobile") }; c.emails = emails.map { LabeledValue($0, "home") }; c.groups = groups
        cards.append(c)
        return c
    }
    func current(_ id: String) -> ContactCard? { cards.first { $0.identifier == id } }

    func findByHandles(phones: [String], emails: [String]) throws -> [ContactCard] {
        lookups += 1
        let p = Set(phones.map { ContactMath.normalizedPhone($0) }), e = Set(emails.map { $0.lowercased() })
        return cards.filter { c in
            c.phones.contains { p.contains(ContactMath.normalizedPhone($0.value)) } || c.emails.contains { e.contains($0.value.lowercased()) }
        }.map { var k = $0; k.groups = []; return k }
    }
    func allNames() throws -> [ContactCard] { lookups += 1; return cards.map { var k = $0; k.groups = []; return k } }
    func allGroupNames() throws -> [String] { lookups += 1; return Array(Set(cards.flatMap { $0.groups } + extraGroups)).sorted() }
    func hasExtraDetails(identifier: String) throws -> Bool {
        guard current(identifier) != nil else { throw ExecError("no such contact") }
        return extraDetails.contains(identifier)
    }
    func card(identifier: String) throws -> ContactCard? { current(identifier) }
    func createContact(_ n: NewContact) throws -> String {
        if failNextWrite { failNextWrite = false; throw ExecError("simulated save failure") }
        creates.append(n)
        var c = ContactCard(identifier: "FAKE-NEW-\(creates.count)")
        c.given = n.given; c.family = n.family; c.nickname = n.nickname; c.org = n.org
        c.phones = n.phones; c.emails = n.emails; c.groups = n.groups
        cards.append(c)
        return c.identifier
    }
    func updateContact(identifier: String, edit: ContactEdit) throws {
        if failNextWrite { failNextWrite = false; throw ExecError("simulated save failure") }
        guard let i = cards.firstIndex(where: { $0.identifier == identifier }) else { throw ExecError("no such contact") }
        updates.append((identifier, edit))
        cards[i] = edit.applying(to: cards[i])
    }
    func deleteContact(identifier: String) throws {
        if failNextWrite { failNextWrite = false; throw ExecError("simulated save failure") }
        guard cards.contains(where: { $0.identifier == identifier }) else { throw ExecError("no such contact") }
        deletes.append(identifier)
        cards.removeAll { $0.identifier == identifier }
    }
}

struct ItemSpec {
    var draftId: String
    var to: String
    var service = "auto"
    var body: String
    var name = ""
    var createContact: [String: Any]?
}

struct ApprovalOpts {
    var approvalId = newId()
    var manifestBatchId: String?
    var manifestRpId: String?
    var rawManifest: String?
    var manifestShaColumn: String?
    var rpIdForAuth: String?
    var origin: String?
    var crossOrigin = false
    var flags: UInt8 = 0x05
    var type = "webauthn.get"
    var signer: P256.Signing.PrivateKey?
    var credentialId: Data?
    var signOver: Data?
    var corruptSignature = false
    var challenge: Data?
    var notAfter: Date?
    var revoked = false
    var pad = false
    var transport = "dry"          // signed into the manifest
    var manifestV = 2
    var omitTransport = false
}

/// One isolated universe: a temp OUTBOX_HOME with its own DB, key, pin file and fake clock.
final class Harness {
    let dir: String
    let schema: String
    let db: Database
    let key = P256.Signing.PrivateKey()
    let credId = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    let rpId = "outbox.selftest.example"
    var origin: String { "https://" + rpId }
    let clock: TestClock
    let contacts = FakeContacts()
    var scriptedDry: ScriptedTransport?
    var live = ScriptedTransport(name: "live")        // tripwire: counts live calls, never touches Messages
    var config: ExecConfig
    private(set) var exec: Executor!

    static let baseTime = Time.parse("2026-11-10T17:00:00Z")!   // 12:00 in America/New_York

    init(schema: String, name: String, parent: String) throws {
        dir = parent + "/Application Support/" + name      // a space in the path, like the real state dir
        self.schema = schema
        try FileManager.default.createDirectory(atPath: dir + "/logs", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        db = try Database(path: dir + "/outbox.db", create: true)
        try db.runSchemaScript(schema)
        clock = TestClock(Harness.baseTime)
        config = ExecConfig(home: dir)
        config.rootPinPath = dir + "/no-root-pin/passkeys.json"      // absent: the real /usr/local path is never read (so: simple mode)
        try writePin(to: config.userPinPath, mode: 0o600)
        try rebuild()
    }

    func rebuild() throws {
        let h = self
        exec = Executor(db: db, config: config, contacts: contacts, clock: { h.clock.now }) { name, cfg, clk in
            if name == "live" { return h.live }
            return h.scriptedDry ?? DryTransport(logPath: cfg.dryLogPath, clock: clk)
        }
        try exec.prepare()
    }

    /// Writes a pin file. Default: v2 with the default policy (live_allowed false). `policy` overrides fields; `rawPolicy` replaces
    /// the policy object outright (to build invalid ones); `version` 1 writes a legacy file without a policy.
    func writePin(to path: String, mode: mode_t, rp: String? = nil, key k: P256.Signing.PrivateKey? = nil,
                  version: Int = 2, policy: [String: Any] = [:], rawPolicy: Any? = nil, omitPolicy: Bool = false) throws {
        let pk = (k ?? key).publicKey.x963Representation
        var obj: [String: Any] = ["v": version, "rp_id": rp ?? rpId, "origin": "https://" + (rp ?? rpId),
                                  "keys": [["credential_id": B64.encodeURL(credId), "x963": B64.encodeURL(pk), "label": "selftest key"]]]
        if version >= 2 && !omitPolicy {
            // the default pin still carries the old v2 pacing fields, like the installed root pin: they must be ignored
            var pol: [String: Any] = ["live_allowed": false, "min_pace_s": 20, "min_burst_pause_s": 120, "max_burst_size": 10, "max_daily_cap": 100, "require_quiet_hours": true]
            for (k, v) in policy { pol[k] = v }
            obj["policy"] = rawPolicy ?? pol
        }
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try JSON.data(obj)!.write(to: URL(fileURLWithPath: path))
        chmod(path, mode)
    }

    /// Simple mode: rewrites the user pin (our uid, 0600, no root pin anywhere) with a live policy, for the tripwire transport.
    func goLiveSimple(allowed: Bool = true, policy: [String: Any] = [:]) throws {
        var pol = policy
        pol["live_allowed"] = allowed
        try? FileManager.default.removeItem(atPath: config.userPinPath)
        try writePin(to: config.userPinPath, mode: 0o600, policy: pol)
    }

    /// Hardened mode: installs a root-style pin file (owned by us, 0444; the ownership rule is pointed at our uid) allowing live sending, for the tripwire transport.
    func goLive(allowed: Bool = true, policy: [String: Any] = [:]) throws {
        let root = dir + "/rootpin/passkeys.json"
        var pol = policy
        pol["live_allowed"] = allowed
        try? FileManager.default.removeItem(atPath: root)
        try writePin(to: root, mode: 0o444, policy: pol)
        config.rootPinPath = root; config.rootExpectedUid = getuid(); config.checkPinAncestors = false
        try rebuild()
    }

    func set(_ k: String, _ v: String) throws { try db.exec("UPDATE settings SET value = ? WHERE key = ?", [.text(v), .text(k)]) }

    func makeBatch(status: String = "approved") throws -> String {
        let id = newId()
        let t = Time.iso(clock.now)
        try db.exec("INSERT INTO batches(id, title, created_by, source, status, created_at, updated_at) VALUES(?, 'selftest', 'selftest', 'cli', ?, ?, ?)",
                    [.text(id), .text(status), .text(t), .text(t)])
        return id
    }

    @discardableResult
    func makeDraft(batch: String, handle: String = "+15551234567", service: String = "auto", body: String = "Hello from the selftest", status: String = "approved",
                   createContact: Bool = false, scheduledFor: String? = nil, position: Int = 0) throws -> ItemSpec {
        let id = newId()
        let t = Time.iso(clock.now)
        try db.exec("INSERT INTO drafts(id, batch_id, position, handle, service, body, status, create_contact, scheduled_for, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [.text(id), .text(batch), .num(position), .text(handle), .text(service), .text(body), .text(status), .num(createContact ? 1 : 0), .opt(scheduledFor), .text(t), .text(t)])
        return ItemSpec(draftId: id, to: handle, service: service, body: body)
    }

    /// Fabricates a WebAuthn assertion over the manifest, exactly as an authenticator would, and stores the approval.
    @discardableResult
    func approve(batch: String, items: [ItemSpec], _ o: ApprovalOpts = ApprovalOpts()) throws -> String {
        let notAfter = o.notAfter ?? clock.now.addingTimeInterval(86_400)
        let itemObjs: [[String: Any]] = items.map { i in
            ["draft_id": i.draftId, "to": i.to, "service": i.service, "body_sha256": Hex.sha256Hex(i.body), "name": i.name,
             "create_contact": i.createContact.map { $0 as Any } ?? NSNull()]
        }
        var m: [String: Any] = ["v": o.manifestV, "transport": o.transport, "approval_id": o.approvalId, "batch_id": o.manifestBatchId ?? batch,
                                "created_at": Time.iso(clock.now), "not_after": Time.iso(notAfter), "rp_id": o.manifestRpId ?? rpId, "items": itemObjs]
        if o.omitTransport { m.removeValue(forKey: "transport") }
        let manifest = o.rawManifest ?? JSON.string(m)
        let digest = Hex.sha256(Data(manifest.utf8))
        let cd: [String: Any] = ["type": o.type, "challenge": B64.encodeURL(o.challenge ?? digest), "origin": o.origin ?? origin, "crossOrigin": o.crossOrigin]
        let cdj = JSON.data(cd)!
        var auth = Hex.sha256(Data((o.rpIdForAuth ?? rpId).utf8))
        auth.append(o.flags)
        auth.append(contentsOf: [0, 0, 0, 0])                       // counter 0, like iCloud passkeys
        var signed = auth
        signed.append(Hex.sha256(cdj))
        var sig = try (o.signer ?? key).signature(for: o.signOver ?? signed).derRepresentation
        if o.corruptSignature { sig = Data((0..<70).map { _ in UInt8.random(in: 0...255) }) }
        func enc(_ d: Data) -> String {
            let u = B64.encodeURL(d)
            if !o.pad { return u }
            return u + String(repeating: "=", count: (4 - u.count % 4) % 4)
        }
        try db.exec("""
            INSERT INTO approvals(id, batch_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at, revoked_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, [.text(o.approvalId), .text(batch), .text(manifest), .text(o.manifestShaColumn ?? Hex.encode(digest)), .text(B64.encodeURL(o.credentialId ?? credId)),
                  .text(enc(auth)), .text(enc(cdj)), .text(enc(sig)), .text(Time.iso(notAfter)), .text(Time.iso(clock.now)), o.revoked ? .text(Time.iso(clock.now)) : .null])
        return o.approvalId
    }

    // MARK: observations
    func dryLines() -> [[String: Any]] {
        guard let s = try? String(contentsOfFile: config.dryLogPath, encoding: .utf8) else { return [] }
        return s.split(separator: "\n").compactMap { JSON.object(Data($0.utf8)) }
    }
    func draftStatus(_ id: String) -> String { (try? db.one("SELECT status FROM drafts WHERE id = ?", [.text(id)]))??.str("status") ?? "?" }
    func batchStatus(_ id: String) -> String { (try? db.one("SELECT status FROM batches WHERE id = ?", [.text(id)]))??.str("status") ?? "?" }
    func sendRows(_ draft: String) -> [Row] { (try? db.query("SELECT * FROM sends WHERE draft_id = ? ORDER BY attempt", [.text(draft)])) ?? [] }
    func rejectionReasons() -> [String] {
        let rows = (try? db.query("SELECT details_json FROM audit_log WHERE action IN ('approval_rejected','item_rejected')")) ?? []
        return rows.compactMap { JSON.object(Data($0.str("details_json").utf8))?["reason"] as? String }
    }
    func setting(_ k: String) -> String { (try? db.one("SELECT value FROM settings WHERE key = ?", [.text(k)]))??.text("value") ?? "" }
    func lastError() -> String { (try? db.one("SELECT last_error FROM exec_status WHERE id = 1"))??.str("last_error") ?? "" }
    func audit(_ action: String) -> Int { ((try? db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND actor = 'exec'", [.text(action)]))??.i("n")) ?? 0 }
    /// One executor pass. The clock moves on by the fixed send gap first, so tests that send several items in a row aren't about the gap.
    func tick() throws -> TickResult { clock.now = clock.now.addingTimeInterval(SendGap.seconds); return try exec.tick() }
    /// One executor pass at exactly the current fake time (for the send-gap tests).
    func tickNow() throws -> TickResult { try exec.tick() }
}
