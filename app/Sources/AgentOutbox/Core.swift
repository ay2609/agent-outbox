import Foundation
import OwnerAPI

// MARK: - Loose JSON
// The owner API is the web dashboard's API; the windows read it as plain JSON dictionaries so a new field never breaks them.

typealias J = [String: Any]

extension Dictionary where Key == String, Value == Any {
    func str(_ k: String, _ d: String = "") -> String { (self[k] as? String) ?? d }
    func int(_ k: String, _ d: Int = 0) -> Int { (self[k] as? Int) ?? (self[k] as? Double).map { Int($0) } ?? d }
    func bool(_ k: String, _ d: Bool = false) -> Bool { (self[k] as? Bool) ?? d }
    func obj(_ k: String) -> J { (self[k] as? J) ?? [:] }
    func arr(_ k: String) -> [J] { (self[k] as? [J]) ?? [] }
    func strs(_ k: String) -> [String] { (self[k] as? [String]) ?? [] }
    var id: String { str("id") }
}

/// Identifiable box so SwiftUI lists can iterate JSON rows.
struct Row: Identifiable, Hashable {
    let j: J
    let id: String
    init(_ j: J, idKey: String = "id") { self.j = j; self.id = j.str(idKey) }
    static func == (a: Row, b: Row) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

func rows(_ a: [J], idKey: String = "id") -> [Row] { a.map { Row($0, idKey: idKey) } }

func jsonData(_ o: Any) -> Data { (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8) }
func parseJSON(_ d: Data) -> J { ((try? JSONSerialization.jsonObject(with: d)) as? J) ?? [:] }

struct APIFailure: Error, LocalizedError {
    var status: Int
    var code: String
    var message: String
    var errorDescription: String? { message }
}

// MARK: - Environment

enum AppEnv {
    static let env = ProcessInfo.processInfo.environment
    static var stateDir: String { outboxStateDir() }
    static var bundlePath: String { Bundle.main.bundlePath }
    /// Running from a real Agent Outbox.app (not `swift run`): the only case where login items are registered.
    static var isRealBundle: Bool {
        bundlePath.hasSuffix(".app") && FileManager.default.isExecutableFile(atPath: bundlePath + "/Contents/MacOS/agent-outbox")
    }
    /// Dev runs (env AGENT_OUTBOX_DEV=1, or not a real bundle) never touch login items.
    static var isDev: Bool { env["AGENT_OUTBOX_DEV"] == "1" || !isRealBundle }
    /// Server binary: env AGENT_OUTBOX_SERVER_BIN (development override), else Contents/MacOS/agent-outbox in this bundle.
    static var serverBin: String { env["AGENT_OUTBOX_SERVER_BIN"].flatMap { $0.isEmpty ? nil : $0 } ?? bundlePath + "/Contents/MacOS/agent-outbox" }
    /// The MCP command registered with Claude Code (the bundled binary; subcommand `mcp`).
    static var mcpBin: String { serverBin }
    static var port: Int {
        if let p = env["OUTBOX_PORT"], let n = Int(p) { return n }
        if let d = FileManager.default.contents(atPath: stateDir + "/config.json"), let n = parseJSON(d)["port"] as? Int { return n }
        return 7477
    }
    static var origin: String { "http://localhost:\(port)" }
    static var launchAgentsDir: String { NSHomeDirectory() + "/Library/LaunchAgents" }
}

func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

/// Small plain-English helpers shared by the windows.
func timeAgo(_ iso: String) -> String {
    guard let d = parseISO(iso) else { return "" }
    let s = Int(Date().timeIntervalSince(d))
    if s < 60 { return "just now" }
    if s < 3600 { return "\(s / 60) min ago" }
    if s < 86_400 { return "\(s / 3600) h ago" }
    return "\(s / 86_400) d ago"
}

func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}

func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) \(n == 1 ? one : (many ?? one + "s"))" }
