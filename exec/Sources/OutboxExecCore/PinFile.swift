import Foundation
import CryptoKit
import Darwin

/// The only kind of signer a pinned key can be (pin v4).
public enum PinKeyKind: String, Sendable {
    case secureEnclave = "secure-enclave"
}

public struct PinKey {
    public let credentialId: Data       // decoded
    public let credentialIdB64: String
    public let publicKey: P256.Signing.PublicKey
    public let label: String
    public var kind: PinKeyKind { .secureEnclave }
}

/// The effective pin file's policy (PinPolicy in src/core/types.ts): whether live sending is allowed and whether contact changes may
/// be written live. Both are mandatory JSON booleans and no other field is accepted (pin v4).
public struct PinPolicy: Equatable, Sendable {
    public var liveAllowed: Bool
    public var contactsLiveAllowed: Bool

    public init(liveAllowed: Bool, contactsLiveAllowed: Bool = false) {
        self.liveAllowed = liveAllowed
        self.contactsLiveAllowed = contactsLiveAllowed
    }

    /// DEFAULT_PIN_POLICY in types.ts (dry only).
    public static let `default` = PinPolicy(liveAllowed: false)
}

/// Which pin file the executor is using. `hardened`: the root-owned file in /Library/Application Support (the user ran the harden command).
/// `simple`: the user's own file in the state directory (the default; no root needed).
public enum PinMode: String, Sendable {
    case hardened
    case simple
}

public struct PinFile {
    public let path: String
    public let rpId: String
    public let origin: String
    public let keys: [PinKey]
    public let mode: PinMode
    /// True when the file passed the checks for its mode (root-owned chain for hardened; user-owned file and directory for simple),
    /// and nothing (e.g. the dry-only override) has withheld live trust from it.
    public let checksPassed: Bool
    /// Always 4: the only accepted pin version (see PinFileLoader.parse).
    public let version: Int
    public let policy: PinPolicy

    /// The one question every live gate asks first: may this pin authorise anything live? It still needs `policy` to allow it.
    public var trustedForLive: Bool { checksPassed }

    public func key(forCredentialId b64: String) -> PinKey? {
        guard let id = B64.decodeURL(b64) else { return nil }
        return keys.first { $0.credentialId == id }
    }
}

public enum PinFileLoader {
    /// Fixed manifest constants (MANIFEST_RP_ID / MANIFEST_ORIGIN in src/core/types.ts). The pin file no longer carries them.
    public static let v4RpId = "agent-outbox"
    public static let v4Origin = "agent-outbox:app"

    /// Which pin file applies. If the root file exists in any form (even a dangling symlink, or unreadable) the executor is hardened
    /// and uses ONLY it: it must load, or this throws, and the user pin is never consulted (no downgrade). Otherwise it is simple
    /// and uses the user pin. `liveTrust: false` (the dry-only override) loads the user pin without live trust.
    public static func resolve(rootPath: String, userPath: String, rootExpectedUid: uid_t = 0, checkRootAncestors: Bool = true,
                               userExpectedUid: uid_t = getuid(), liveTrust: Bool = true) throws -> PinFile {
        if exists(rootPath) {
            return try load(path: rootPath, mode: .hardened, expectedUid: rootExpectedUid, checkAncestors: checkRootAncestors)
        }
        return try load(path: userPath, mode: .simple, expectedUid: userExpectedUid, liveTrust: liveTrust)
    }

    /// lstat-based existence: a symlink counts (even a dangling one), and any error but "not there" counts as present, so the
    /// executor fails closed into hardened mode rather than quietly dropping to the user pin.
    static func exists(_ path: String) -> Bool {
        var st = stat()
        if lstat(path, &st) == 0 { return true }
        return errno != ENOENT && errno != ENOTDIR
    }

    /// Loads and validates a pin file. Hardened: the file and every ancestor directory must be owned by `expectedUid` (root) and not
    /// group- or world-writable. Simple: the file and its parent directory (the state directory) must be owned by `expectedUid`
    /// (default: the current user) and not group- or world-writable. Both: a regular file, never a symlink. The file is opened with
    /// O_NOFOLLOW and its ownership is read from the open descriptor, so it can't be swapped after the check.
    public static func load(path: String, mode: PinMode, expectedUid: uid_t? = nil, checkAncestors: Bool = true, liveTrust: Bool = true) throws -> PinFile {
        let uid = expectedUid ?? (mode == .hardened ? 0 : getuid())
        let fd = open(path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw ExecError("pin file \(path): cannot open (\(String(cString: strerror(errno))))") }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0 else { throw ExecError("pin file \(path): fstat failed") }
        guard (st.st_mode & S_IFMT) == S_IFREG else { throw ExecError("pin file \(path): not a regular file") }
        try checkOwnership(st: st, what: "pin file \(path)", expectedUid: uid)
        switch mode {
        case .hardened:
            if checkAncestors { try Self.checkAncestors(of: path, expectedUid: uid) }
        case .simple:
            try checkStateDir(of: path, expectedUid: uid)
        }
        var data = Data()
        let bufSize = 4096
        var buf = [UInt8](repeating: 0, count: bufSize)
        while true {
            let n = read(fd, &buf, bufSize)
            if n < 0 { throw ExecError("pin file \(path): read failed") }
            if n == 0 { break }
            data.append(contentsOf: buf[0..<n])
            if data.count > 1_000_000 { throw ExecError("pin file \(path): too large") }
        }
        return try parse(data, path: path, mode: mode, checksPassed: mode == .hardened || liveTrust)
    }

    static func checkOwnership(st: stat, what: String, expectedUid: uid_t) throws {
        if st.st_uid != expectedUid { throw ExecError("\(what): owned by uid \(st.st_uid), expected \(expectedUid)") }
        if st.st_mode & (S_IWGRP | S_IWOTH) != 0 {
            throw ExecError("\(what): group- or world-writable (mode \(String(st.st_mode & 0o7777, radix: 8)))")
        }
    }

    /// Simple mode: the directory holding the user pin (the state directory) must be a directory owned by `expectedUid` and not
    /// group- or world-writable, or anyone who can write there could swap the pin file. Its own ancestors are not walked.
    public static func checkStateDir(of path: String, expectedUid: uid_t) throws {
        let dir = (path as NSString).deletingLastPathComponent
        var st = stat()
        guard stat(dir, &st) == 0 else { throw ExecError("state dir \(dir): cannot stat") }
        guard (st.st_mode & S_IFMT) == S_IFDIR else { throw ExecError("state dir \(dir): not a directory") }
        try checkOwnership(st: st, what: "state dir \(dir)", expectedUid: expectedUid)
    }

    /// Every directory from `/` down to the file's parent: a real directory (no symlink), owned by `expectedUid`, not g/o-writable.
    public static func checkAncestors(of path: String, expectedUid: uid_t) throws {
        let comps = (path as NSString).deletingLastPathComponent.split(separator: "/").map(String.init)
        var cur = ""
        var dirs = ["/"]
        for c in comps { cur += "/" + c; dirs.append(cur) }
        for d in dirs {
            var st = stat()
            guard lstat(d, &st) == 0 else { throw ExecError("pin dir \(d): cannot stat") }
            guard (st.st_mode & S_IFMT) == S_IFDIR else { throw ExecError("pin dir \(d): not a plain directory (symlink?)") }
            try checkOwnership(st: st, what: "pin dir \(d)", expectedUid: expectedUid)
        }
    }

    /// Test hook: ownership check of a single path against an arbitrary uid.
    public static func checkPathOwnership(_ path: String, expectedUid: uid_t) throws {
        var st = stat()
        guard lstat(path, &st) == 0 else { throw ExecError("cannot stat \(path)") }
        try checkOwnership(st: st, what: path, expectedUid: expectedUid)
    }

    /// The reason strings the app maps to user text. Stable: the app matches on these substrings (they end up in exec_status.last_error
    /// as "no usable pin file: pin file <path>: <reason>").
    public enum Refusal {
        public static func browserPasskeys(_ v: Int) -> String {
            "pin version \(v) holds browser passkeys, which Agent Outbox no longer accepts: set up Touch ID in the app (hardened: then run the harden command again)"
        }
        public static func unsupportedVersion(_ v: String) -> String { "unsupported version \(v)" }
        public static let webauthnKey = "WebAuthn keys are no longer accepted"
    }

    /// Pin v4 policy: exactly `live_allowed` and `contacts_live_allowed`, both JSON booleans. Anything else throws, and the caller holds.
    static func parsePolicy(_ any: Any?, path: String) throws -> PinPolicy {
        guard let o = any as? [String: Any] else { throw ExecError("pin file \(path): no valid policy object") }
        guard Set(o.keys) == ["live_allowed", "contacts_live_allowed"] else {
            throw ExecError("pin file \(path): policy must have exactly live_allowed and contacts_live_allowed (has \(o.keys.sorted().joined(separator: ", ")))")
        }
        func bool(_ k: String) throws -> Bool {
            guard let n = o[k] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw ExecError("pin file \(path): policy.\(k) is not a boolean") }
            return n.boolValue
        }
        return PinPolicy(liveAllowed: try bool("live_allowed"), contactsLiveAllowed: try bool("contacts_live_allowed"))
    }

    /// The only pin shape: `{v: 4, keys: [{kind: "secure-enclave", credential_id, x963, label}], policy: {live_allowed, contacts_live_allowed}}`,
    /// with exactly those key sets at every level. `keys` may be empty (then every approval is refused). v1/v2/v3 and anything else are refused.
    public static func parse(_ data: Data, path: String, mode: PinMode, checksPassed: Bool) throws -> PinFile {
        guard let root = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else { throw ExecError("pin file \(path): invalid JSON (not an object)") }
        guard let vNum = root["v"] as? NSNumber, CFGetTypeID(vNum) != CFBooleanGetTypeID(), vNum.doubleValue == Double(vNum.intValue) else {
            throw ExecError("pin file \(path): \(Refusal.unsupportedVersion("(missing or not an integer)"))")
        }
        let v = vNum.intValue
        if v == 1 || v == 2 || v == 3 { throw ExecError("pin file \(path): \(Refusal.browserPasskeys(v))") }
        guard v == 4 else { throw ExecError("pin file \(path): \(Refusal.unsupportedVersion(String(v)))") }
        guard Set(root.keys) == ["v", "keys", "policy"] else {
            throw ExecError("pin file \(path): v4 pin must have exactly v, keys and policy (has \(root.keys.sorted().joined(separator: ", ")))")
        }
        let policy = try parsePolicy(root["policy"], path: path)
        guard let rawKeys = root["keys"] as? [Any] else { throw ExecError("pin file \(path): keys is not an array") }
        guard rawKeys.count <= 32 else { throw ExecError("pin file \(path): too many keys (\(rawKeys.count), at most 32)") }
        var keys: [PinKey] = []
        var seenIds = Set<Data>()
        for (i, any) in rawKeys.enumerated() {
            guard let k = any as? [String: Any] else { throw ExecError("pin file \(path): keys[\(i)] is not an object") }
            if let kind = k["kind"] as? String, kind == "webauthn" { throw ExecError("pin file \(path): \(Refusal.webauthnKey)") }
            guard Set(k.keys) == ["kind", "credential_id", "x963", "label"] else {
                throw ExecError("pin file \(path): keys[\(i)] must have exactly kind, credential_id, x963 and label (has \(k.keys.sorted().joined(separator: ", ")))")
            }
            guard (k["kind"] as? String) == "secure-enclave" else { throw ExecError("pin file \(path): keys[\(i)].kind is not \"secure-enclave\"") }
            guard let cidS = k["credential_id"] as? String, let xS = k["x963"] as? String, let label = k["label"] as? String else {
                throw ExecError("pin file \(path): keys[\(i)] has a non-string credential_id, x963 or label")
            }
            guard label.count <= 200 else { throw ExecError("pin file \(path): keys[\(i)].label is longer than 200 characters") }
            guard let cid = B64.decodeURL(cidS), !cid.isEmpty else { throw ExecError("pin file \(path): bad credential_id") }
            guard let raw = B64.decodeURL(xS), raw.count == 65, raw.first == 0x04,
                  let pk = try? P256.Signing.PublicKey(x963Representation: raw)
            else { throw ExecError("pin file \(path): bad x963 key for credential \(cidS)") }
            // SE key ids are base64url(sha256(x963)): the id can't be chosen independently of the key.
            guard cid == Data(SHA256.hash(data: raw)) else { throw ExecError("pin file \(path): credential_id is not sha256(x963)") }
            guard seenIds.insert(cid).inserted else { throw ExecError("pin file \(path): duplicate credential_id \(cidS)") }
            keys.append(PinKey(credentialId: cid, credentialIdB64: B64.encodeURL(cid), publicKey: pk, label: label))
        }
        return PinFile(path: path, rpId: v4RpId, origin: v4Origin, keys: keys, mode: mode, checksPassed: checksPassed, version: 4, policy: policy)
    }
}
