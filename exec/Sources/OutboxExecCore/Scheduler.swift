import Foundation

/// Optional pacing ("Spread out messages"), owner-only settings. Off = approved messages send right away, SendGap apart.
/// This protects the user's number from looking like a spammer's; it is not a security gate, so a value that makes no sense
/// is clamped or ignored instead of holding sending forever.
public struct PaceSettings: Equatable {
    public var enabled = false
    public var minS = 30.0, maxS = 90.0
    public var dailyCap = 0                 // 0 = no limit
    public var quietStart: Int?, quietEnd: Int?   // minutes after local midnight; nil = no quiet hours

    public init() {}

    /// "HH:MM" -> minutes after midnight.
    public static func minutes(_ s: String) -> Int? {
        let p = s.split(separator: ":")
        guard p.count == 2, p[0].count == 2, p[1].count == 2, let h = Int(p[0]), let m = Int(p[1]), (0...23).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }

    static func load(_ kv: [String: String]) -> PaceSettings {
        var p = PaceSettings()
        p.enabled = kv["pace_enabled"] == "1"
        if let v = kv["pace_min_s"].flatMap(Double.init) { p.minS = v }
        if let v = kv["pace_max_s"].flatMap(Double.init) { p.maxS = v }
        p.minS = min(max(p.minS, 2), 3600)
        p.maxS = min(max(p.maxS, p.minS), 3600)
        if let v = kv["daily_cap"].flatMap({ Int($0) }) { p.dailyCap = min(max(v, 0), 1000) }
        if let s = kv["quiet_start"].flatMap(minutes), let e = kv["quiet_end"].flatMap(minutes), s != e { p.quietStart = s; p.quietEnd = e }
        return p
    }
}

/// Settings as the executor reads them (DB `settings` table). Safety-critical values fail closed.
public struct ExecSettings {
    /// Display only (heartbeat). Which transport an approval uses is decided by its signed manifest and the pin policy.
    public var transport = "dry"
    public var killSwitch = true      // missing or unparseable => engaged
    public var breakerOnFailure = true
    /// v4: display only (heartbeat). Which lane a contact approval uses is decided by its signed manifest and the pin policy.
    public var contactsTransport = "dry"
    public var pace = PaceSettings()

    public static func load(_ db: Database) throws -> ExecSettings {
        var kv: [String: String] = [:]
        for r in try db.query("SELECT key, value FROM settings") { kv[r.str("key")] = r.str("value") }
        var s = ExecSettings()
        if let t = kv["transport"] { s.transport = t }
        if let k = kv["kill_switch"] { s.killSwitch = !(k == "0" || k.lowercased() == "false") } else { s.killSwitch = true }
        if let b = kv["breaker_on_failure"] { s.breakerOnFailure = !(b == "0" || b.lowercased() == "false") }
        if kv["contacts_transport"] == "live" { s.contactsTransport = "live" }
        s.pace = PaceSettings.load(kv)
        return s
    }
}

/// The timing rule while pacing is off: consecutive sends are this many seconds apart. A constant, not a setting.
public enum SendGap {
    public static let seconds: Double = 2

    /// Seconds still to wait before the next send may start, given when the previous attempt finished (0 = go now).
    public static func remaining(now: Date, lastFinished: Date?) -> Double {
        guard let last = lastFinished else { return 0 }
        let r = last.addingTimeInterval(seconds).timeIntervalSince(now)
        return r > 0 ? min(r, seconds) : 0     // never wait more than the gap, even if the clock moved backwards
    }
}

public enum PaceHoldKind: String { case gap, daily, quiet }

/// Why approved messages are waiting, and when sending may continue.
public struct PaceHold: Equatable {
    public let kind: PaceHoldKind
    public let until: Date
}

/// The pacing rules as pure functions (no clock, no database, no randomness of their own), so the selftest can drive them.
public enum Pacing {
    static func calendar(_ tz: TimeZone) -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = tz
        return c
    }

    static func inQuiet(_ t: Date, _ p: PaceSettings, _ cal: Calendar) -> Bool {
        guard let s = p.quietStart, let e = p.quietEnd else { return false }
        let c = cal.dateComponents([.hour, .minute], from: t)
        let cur = (c.hour ?? 0) * 60 + (c.minute ?? 0)
        return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e)      // wraps midnight (21:00 -> 09:00)
    }

    /// The next local time of day `minutes`, strictly after t.
    static func nextOccurrence(after t: Date, minutes: Int, _ cal: Calendar) -> Date {
        let d = cal.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: t) ?? t.addingTimeInterval(3600)
        return d > t ? d : (cal.date(byAdding: .day, value: 1, to: d) ?? d.addingTimeInterval(86_400))
    }

    static func dayStart(_ t: Date, _ tz: TimeZone) -> Date { calendar(tz).startOfDay(for: t) }

    /// nil = a message may start now. `nextSendAt` is the earliest start the random pause allows; `sentToday` counts the sends
    /// that started since local midnight (dry and live both count). The daily limit applies to today only: tomorrow starts at zero.
    public static func evaluate(now: Date, pace: PaceSettings, nextSendAt: Date?, sentToday: Int, tz: TimeZone) -> PaceHold? {
        guard pace.enabled else { return nil }
        let cal = calendar(tz)
        var t = now
        if let n = nextSendAt, n > now { t = n }
        var quiet = false, daily = false
        for _ in 0..<8 {
            if inQuiet(t, pace, cal), let qe = pace.quietEnd { t = nextOccurrence(after: t, minutes: qe, cal); quiet = true; continue }
            if pace.dailyCap > 0, sentToday >= pace.dailyCap, cal.isDate(t, inSameDayAs: now) {
                t = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) ?? t.addingTimeInterval(86_400); daily = true; continue
            }
            break
        }
        guard t > now else { return nil }
        return PaceHold(kind: daily ? .daily : quiet ? .quiet : .gap, until: t)
    }

    /// A random pause, uniform in [min, max] seconds. `random` returns a value in 0..<1.
    public static func drawGap(_ pace: PaceSettings, random: () -> Double) -> Double {
        pace.maxS <= pace.minS ? pace.minS : pace.minS + (pace.maxS - pace.minS) * min(max(random(), 0), 1)
    }

    /// "9:00 pm" style local time for messages and the log (the dashboard formats the ISO time itself).
    static func clockText(_ d: Date, _ tz: TimeZone) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = tz; f.dateFormat = "HH:mm"
        return f.string(from: d)
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
