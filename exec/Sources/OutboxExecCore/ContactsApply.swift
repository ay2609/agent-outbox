import Foundation

// Native contact management in the executor.
//
// Owner rule (2026-11-16): contacts are NEVER added automatically. Every change (create, update, undo) reaches the address book only
// under a verified, unconsumed, unrevoked `contact_approvals` row (a Touch ID signature) whose signed manifest lists the exact change
// (kind, target and payload bytes). There is no auto-apply lane any more. In simple mode a process running as the same user can write
// the database, so a row that claims otherwise (`auto_queued`, or `requires_approval = 0`) is moved to review by
// `holdUnapprovedContacts` and is never written to Contacts.
//
// Approved creates still run a LIVE handle lookup right before the save. A hit means the person is already in Contacts (added since the
// user looked, or the cache was stale): the create FAILS with "already in Contacts" and nothing is written. That matches how an approved
// edit treats a surprise (the card is gone, a fingerprint differs: `failed` with the reason, never a guess), and it is the safest
// outcome: no duplicate card, no silent turning into an edit the user did not sign. The user can propose the edit instead.
//
// Every apply claims a `contact_applies` row first (UNIQUE change_id, like `sends`), so a change is applied at most once and a crash
// in the middle becomes `unknown`, never a retry.

struct ContactChangeRow {
    let raw: Row
    let id: String, setId: String, kind: String, status: String, payloadJson: String
    let position: Int
    let targetMacosId: String?, beforeVcard: String?, afterFingerprint: String?, resultMacosId: String?, undoOf: String?, transport: String?
    let requiresApproval: Bool

    init(row: Row) {
        raw = row
        id = row.str("id"); setId = row.str("set_id"); kind = row.str("kind"); status = row.str("status"); payloadJson = row.str("payload_json")
        position = row.i("position")
        targetMacosId = row.text("target_macos_id"); beforeVcard = row.text("before_vcard"); afterFingerprint = row.text("after_fingerprint")
        resultMacosId = row.text("result_macos_id"); undoOf = row.text("undo_of"); transport = row.text("transport")
        requiresApproval = row.i("requires_approval") != 0
    }

    var payloadObject: [String: Any] { JSON.object(Data(payloadJson.utf8)) ?? [:] }
}

/// A Contacts read that failed before anything was written: the claim is given back and tried again, never consumed.
struct ContactReadError: Error { let message: String }

enum ContactClaim {
    case claimed(applyId: String, row: ContactChangeRow, lane: String, approvalId: String?)
    case killed
    case skipped(String)
}

extension Executor {
    func contactsWriter(_ lane: String) -> ContactsWriter {
        if let w = contactsWriters[lane] { return w }
        let w: ContactsWriter = lane == "live" ? LiveContactsWriter(provider: contacts) : DryContactsWriter(logPath: config.dryContactsLogPath, clock: clock)
        contactsWriters[lane] = w
        return w
    }

    func readContacts<T>(_ f: () throws -> T) throws -> T {
        do { return try f() } catch { throw ContactReadError(message: "\(error)") }
    }

    func loadChange(_ id: String) throws -> ContactChangeRow? {
        try db.one("SELECT * FROM contact_changes WHERE id = ?", [.text(id)]).map(ContactChangeRow.init(row:))
    }

    func isContactConsumed(_ changeId: String) throws -> Bool {
        (try db.one("SELECT COUNT(*) AS n FROM contact_applies WHERE change_id = ?", [.text(changeId)])?.i("n") ?? 0) > 0
    }

    // MARK: set status

    /// `done` when nothing in the set is waiting; `review` while any change is in review, else `approved` while any is approved.
    /// A cancelled set stays cancelled.
    func refreshContactSet(_ setId: String, now: String) throws {
        guard let s = try db.one("SELECT status FROM contact_change_sets WHERE id = ?", [.text(setId)]), s.str("status") != "cancelled" else { return }
        let c = try db.one("""
            SELECT COALESCE(SUM(CASE WHEN status IN ('pending','auto_queued','review','approved') THEN 1 ELSE 0 END), 0) AS open,
                   COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) AS review,
                   COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved
            FROM contact_changes WHERE set_id = ?
            """, [.text(setId)])
        let next: String
        if (c?.i("open") ?? 0) == 0 { next = "done" }
        else if (c?.i("review") ?? 0) > 0 { next = "review" }
        else if (c?.i("approved") ?? 0) > 0 { next = "approved" }
        else { return }
        if next != s.str("status") {
            try db.exec("UPDATE contact_change_sets SET status = ?, updated_at = ? WHERE id = ?", [.text(next), .text(now), .text(setId)])
        }
    }

    // MARK: crash recovery

    /// A contact apply that never finished (crash or kill mid-apply) becomes `unknown` and its change `failed`, "interrupted".
    /// Never retried: the contact may or may not have been written.
    @discardableResult
    func recoverContactApplies() throws -> Int {
        let now = Time.iso(clock())
        return try db.transaction {
            var n = 0
            var sets = Set<String>()
            for r in try db.query("SELECT a.id AS aid, a.change_id AS cid, c.set_id AS sid FROM contact_applies a JOIN contact_changes c ON c.id = a.change_id WHERE a.finished_at IS NULL") {
                try db.exec("UPDATE contact_applies SET finished_at = ?, result = 'unknown', error = ? WHERE id = ?",
                            [.text(now), .text("executor stopped before the apply finished; outcome unknown, not retried"), .text(r.str("aid"))])
                try db.exec("UPDATE contact_changes SET status = 'failed', error = 'interrupted' WHERE id = ?", [.text(r.str("cid"))])
                try audit("contact_apply_interrupted", target: r.str("cid"), ["note": "apply was unfinished at start-up; marked unknown, never retried"])
                sets.insert(r.str("sid"))
                n += 1
            }
            for s in sets { try refreshContactSet(s, now: now) }
            return n
        }
    }

    // MARK: reconcile (give unusable approvals' changes back to the user)

    func contactVerdict(_ rec: ContactApprovalRecord, pin: PinFile, now: Date, cache: ContactEvalCache) -> Result<VerifiedContactApproval, Rejection> {
        if let v = cache.verdicts[rec.id] { return v }
        let v: Result<VerifiedContactApproval, Rejection>
        do { v = .success(try Verifier.verifyContactApproval(rec, pin: pin, now: now)) }
        catch let r as Rejection { v = .failure(r) }
        catch { v = .failure(Rejection("\(error)")) }
        cache.verdicts[rec.id] = v
        return v
    }

    /// Does a live approval vouch for this change right now? Rejections are audited once per reason.
    func contactCovered(_ row: ContactChangeRow, pin: PinFile, now: Date, cache: ContactEvalCache) throws -> (covered: Bool, reasons: [String]) {
        var reasons: [String] = []
        let approvals = try db.query("SELECT * FROM contact_approvals WHERE set_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC", [.text(row.setId)])
        for arow in approvals {
            let rec = ContactApprovalRecord(row: arow)
            switch contactVerdict(rec, pin: pin, now: now, cache: cache) {
            case .failure(let r):
                try auditOnce(key: "crej:\(rec.id)", action: "contact_approval_rejected", target: rec.id, ["reason": r.reason, "set_id": rec.setId])
                reasons.append("approval \(rec.id.prefix(8)) refused: \(r.reason)")
            case .success(let ok):
                guard let item = ok.items.first(where: { $0.changeId == row.id }) else { continue }
                if let why = Verifier.checkContactItem(item, row: row.raw, setId: ok.setId, consumed: try isContactConsumed(row.id)) {
                    try auditOnce(key: "crej:\(rec.id):\(row.id)", action: "contact_item_rejected", target: row.id, ["reason": why, "approval_id": rec.id])
                    reasons.append("approval \(rec.id.prefix(8)): \(why)")
                    continue
                }
                return (true, reasons)
            }
        }
        if reasons.isEmpty {
            let revoked = try db.one("SELECT COUNT(*) AS n FROM contact_approvals WHERE set_id = ? AND revoked_at IS NOT NULL", [.text(row.setId)])?.i("n") ?? 0
            reasons.append(revoked > 0 ? "the approval was revoked" : "no live approval covers this change")
        }
        return (false, reasons)
    }

    /// Approved changes that no live approval covers go back to `review` (one transaction), with the reason in `error`, an
    /// exec_status.last_error and one audit row per set and reason. Changes that were already applied but whose status was reset
    /// are put back to what really happened. Runs even with the kill switch on: it applies nothing.
    func reconcileContacts(now: Date, pin: PinFile) throws {
        let ts = Time.iso(now)
        // a status reset on a consumed change (agent or crash) is repaired from the apply record
        let stale = try db.query("""
            SELECT c.id AS id, c.set_id AS sid, a.result AS result FROM contact_changes c JOIN contact_applies a ON a.change_id = c.id
            WHERE c.status IN ('pending','auto_queued','review','approved') AND a.result IS NOT NULL
            """)
        let waiting = try db.query("""
            SELECT c.id AS id FROM contact_changes c JOIN contact_change_sets s ON s.id = c.set_id
            WHERE c.status = 'approved' AND s.status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM contact_applies a WHERE a.change_id = c.id)
            ORDER BY c.created_at, c.position, c.id
            """)
        if stale.isEmpty && waiting.isEmpty { return }
        var notes: [String] = []
        try db.transaction {
            var sets = Set<String>()
            for r in stale {
                let st = r.str("result") == "applied" ? "applied" : "failed"
                try db.exec("UPDATE contact_changes SET status = ? WHERE id = ?", [.text(st), .text(r.str("id"))])
                sets.insert(r.str("sid"))
            }
            let cache = ContactEvalCache()
            var groups: [String: (set: String, reason: String, ids: [String])] = [:]
            var order: [String] = []
            for w in waiting {
                guard let row = try loadChange(w.str("id")) else { continue }
                let (covered, reasons) = try contactCovered(row, pin: pin, now: now, cache: cache)
                if covered { continue }
                let reason = reasons.first ?? "no live approval covers this change"
                let key = row.setId + "|" + reason
                if groups[key] == nil { groups[key] = (row.setId, reason, []); order.append(key) }
                groups[key]!.ids.append(row.id)
            }
            for key in order {
                let g = groups[key]!
                var moved = 0
                for id in g.ids {
                    moved += try db.exec("UPDATE contact_changes SET status = 'review', error = ? WHERE id = ? AND status = 'approved'", [.text(g.reason), .text(id)])
                }
                if moved == 0 { continue }
                try audit("contact_changes_returned_to_review", target: g.set, ["reason": g.reason, "count": moved, "change_ids": Array(g.ids.prefix(200))])
                notes.append("\(moved) contact change(s) in set \(g.set.prefix(8)) returned to review, to be approved again: \(g.reason)")
                sets.insert(g.set)
            }
            for s in sets { try refreshContactSet(s, now: ts) }
        }
        if !notes.isEmpty { lastError = notes.joined(separator: " | ") }
    }

    /// Moves anything that claims to apply without approval back to review. Defence in depth: the server never makes such a row, but in
    /// simple mode a same-user process can write the database. Matches an unconsumed change that is `auto_queued` or has
    /// `requires_approval = 0` (also when `approved`: a signature cannot vouch for a row that says no approval is needed). Writes only
    /// to the database, never to Contacts, so it runs even with the kill switch on. Returns how many it moved.
    @discardableResult
    func holdUnapprovedContacts(now: Date) throws -> Int {
        let rows = try db.query("""
            SELECT c.id AS id, c.set_id AS sid FROM contact_changes c
            WHERE (c.status = 'auto_queued' OR c.requires_approval = 0) AND c.status IN ('pending','auto_queued','review','approved')
              AND NOT EXISTS (SELECT 1 FROM contact_applies a WHERE a.change_id = c.id)
            ORDER BY c.created_at, c.position, c.id
            """)
        if rows.isEmpty { return 0 }
        let ts = Time.iso(now)
        try db.transaction {
            var sets = Set<String>()
            for r in rows {
                try db.exec("""
                    UPDATE contact_changes SET status = 'review', requires_approval = 1, error = NULL,
                      note = CASE WHEN note = '' THEN 'new contact' ELSE note END WHERE id = ?
                    """, [.text(r.str("id"))])
                try audit("contact_sent_to_review", target: r.str("id"), ["note": "queued without approval; contacts are never added automatically"])
                sets.insert(r.str("sid"))
            }
            for s in sets { try refreshContactSet(s, now: ts) }
        }
        contactsNote = "\(rows.count) contact change(s) were queued without approval and were moved to review; contacts are only added after Touch ID approval"
        return rows.count
    }

    // MARK: the contacts pass of one tick

    /// Approved changes only. Returns true when a LIVE change was written (the caller then re-exports contacts).
    /// Contacts work waiting without Contacts access holds with a note in exec_status.last_error; nothing here ever prompts.
    func applyContacts(now: Date, pin: PinFile) throws -> Bool {
        let approvedN = try db.one("""
            SELECT COUNT(*) AS n FROM contact_changes c JOIN contact_change_sets s ON s.id = c.set_id
            WHERE c.status = 'approved' AND s.status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM contact_applies a WHERE a.change_id = c.id)
            """)?.i("n") ?? 0
        if approvedN == 0 { return false }
        guard contacts.accessGranted else {
            contactsNote = "Contacts access has not been granted to outbox-exec: \(approvedN) contact change(s) are waiting. Run `outbox-exec contacts-export` on the Mac and answer the macOS prompt."
            return false
        }
        return try processApprovedContacts(now: now, pin: pin)
    }

    func insertApply(changeId: String, approvalId: String?, lane: String) throws -> String {
        let applyId = newId()
        try db.exec("INSERT INTO contact_applies(id, change_id, approval_id, transport, started_at) VALUES(?, ?, ?, ?, ?)",
                    [.text(applyId), .text(changeId), .opt(approvalId), .text(lane), .text(Time.iso(clock()))])
        try audit("contact_apply_start", target: changeId, ["apply_id": applyId, "approval_id": approvalId ?? "", "transport": lane])
        return applyId
    }

    // MARK: approved changes

    func processApprovedContacts(now: Date, pin: PinFile) throws -> Bool {
        let ids = try db.query("""
            SELECT c.id AS id FROM contact_changes c JOIN contact_change_sets s ON s.id = c.set_id
            WHERE c.status = 'approved' AND s.status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM contact_applies a WHERE a.change_id = c.id)
            ORDER BY c.created_at, c.position, c.id
            """)
        var live = false
        for r in ids {
            if try killSwitchOn() { break }
            switch try claimApproved(r.str("id"), pin: pin, now: now) {
            case .killed: return live
            case .skipped: continue
            case .claimed(let applyId, let row, let lane, let approvalId):
                let ok: Bool
                do {
                    switch try ContactPayloadParser.parse(kind: row.kind, json: row.payloadJson, targetMacosId: row.targetMacosId) {
                    case .create(let p):
                        // approved creates still run the live lookup: a hit means the person is already in Contacts, so the create
                        // fails (nothing written, no duplicate card); see the header comment
                        let hits = try readContacts { try contacts.findByHandles(phones: p.phones.map { $0.value }, emails: p.emails.map { $0.value }) }
                        if !hits.isEmpty { try finishContactApply(applyId: applyId, row: row, lane: lane, ok: false, error: "already in Contacts"); ok = false }
                        else { ok = try writeCreate(row, p, lane: lane, applyId: applyId, approvalId: approvalId) }
                    case .update(let p): ok = try performUpdate(row, p, lane: lane, applyId: applyId, approvalId: approvalId)
                    case .undo(let p): ok = try performUndo(row, p, lane: lane, applyId: applyId, approvalId: approvalId)
                    }
                } catch let rej as Rejection {
                    try finishContactApply(applyId: applyId, row: row, lane: lane, ok: false, error: "invalid payload: \(rej.reason)")
                    ok = false
                } catch let e as ContactReadError {
                    // a read failed before anything was written: give the claim back, it is tried again next pass.
                    // (Any other error, such as a failed database write after the save, must NOT release: the unfinished
                    // apply row then becomes `unknown` at the next start.)
                    try releaseContactApply(applyId: applyId, row: row, reason: e.message)
                    contactsNote = "contact change \(row.id.prefix(8)) not applied yet: \(e.message)"
                    ok = false
                }
                if ok && lane == "live" { live = true }
            }
        }
        return live
    }

    /// One write transaction: kill switch, the change is still `approved` and unconsumed, a live approval's signed item still matches
    /// the CURRENT row (verified again here, not trusted from an earlier pass), then the contact_applies row.
    func claimApproved(_ id: String, pin: PinFile, now: Date) throws -> ContactClaim {
        try db.transaction {
            if try killSwitchOn() { return .killed }
            guard let row = try loadChange(id), row.status == "approved" else { return .skipped("not approved") }
            // a row that says no approval is needed is never applied, signed or not (holdUnapprovedContacts moves it to review)
            guard row.requiresApproval else { return .skipped("row does not require approval; not applied") }
            if try isContactConsumed(id) { return .skipped("already consumed") }
            let approvals = try db.query("SELECT * FROM contact_approvals WHERE set_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC", [.text(row.setId)])
            for arow in approvals {
                let rec = ContactApprovalRecord(row: arow)
                guard let ok = try? Verifier.verifyContactApproval(rec, pin: pin, now: now),
                      let item = ok.items.first(where: { $0.changeId == id }),
                      Verifier.checkContactItem(item, row: row.raw, setId: ok.setId, consumed: false) == nil else { continue }
                let lane = Verifier.contactsLane(signedTransport: ok.transport, pin: pin)
                let applyId = try insertApply(changeId: id, approvalId: rec.id, lane: lane)
                try db.exec("UPDATE contact_change_sets SET status = 'applying', updated_at = ? WHERE id = ? AND status = 'approved'", [.text(Time.iso(clock())), .text(row.setId)])
                return .claimed(applyId: applyId, row: row, lane: lane, approvalId: rec.id)
            }
            return .skipped("no live approval covers it")
        }
    }

    // MARK: stop checks and bookkeeping

    /// Why this apply must not write right now, or nil: kill switch on, the set was cancelled, the approval it came from was revoked
    /// or has expired since the claim, or live is no longer allowed. Checked again right before every write.
    func contactStopReason(lane: String, row: ContactChangeRow, approvalId: String?) throws -> String? {
        beforeContactWriteHook?()
        if try killSwitchOn() { return "kill switch is on" }
        if let st = try db.one("SELECT status FROM contact_change_sets WHERE id = ?", [.text(row.setId)])?.str("status"), st == "cancelled" { return "the change set was cancelled" }
        if let aid = approvalId {
            guard let a = try db.one("SELECT revoked_at, not_after FROM contact_approvals WHERE id = ?", [.text(aid)]) else { return "the approval no longer exists" }
            if !a.isNull("revoked_at") { return "the approval was revoked" }
            guard let exp = Time.parse(a.str("not_after")), clock() < exp else { return "the approval has expired" }
        }
        if lane == "live" {
            do {
                let p = try loadPin()
                guard p.trustedForLive, p.version >= 2, p.policy.contactsLiveAllowed else { return "the pin policy no longer allows live contact changes (\(p.mode.rawValue) mode)" }
            } catch { return "the pin file is no longer usable: \(error)" }
        }
        return nil
    }

    /// Gives a claim back without consuming the change: the unfinished apply row is deleted and the change keeps its status.
    func releaseContactApply(applyId: String, row: ContactChangeRow, reason: String) throws {
        try db.transaction {
            try db.exec("DELETE FROM contact_applies WHERE id = ? AND finished_at IS NULL", [.text(applyId)])
            try db.exec("UPDATE contact_change_sets SET status = 'approved' WHERE id = ? AND status = 'applying'", [.text(row.setId)])
            try audit("contact_apply_released", target: row.id, ["apply_id": applyId, "reason": reason])
        }
    }

    /// Finishes an apply in one transaction (retried once; if that also fails the apply row stays unfinished and becomes `unknown`
    /// at the next start). `undone` names the original change an undo has just reverted.
    func finishContactApply(applyId: String, row: ContactChangeRow, lane: String, ok: Bool, error: String?, macosId: String? = nil,
                            beforeVcard: String? = nil, afterFingerprint: String? = nil, note: String? = nil, undone: ContactChangeRow? = nil) throws {
        func go() throws {
            try db.transaction {
                let ts = Time.iso(clock())
                try db.exec("UPDATE contact_applies SET finished_at = ?, result = ?, error = ?, macos_id = ? WHERE id = ?",
                            [.text(ts), .text(ok ? "applied" : "failed"), .opt(error), .opt(macosId), .text(applyId)])
                if ok {
                    try db.exec("""
                        UPDATE contact_changes SET status = 'applied', transport = ?, result_macos_id = ?, before_vcard = COALESCE(?, before_vcard),
                          after_fingerprint = ?, applied_at = ?, error = NULL, note = CASE WHEN ? = '' THEN note ELSE ? END WHERE id = ?
                        """, [.text(lane), .opt(macosId), .opt(beforeVcard), .opt(afterFingerprint), .text(ts), .text(note ?? ""), .text(note ?? ""), .text(row.id)])
                } else {
                    try db.exec("UPDATE contact_changes SET status = 'failed', transport = ?, error = ? WHERE id = ?", [.text(lane), .text(error ?? "failed"), .text(row.id)])
                }
                if let o = undone {
                    try db.exec("UPDATE contact_changes SET status = 'undone' WHERE id = ? AND status = 'applied'", [.text(o.id)])
                    try refreshContactSet(o.setId, now: ts)
                }
                try audit(ok ? "contact_applied" : "contact_failed", target: row.id, ["apply_id": applyId, "kind": row.kind, "transport": lane, "error": error ?? ""])
                try refreshContactSet(row.setId, now: ts)
            }
        }
        do { try go() } catch {
            Thread.sleep(forTimeInterval: 1)
            try go()
        }
    }

    // MARK: writes

    /// Create (always under an approval; the caller has already run the live duplicate lookup). Returns true when it was written (the caller counts live ones for the export).
    func writeCreate(_ row: ContactChangeRow, _ p: CreatePayload, lane: String, applyId: String, approvalId: String?) throws -> Bool {
        if let why = try contactStopReason(lane: lane, row: row, approvalId: approvalId) {
            try releaseContactApply(applyId: applyId, row: row, reason: why)
            contactsNote = "contact change \(row.id.prefix(8)) stopped: \(why)"
            return false
        }
        let n = p.newContact()
        let ctx = WriteContext(changeId: row.id, approvalId: approvalId, kind: "create", targetMacosId: nil, payload: row.payloadObject)
        let id: String
        do { id = try contactsWriter(lane).create(n, ctx) } catch {
            try finishContactApply(applyId: applyId, row: row, lane: lane, ok: false, error: "\(error)")
            return false
        }
        var fp = ContactMath.fingerprint(ContactMath.card(for: n, identifier: id))
        if lane == "live", let c = (try? contacts.card(identifier: id)) ?? nil { fp = ContactMath.fingerprint(c) }
        try finishContactApply(applyId: applyId, row: row, lane: lane, ok: true, error: nil, macosId: id, afterFingerprint: fp)
        return true
    }

    func performUpdate(_ row: ContactChangeRow, _ p: UpdatePayload, lane: String, applyId: String, approvalId: String?) throws -> Bool {
        guard let target = row.targetMacosId else { throw Rejection("an update needs a target contact") }
        guard let card = try readContacts({ try contacts.card(identifier: target) }) else {
            try finishContactApply(applyId: applyId, row: row, lane: lane, ok: false, error: "contact not found in Contacts")
            return false
        }
        // snapshot from the card just read (names, handles, groups; no note key, so no entitlement is needed)
        let before = ContactSnapshot.json(card)
        let edit = p.edit()
        let predicted = edit.applying(to: card)
        if predicted == card {
            // someone already made this change: nothing to write, and nothing to undo either
            try finishContactApply(applyId: applyId, row: row, lane: lane, ok: true, error: nil, macosId: target, beforeVcard: before,
                                   afterFingerprint: ContactMath.fingerprint(card), note: "already up to date, nothing written")
            return false
        }
        if let why = try contactStopReason(lane: lane, row: row, approvalId: approvalId) {
            try releaseContactApply(applyId: applyId, row: row, reason: why)
            contactsNote = "contact change \(row.id.prefix(8)) stopped: \(why)"
            return false
        }
        let ctx = WriteContext(changeId: row.id, approvalId: approvalId, kind: "update", targetMacosId: target, payload: row.payloadObject)
        do { try contactsWriter(lane).update(identifier: target, edit: edit, ctx) } catch {
            try finishContactApply(applyId: applyId, row: row, lane: lane, ok: false, error: "\(error)")
            return false
        }
        var fp = ContactMath.fingerprint(predicted)
        if lane == "live", let c = (try? contacts.card(identifier: target)) ?? nil { fp = ContactMath.fingerprint(c) }
        try finishContactApply(applyId: applyId, row: row, lane: lane, ok: true, error: nil, macosId: target, beforeVcard: before, afterFingerprint: fp)
        return true
    }

    func performUndo(_ row: ContactChangeRow, _ p: UndoPayload, lane signedLane: String, applyId: String, approvalId: String?) throws -> Bool {
        func fail(_ why: String) throws -> Bool {
            try finishContactApply(applyId: applyId, row: row, lane: signedLane, ok: false, error: why)
            return false
        }
        guard let target = row.targetMacosId else { return try fail("an undo needs a target contact") }
        if let col = row.undoOf, col != p.undoOf { return try fail("undo_of column does not match the signed payload") }
        guard let orig = try loadChange(p.undoOf) else { return try fail("the change to undo does not exist") }
        guard orig.status == "applied" else { return try fail("the change to undo is not applied (it is \(orig.status))") }
        guard orig.kind == p.undoKind else { return try fail("the change to undo is a \(orig.kind), not a \(p.undoKind)") }
        guard let oa = try db.one("SELECT transport, result FROM contact_applies WHERE change_id = ?", [.text(orig.id)]), oa.str("result") == "applied" else {
            return try fail("the change to undo was not applied by the executor")
        }
        let expectedTarget = p.undoKind == "create" ? orig.resultMacosId : orig.targetMacosId
        guard let expectedTarget, expectedTarget == target else { return try fail("the signed target is not the contact that change touched") }
        guard let recorded = orig.afterFingerprint, recorded == p.afterFingerprint else { return try fail("after_fingerprint differs from the one recorded when the change was applied") }
        var before: ContactCard?, beforeGroups: [String]?
        if p.undoKind == "update" {
            guard let bv = orig.beforeVcard, Hex.sha256Hex(bv) == p.beforeVcardSha256 else { return try fail("the before snapshot differs from the signed hash") }
            if (oa.str("transport")) == "live" {
                guard let snap = ContactSnapshot.parse(bv) else { return try fail("could not read the before snapshot") }
                before = snap
                beforeGroups = snap.groups
            }
        }
        // undo of a dry change is applied dry, whatever the manifest says; undo of a live change needs the live lane (it would
        // otherwise be marked undone without touching the contact)
        let origLane = oa.str("transport")
        let lane: String
        if origLane != "live" { lane = "dry" }
        else if signedLane == "live" { lane = "live" }
        else { return try fail("undoing a live change needs the live lane: the manifest asked for dry, or the pin policy does not allow live contact changes") }

        let ctx = WriteContext(changeId: row.id, approvalId: approvalId, kind: "undo", targetMacosId: target, payload: row.payloadObject)
        if lane == "dry" {
            if let why = try contactStopReason(lane: "dry", row: row, approvalId: approvalId) {
                try releaseContactApply(applyId: applyId, row: row, reason: why)
                contactsNote = "contact change \(row.id.prefix(8)) stopped: \(why)"
                return false
            }
            do {
                if p.undoKind == "create" { try contactsWriter("dry").delete(identifier: target, ctx) }
                else { try contactsWriter("dry").update(identifier: target, edit: ContactEdit(), ctx) }
            } catch { return try fail("\(error)") }
            try finishContactApply(applyId: applyId, row: row, lane: "dry", ok: true, error: nil, macosId: target, undone: orig)
            return false
        }

        guard let card = try readContacts({ try contacts.card(identifier: target) }) else { return try fail("the contact no longer exists in Contacts") }
        guard ContactMath.fingerprint(card) == p.afterFingerprint else { return try fail("the contact was edited since the change (fingerprint mismatch); not undone") }
        if p.undoKind == "create", try readContacts({ try contacts.hasExtraDetails(identifier: target) }) {
            return try fail("the card has details added since; delete it by hand if you want")
        }
        let snapshot = ContactSnapshot.json(card)
        if let why = try contactStopReason(lane: "live", row: row, approvalId: approvalId) {
            try releaseContactApply(applyId: applyId, row: row, reason: why)
            contactsNote = "contact change \(row.id.prefix(8)) stopped: \(why)"
            return false
        }
        if p.undoKind == "create" {
            do { try contactsWriter("live").delete(identifier: target, ctx) } catch { return try fail("\(error)") }
            try finishContactApply(applyId: applyId, row: row, lane: "live", ok: true, error: nil, macosId: target, beforeVcard: snapshot, undone: orig)
            return true
        }
        guard let b = before, case .update(let op) = try ContactPayloadParser.parse(kind: "update", json: orig.payloadJson, targetMacosId: orig.targetMacosId) else {
            return try fail("could not read the original change or its snapshot")
        }
        var e = ContactEdit()
        if op.set["given_name"] != nil { e.given = b.given }
        if op.set["family_name"] != nil { e.family = b.family }
        if op.set["nickname"] != nil { e.nickname = b.nickname }
        if op.set["org"] != nil { e.org = b.org }
        let hadPhones = Set(b.phones.map { ContactMath.normalizedPhone($0.value) })
        let hadEmails = Set(b.emails.map { $0.value.lowercased() })
        e.removePhones = op.addPhones.map { ContactMath.normalizedPhone($0.value) }.filter { !hadPhones.contains($0) }
        e.removeEmails = op.addEmails.map { $0.value.lowercased() }.filter { !hadEmails.contains($0) }
        if let bg = beforeGroups { e.removeGroups = op.addGroups.filter { !bg.contains($0) } }
        let predicted = e.applying(to: card)
        if predicted != card {
            do { try contactsWriter("live").update(identifier: target, edit: e, ctx) } catch { return try fail("\(error)") }
        }
        var fp = ContactMath.fingerprint(predicted)
        if let c = (try? contacts.card(identifier: target)) ?? nil { fp = ContactMath.fingerprint(c) }
        try finishContactApply(applyId: applyId, row: row, lane: "live", ok: true, error: nil, macosId: target, beforeVcard: snapshot, afterFingerprint: fp, undone: orig)
        return true
    }
}

/// Per-pass memo so each contacts approval's signature is verified once.
final class ContactEvalCache {
    var verdicts: [String: Result<VerifiedContactApproval, Rejection>] = [:]
}
