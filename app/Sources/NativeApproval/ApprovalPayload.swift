import Foundation
import CryptoKit

/// Fixed Touch ID reason text. macOS renders "“<app>” is trying to <reason>." Counts and fixed
/// words only: never a name, a number, a message body or a label, because those are agent-controlled or private.
public enum ApprovalReason {
    static func plural(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? one : many }

    public static func send(live: Bool, messages n: Int, people p: Int) -> String {
        live ? "send \(n) \(plural(n, "message", "messages")) to \(p) \(plural(p, "person", "people"))"
             : "approve a dry run of \(n) \(plural(n, "message", "messages")) (nothing is sent)"
    }
    public static func contacts(live: Bool, changes n: Int) -> String {
        live ? "change \(n) \(plural(n, "contact", "contacts"))" : "approve a dry run of \(n) contact \(plural(n, "change", "changes"))"
    }
    public static let enroll = "set up Touch ID approval for Agent Outbox"
    /// reauth actions the server knows: mode_live, policy_live, passkey_add, native_key_add, browser_link.
    public static func reauth(action: String) -> String? {
        switch action {
        case "mode_live": return "turn on live sending"
        case "policy_live": return "allow live sending"
        case "passkey_add": return "add a passkey"
        case "native_key_add": return "add an approval key"
        case "browser_link": return "open the dashboard in your browser"
        default: return nil
        }
    }
}

/// Why the app refuses to show or sign what the server sent.
public enum PayloadError: Error, LocalizedError, Equatable {
    case notJSON
    case wrong(String)
    /// A body or payload that doesn't hash to what the manifest says. The owner-facing text is fixed.
    case mismatch(String)

    public var errorDescription: String? {
        switch self {
        case .notJSON: return "The server sent an approval the app can't read."
        case .wrong(let m): return "The server sent an approval that doesn't match what you asked for: \(m)."
        case .mismatch: return "The server sent a message that doesn't match."
        }
    }
}

/// The approval as the owner sees it, parsed from the EXACT `manifest_bytes` string the server returned from `approve/options`. The same
/// bytes (`manifestBytes`) are hashed into the signed message, so the sheet and the signature can't disagree: a lying server can't make
/// the app show one thing and sign another. Nothing is re-serialised anywhere.
public struct ApprovalPayload: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case send, contacts }

    public struct ContactProposal: Sendable, Equatable {
        public var given: String, family: String, org: String
        public var phones: [String], emails: [String]
        /// "Sam Lee, Acme, +1…": one line for the sheet.
        public var line: String {
            let name = [given, family].filter { !$0.isEmpty }.joined(separator: " ")
            return ([name, org] + phones + emails).filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }
    public struct Recipient: Sendable, Equatable, Identifiable {
        public var id: String { draftId }
        public let draftId: String, name: String, to: String, service: String, body: String
        public let createContact: ContactProposal?
    }
    public struct ContactChange: Sendable, Equatable, Identifiable {
        public var id: String { changeId }
        public let changeId: String, kind: String, target: String?
        /// The exact payload text the manifest's hash covers (parsed for display only).
        public let payloadJSON: String
        public let lines: [String]
    }

    public let kind: Kind
    public let approvalId: String
    /// The batch (send) or set (contacts) this approval is for.
    public let scopeId: String
    public let transport: String
    public let notAfter: Date
    public let recipients: [Recipient]
    public let changes: [ContactChange]
    /// The exact manifest bytes. Hashed into the signed message; never re-encoded.
    public let manifestBytes: Data

    public var id: String { approvalId }
    public var isLive: Bool { transport == "live" }
    /// The tag of the signed message: "send" or "contacts".
    public var tag: String { kind.rawValue }
    /// n: messages or contact changes in this approval.
    public var itemCount: Int { kind == .send ? recipients.count : changes.count }
    /// p: distinct recipients (send only).
    public var peopleCount: Int { Set(recipients.map(\.to)).count }
    /// The Touch ID reason: fixed templates, counts only.
    public var reasonText: String {
        kind == .send ? ApprovalReason.send(live: isLive, messages: itemCount, people: peopleCount) : ApprovalReason.contacts(live: isLive, changes: itemCount)
    }
    /// The message the key signs: M(tag, sha256(manifestBytes)).
    public var signedMessage: Data { SESig.manifestMessage(tag: tag, manifestBytes: manifestBytes) }

    // MARK: parsing

    private static func object(_ s: String) throws -> [String: Any] {
        guard let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d), let dict = o as? [String: Any] else { throw PayloadError.notJSON }
        return dict
    }
    private static func int(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.intValue
    }
    private static func str(_ v: Any?) -> String? { v as? String }
    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
    static func sha256Hex(_ s: String) -> String { hex(Data(SHA256.hash(data: Data(s.utf8)))) }
    static func date(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
    private static func isHex64(_ s: String) -> Bool { s.count == 64 && s.allSatisfy { $0.isHexDigit } }

    /// Parses and checks a SEND manifest: v == 2, no `kind`, `batch_id` == the batch asked for, every draft id among the ids that were sent,
    /// `not_after` in the future, transport dry|live, and each body (from the response's `drafts[]`) hashing to the item's `body_sha256`.
    public static func send(manifestBytes: String, batchId: String, requestedDraftIds: [String], bodies: [String: String], now: Date = Date()) throws -> ApprovalPayload {
        let m = try object(manifestBytes)
        guard int(m["v"]) == 2 else { throw PayloadError.wrong("manifest version") }
        guard m["kind"] == nil else { throw PayloadError.wrong("this is not a message approval") }
        guard str(m["batch_id"]) == batchId else { throw PayloadError.wrong("batch") }
        guard let approvalId = str(m["approval_id"]), !approvalId.isEmpty else { throw PayloadError.wrong("approval id") }
        guard let transport = str(m["transport"]), transport == "dry" || transport == "live" else { throw PayloadError.wrong("transport") }
        guard let na = str(m["not_after"]), let notAfter = date(na), notAfter > now else { throw PayloadError.wrong("the approval has already expired") }
        guard let raw = m["items"] as? [Any], !raw.isEmpty else { throw PayloadError.wrong("no messages") }
        let allowed = Set(requestedDraftIds)
        var seen = Set<String>()
        var out: [Recipient] = []
        for any in raw {
            guard let o = any as? [String: Any], let did = str(o["draft_id"]), !did.isEmpty else { throw PayloadError.wrong("a message has no id") }
            guard allowed.contains(did) else { throw PayloadError.wrong("a message you didn't pick") }
            guard seen.insert(did).inserted else { throw PayloadError.wrong("a message is listed twice") }
            guard let to = str(o["to"]), !to.isEmpty else { throw PayloadError.wrong("a message has no recipient") }
            guard let svc = str(o["service"]), ["iMessage", "SMS", "auto"].contains(svc) else { throw PayloadError.wrong("a message has an unknown service") }
            guard let h = str(o["body_sha256"]), isHex64(h) else { throw PayloadError.wrong("a message has no body hash") }
            guard let body = bodies[did], sha256Hex(body) == h.lowercased() else { throw PayloadError.mismatch(did) }
            var proposal: ContactProposal?
            if let cc = o["create_contact"], !(cc is NSNull) {
                guard let co = cc as? [String: Any] else { throw PayloadError.wrong("a new contact is malformed") }
                proposal = ContactProposal(
                    given: str(co["given_name"]) ?? "", family: str(co["family_name"]) ?? "", org: str(co["org"]) ?? "",
                    phones: ((co["phones"] as? [[String: Any]]) ?? []).compactMap { str($0["e164"]) },
                    emails: ((co["emails"] as? [[String: Any]]) ?? []).compactMap { str($0["email"]) })
            }
            out.append(Recipient(draftId: did, name: str(o["name"]) ?? "", to: to, service: svc, body: body, createContact: proposal))
        }
        return ApprovalPayload(kind: .send, approvalId: approvalId, scopeId: batchId, transport: transport, notAfter: notAfter, recipients: out, changes: [],
                               manifestBytes: Data(manifestBytes.utf8))
    }

    /// Parses and checks a CONTACTS manifest: kind == "contacts", v == 1, `set_id` == the set asked for, every change id among those sent,
    /// not expired, and each payload (the response's `payloads`) hashing to its `payload_sha256`.
    public static func contacts(manifestBytes: String, setId: String, requestedChangeIds: [String], payloads: [String: String], now: Date = Date()) throws -> ApprovalPayload {
        let m = try object(manifestBytes)
        guard str(m["kind"]) == "contacts" else { throw PayloadError.wrong("this is not a contacts approval") }
        guard int(m["v"]) == 1 else { throw PayloadError.wrong("manifest version") }
        guard str(m["set_id"]) == setId else { throw PayloadError.wrong("set") }
        guard let approvalId = str(m["approval_id"]), !approvalId.isEmpty else { throw PayloadError.wrong("approval id") }
        guard let transport = str(m["transport"]), transport == "dry" || transport == "live" else { throw PayloadError.wrong("transport") }
        guard let na = str(m["not_after"]), let notAfter = date(na), notAfter > now else { throw PayloadError.wrong("the approval has already expired") }
        guard let raw = m["contact_items"] as? [Any], !raw.isEmpty else { throw PayloadError.wrong("no changes") }
        let allowed = Set(requestedChangeIds)
        var seen = Set<String>()
        var out: [ContactChange] = []
        for any in raw {
            guard let o = any as? [String: Any], let cid = str(o["change_id"]), !cid.isEmpty else { throw PayloadError.wrong("a change has no id") }
            guard allowed.contains(cid) else { throw PayloadError.wrong("a change you didn't pick") }
            guard seen.insert(cid).inserted else { throw PayloadError.wrong("a change is listed twice") }
            guard let kind = str(o["kind"]), ["create", "update", "undo"].contains(kind) else { throw PayloadError.wrong("a change has an unknown kind") }
            guard let h = str(o["payload_sha256"]), isHex64(h) else { throw PayloadError.wrong("a change has no payload hash") }
            guard let payload = payloads[cid], sha256Hex(payload) == h.lowercased() else { throw PayloadError.mismatch(cid) }
            let target: String? = (o["target_macos_id"] as? String)
            out.append(ContactChange(changeId: cid, kind: kind, target: target, payloadJSON: payload, lines: displayLines(payload)))
        }
        return ApprovalPayload(kind: .contacts, approvalId: approvalId, scopeId: setId, transport: transport, notAfter: notAfter, recipients: [], changes: out,
                               manifestBytes: Data(manifestBytes.utf8))
    }

    /// A readable rendering of a change payload (display only: the hash check above is what ties it to the signature).
    static func displayLines(_ json: String) -> [String] {
        guard let d = json.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) else { return [json] }
        func render(_ v: Any) -> String {
            switch v {
            case let s as String: return s
            case let n as NSNumber: return n.stringValue
            case let a as [Any]: return a.map(render).joined(separator: ", ")
            case let d as [String: Any]: return d.keys.sorted().map { "\($0) \(render(d[$0]!))" }.joined(separator: "; ")
            default: return "\(v)"
            }
        }
        guard let dict = o as? [String: Any] else { return [render(o)] }
        return dict.keys.sorted().map { "\($0.replacingOccurrences(of: "_", with: " ")): \(render(dict[$0]!))" }
    }
}
