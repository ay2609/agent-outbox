import Foundation
import CryptoKit
import LocalAuthentication
import Security

/// A key the app can sign with. `keyId = base64url(sha256(x963))` (43 characters), the id the pin file and the server use.
public struct SEKeyHandle: Sendable {
    public let keyId: String
    public let x963: Data
    public let signer: any Signer
    public init(x963: Data, signer: any Signer) {
        self.x963 = x963
        self.keyId = B64.encode(SESig.sha256(x963))
        self.signer = signer
    }
}

/// Where the approver gets its keys. The real implementation is `SEKeyStore`; tests use `SoftwareKeyStore`.
public protocol KeyProviding: Sendable {
    func create() throws -> SEKeyHandle
    func load(keyId: String) throws -> SEKeyHandle
    func delete(keyId: String)
    /// Key ids with a blob on this Mac.
    func localKeyIds() -> [String]
}

/// Secure Enclave keys, created with `[.privateKeyUsage, .biometryCurrentSet]` ONLY (no `.userPresence`, so the Mac password can't
/// approve) and `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. The key stays in the Secure Enclave; what we store is its opaque
/// `dataRepresentation` blob at `<state>/native-keys/<key_id>.se` (file 0600, directory 0700, written atomically). It is not in the
/// keychain: an ad-hoc signed app can't use the data-protection keychain, and a login-keychain ACL would break at every update.
/// Honest limit (SECURITY.md): any process running as this user can load the blob and ask for a signature; each one still needs a finger.
public struct SEKeyStore: KeyProviding {
    public let directory: URL

    /// `directory` defaults to `<OUTBOX_HOME or ~/Library/Application Support/agent-outbox>/native-keys`.
    public init(directory: URL? = nil) {
        self.directory = directory ?? SEKeyStore.defaultDirectory()
    }

    public static func defaultDirectory() -> URL {
        let env = ProcessInfo.processInfo.environment["OUTBOX_HOME"]
        let state = (env?.isEmpty == false)
            ? URL(fileURLWithPath: env!, isDirectory: true)
            : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/agent-outbox", isDirectory: true)
        return state.appendingPathComponent("native-keys", isDirectory: true)
    }

    private func blobURL(_ keyId: String) throws -> URL {
        // keyId is part of a file name: only 43 base64url characters are ever acceptable.
        guard keyId.count == 43, B64.decode(keyId) != nil else { throw NativeError.storage("Bad key id.") }
        return directory.appendingPathComponent("\(keyId).se")
    }

    public func create() throws -> SEKeyHandle {
        guard SecureEnclave.isAvailable else { throw NativeError.secureEnclaveUnavailable }
        var cfError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           [.privateKeyUsage, .biometryCurrentSet], &cfError) else {
            throw NativeError.signingFailed(cfError?.takeRetainedValue().localizedDescription ?? "access control")
        }
        let key: SecureEnclave.P256.Signing.PrivateKey
        do {
            key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
        } catch {
            // On a Mac without enrolled biometry (a Mac mini with no Touch ID keyboard) key creation fails with LAError -1000 / -7 / -12.
            let ns = error as NSError
            if ns.domain == LAError.errorDomain || ns.localizedDescription.lowercased().contains("bio") {
                throw NativeError.touchIDNotAvailable(TouchID.reason(for: ns))
            }
            throw NativeError.signingFailed(ns.localizedDescription)
        }
        let x963 = key.publicKey.x963Representation
        let handle = SEKeyHandle(x963: x963, signer: SEKeySigner(dataRepresentation: key.dataRepresentation))
        try write(blob: key.dataRepresentation, keyId: handle.keyId)
        return handle
    }

    public func load(keyId: String) throws -> SEKeyHandle {
        let url = try blobURL(keyId)
        // O_NOFOLLOW read through a descriptor: a planted symlink is never followed.
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw NativeError.noLocalKey }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), st.st_size < 4096 else { throw NativeError.noLocalKey }
        var data = Data(count: Int(st.st_size))
        let n = data.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
        guard n == Int(st.st_size) else { throw NativeError.noLocalKey }
        let key: SecureEnclave.P256.Signing.PrivateKey
        do { key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data) }
        catch { throw NativeError.keyInvalidated }
        let handle = SEKeyHandle(x963: key.publicKey.x963Representation, signer: SEKeySigner(dataRepresentation: data))
        guard handle.keyId == keyId else { throw NativeError.mismatch("The stored key doesn't match its name.") }
        return handle
    }

    public func delete(keyId: String) {
        guard let url = try? blobURL(keyId) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    public func localKeyIds() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".se") }.map { String($0.dropLast(3)) }.filter { $0.count == 43 && B64.decode($0) != nil }.sorted()
    }

    private func write(blob: Data, keyId: String) throws {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            chmod(directory.path, 0o700)
            let tmp = directory.appendingPathComponent("\(keyId).se.\(getpid()).tmp")
            try? fm.removeItem(at: tmp)
            guard fm.createFile(atPath: tmp.path, contents: blob, attributes: [.posixPermissions: 0o600]) else { throw NativeError.storage("Couldn't write the key.") }
            chmod(tmp.path, 0o600)
            try fm.moveItem(at: tmp, to: try blobURL(keyId))
        } catch let e as NativeError { throw e } catch { throw NativeError.storage("Couldn't save the key: \(error.localizedDescription)") }
    }
}

/// Software keys in memory (unit tests; a development app against a mock server). Same `KeyProviding` seam as the real store.
public final class SoftwareKeyStore: KeyProviding, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: SoftwareSigner] = [:]
    public init() {}
    public func create() throws -> SEKeyHandle {
        let s = SoftwareSigner()
        let h = s.handle
        lock.lock(); keys[h.keyId] = s; lock.unlock()
        return h
    }
    public func load(keyId: String) throws -> SEKeyHandle {
        lock.lock(); defer { lock.unlock() }
        guard let s = keys[keyId] else { throw NativeError.noLocalKey }
        return s.handle
    }
    public func delete(keyId: String) { lock.lock(); keys[keyId] = nil; lock.unlock() }
    public func localKeyIds() -> [String] { lock.lock(); defer { lock.unlock() }; return keys.keys.sorted() }
    /// Test helper: the underlying private key.
    public func signer(keyId: String) -> SoftwareSigner? { lock.lock(); defer { lock.unlock() }; return keys[keyId] }
}
