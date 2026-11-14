import Foundation
import CryptoKit
import Darwin

public struct PinKey {
    public let credentialId: Data       // decoded
    public let credentialIdB64: String
    public let publicKey: P256.Signing.PublicKey
    public let label: String
}

/// The effective pin file's policy (PinPolicy in src/core/types.ts). v3: whether live sending is allowed; v4 adds whether contact
/// changes may be written live. Extra fields in older pin files (pacing floors, daily cap, quiet hours) are ignored, so an
/// already-installed pin keeps loading.
public struct PinPolicy: Equatable, Sendable {
    public var liveAllowed: Bool
    /// v4: missing, or not a boolean, means false (contact changes are only ever applied dry). It never affects `liveAllowed`.
    public var contactsLiveAllowed: Bool

    public init(liveAllowed: Bool, contactsLiveAllowed: Bool = false) {
        self.liveAllowed = liveAllowed
        self.contactsLiveAllowed = contactsLiveAllowed
    }

    /// DEFAULT_PIN_POLICY in types.ts. Used for v1 pin files (dry only: live_allowed is false).
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
    /// 1 = legacy file without a policy (dry only, default policy); 2 = file with an explicit policy.
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

    /// v2 policy: `live_allowed` must be a boolean. Anything else throws, and the caller holds (fail closed). `contacts_live_allowed`
    /// is optional: missing or of the wrong type means false and never makes the file unusable. Other fields are ignored.
    static func parsePolicy(_ any: Any?, path: String) throws -> PinPolicy {
        guard let o = any as? [String: Any] else { throw ExecError("pin file \(path): v2 pin file has no valid policy object") }
        guard let la = o["live_allowed"] as? NSNumber, CFGetTypeID(la) == CFBooleanGetTypeID() else { throw ExecError("pin file \(path): policy.live_allowed missing or not a boolean") }
        var contactsLive = false
        if let cl = o["contacts_live_allowed"] as? NSNumber, CFGetTypeID(cl) == CFBooleanGetTypeID() { contactsLive = cl.boolValue }
        return PinPolicy(liveAllowed: la.boolValue, contactsLiveAllowed: contactsLive)
    }

    struct DTO: Decodable {
        struct K: Decodable { let credential_id: String; let x963: String; let label: String? }
        let v: Int
        let rp_id: String
        let origin: String
        let keys: [K]
    }

    public static func parse(_ data: Data, path: String, mode: PinMode, checksPassed: Bool) throws -> PinFile {
        let dto: DTO
        do { dto = try JSONDecoder().decode(DTO.self, from: data) } catch { throw ExecError("pin file \(path): invalid JSON (\(error))") }
        guard dto.v == 1 || dto.v == 2 else { throw ExecError("pin file \(path): unsupported version \(dto.v)") }
        guard !dto.rp_id.isEmpty, !dto.origin.isEmpty else { throw ExecError("pin file \(path): empty rp_id or origin") }
        guard !dto.keys.isEmpty else { throw ExecError("pin file \(path): no keys") }
        // v2: the policy object and its live_allowed boolean are mandatory. v1 (pre-policy): default policy, which forbids live.
        let policy: PinPolicy
        if dto.v == 2 {
            let root = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
            policy = try parsePolicy(root?["policy"], path: path)
        } else {
            policy = .default
        }
        var keys: [PinKey] = []
        for k in dto.keys {
            guard let cid = B64.decodeURL(k.credential_id), !cid.isEmpty else { throw ExecError("pin file \(path): bad credential_id") }
            guard let raw = B64.decodeURL(k.x963), raw.count == 65, raw.first == 0x04,
                  let pk = try? P256.Signing.PublicKey(x963Representation: raw)
            else { throw ExecError("pin file \(path): bad x963 key for credential \(k.credential_id)") }
            keys.append(PinKey(credentialId: cid, credentialIdB64: B64.encodeURL(cid), publicKey: pk, label: k.label ?? ""))
        }
        return PinFile(path: path, rpId: dto.rp_id, origin: dto.origin, keys: keys, mode: mode, checksPassed: checksPassed, version: dto.v, policy: policy)
    }
}
