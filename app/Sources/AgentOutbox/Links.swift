import Foundation

// MARK: - Deep links (agent-outbox://...)

/// `agent-outbox://inbox`, `batch/<id>`, `contacts/changes/<id>`, `imports/<id>`, `groups/<id>`. Navigation only: a link never opens a
/// confirm sheet, signs, enrols or changes a setting.
enum DeepLink: Equatable {
    case inbox
    case batch(String), contactChanges(String), importRef(String), group(String)

    static func parse(_ url: URL) -> DeepLink? {
        guard url.scheme?.lowercased() == "agent-outbox" else { return nil }
        var parts: [String] = []
        if let h = url.host, !h.isEmpty { parts.append(h.lowercased()) }
        parts += url.path.split(separator: "/").map(String.init)
        func ok(_ s: String) -> Bool { !s.isEmpty && s.count <= 100 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") } }
        if parts == ["inbox"] { return .inbox }
        if parts.count == 2, ok(parts[1]) {
            switch parts[0] {
            case "batch": return .batch(parts[1])
            case "imports": return .importRef(parts[1])
            case "groups": return .group(parts[1])
            default: return nil
            }
        }
        if parts.count == 3, parts[0] == "contacts", parts[1] == "changes", ok(parts[2]) { return .contactChanges(parts[2]) }
        return nil
    }
}

// MARK: - What the server's status says about setup and the sender, in plain words

/// `GET /api/status` `setup`: {done, proof_available: "recovery_token" | "setup_token" | "se_reauth" | null, recovery_expires_at}.
struct SetupInfo: Equatable {
    var done = false
    var proof: String?
    var recoveryExpires: Date?
    init() {}
    init(_ status: J) {
        let s = status.obj("setup")
        done = s.bool("done")
        proof = s["proof_available"] as? String
        recoveryExpires = (s["recovery_expires_at"] as? String).flatMap(parseISO)
    }
    var recoveryOpen: Bool { proof == "recovery_token" }
    var recoveryOpenedAt: Date? { recoveryExpires?.addingTimeInterval(-30 * 60) }
}

/// The sender (executor) holds approved messages for reasons it reports as short technical sentences; these are the words for the owner.
enum HoldReason {
    static func plain(_ raw: String) -> String? {
        let t = raw.lowercased()
        if t.isEmpty { return nil }
        let oldPin = t.contains("pin version") && (t.contains("passkey") || t.contains("1") || t.contains("2") || t.contains("3"))
        if oldPin {
            return "Your approval key file is from the browser version of Agent Outbox. Set up Touch ID in the app. If this Mac is hardened, run the harden command again afterwards."
        }
        if t.contains("webauthn") {
            return "An old passkey from the browser version is still listed as an approval key. Set up Touch ID in the app so the key list is rewritten."
        }
        if t.contains("credential_id is not in the pin") || t.contains("no approval key") {
            return "The sender doesn't trust any approval key yet. Set up Touch ID in Settings (hardened Macs: then run the harden command)."
        }
        if t.contains("unsupported version") { return "The approval key file is in a format this sender doesn't understand. Open Agent Outbox and set up Touch ID again." }
        return nil
    }
}
