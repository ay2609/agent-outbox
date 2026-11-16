import Foundation

public struct ExecConfig {
    public var home: String
    public var rootPinPath = Paths.rootPinFile
    /// Root pin file ownership rules. Production: uid 0 and every ancestor directory checked. Selftest relaxes them.
    public var rootExpectedUid: uid_t = 0
    public var checkPinAncestors = true
    /// Simple mode: the user pin and the state directory must be owned by this uid (the current user). Selftest can point it elsewhere.
    public var userExpectedUid: uid_t = getuid()
    /// False (OUTBOX_IGNORE_ROOT_PIN=1, tests only): the root pin is skipped and the user pin is used for dry runs only: no live trust.
    public var userPinTrustedForLive = true
    public var contactsExportIntervalS: Double = 1800

    public init(home: String) { self.home = home }
    public var dbPath: String { home + "/outbox.db" }
    public var userPinPath: String { home + "/passkeys.json" }
    public var dryLogPath: String { home + "/logs/dry-sends.jsonl" }
    public var dryContactsLogPath: String { home + "/logs/dry-contacts.jsonl" }
    public var contactsExportPath: String { home + "/contacts-export.json" }
}

public enum TickResult: Equatable {
    case idle
    case held(String)
    case processed(draftId: String, result: String)
}

struct Claim {
    let sendId: String
    let draft: DraftSnapshot
    let priorStatus: String
    let approval: VerifiedApproval
    let item: ManifestItemModel
    let attempt: Int
}

struct ClaimOutcome {
    var claim: Claim?
    var killed = false
    var needsPreflight = false
}

/// An approval that vouches for one draft right now (verified, live, the item matches the draft).
struct Acceptance {
    let rec: ApprovalRecord
    let ok: VerifiedApproval
    let item: ManifestItemModel
}

/// Per-pass memo so each approval's signature is verified once.
final class EvalCache {
    var verdicts: [String: Result<VerifiedApproval, Rejection>] = [:]
    var approvals: [String: [Row]] = [:]
}

public final class Executor {
    public let db: Database
    public let config: ExecConfig
    public let state: ExecState
    let clock: () -> Date
    /// Test seams for pacing: a value in 0..<1 (the random pause) and the time zone of quiet hours and "today" (the Mac's own).
    var random: () -> Double = { Double.random(in: 0..<1) }
    var timeZone: TimeZone = .current
    /// What pace_hold / pace_until in exec_state say right now, so an unchanged hold isn't rewritten every few seconds.
    private var publishedPace: String?
    let contacts: ContactsProvider
    private let makeTransport: (String) -> Transport
    private var liveTransport: Transport?
    private var dryTransport: Transport?
    public internal(set) var lastError: String?
    private var tamperMessage: String?
    private var liveNote: String?
    private var preflightOK = false
    private var lastPreflight: Date?
    private var contactsPromptAsked = false
    /// v4: why contact changes are waiting (no Contacts access, a lookup failed, a write was stopped). Shown as exec_status.last_error
    /// when nothing more urgent is; contact trouble never holds back message sends.
    var contactsNote: String?
    var contactsWriters: [String: ContactsWriter] = [:]
    /// v4 tables the database lacks right now (outboxd hasn't created them yet). Re-checked every tick; contacts work is off while any is missing.
    var contactTablesMissing: [String] = []
    var contactRecoveryDone = false
    /// Test seam: runs at the start of every pre-write stop check of a contact change.
    var beforeContactWriteHook: (() -> Void)?
    /// The pin file of the current tick; refreshBatch uses it to tell a live approval from a dead one.
    var currentPin: PinFile?
    /// Test seam: runs after the claim and the contact write, immediately before the final stop re-check and the send.
    var beforeSendHook: (() -> Void)?

    /// Tables whose contents decide what gets sent. A trigger anywhere, or a view shadowing one of these, means the DB was tampered with.
    static let gatedTables: Set<String> = ["approvals", "sends", "drafts", "settings", "contact_writes", "exec_state",
                                          "contact_changes", "contact_change_sets", "contact_approvals", "contact_applies"]

    public init(db: Database, config: ExecConfig, contacts: ContactsProvider, clock: @escaping () -> Date = Date.init,
                makeTransport: ((String, ExecConfig, @escaping () -> Date) -> Transport)? = nil) {
        self.db = db
        self.config = config
        self.state = ExecState(db: db)
        self.contacts = contacts
        self.clock = clock
        let cfg = config
        if let makeTransport {
            self.makeTransport = { name in makeTransport(name, cfg, clock) }
        } else {
            self.makeTransport = { name in
                if name == "live" { return LiveMessagesTransport() }
                return DryTransport(logPath: cfg.dryLogPath, clock: clock)
            }
        }
    }

    // MARK: start-up

    /// Why the executor must not run against this database, or nil. Triggers could rewrite rows behind our back (for example
    /// un-consume a send); a view named like a gated table could feed us made-up rows. Neither is part of the schema.
    func checkTamper() throws -> String? {
        var problems: [String] = []
        for r in try db.query("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('trigger', 'view')") {
            let name = r.str("name")
            if r.str("type") == "trigger" { problems.append("trigger \(name) on \(r.str("tbl_name"))") }
            else if Self.gatedTables.contains(name.lowercased()) { problems.append("view \(name) shadows a table") }
        }
        if problems.isEmpty { return nil }
        return "database tampering suspected, refusing to run: " + problems.joined(separator: "; ")
    }

    static let contactTables = ["contact_changes", "contact_change_sets", "contact_approvals", "contact_applies"]

    /// Which v4 tables are missing now. Never throws: a database from before v4 must not stop message sending.
    func refreshContactTables() {
        contactTablesMissing = Self.contactTables.filter { !((try? db.tableExists($0)) ?? false) }
    }

    public func prepare() throws {
        if let why = try checkTamper() { tamperMessage = why; return }   // the tick holds and reports it
        for t in ["settings", "drafts", "batches", "approvals", "sends", "contact_writes", "exec_requests", "exec_status", "audit_log"] {
            guard try db.tableExists(t) else { throw ExecError("database is missing table \(t): has outboxd created the schema?") }
        }
        // the v4 contact tables are different: if they are missing (an old outboxd is still running) messages keep working and
        // contacts processing stays off, with a visible note, until a later tick finds them
        refreshContactTables()
        try state.ensureTable()
    }

    /// Any send that never finished (crash or kill mid-send) becomes `unknown` and is never retried automatically.
    @discardableResult
    public func recoverInterrupted() throws -> Int {
        if try checkTamper() != nil { return 0 }
        let now = Time.iso(clock())
        let sends: Int = try db.transaction {
            var n = 0
            var batches = Set<String>()
            for r in try db.query("SELECT s.id AS sid, s.draft_id AS did FROM sends s WHERE s.finished_at IS NULL") {
                try db.exec("UPDATE sends SET finished_at = ?, result = 'unknown', error = ? WHERE id = ?",
                            [.text(now), .text("executor stopped before the send finished; outcome unknown, not retried"), .text(r.str("sid"))])
                n += 1
            }
            for r in try db.query("SELECT id, batch_id FROM drafts WHERE status = 'sending'") {
                try db.exec("UPDATE drafts SET status = 'unknown', updated_at = ? WHERE id = ?", [.text(now), .text(r.str("id"))])
                try audit("send_interrupted", target: r.str("id"), ["note": "draft was in 'sending' at start-up; marked unknown, never retried"])
                batches.insert(r.str("batch_id"))
            }
            for b in batches { try refreshBatch(b, now: now) }
            return n
        }
        refreshContactTables()
        var contactRecovered = 0
        if contactTablesMissing.isEmpty { contactRecovered = try recoverContactApplies(); contactRecoveryDone = true }
        return sends + contactRecovered
    }

    // MARK: helpers

    func audit(_ action: String, target: String?, _ details: [String: Any] = [:]) throws {
        try db.exec("INSERT INTO audit_log(at, actor, action, target, details_json) VALUES(?, 'exec', ?, ?, ?)",
                    [.text(Time.iso(clock())), .text(action), .opt(target), .text(JSON.string(details))])
    }

    /// Audit a rejection once per distinct reason, so a bad approval doesn't write a row every 3 seconds.
    func auditOnce(key: String, action: String, target: String, _ details: [String: Any]) throws {
        let reason = (details["reason"] as? String) ?? ""
        if try state.get(key) == reason { return }
        try state.set(key, reason)
        try audit(action, target: target, details)
    }

    /// Missing or unparseable means ON.
    func killSwitchOn() throws -> Bool {
        guard let v = try db.one("SELECT value FROM settings WHERE key = 'kill_switch'")?.text("value") else { return true }
        return !(v == "0" || v.lowercased() == "false")
    }

    /// Failed attempts for one (approval, draft). Retries are capped per approval: a fresh approval gets fresh attempts.
    func failureCount(approvalId: String, draftId: String) throws -> Int {
        try db.one("SELECT COUNT(*) AS n FROM sends WHERE approval_id = ? AND draft_id = ? AND result = 'failed'", [.text(approvalId), .text(draftId)])?.i("n") ?? 0
    }

    static let maxFailuresPerApproval = 3

    /// Consumed: any `sent` or `unknown` send for the draft, under any approval.
    func isConsumed(_ draftId: String) throws -> Bool {
        (try db.one("SELECT COUNT(*) AS n FROM sends WHERE draft_id = ? AND result IN ('sent','unknown')", [.text(draftId)])?.i("n") ?? 0) > 0
    }

    func snapshot(_ draftId: String) throws -> (DraftSnapshot, Row)? {
        guard let row = try db.one("SELECT id, batch_id, handle, service, body, status, create_contact FROM drafts WHERE id = ?", [.text(draftId)]) else { return nil }
        return (DraftSnapshot(row: row), row)
    }

    func verdict(_ rec: ApprovalRecord, pin: PinFile, now: Date, cache: EvalCache) -> Result<VerifiedApproval, Rejection> {
        if let v = cache.verdicts[rec.id] { return v }
        let v: Result<VerifiedApproval, Rejection>
        do { v = .success(try Verifier.verifyApproval(rec, pin: pin, now: now)) }
        catch let r as Rejection { v = .failure(r) }
        catch { v = .failure(Rejection("\(error)")) }
        cache.verdicts[rec.id] = v
        return v
    }

    /// Every live approval that vouches for this draft, newest first, plus the reasons the others were refused.
    /// Rejections are audited once per reason.
    func acceptances(for draft: DraftSnapshot, pin: PinFile, now: Date, cache: EvalCache) throws -> (accepted: [Acceptance], reasons: [String]) {
        if cache.approvals[draft.batchId] == nil {
            cache.approvals[draft.batchId] = try db.query("SELECT * FROM approvals WHERE batch_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC", [.text(draft.batchId)])
        }
        var accepted: [Acceptance] = []
        var reasons: [String] = []
        for arow in cache.approvals[draft.batchId] ?? [] {
            let rec = ApprovalRecord(row: arow)
            switch verdict(rec, pin: pin, now: now, cache: cache) {
            case .failure(let r):
                try auditOnce(key: "rej:\(rec.id)", action: "approval_rejected", target: rec.id, ["reason": r.reason, "batch_id": rec.batchId])
                reasons.append("approval \(rec.id.prefix(8)) refused: \(r.reason)")
            case .success(let ok):
                guard let item = ok.items.first(where: { $0.draftId == draft.id }) else { continue }
                if let why = Verifier.checkItem(item, draft: draft, batchId: ok.batchId) {
                    try auditOnce(key: "rej:\(rec.id):\(draft.id)", action: "item_rejected", target: draft.id, ["reason": why, "approval_id": rec.id])
                    reasons.append("approval \(rec.id.prefix(8)): \(why)")
                    continue
                }
                accepted.append(Acceptance(rec: rec, ok: ok, item: item))
            }
        }
        return (accepted, reasons)
    }

    // MARK: batch status

    /// Live = unrevoked, unexpired and verifiable against the pin. Without a pin (start-up) only the stored columns can be checked.
    func hasLiveRetries(_ draft: DraftSnapshot, now: Date, cache: EvalCache) throws -> Bool {
        if cache.approvals[draft.batchId] == nil {
            cache.approvals[draft.batchId] = try db.query("SELECT * FROM approvals WHERE batch_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC", [.text(draft.batchId)])
        }
        for arow in cache.approvals[draft.batchId] ?? [] {
            let rec = ApprovalRecord(row: arow)
            if let pin = currentPin {
                guard case .success(let ok) = verdict(rec, pin: pin, now: now, cache: cache),
                      let item = ok.items.first(where: { $0.draftId == draft.id }),
                      Verifier.checkItem(item, draft: draft, batchId: ok.batchId) == nil else { continue }
            } else {
                guard let exp = Time.parse(rec.notAfter), now < exp else { continue }
                let tried = try db.one("SELECT COUNT(*) AS n FROM sends WHERE approval_id = ? AND draft_id = ?", [.text(rec.id), .text(draft.id)])?.i("n") ?? 0
                if tried == 0 { continue }
            }
            if try failureCount(approvalId: rec.id, draftId: draft.id) < Self.maxFailuresPerApproval { return true }
        }
        return false
    }

    /// A batch is `done` only when no draft is in draft/review/approved/sending and no failed draft can still be retried
    /// under a live approval. A failed draft whose approval is dead is not open. If only draft/review drafts remain (an approval
    /// expired or was refused), the batch goes back to `review` so the user can approve again.
    func refreshBatch(_ batchId: String, now: String) throws {
        guard let b = try db.one("SELECT status FROM batches WHERE id = ?", [.text(batchId)]), ["approved", "sending"].contains(b.str("status")) else { return }
        let nowDate = Time.parse(now) ?? clock()
        let counts = try db.one("""
            SELECT COALESCE(SUM(CASE WHEN status IN ('draft','review') THEN 1 ELSE 0 END), 0) AS unapproved,
                   COALESCE(SUM(CASE WHEN status IN ('approved','sending') THEN 1 ELSE 0 END), 0) AS active
            FROM drafts WHERE batch_id = ?
            """, [.text(batchId)])
        let unapproved = counts?.i("unapproved") ?? 0
        let active = counts?.i("active") ?? 0
        var retrying = false
        if active == 0 {
            let cache = EvalCache()
            for r in try db.query("SELECT id FROM drafts WHERE batch_id = ? AND status = 'failed'", [.text(batchId)]) {
                guard let (d, _) = try snapshot(r.str("id")) else { continue }
                if try hasLiveRetries(d, now: nowDate, cache: cache) { retrying = true; break }
            }
        }
        if active > 0 || retrying {
            try db.exec("UPDATE batches SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'approved'", [.text(now), .text(batchId)])
        } else if unapproved > 0 {
            try db.exec("UPDATE batches SET status = 'review', updated_at = ? WHERE id = ? AND status IN ('approved','sending')", [.text(now), .text(batchId)])
        } else {
            try db.exec("UPDATE batches SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('approved','sending')", [.text(now), .text(batchId)])
        }
    }

    /// Informational only (heartbeat `sent_today`): sends that went out in the last 24 hours. It gates nothing.
    func countSentToday(now: Date) throws -> Int {
        try db.one("SELECT COUNT(*) AS n FROM sends WHERE started_at >= ? AND (result IN ('sent','unknown') OR result IS NULL)",
                   [.text(Time.iso(now.addingTimeInterval(-86_400)))])?.i("n") ?? 0
    }

    func lastFinishedSend() throws -> Date? {
        try db.one("SELECT MAX(finished_at) AS f FROM sends WHERE finished_at IS NOT NULL")?.text("f").flatMap(Time.parse)
    }

    /// Seconds to wait before the next send may start while pacing is off: the fixed gap after the most recent finished attempt (any transport, any result).
    func gapRemaining(now: Date) throws -> Double {
        SendGap.remaining(now: now, lastFinished: try lastFinishedSend())
    }

    // MARK: pacing

    /// Sends that started since local midnight, dry and live alike (every attempt that wasn't released unsent).
    func sendsStartedToday(now: Date) throws -> Int {
        try db.one("SELECT COUNT(*) AS n FROM sends WHERE started_at >= ?", [.text(Time.iso(Pacing.dayStart(now, timeZone)))])?.i("n") ?? 0
    }

    /// Why pacing holds the next send, or nil. Reads the persisted next_send_at, so it survives a restart. The earliest start is never
    /// later than the last send plus the current longest pause: loosening the settings takes effect at once.
    func paceHold(now: Date, pace: PaceSettings) throws -> PaceHold? {
        var next = try state.get("next_send_at").flatMap(Time.parse)
        if let n = next, let last = try lastFinishedSend() { next = min(n, last.addingTimeInterval(pace.maxS)) }
        return Pacing.evaluate(now: now, pace: pace, nextSendAt: next, sentToday: try sendsStartedToday(now: now), tz: timeZone)
    }

    /// Tells the dashboard why approved messages are waiting (exec_state pace_hold / pace_until; "" = not holding).
    func publishPace(_ hold: PaceHold?) {
        let kind = hold?.kind.rawValue ?? "", until = hold.map { Time.iso($0.until) } ?? ""
        let key = kind + "|" + until
        if publishedPace == key { return }
        do { try state.set("pace_hold", kind); try state.set("pace_until", until); publishedPace = key } catch { publishedPace = nil }
    }

    func holdMessage(_ h: PaceHold, pace: PaceSettings, sentToday: Int) -> String {
        let at = Pacing.clockText(h.until, timeZone)
        switch h.kind {
        case .gap: return "pacing: next message at \(at)"
        case .daily: return "pacing: daily limit reached (\(sentToday)/\(pace.dailyCap)), continues at \(at)"
        case .quiet: return "pacing: quiet hours until \(at)"
        }
    }

    // MARK: pin

    struct Mode {
        var pin: PinFile?
        var hold: String?               // set when nothing may be sent
        var pinError: String?
    }

    /// The effective pin, loaded fresh: the root pin file if it exists in any form (hardened, and then it must be valid: there is no
    /// fallback), else the user pin file (simple). See PinFileLoader.resolve for the checks.
    func loadPin() throws -> PinFile {
        try PinFileLoader.resolve(rootPath: config.rootPinPath, userPath: config.userPinPath, rootExpectedUid: config.rootExpectedUid,
                                  checkRootAncestors: config.checkPinAncestors, userExpectedUid: config.userExpectedUid,
                                  liveTrust: config.userPinTrustedForLive)
    }

    /// The DB `transport` setting plays no part: an approval's own signed manifest says dry or live, and the effective pin
    /// (trusted, with a policy that allows it) says whether live is allowed at all.
    func resolvePin() -> Mode {
        do { return Mode(pin: try loadPin(), hold: nil, pinError: nil) }
        catch { return Mode(pin: nil, hold: "no usable pin file: \(error)", pinError: "\(error)") }
    }

    func transport(for name: String) -> Transport {
        if name == "live" {
            if liveTransport == nil { liveTransport = makeTransport("live") }
            return liveTransport!
        }
        if dryTransport == nil { dryTransport = makeTransport("dry") }
        return dryTransport!
    }

    // MARK: heartbeat

    /// `transport` in exec_status is the DB setting, shown to the user only. It does not decide how anything is sent.
    func heartbeat(mode: Mode?, settings: ExecSettings?, sentToday: Int) {
        let pinOK = (try? loadPin()) != nil     // the effective pin (root if present, else user) loaded and passed its checks
        let err = tamperMessage ?? lastError ?? contactsNote ?? mode?.pinError ?? liveNote
        let shown = settings?.transport == "live" ? "live" : "dry"
        _ = try? db.exec("""
            INSERT INTO exec_status(id, heartbeat_at, version, transport, pin_file_ok, last_error, sent_today) VALUES(1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, version = excluded.version, transport = excluded.transport,
              pin_file_ok = excluded.pin_file_ok, last_error = excluded.last_error, sent_today = excluded.sent_today
            """, [.text(Time.iso(clock())), .text(Version.current), .text(shown), .int(pinOK ? 1 : 0), .opt(err), .num(sentToday)])
    }

    // MARK: contacts export

    /// `force`: export now even though nothing asked for it (right after a live contact change, so the cache and agents' searches
    /// see it). Still never prompts: only an explicit sync request may.
    func serviceContactsExport(force: Bool = false) throws {
        let pending = try db.query("SELECT id FROM exec_requests WHERE kind = 'contacts_export' AND done_at IS NULL ORDER BY created_at")
        let now = clock()
        var periodicDue = false
        if contacts.accessGranted {
            let last = try state.get("last_contacts_export").flatMap(Time.parse)
            periodicDue = force || last == nil || now.timeIntervalSince(last!) >= config.contactsExportIntervalS
        }
        if pending.isEmpty && !periodicDue { return }
        // An explicit sync request is the one place the Contacts prompt may appear before going live: it asks macOS once
        // (a no-op unless the status is still notDetermined) and this round fails; the next request succeeds after Allow.
        if !pending.isEmpty && !contacts.accessGranted { contacts.requestAccessIfNeeded() }
        var result: [String: Any]
        do {
            guard contacts.accessGranted else { throw ExecError("Contacts access has not been granted to outbox-exec (answer the macOS prompt on this Mac, then sync again)") }
            let data = try contacts.exportAll(now: now)
            try writeAtomically(data, to: config.contactsExportPath)
            try state.set("last_contacts_export", Time.iso(now))
            result = ["ok": true, "bytes": data.count]
        } catch {
            result = ["ok": false, "error": "\(error)"]
            if !pending.isEmpty { try audit("contacts_export_failed", target: nil, result) }
            try state.set("last_contacts_export", Time.iso(now))   // don't hammer on failure
        }
        for r in pending {
            try db.exec("UPDATE exec_requests SET done_at = ?, result_json = ? WHERE id = ?", [.text(Time.iso(clock())), .text(JSON.string(result)), .text(r.str("id"))])
        }
    }

    // MARK: the tick

    /// One pass of the loop: housekeeping, then at most one send.
    @discardableResult
    public func tick() throws -> TickResult {
        let now = clock()
        if let why = try checkTamper() {
            tamperMessage = why
            heartbeat(mode: nil, settings: nil, sentToday: 0)
            return .held(why)
        }
        tamperMessage = nil
        let settings = try ExecSettings.load(db)
        let mode = resolvePin()
        currentPin = mode.pin
        if settings.transport == "live", !(mode.pin.map { $0.trustedForLive && $0.version >= 2 && $0.policy.liveAllowed } ?? false) {
            liveNote = "transport setting is live, but the pin policy does not allow live sending (\(mode.pin?.mode.rawValue ?? "no usable pin") mode): live-signed approvals will be refused"
        } else { liveNote = nil }
        let sentToday = (try? countSentToday(now: now)) ?? 0
        defer {
            let after = (try? countSentToday(now: clock())) ?? sentToday
            heartbeat(mode: mode, settings: settings, sentToday: after)
        }

        try serviceContactsExport()

        // approvals that stopped being valid (expired, revoked, unverifiable, unpinned key, item changed) give their drafts back to the user
        if mode.hold == nil, let pin = mode.pin { try reconcile(now: now, pin: pin) }
        // the same for contact changes. Contact trouble is reported (exec_status.last_error) but never holds back messages.
        contactsNote = nil
        refreshContactTables()
        let contactsReady = contactTablesMissing.isEmpty
        if !contactsReady { contactsNote = "contacts tables missing: restart outboxd" }
        if contactsReady, !contactRecoveryDone {
            do { try recoverContactApplies(); contactRecoveryDone = true } catch { contactsNote = "contacts: \(error)" }
        }
        // anything queued without an approval (auto_queued, requires_approval = 0) goes back to review; database only, runs even when held
        if contactsReady {
            do { try holdUnapprovedContacts(now: now) } catch { contactsNote = "contacts: \(error)" }
        }
        if contactsReady, mode.hold == nil, let pin = mode.pin {
            do { try reconcileContacts(now: now, pin: pin) } catch { contactsNote = "contacts: \(error)" }
        }

        if settings.killSwitch { return .held("kill switch is on") }
        if let h = mode.hold { return .held(h) }
        guard let pin = mode.pin else { return .held("no pin file") }

        // contact changes: approved creates, edits and undos only (kill switch and tamper check already passed above)
        if contactsReady {
            do {
                if try applyContacts(now: now, pin: pin) { try serviceContactsExport(force: true) }
            } catch { contactsNote = "contacts: \(error)" }
        }

        let waiting = try db.one("""
            SELECT COUNT(*) AS n FROM drafts d JOIN batches b ON b.id = d.batch_id
            WHERE d.status IN ('approved','failed') AND b.status != 'cancelled'
            """)?.i("n") ?? 0
        if waiting == 0 { publishPace(nil); return .idle }

        if settings.pace.enabled {
            // optional pacing: a random pause, a daily limit and quiet hours (dry and live alike)
            let hold = try paceHold(now: now, pace: settings.pace)
            publishPace(hold)
            if let h = hold { return .held(holdMessage(h, pace: settings.pace, sentToday: try sendsStartedToday(now: now))) }
        } else {
            // off: a fixed gap after the previous send
            publishPace(nil)
            let wait = try gapRemaining(now: now)
            if wait > 0 { return .held("2 s gap between sends (\(String(format: "%.1f", wait)) s left)") }
        }

        var out = try claimNext(now: now, pin: pin)
        if out.claim == nil, out.needsPreflight {
            // Live only. Until Messages answers a read-only probe, nothing is attempted (so a missing permission doesn't burn
            // approvals or trip the breaker). Retried every 30 s.
            if !contactsPromptAsked { contactsPromptAsked = true; contacts.requestAccessIfNeeded() }
            if let why = livePreflight(now: now) { return .held(why) }
            out = try claimNext(now: now, pin: pin)
        }
        if out.killed { return .held("kill switch is on") }
        guard let claim = out.claim else {
            return .idle
        }
        return try execute(claim, mode: mode, settings: settings)
    }

    func livePreflight(now: Date) -> String? {
        if preflightOK { return nil }
        if let last = lastPreflight, now.timeIntervalSince(last) < 30 { return lastError ?? "waiting for the Messages preflight" }
        lastPreflight = now
        if let why = transport(for: "live").preflight() {
            lastError = why
            return why
        }
        preflightOK = true
        lastError = nil
        return nil
    }

    // MARK: reconcile (give unusable approvals' drafts back to the user)

    /// Drafts still `approved` that no live approval covers go back to `review` (one transaction), with an exec_status.last_error
    /// and one audit row per batch and reason. Without this a 24 h approval that expires leaves its drafts "approved" forever.
    /// Consumed drafts (a `sent` or `unknown` send exists) and failed drafts are left alone.
    func reconcile(now: Date, pin: PinFile) throws {
        try settleBatches(now: now)
        let pending = try db.one("SELECT COUNT(*) AS n FROM drafts d JOIN batches b ON b.id = d.batch_id WHERE d.status = 'approved' AND b.status != 'cancelled'")?.i("n") ?? 0
        if pending == 0 { return }
        let ts = Time.iso(now)
        var notes: [String] = []
        try db.transaction {
            let cache = EvalCache()
            var groups: [String: (batch: String, reason: String, ids: [String])] = [:]
            var order: [String] = []
            for r in try db.query("SELECT d.id AS id FROM drafts d JOIN batches b ON b.id = d.batch_id WHERE d.status = 'approved' AND b.status != 'cancelled' ORDER BY b.created_at, d.position, d.id") {
                guard let (d, _) = try snapshot(r.str("id")) else { continue }
                if try isConsumed(d.id) { continue }
                let (accepted, reasons) = try acceptances(for: d, pin: pin, now: now, cache: cache)
                if !accepted.isEmpty { continue }
                let reason = reasons.first ?? "no live approval covers this draft"
                let key = d.batchId + "|" + reason
                if groups[key] == nil { groups[key] = (d.batchId, reason, []); order.append(key) }
                groups[key]!.ids.append(d.id)
            }
            var batches = Set<String>()
            for key in order {
                let g = groups[key]!
                var moved = 0
                for id in g.ids {
                    moved += try db.exec("UPDATE drafts SET status = 'review', updated_at = ? WHERE id = ? AND status = 'approved'", [.text(ts), .text(id)])
                }
                if moved == 0 { continue }
                try audit("drafts_returned_to_review", target: g.batch, ["reason": g.reason, "count": moved, "draft_ids": Array(g.ids.prefix(200))])
                notes.append("\(moved) draft(s) in batch \(g.batch.prefix(8)) returned to review, to be approved again: \(g.reason)")
                batches.insert(g.batch)
            }
            for b in batches { try refreshBatch(b, now: ts) }
        }
        if !notes.isEmpty { lastError = notes.joined(separator: " | ") }
    }

    /// Batches marked approved/sending with no approved or sending draft left (their approvals died or all drafts finished) are
    /// re-evaluated, so a failed draft whose approval expired stops holding its batch open.
    func settleBatches(now: Date) throws {
        let stale = try db.query("""
            SELECT b.id AS id FROM batches b WHERE b.status IN ('approved','sending')
              AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.batch_id = b.id AND d.status IN ('approved','sending'))
            """)
        if stale.isEmpty { return }
        let ts = Time.iso(now)
        try db.transaction { for r in stale { try refreshBatch(r.str("id"), now: ts) } }
    }

    // MARK: claim (verification happens inside the write transaction)

    func claimNext(now: Date, pin: PinFile) throws -> ClaimOutcome {
        try db.transaction {
            var out = ClaimOutcome()
            // the kill switch is re-read here, inside the write transaction, not taken from the start of the tick
            if try killSwitchOn() { out.killed = true; return out }
            let cache = EvalCache()
            let candidates = try db.query("""
                SELECT d.id AS id FROM drafts d JOIN batches b ON b.id = d.batch_id
                WHERE d.status IN ('approved','failed') AND b.status != 'cancelled'
                ORDER BY b.created_at, d.position, d.id
                """)
            for c in candidates {
                guard let (draft, _) = try snapshot(c.str("id")) else { continue }
                if try isConsumed(draft.id) { continue }
                let (accepted, _) = try acceptances(for: draft, pin: pin, now: now, cache: cache)
                for a in accepted {
                    let prior = try db.one("SELECT COALESCE(MAX(attempt), 0) AS m FROM sends WHERE approval_id = ? AND draft_id = ?", [.text(a.rec.id), .text(draft.id)])
                    if try failureCount(approvalId: a.rec.id, draftId: draft.id) >= Self.maxFailuresPerApproval { continue }
                    let lane = a.ok.transport
                    if lane == "live", !preflightOK { out.needsPreflight = true; continue }
                    let attempt = (prior?.i("m") ?? 0) + 1
                    let sendId = newId()
                    let ts = Time.iso(clock())
                    try db.exec("INSERT INTO sends(id, draft_id, approval_id, attempt, transport, started_at, handle, body_sha256) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                                [.text(sendId), .text(draft.id), .text(a.rec.id), .num(attempt), .text(lane), .text(ts), .text(draft.handle), .text(Hex.sha256Hex(draft.body))])
                    try db.exec("UPDATE drafts SET status = 'sending', updated_at = ? WHERE id = ?", [.text(ts), .text(draft.id)])
                    try db.exec("UPDATE batches SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'approved'", [.text(ts), .text(draft.batchId)])
                    try audit("send_start", target: draft.id, ["approval_id": a.rec.id, "attempt": attempt, "transport": lane, "to": draft.handle, "credential": a.ok.credentialLabel])
                    out.claim = Claim(sendId: sendId, draft: draft, priorStatus: draft.status, approval: a.ok, item: a.item, attempt: attempt)
                    return out
                }
            }
            return out
        }
    }

    // MARK: execute

    /// Why this claim must not be sent right now (kill switch on, or live no longer allowed), or nil.
    func stopReason(for claim: Claim) throws -> String? {
        if try killSwitchOn() { return "kill switch is on" }
        if claim.approval.transport == "live" {
            do {
                let p = try loadPin()
                guard p.trustedForLive, p.version >= 2, p.policy.liveAllowed else { return "the pin policy no longer allows live sending (\(p.mode.rawValue) mode)" }
            } catch { return "the pin file is no longer usable: \(error)" }
        }
        return nil
    }

    /// Gives a claim back without counting an attempt: the unfinished sends row is deleted and the draft returns to its earlier status.
    func release(_ claim: Claim, reason: String) throws {
        try db.transaction {
            let ts = Time.iso(clock())
            try db.exec("DELETE FROM sends WHERE id = ? AND finished_at IS NULL", [.text(claim.sendId)])
            try db.exec("UPDATE drafts SET status = ?, updated_at = ? WHERE id = ? AND status = 'sending'", [.text(claim.priorStatus), .text(ts), .text(claim.draft.id)])
            try audit("send_released", target: claim.draft.id, ["approval_id": claim.approval.approvalId, "reason": reason])
            try refreshBatch(claim.draft.batchId, now: ts)
        }
    }

    func execute(_ claim: Claim, mode: Mode, settings: ExecSettings) throws -> TickResult {
        let d = claim.draft
        // the signed manifest picks the transport (live also needs a trusted pin whose policy allows it, checked when the approval was verified)
        let laneName = claim.approval.transport
        let tr = transport(for: laneName)

        // refuse anything the live script builder would refuse, in dry mode too, so a dry run previews real behaviour.
        // This comes BEFORE any contact is created.
        var outcome: SendOutcome
        if let why = AppleScriptSource.validateHandle(d.handle) {
            outcome = .failedBeforeHandoff("invalid handle: \(why)")
        } else if let why = AppleScriptSource.validateBody(d.body) {
            outcome = .failedBeforeHandoff("invalid body: \(why)")
        } else {
            if let why = try stopReason(for: claim) {
                try release(claim, reason: why)
                lastError = "send of \(d.id) stopped: \(why)"
                return .held(why)
            }
            // contact creation before the send (signed intent comes from the manifest; the draft flag must agree)
            if let proposed = claim.item.createContact, d.createContact {
                createContactIfNeeded(claim, proposed: proposed, laneName: laneName)
            }
            let sentNow = (try? countSentToday(now: clock())) ?? 0
            heartbeat(mode: mode, settings: settings, sentToday: sentNow)
            beforeSendHook?()
            if let why = try stopReason(for: claim) {
                try release(claim, reason: why)
                lastError = "send of \(d.id) stopped: \(why)"
                return .held(why)
            }
            outcome = tr.send(SendRequest(draftId: d.id, approvalId: claim.approval.approvalId, handle: d.handle, service: d.service, body: d.body))
        }

        let result: String, error: String?, serviceUsed: String?, status: String
        switch outcome {
        case .sent(let s): result = "sent"; error = nil; serviceUsed = s; status = "sent"
        case .failedBeforeHandoff(let e): result = "failed"; error = e; serviceUsed = nil; status = "failed"
        case .unknown(let e): result = "unknown"; error = e; serviceUsed = nil; status = "unknown"
        }

        // Any finished attempt starts the next random pause (a failed or unconfirmed one counts too). Drawn once, so a retried finish() keeps it.
        let finishedAt = clock()
        let nextSend = settings.pace.enabled ? Pacing.drawGap(settings.pace, random: random) : nil
        func finish() throws {
            try db.transaction {
                let ts = Time.iso(clock())
                try state.set("next_send_at", nextSend.map { Time.iso(finishedAt.addingTimeInterval($0)) } ?? "")
                try db.exec("UPDATE sends SET finished_at = ?, result = ?, error = ?, service_used = ?, handle = ?, body_sha256 = ? WHERE id = ?",
                            [.text(ts), .text(result), .opt(error), .opt(serviceUsed), .text(d.handle), .text(Hex.sha256Hex(d.body)), .text(claim.sendId)])
                try db.exec("UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?", [.text(status), .text(ts), .text(d.id)])
                try audit("send_\(result)", target: d.id, ["approval_id": claim.approval.approvalId, "attempt": claim.attempt, "transport": laneName, "service_used": serviceUsed ?? "", "error": error ?? ""])
                if result != "sent" && settings.breakerOnFailure {
                    // the breaker stops sending but revokes nothing: the user resumes it from the dashboard
                    try db.exec("INSERT INTO settings(key, value) VALUES('kill_switch', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                    try db.exec("INSERT INTO settings(key, value) VALUES('kill_reason', 'breaker') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
                    try audit("breaker_tripped", target: d.id, ["reason": error ?? result])
                }
                try refreshBatch(d.batchId, now: ts)
            }
        }
        do { try finish() } catch {
            Thread.sleep(forTimeInterval: 1)
            try finish()   // if this also throws, the draft stays 'sending' and becomes 'unknown' at next start
        }
        lastError = result == "sent" ? nil : "send \(d.id) \(result): \(error ?? "")"
        return .processed(draftId: d.id, result: result)
    }

    func createContactIfNeeded(_ claim: Claim, proposed: ProposedContactModel, laneName: String) {
        do {
            // defence in depth: the item check already refused a contact whose handle isn't the recipient
            if let why = Verifier.checkProposedContact(proposed, to: claim.draft.handle) { lastError = "contact for \(claim.draft.id) not created: \(why)"; return }
            let existing = try db.one("SELECT COUNT(*) AS n FROM contact_writes WHERE approval_id = ? AND draft_id = ?", [.text(claim.approval.approvalId), .text(claim.draft.id)])?.i("n") ?? 0
            if existing > 0 { return }
            // one contact per draft, however many times the draft is approved again
            let alreadyCreated = try db.one("SELECT COUNT(*) AS n FROM contact_writes WHERE draft_id = ? AND result = 'created'", [.text(claim.draft.id)])?.i("n") ?? 0
            var res = "created", macosId: String? = nil, err: String? = nil
            if alreadyCreated > 0 {
                res = "skipped"; err = "contact already created for this draft under an earlier approval"
            } else if laneName == "live" {
                do { macosId = try contacts.create(proposed) } catch { res = "failed"; err = "\(error)" }
            } else {
                res = "skipped"; err = "dry transport: contact not created"
                let rec: [String: Any] = ["at": Time.iso(clock()), "draft_id": claim.draft.id, "approval_id": claim.approval.approvalId, "contact": proposed.raw]
                if let line = JSON.data(rec) { _ = appendLine(line, to: config.dryContactsLogPath) }
            }
            try db.transaction {
                try db.exec("INSERT INTO contact_writes(id, draft_id, approval_id, payload_json, transport, result, macos_id, error, at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            [.text(newId()), .text(claim.draft.id), .text(claim.approval.approvalId), .text(JSON.string(proposed.raw)), .text(laneName), .text(res), .opt(macosId), .opt(err), .text(Time.iso(clock()))])
                try audit("contact_\(res)", target: claim.draft.id, ["approval_id": claim.approval.approvalId, "error": err ?? ""])
            }
        } catch {
            lastError = "contact write for \(claim.draft.id): \(error)"
        }
    }

    // MARK: daemon loop

    public func runLoop(once: Bool, sleepSeconds: Double = 3, shouldStop: () -> Bool = { false }) throws {
        try prepare()
        try recoverInterrupted()
        repeat {
            var sentOne = false
            do { if case .processed = try tick() { sentOne = true } } catch {
                lastError = "tick failed: \(error)"
                FileHandle.standardError.write(Data("outbox-exec: \(lastError!)\n".utf8))
                heartbeat(mode: nil, settings: nil, sentToday: 0)
            }
            if once { break }          // `run --once` sends at most one item
            if shouldStop() { break }
            // right after a send, wake when the fixed gap is over so queued items go out exactly one gap apart
            Thread.sleep(forTimeInterval: sentOne ? min(sleepSeconds, SendGap.seconds) : sleepSeconds)
        } while !shouldStop()
    }
}

/// UUIDv7 (time-sortable), same family of ids as the TypeScript side.
public func newId() -> String {
    var b = [UInt8](repeating: 0, count: 16)
    let ms = UInt64(Date().timeIntervalSince1970 * 1000)
    for i in 0..<6 { b[i] = UInt8((ms >> UInt64(8 * (5 - i))) & 0xFF) }
    for i in 6..<16 { b[i] = UInt8.random(in: 0...255) }
    b[6] = (b[6] & 0x0F) | 0x70
    b[8] = (b[8] & 0x3F) | 0x80
    let h = Hex.encode(b)
    let c = Array(h)
    return String(c[0..<8]) + "-" + String(c[8..<12]) + "-" + String(c[12..<16]) + "-" + String(c[16..<20]) + "-" + String(c[20..<32])
}

extension ExecConfig {
    /// Config for the CLI. OUTBOX_IGNORE_ROOT_PIN=1 (tests only) points the root pin at a path that can't exist and withholds live
    /// trust from the user pin, so it runs dry on the user pin and live mode is impossible. It can only remove capability, never add it.
    public static func fromEnvironment() -> ExecConfig {
        var c = ExecConfig(home: Paths.defaultHome())
        if ProcessInfo.processInfo.environment["OUTBOX_IGNORE_ROOT_PIN"] == "1" {
            c.rootPinPath = c.home + "/no-root-pin/passkeys.json"
            c.userPinTrustedForLive = false
        }
        return c
    }
}
