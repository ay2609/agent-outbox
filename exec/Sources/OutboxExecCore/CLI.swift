import Foundation

nonisolated(unsafe) private var stopRequested: sig_atomic_t = 0

public enum CLI {
    static let usage = """
    outbox-exec \(Version.current): the only component that can send iMessages.
      run [--once]               daemon loop (polls every 3 s). Sends an approved item right away, one at a time, 2 s apart.
                             --once sends one item and exits. (--no-pace is accepted and ignored.)
      selftest [--keep] [--schema PATH]   verification test suite in a temp dir; touches no real state
      verify <approval_id>       print per-item verdicts for an approval; sends nothing
      contacts-export            write contacts-export.json from the address book (asks for Contacts access)
      version
    Environment: OUTBOX_HOME (default ~/Library/Application Support/agent-outbox)
    """

    public static func run(_ argv: [String]) -> Int32 {
        let args = Array(argv.dropFirst())
        guard let cmd = args.first else { print(usage); return 2 }
        let rest = Array(args.dropFirst())
        do {
            switch cmd {
            case "version", "--version": print("outbox-exec \(Version.current)"); return 0
            case "run": return try cmdRun(rest)
            case "selftest": return cmdSelftest(rest)
            case "verify": return try cmdVerify(rest)
            case "contacts-export": return try cmdContactsExport()
            case "help", "--help", "-h": print(usage); return 0
            default: FileHandle.standardError.write(Data((usage + "\n").utf8)); return 2
            }
        } catch {
            FileHandle.standardError.write(Data("outbox-exec: \(error)\n".utf8))
            return 1
        }
    }

    static func cmdRun(_ a: [String]) throws -> Int32 {
        let once = a.contains("--once")
        let config = ExecConfig.fromEnvironment()
        let known: Set<String> = ["--once", "--no-pace"]
        if let bad = a.first(where: { !known.contains($0) }) { throw ExecError("unknown option \(bad)") }
        let db = try Database(path: config.dbPath)
        let ex = Executor(db: db, config: config, contacts: SystemContacts())
        signal(SIGTERM) { _ in stopRequested = 1 }
        signal(SIGINT) { _ in stopRequested = 1 }
        FileHandle.standardError.write(Data("outbox-exec \(Version.current) starting (home \(config.home), once=\(once))\n".utf8))
        try ex.runLoop(once: once, shouldStop: { stopRequested != 0 })
        return 0
    }

    static func cmdSelftest(_ a: [String]) -> Int32 {
        var keep = false
        var schema: String?
        var i = 0
        while i < a.count {
            if a[i] == "--keep" { keep = true }
            else if a[i] == "--schema", i + 1 < a.count { schema = a[i + 1]; i += 1 }
            i += 1
        }
        return SelfTest.run(keep: keep, schemaPath: schema) ? 0 : 1
    }

    static func cmdVerify(_ a: [String]) throws -> Int32 {
        guard a.count == 1 else { throw ExecError("usage: outbox-exec verify <approval_id>") }
        let config = ExecConfig.fromEnvironment()
        let db = try Database(path: config.dbPath)
        let ex = Executor(db: db, config: config, contacts: SystemContacts())
        let settings = try ExecSettings.load(db)
        let mode = ex.resolvePin()
        guard let pin = mode.pin else { throw ExecError(mode.hold ?? "no pin file") }
        let (ok, lines) = try verifyReport(db: db, approvalId: a[0], pin: pin, now: Date())
        print("pin: \(pin.path) (\(pin.mode.rawValue) mode, \(pin.trustedForLive ? "trusted for live" : "not trusted for live"), policy live_allowed=\(pin.policy.liveAllowed) contacts_live_allowed=\(pin.policy.contactsLiveAllowed))  transport setting: \(settings.transport)")
        lines.forEach { print($0) }
        return ok ? 0 : 1
    }

    static func cmdContactsExport() throws -> Int32 {
        let config = ExecConfig.fromEnvironment()
        let c = SystemContacts()
        guard c.requestAccessBlocking() else { throw ExecError("Contacts access was not granted (System Settings > Privacy & Security > Contacts)") }
        let data = try c.exportAll(now: Date())
        try writeAtomically(data, to: config.contactsExportPath)
        print("wrote \(config.contactsExportPath) (\(data.count) bytes)")
        return 0
    }

    /// Per-item verdicts. Read-only.
    public static func verifyReport(db: Database, approvalId: String, pin: PinFile, now: Date) throws -> (Bool, [String]) {
        guard let row = try db.one("SELECT * FROM approvals WHERE id = ?", [.text(approvalId)]) else { return (false, ["approval \(approvalId): not found"]) }
        let rec = ApprovalRecord(row: row)
        var lines: [String] = []
        let v: VerifiedApproval
        do { v = try Verifier.verifyApproval(rec, pin: pin, now: now) } catch let r as Rejection {
            return (false, ["approval \(approvalId): REJECTED: \(r.reason)"])
        }
        lines.append("approval \(approvalId): signature OK (key '\(v.credentialLabel)', batch \(v.batchId), expires \(Time.iso(v.notAfter)))")
        var all = true
        for it in v.items {
            let d = try db.one("SELECT id, batch_id, handle, service, body, status, create_contact FROM drafts WHERE id = ?", [.text(it.draftId)]).map(DraftSnapshot.init(row:))
            var verdict: String
            if let why = Verifier.checkItem(it, draft: d, batchId: v.batchId) { verdict = "REJECT: \(why)"; all = false }
            else {
                let sent = try db.one("SELECT COUNT(*) AS n FROM sends WHERE draft_id = ? AND result IN ('sent','unknown')", [.text(it.draftId)])?.i("n") ?? 0
                verdict = sent > 0 ? "OK but already consumed (status \(d?.status ?? "?"))" : "OK (status \(d?.status ?? "?"))"
            }
            lines.append("  \(it.draftId) -> \(it.to) [\(it.service)] \(verdict)")
        }
        return (all, lines)
    }
}
