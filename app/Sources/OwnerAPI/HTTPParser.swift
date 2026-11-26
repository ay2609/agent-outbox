import Foundation

/// A minimal HTTP/1.1 response parser for the owner API socket (the server always answers `Connection: close`).
/// Handles Content-Length bodies, chunked bodies and "read until EOF" bodies. Pure value logic: no sockets, so it is
/// covered by `Agent Outbox --selfcheck`.
public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    public var headers: [String: String]   // lower-cased names
    public var body: Data
}

public enum HTTPParseError: Error, Equatable, CustomStringConvertible {
    case incomplete
    case malformed(String)
    public var description: String {
        switch self { case .incomplete: return "incomplete response"; case .malformed(let m): return "malformed response: \(m)" }
    }
}

public enum HTTPParser {
    /// Largest response the app accepts (batches with 500 drafts are well below this).
    public static let maxBytes = 64 * 1024 * 1024

    /// Parses `data` as a whole response. `eof` = the peer closed the connection (a body with no length is then complete).
    /// Throws `.incomplete` when more bytes are needed.
    public static func parse(_ data: Data, eof: Bool) throws -> HTTPResponse {
        let bytes = [UInt8](data)
        guard let headEnd = find(bytes, [13, 10, 13, 10], from: 0) else {
            if eof { throw HTTPParseError.malformed("no header terminator") }
            throw HTTPParseError.incomplete
        }
        guard let head = String(bytes: bytes[0..<headEnd], encoding: .isoLatin1) else { throw HTTPParseError.malformed("header encoding") }
        var lines = head.components(separatedBy: "\r\n")
        let statusLine = lines.removeFirst()
        let parts = statusLine.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
        guard parts.count >= 2, parts[0].hasPrefix("HTTP/1."), let status = Int(parts[1]) else {
            throw HTTPParseError.malformed("status line")
        }
        var headers: [String: String] = [:]
        for l in lines {
            guard let c = l.firstIndex(of: ":") else { throw HTTPParseError.malformed("header line") }
            let k = l[l.startIndex..<c].trimmingCharacters(in: .whitespaces).lowercased()
            let v = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
            headers[k] = v
        }
        let bodyStart = headEnd + 4
        // 1xx, 204 and 304 carry no body.
        if status == 204 || status == 304 || (100..<200).contains(status) {
            return HTTPResponse(status: status, headers: headers, body: Data())
        }
        if let te = headers["transfer-encoding"], te.lowercased().contains("chunked") {
            var body = [UInt8]()
            var i = bodyStart
            while true {
                guard let lineEnd = find(bytes, [13, 10], from: i) else { throw eof ? HTTPParseError.malformed("truncated chunk header") : HTTPParseError.incomplete }
                let sizeText = String(bytes: bytes[i..<lineEnd], encoding: .ascii) ?? ""
                let hex = sizeText.split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
                guard !hex.isEmpty, let size = Int(hex, radix: 16), size >= 0 else { throw HTTPParseError.malformed("chunk size") }
                i = lineEnd + 2
                if size == 0 {
                    // Optional trailers, then a blank line. Accept a missing final CRLF at EOF.
                    if find(bytes, [13, 10], from: i) != nil || eof { return HTTPResponse(status: status, headers: headers, body: Data(body)) }
                    throw HTTPParseError.incomplete
                }
                guard bytes.count >= i + size + 2 else { throw eof ? HTTPParseError.malformed("truncated chunk") : HTTPParseError.incomplete }
                body.append(contentsOf: bytes[i..<(i + size)])
                guard bytes[i + size] == 13, bytes[i + size + 1] == 10 else { throw HTTPParseError.malformed("chunk terminator") }
                i += size + 2
                if body.count > maxBytes { throw HTTPParseError.malformed("response too large") }
            }
        }
        if let cl = headers["content-length"] {
            guard let n = Int(cl), n >= 0, n <= maxBytes else { throw HTTPParseError.malformed("content-length") }
            guard bytes.count >= bodyStart + n else { throw eof ? HTTPParseError.malformed("truncated body") : HTTPParseError.incomplete }
            return HTTPResponse(status: status, headers: headers, body: Data(bytes[bodyStart..<(bodyStart + n)]))
        }
        guard eof else { throw HTTPParseError.incomplete }
        return HTTPResponse(status: status, headers: headers, body: Data(bytes[bodyStart...]))
    }

    static func find(_ hay: [UInt8], _ needle: [UInt8], from: Int) -> Int? {
        guard hay.count >= needle.count, from <= hay.count - needle.count else { return nil }
        var i = from
        let last = hay.count - needle.count
        while i <= last {
            if hay[i] == needle[0] {
                var ok = true
                for j in 1..<needle.count where hay[i + j] != needle[j] { ok = false; break }
                if ok { return i }
            }
            i += 1
        }
        return nil
    }

    /// Builds the request bytes for one call (Connection: close, Host: localhost, X-Outbox, X-Outbox-App).
    public static func request(method: String, path: String, json: Data?, token: String) -> Data {
        var head = "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAccept: application/json\r\nX-Outbox: 1\r\nX-Outbox-App: \(token)\r\n"
        if let j = json { head += "Content-Type: application/json\r\nContent-Length: \(j.count)\r\n" }
        else if method != "GET" && method != "HEAD" { head += "Content-Length: 0\r\n" }
        head += "\r\n"
        var d = Data(head.utf8)
        if let j = json { d.append(j) }
        return d
    }
}
