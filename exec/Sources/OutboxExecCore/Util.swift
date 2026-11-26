import Foundation
import CryptoKit

public struct ExecError: Error, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// base64url helpers. Decoding accepts the URL alphabet only, with or without correct "=" padding.
public enum B64 {
    public static func encodeURL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decodeURL(_ input: String) -> Data? {
        var body = Substring(input)
        var pads = 0
        while body.hasSuffix("=") { body = body.dropLast(); pads += 1 }
        for u in body.utf8 {
            let ok = (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A) || (u >= 0x30 && u <= 0x39) || u == 0x2D || u == 0x5F
            if !ok { return nil }
        }
        let rem = body.utf8.count % 4
        if rem == 1 { return nil }
        let needed = rem == 0 ? 0 : 4 - rem
        if pads != 0 && pads != needed { return nil }
        var std = String(body).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        std += String(repeating: "=", count: needed)
        return Data(base64Encoded: std)
    }
}

public enum Hex {
    public static func encode(_ data: some Sequence<UInt8>) -> String {
        var s = ""
        for b in data { s += String(format: "%02x", b) }
        return s
    }
    public static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }
    public static func sha256Hex(_ data: Data) -> String { encode(SHA256.hash(data: data)) }
    public static func sha256Hex(_ s: String) -> String { sha256Hex(Data(s.utf8)) }
}

public enum Time {
    /// "2026-11-10T08:00:00.000Z" with or without fractional seconds.
    public static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        let g = ISO8601DateFormatter()
        g.formatOptions = [.withInternetDateTime]
        return g.date(from: s)
    }
    public static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }
}

/// Strict JSON-object parsing helpers (any type surprise is a rejection upstream).
public enum JSON {
    public static func object(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
    }
    public static func data(_ obj: Any) -> Data? {
        try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    public static func string(_ obj: Any) -> String {
        guard let d = data(obj), let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
}

public enum Paths {
    /// Hardened mode's pin file. A compiled-in constant: not configurable, so nothing can point the executor at another one.
    public static let rootPinFile = "/Library/Application Support/agent-outbox/passkeys.json"
    /// The state directory. The path has a space ("Application Support"): everything here builds paths as strings, never through a shell.
    public static func defaultHome() -> String {
        if let h = ProcessInfo.processInfo.environment["OUTBOX_HOME"], !h.isEmpty { return h }
        return NSHomeDirectory() + "/Library/Application Support/agent-outbox"
    }
}

/// A login item registered by Agent Outbox.app (SMAppService) has a static plist with no StandardOutPath: launchd then connects
/// stdout and stderr to /dev/null. In that case (and only then) send them to `<home>/logs/outbox-exec.{out,err}.log`, the same files
/// the developer install's LaunchAgent names. A terminal, a pipe or a file the caller chose is left alone.
public func redirectStdioFromDevNull(home: String) {
    var null = stat()
    guard stat("/dev/null", &null) == 0 else { return }
    let logs = home + "/logs"
    for (fd, name) in [(Int32(1), "outbox-exec.out.log"), (Int32(2), "outbox-exec.err.log")] {
        var st = stat()
        guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFCHR, st.st_rdev == null.st_rdev else { continue }
        try? FileManager.default.createDirectory(atPath: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let f = open(logs + "/" + name, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard f >= 0 else { continue }
        dup2(f, fd)
        close(f)
    }
}

public enum Version {
    public static let current = "0.1.0"
}

/// Appends `data` + "\n" to a file (created 0600, parent dir 0700) with O_APPEND. Returns false on any failure.
public func appendLine(_ data: Data, to path: String) -> Bool {
    let dir = (path as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var line = data
    line.append(0x0A)
    return line.withUnsafeBytes { write(fd, $0.baseAddress, line.count) == line.count }
}
