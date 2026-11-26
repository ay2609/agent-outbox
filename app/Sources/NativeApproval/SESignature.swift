import Foundation
import CryptoKit
import LocalAuthentication

/// Signs a message with a key and returns an ECDSA P-256/SHA-256 signature in DER form. The Secure Enclave key and the software key
/// used by tests both sit behind this seam; nothing else in the module knows which one it has.
public protocol Signer: Sendable {
    func sign(_ message: Data, reason: String) async throws -> Data
}

/// Signed message M (local-docs/APP-SECURITY-C.md section 2), byte-identical to the executor's `SESig` and the server's `seMessage`:
/// M = utf8("agent-outbox/se/v1") || 0x00 || utf8(TAG) || 0x00 || DIGEST (32 raw bytes).
public enum SESig {
    public static let prefix = Data("agent-outbox/se/v1".utf8)

    public static func message(tag: String, digest: Data) -> Data {
        precondition(digest.count == 32, "digest must be 32 bytes")
        var m = prefix
        m.append(0); m.append(Data(tag.utf8)); m.append(0); m.append(digest)
        return m
    }
    public static func sha256(_ d: Data) -> Data { Data(SHA256.hash(data: d)) }

    /// send / contacts: the digest is sha256 of the exact manifest bytes (the same buffer the confirm sheet was built from).
    public static func manifestMessage(tag: String, manifestBytes: Data) -> Data { message(tag: tag, digest: sha256(manifestBytes)) }
    /// reauth: sha256(challenge), challenge = the 32 raw bytes the server issued.
    public static func reauthMessage(challenge: Data) -> Data { message(tag: "reauth", digest: sha256(challenge)) }
    /// enroll: sha256(challenge || x963), x963 = the 65-byte public key being enrolled.
    public static func enrollMessage(challenge: Data, x963: Data) -> Data { message(tag: "enroll", digest: sha256(challenge + x963)) }

    /// Signs `message` with the handle's key (Touch ID for a Secure Enclave key) and checks the result against the handle's public key
    /// before returning it, so a wrong or corrupt signature never leaves the app. Returns DER.
    public static func sign(handle: SEKeyHandle, message: Data, reason: String) async throws -> Data {
        let der = try await handle.signer.sign(message, reason: reason)
        guard let pub = try? P256.Signing.PublicKey(x963Representation: handle.x963),
              let sig = try? P256.Signing.ECDSASignature(derRepresentation: der),
              pub.isValidSignature(sig, for: message)
        else { throw NativeError.signingFailed("the signature didn't verify against the key") }
        return der
    }
}

/// A Secure Enclave key behind the Signer seam. Each signature uses a FRESH LAContext (no reuse of an earlier Touch ID, no password
/// fallback button), is made off the main thread, and the context is invalidated afterwards.
struct SEKeySigner: Signer {
    let dataRepresentation: Data

    func sign(_ message: Data, reason: String) async throws -> Data {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let ctx = LAContext()
                ctx.touchIDAuthenticationAllowableReuseDuration = 0
                ctx.localizedFallbackTitle = ""
                ctx.localizedReason = reason
                defer { ctx.invalidate() }
                do {
                    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation, authenticationContext: ctx)
                    let sig = try key.signature(for: message)
                    cont.resume(returning: sig.derRepresentation)
                } catch {
                    cont.resume(throwing: NativeError.fromSigning(error))
                }
            }
        }
    }
}

extension NativeError {
    /// Maps LocalAuthentication / Security / CryptoKit failures to the few outcomes the UI cares about.
    static func fromSigning(_ error: Error) -> NativeError {
        if let n = error as? NativeError { return n }
        let ns = error as NSError
        if ns.domain == LAError.errorDomain {
            switch LAError.Code(rawValue: ns.code) {
            case .userCancel, .appCancel, .systemCancel: return .cancelled
            case .biometryNotEnrolled, .biometryNotAvailable, .biometryLockout: return .touchIDNotAvailable(ns.localizedDescription)
            case .authenticationFailed: return .signingFailed("Touch ID didn't recognise the finger")
            default: break
            }
        }
        // An item that no longer opens (the Touch ID set changed: .biometryCurrentSet) shows up as an authentication/item failure.
        if ns.domain == NSOSStatusErrorDomain && [-25293, -25300, -67671, -25295].contains(ns.code) { return .keyInvalidated }
        if ns.domain == "CryptoKit.CryptoKitError" || ns.domain == "com.apple.CryptoKit.CryptoKitError" { return .keyInvalidated }
        return .signingFailed(ns.localizedDescription)
    }
}

/// A software P-256 key behind the Signer seam: unit tests, and a development app run against a mock server on a Mac without Touch ID.
/// NEVER offered by the real key store; the production approver only gets handles from `SEKeyStore`.
public struct SoftwareSigner: Signer {
    public let key: P256.Signing.PrivateKey
    public init(key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) { self.key = key }
    public func sign(_ message: Data, reason: String) async throws -> Data { try key.signature(for: message).derRepresentation }
    public var handle: SEKeyHandle { SEKeyHandle(x963: key.publicKey.x963Representation, signer: self) }
}
