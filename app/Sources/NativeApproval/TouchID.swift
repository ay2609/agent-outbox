import Foundation
import CryptoKit
import LocalAuthentication

/// Touch ID availability in plain words. There is no password fallback anywhere: a Mac that can't do biometrics can't approve.
public enum TouchID {
    static let generic = "Touch ID isn't available on this Mac. Approving needs a Mac or a Magic Keyboard with Touch ID; there is no password fallback."

    /// Plain-words reason for a LocalAuthentication error.
    public static func reason(for error: NSError?) -> String {
        guard let error, error.domain == LAError.errorDomain else { return generic }
        switch LAError.Code(rawValue: error.code) {
        case .biometryNotEnrolled: return "Add a fingerprint in System Settings > Touch ID & Password."
        case .biometryLockout: return "Touch ID is locked; unlock it with your password in System Settings."
        case .biometryNotAvailable:
            return "This Mac has no usable Touch ID sensor (or its lid is closed). Approving needs a Mac or a Magic Keyboard with Touch ID; there is no password fallback. Open the lid or connect a Touch ID keyboard."
        default: return generic
        }
    }

    /// Biometrics only (never `.deviceOwnerAuthentication`). `domainHash`: sha256 of the fingerprint-set state, to notice a changed set.
    public static func check() -> (available: Bool, reason: String?, domainHash: String?) {
        let ctx = LAContext()
        var err: NSError?
        let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        let hash = ctx.evaluatedPolicyDomainState.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }
        return (ok, ok ? nil : reason(for: err), hash)
    }
}
