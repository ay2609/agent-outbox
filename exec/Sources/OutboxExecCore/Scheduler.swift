import Foundation

/// Settings as the executor reads them (DB `settings` table). Safety-critical values fail closed.
/// v3: there is no pacing, cap or quiet-hours setting. Approved messages send right away.
public struct ExecSettings {
    /// Display only (heartbeat). Which transport an approval uses is decided by its signed manifest and the pin policy.
    public var transport = "dry"
    public var killSwitch = true      // missing or unparseable => engaged
    public var breakerOnFailure = true
    /// v4: display only (heartbeat). Which lane a contact approval uses is decided by its signed manifest and the pin policy.
    public var contactsTransport = "dry"

    public static func load(_ db: Database) throws -> ExecSettings {
        var kv: [String: String] = [:]
        for r in try db.query("SELECT key, value FROM settings") { kv[r.str("key")] = r.str("value") }
        var s = ExecSettings()
        if let t = kv["transport"] { s.transport = t }
        if let k = kv["kill_switch"] { s.killSwitch = !(k == "0" || k.lowercased() == "false") } else { s.killSwitch = true }
        if let b = kv["breaker_on_failure"] { s.breakerOnFailure = !(b == "0" || b.lowercased() == "false") }
        if kv["contacts_transport"] == "live" { s.contactsTransport = "live" }
        return s
    }
}

/// The one timing rule: consecutive sends are this many seconds apart. A constant, not a setting.
public enum SendGap {
    public static let seconds: Double = 2

    /// Seconds still to wait before the next send may start, given when the previous attempt finished (0 = go now).
    public static func remaining(now: Date, lastFinished: Date?) -> Double {
        guard let last = lastFinished else { return 0 }
        let r = last.addingTimeInterval(seconds).timeIntervalSince(now)
        return r > 0 ? min(r, seconds) : 0     // never wait more than the gap, even if the clock moved backwards
    }
}

/// Small key/value state in `exec_state` (created by the executor itself, see CLAUDE notes in the report).
public struct ExecState {
    let db: Database
    public init(db: Database) { self.db = db }

    public func ensureTable() throws {
        try db.exec("CREATE TABLE IF NOT EXISTS exec_state (key TEXT PRIMARY KEY, value TEXT)")
    }
    public func get(_ key: String) throws -> String? {
        try db.one("SELECT value FROM exec_state WHERE key = ?", [.text(key)])?.text("value")
    }
    public func set(_ key: String, _ value: String) throws {
        try db.exec("INSERT INTO exec_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [.text(key), .text(value)])
    }
}
