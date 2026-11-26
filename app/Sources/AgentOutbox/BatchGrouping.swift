import Foundation

// Pure helpers of the batch review screen, ported from the old browser page (web/src/pages/Batch.tsx, deleted in the app-only change).
// Kept free of SwiftUI so `--selfcheck` can test them.

/// Warnings that hold a message back until "include anyway" (mirrors HELD_WARNINGS / UNSENDABLE_WARNINGS in src/owner-api/approval.ts).
let heldCodes: Set<String> = ["unresolved_var", "duplicate_recipient"]
let unsendableCodes: Set<String> = ["empty_body", "invalid_handle"]

/// Plain-words label per warning code (the web's WARNING_LABEL).
let warningLabel: [String: String] = [
    "unresolved_var": "Unfilled field", "empty_var": "Empty field", "duplicate_recipient": "Duplicate", "pending_elsewhere": "Pending elsewhere",
    "recently_messaged": "Messaged recently", "invalid_handle": "Invalid number", "non_mobile": "Not a mobile", "too_long": "Very long",
    "identical_to_template": "Same as template", "empty_body": "Empty", "new_contact": "New contact", "ambiguous_contact": "Ambiguous contact",
    "link_in_first_message": "Has a link", "group_contact_changed": "Contact changed",
]
func labelFor(warning code: String) -> String { warningLabel[code] ?? code }

/// "+15551234567" -> "+1 (555) 123-4567"; anything else unchanged.
func prettyHandle(_ h: String) -> String {
    let d = Array(h)
    guard d.count == 12, d[0] == "+", d[1] == "1", d[2...].allSatisfy({ $0.isASCII && $0.isNumber }) else { return h }
    return "+1 (\(String(d[2...4]))) \(String(d[5...7]))-\(String(d[8...11]))"
}

/// A warning of one draft, as shown: `new_contact` is its own chip, not a warning.
func shownWarnings(_ d: J) -> [(code: String, message: String)] {
    d.arr("warnings").map { (code: $0.str("code"), message: $0.str("message")) }.filter { $0.code != "new_contact" }
}
func isHeldDraft(_ d: J) -> Bool { d.arr("warnings").contains { heldCodes.contains($0.str("code")) } }
func isUnsendableDraft(_ d: J) -> Bool { d.arr("warnings").contains { unsendableCodes.contains($0.str("code")) } }
func isCovered(_ d: J) -> Bool { !(d["covered_by"] == nil || d["covered_by"] is NSNull) }
/// Waiting for approval and not inside a live approval. (An `approved` draft whose approval ended has covered_by null: approvable again.)
func wantsApproval(_ d: J) -> Bool { !isCovered(d) && ["review", "failed", "approved"].contains(d.str("status")) }
func isApprovable(_ d: J) -> Bool { wantsApproval(d) && !d.str("body").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isUnsendableDraft(d) }
func isTogglable(_ d: J) -> Bool { ["draft", "review", "failed", "skipped"].contains(d.str("status")) }

/// Consecutive messages (by position) to the same handle: one recipient, one box.
struct DraftGroup: Identifiable {
    let id: String
    let handle: String
    var name: String
    var drafts: [J]
}

func groupDrafts(_ ds: [J]) -> [DraftGroup] {
    let ordered = ds.enumerated().sorted { a, b in
        let pa = a.element.int("position"), pb = b.element.int("position")
        return pa != pb ? pa < pb : a.offset < b.offset
    }.map { $0.element }
    var out: [DraftGroup] = []
    for d in ordered {
        if let last = out.last, last.handle == d.str("handle") {
            out[out.count - 1].drafts.append(d)
            if out[out.count - 1].name.isEmpty { out[out.count - 1].name = d.str("recipient_name") }
        } else {
            out.append(DraftGroup(id: d.id, handle: d.str("handle"), name: d.str("recipient_name"), drafts: [d]))
        }
    }
    return out
}

func peopleCount(_ ds: [J]) -> Int { Set(ds.map { $0.str("handle") }).count }

/// Warnings of a group merged by code, messages joined (first-seen order): the chips and list in the group header.
func mergedWarnings(_ ds: [J]) -> [(code: String, messages: [String])] {
    var order: [String] = [], msgs: [String: [String]] = [:]
    for d in ds { for w in shownWarnings(d) {
        if msgs[w.code] == nil { order.append(w.code); msgs[w.code] = [] }
        if !msgs[w.code]!.contains(w.message) { msgs[w.code]!.append(w.message) }
    } }
    return order.map { (code: $0, messages: msgs[$0]!) }
}

enum BatchFilter: String, CaseIterable, Identifiable {
    case all, warnings, new, skipped
    var id: String { rawValue }
    var title: String { switch self { case .all: return "All"; case .warnings: return "Warnings"; case .new: return "New contacts"; case .skipped: return "Skipped" } }
    func matches(_ d: J) -> Bool {
        switch self {
        case .all: return true
        case .warnings: return !shownWarnings(d).isEmpty
        case .new: return d["proposed_contact"] is J
        case .skipped: return d.str("status") == "skipped"
        }
    }
}
