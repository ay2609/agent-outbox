// NativeApproval: Secure Enclave Touch ID approval for Agent Outbox.app (SECURITY.md has the security model).
//
// What this module guarantees, in one place:
//  - Keys are Secure Enclave P-256 keys with [.privateKeyUsage, .biometryCurrentSet] only: no password fallback.
//  - What the owner sees and what is signed are built from the same `manifest_bytes` buffer (`ApprovalPayload`).
//  - Touch ID reason text comes from fixed templates (counts and fixed words only).
//  - Signing happens only after the owner pressed Approve in the app's own confirm sheet in the last 60 seconds, one signature at a time.
import Foundation
import OwnerAPI

/// Everything that can go wrong, with a sentence for the owner. `touchIDNotAvailable` means approving can't happen on this Mac (no fallback).
public enum NativeError: Error, LocalizedError, Equatable {
    /// No Touch ID sensor, no fingerprints enrolled, or locked out: approving can't happen here. The text says why (no password fallback exists).
    case touchIDNotAvailable(String)
    /// The server has no proof of the owner available for a new key: run the recover command in Terminal first.
    case proofRequired
    case secureEnclaveUnavailable
    /// The Touch ID set changed (or the key was invalidated): enrol a new key.
    case keyInvalidated
    case cancelled
    case noLocalKey
    case busy
    case confirmationExpired
    case notConfirmed
    /// The server's answer doesn't match what the app asked for or what it signs.
    case mismatch(String)
    case server(status: Int, code: String, message: String)
    case signingFailed(String)
    case storage(String)
    case unsupported(String)

    public var errorDescription: String? {
        switch self {
        case .touchIDNotAvailable(let m): return m.isEmpty ? TouchID.generic : m
        case .proofRequired: return "Confirm it's you in Terminal first: run the recover command shown in the app, then try again."
        case .secureEnclaveUnavailable: return "This Mac has no Secure Enclave."
        case .keyInvalidated: return "Touch ID changed: set up approval again."
        case .cancelled: return "Cancelled."
        case .noLocalKey: return "This Mac has no approval key for Agent Outbox. Set up Touch ID approval again."
        case .busy: return "Another approval is already waiting for Touch ID."
        case .confirmationExpired: return "That took too long. Press Approve again."
        case .notConfirmed: return "Nothing was approved."
        case .mismatch(let m): return m
        case .server(_, _, let m): return m
        case .signingFailed(let m): return "Touch ID signing failed: \(m)"
        case .storage(let m): return m
        case .unsupported(let m): return m
        }
    }
}

public enum B64 {
    public static func encode(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public static func decode(_ s: String) -> Data? {
        guard s.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        t += String(repeating: "=", count: (4 - t.count % 4) % 4)
        return Data(base64Encoded: t)
    }
}

// MARK: models the app consumes

public struct NativeStatus: Sendable, Equatable {
    /// Touch ID sensor present with fingerprints enrolled (LocalAuthentication). False -> approvals are disabled (no fallback).
    public var touchIDAvailable: Bool
    /// Plain-words reason when `touchIDAvailable` is false.
    public var touchIDReason: String?
    /// The fingerprint set changed since the key was made: every key on this Mac is dead; set up approval again.
    public var touchIDChanged: Bool
    public var secureEnclaveAvailable: Bool
    /// Active keys the server knows (any Mac's).
    public var keysActive: Int
    /// `GET /api/status` native.approve_in_app: the effective pin trusts an active native key (hardened mode: only after the sudo command).
    public var approveInApp: Bool
    public var pinNeedsUpdate: Bool
    /// An ACTIVE server key whose blob is on this Mac (the one the app can sign with).
    public var localKeyId: String?
    /// True when the server has no usable key for this Mac although a blob exists or existed: show "set up approval again".
    public var needsReenroll: Bool
    /// The app signs here only when Touch ID works, a local active key exists AND the pin trusts it.
    public var canApproveInApp: Bool { touchIDAvailable && secureEnclaveAvailable && localKeyId != nil && approveInApp }
    /// The server could not be asked (status call failed); the rest is what is known locally.
    public var serverReachable: Bool
}

public struct NativeKeyInfo: Sendable, Equatable {
    public var keyId: String
    public var label: String
    public var fingerprint: String
    /// Always "active": enrolment is synchronous.
    public var status: String
}

public struct ApproveVerifyResult: Sendable, Equatable, Decodable {
    public var approvalId: String
    public var manifestSha256: String
    public var count: Int
    public var notAfter: String
    public var credentialId: String
    public var transport: String
    enum CodingKeys: String, CodingKey {
        case approvalId = "approval_id", manifestSha256 = "manifest_sha256", count, notAfter = "not_after", credentialId = "credential_id", transport
    }
}

/// A Touch ID confirmation for a sensitive change, to put in the request body as `se_reauth` (the encoded form is the server's shape).
public struct SEReauth: Sendable, Equatable, Codable {
    public var challengeId: String
    public var keyId: String
    public var signature: String
    enum CodingKeys: String, CodingKey { case challengeId = "challenge_id", keyId = "key_id", signature }
}

/// What B implements to show `ApprovalConfirmView` and wait for the owner. Return true only when the owner pressed Approve.
public protocol ApprovalConfirming: Sendable {
    func confirm(_ payload: ApprovalPayload) async -> Bool
}
