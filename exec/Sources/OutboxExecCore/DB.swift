import Foundation
import SQLite3

/// A bound SQL parameter. SQL text is always a StaticString (a compile-time literal), values are always bound.
public enum SQLValue: Sendable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByNilLiteral {
    case null
    case int(Int64)
    case double(Double)
    case text(String)
    case blob(Data)

    public init(stringLiteral value: String) { self = .text(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(nilLiteral: ()) { self = .null }
    public static func opt(_ s: String?) -> SQLValue { s.map { .text($0) } ?? .null }
    public static func num(_ i: Int) -> SQLValue { .int(Int64(i)) }
}

public struct Row {
    public let values: [String: SQLValue]
    public func text(_ c: String) -> String? { if case .text(let s)? = values[c] { return s }; return nil }
    public func str(_ c: String) -> String { text(c) ?? "" }
    public func int(_ c: String) -> Int64? {
        switch values[c] {
        case .int(let i)?: return i
        case .double(let d)?: return Int64(d)
        case .text(let s)?: return Int64(s)
        default: return nil
        }
    }
    public func i(_ c: String) -> Int { Int(int(c) ?? 0) }
    public func isNull(_ c: String) -> Bool { if case .null? = values[c] { return true }; return values[c] == nil }
}

public final class Database {
    private var handle: OpaquePointer?
    public let path: String
    private var inTransaction = false

    /// Opens an existing DB read-write (never creates it) unless `create` is true (selftest only).
    public init(path: String, create: Bool = false) throws {
        self.path = path
        var flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        if create { flags |= SQLITE_OPEN_CREATE }
        var h: OpaquePointer?
        let rc = sqlite3_open_v2(path, &h, flags, nil)
        guard rc == SQLITE_OK, let h else {
            let msg = h.map { String(cString: sqlite3_errmsg($0)) } ?? "rc=\(rc)"
            if let h { sqlite3_close(h) }
            throw ExecError("cannot open database \(path): \(msg)")
        }
        handle = h
        sqlite3_busy_timeout(h, 5000)
        try exec("PRAGMA journal_mode = WAL")
        try exec("PRAGMA busy_timeout = 5000")
        try exec("PRAGMA foreign_keys = ON")
    }

    deinit { if let handle { sqlite3_close(handle) } }

    private func errmsg() -> String { handle.map { String(cString: sqlite3_errmsg($0)) } ?? "no db" }

    private func prepare(_ sql: StaticString) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        let rc = sql.withUTF8Buffer { buf -> Int32 in
            buf.baseAddress!.withMemoryRebound(to: CChar.self, capacity: buf.count) {
                sqlite3_prepare_v2(handle, $0, Int32(buf.count), &stmt, nil)
            }
        }
        guard rc == SQLITE_OK, let stmt else { throw ExecError("sql prepare failed: \(errmsg())") }
        return stmt
    }

    private func bind(_ stmt: OpaquePointer, _ params: [SQLValue]) throws {
        let transient = unsafeBitCast(OpaquePointer(bitPattern: -1), to: sqlite3_destructor_type.self)
        for (i, p) in params.enumerated() {
            let idx = Int32(i + 1)
            let rc: Int32
            switch p {
            case .null: rc = sqlite3_bind_null(stmt, idx)
            case .int(let v): rc = sqlite3_bind_int64(stmt, idx, v)
            case .double(let v): rc = sqlite3_bind_double(stmt, idx, v)
            case .text(let s):
                let u = Array(s.utf8)
                if u.isEmpty {
                    rc = sqlite3_bind_text(stmt, idx, "", 0, transient)
                } else {
                    rc = u.withUnsafeBufferPointer { b in
                        b.baseAddress!.withMemoryRebound(to: CChar.self, capacity: u.count) {
                            sqlite3_bind_text(stmt, idx, $0, Int32(u.count), transient)
                        }
                    }
                }
            case .blob(let d):
                rc = d.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(d.count), transient) }
            }
            if rc != SQLITE_OK { throw ExecError("sql bind failed: \(errmsg())") }
        }
    }

    /// Run a statement that returns no rows. Returns the number of rows changed.
    @discardableResult
    public func exec(_ sql: StaticString, _ params: [SQLValue] = []) throws -> Int {
        let stmt = try prepare(sql)
        defer { sqlite3_finalize(stmt) }
        try bind(stmt, params)
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_ROW { continue }
            if rc == SQLITE_DONE { break }
            throw ExecError("sql step failed (\(rc)): \(errmsg())")
        }
        return Int(sqlite3_changes(handle))
    }

    public func query(_ sql: StaticString, _ params: [SQLValue] = []) throws -> [Row] {
        let stmt = try prepare(sql)
        defer { sqlite3_finalize(stmt) }
        try bind(stmt, params)
        var rows: [Row] = []
        let n = sqlite3_column_count(stmt)
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw ExecError("sql step failed (\(rc)): \(errmsg())") }
            var vals: [String: SQLValue] = [:]
            for c in 0..<n {
                let name = String(cString: sqlite3_column_name(stmt, c))
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: vals[name] = .int(sqlite3_column_int64(stmt, c))
                case SQLITE_FLOAT: vals[name] = .double(sqlite3_column_double(stmt, c))
                case SQLITE_TEXT:
                    let len = Int(sqlite3_column_bytes(stmt, c))
                    if let p = sqlite3_column_text(stmt, c) {
                        vals[name] = .text(String(decoding: UnsafeBufferPointer(start: p, count: len), as: UTF8.self))
                    } else { vals[name] = .text("") }
                case SQLITE_BLOB:
                    let len = Int(sqlite3_column_bytes(stmt, c))
                    if let p = sqlite3_column_blob(stmt, c) { vals[name] = .blob(Data(bytes: p, count: len)) } else { vals[name] = .blob(Data()) }
                default: vals[name] = .null
                }
            }
            rows.append(Row(values: vals))
        }
        return rows
    }

    public func one(_ sql: StaticString, _ params: [SQLValue] = []) throws -> Row? {
        try query(sql, params).first
    }

    /// BEGIN IMMEDIATE ... COMMIT; rolls back if `body` throws. Not re-entrant.
    public func transaction<T>(_ body: () throws -> T) throws -> T {
        precondition(!inTransaction, "nested transaction")
        try exec("BEGIN IMMEDIATE")
        inTransaction = true
        defer { inTransaction = false }
        do {
            let r = try body()
            try exec("COMMIT")
            return r
        } catch {
            _ = try? exec("ROLLBACK")
            throw error
        }
    }

    /// Runs a static multi-statement DDL script (schema bootstrap in selftest). Never takes dynamic values.
    public func runSchemaScript(_ script: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(handle, script, nil, nil, &err)
        if rc != SQLITE_OK {
            let m = err.map { String(cString: $0) } ?? "rc=\(rc)"
            sqlite3_free(err)
            throw ExecError("schema script failed: \(m)")
        }
    }

    public func tableExists(_ name: String) throws -> Bool {
        try one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [.text(name)]) != nil
    }
}
