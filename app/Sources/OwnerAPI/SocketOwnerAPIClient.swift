import Foundation
import Darwin

public enum OwnerAPIError: Error, CustomStringConvertible, Equatable {
    /// No socket yet: the server has not started or has stopped.
    case notRunning
    /// lstat checks failed (not a socket, wrong owner, folder open to others).
    case socketUnsafe(String)
    /// A different process answers on the socket than the one this app started.
    case peerMismatch
    case io(String)
    case badResponse(String)
    public var description: String {
        switch self {
        case .notRunning: return "The Agent Outbox server isn't running."
        case .socketUnsafe(let m): return "The server socket isn't safe to use: \(m)"
        case .peerMismatch: return "Another program is answering for the Agent Outbox server."
        case .io(let m): return "Can't talk to the server: \(m)"
        case .badResponse(let m): return "The server sent a reply the app can't read: \(m)"
        }
    }
}

/// State directory: env OUTBOX_HOME, else ~/Library/Application Support/agent-outbox.
public func outboxStateDir(env: [String: String] = ProcessInfo.processInfo.environment) -> String {
    if let h = env["OUTBOX_HOME"], !h.isEmpty { return h }
    return NSHomeDirectory() + "/Library/Application Support/agent-outbox"
}

/// Owner API over the unix socket.
public final class SocketOwnerAPIClient: OwnerAPIClient, @unchecked Sendable {
    public let socketPath: String
    private let token: @Sendable () -> String?
    private let expectedPID: @Sendable () -> pid_t?

    /// `token`: the per-launch token. `expectedPID`: the supervised server's pid (nil = not running).
    public init(stateDir: String = outboxStateDir(), token: @escaping @Sendable () -> String?, expectedPID: @escaping @Sendable () -> pid_t?) {
        self.socketPath = stateDir + "/run/owner.sock"
        self.token = token
        self.expectedPID = expectedPID
    }

    /// lstat checks before connecting: the path is a socket owned by this user, in a folder owned by this user with mode 0700.
    /// Returns nil when fine, `.notRunning` when absent, `.socketUnsafe` otherwise. `uid` is injectable for tests.
    public static func preflight(socketPath: String, uid: uid_t = getuid()) -> OwnerAPIError? {
        var st = stat()
        if lstat(socketPath, &st) != 0 {
            return errno == ENOENT ? .notRunning : .socketUnsafe("can't inspect it (errno \(errno))")
        }
        if (st.st_mode & S_IFMT) != S_IFSOCK { return .socketUnsafe("it is not a socket") }
        if st.st_uid != uid { return .socketUnsafe("it belongs to another user") }
        let dir = (socketPath as NSString).deletingLastPathComponent
        var ds = stat()
        if lstat(dir, &ds) != 0 { return .socketUnsafe("its folder can't be inspected") }
        if (ds.st_mode & S_IFMT) != S_IFDIR { return .socketUnsafe("its folder is not a folder") }
        if ds.st_uid != uid { return .socketUnsafe("its folder belongs to another user") }
        if (ds.st_mode & 0o077) != 0 { return .socketUnsafe("its folder is open to other users (mode \(String(ds.st_mode & 0o777, radix: 8)))") }
        return nil
    }

    public func request(_ method: String, _ path: String, json: Data?) async throws -> (status: Int, body: Data) {
        let tok = token(), pid = expectedPID()
        let sock = socketPath
        return try await Task.detached(priority: .userInitiated) { [self] in
            guard let tok, let pid else { throw OwnerAPIError.notRunning }
            return try blockingRequest(method, path, json, token: tok, pid: pid, socketPath: sock)
        }.value
    }

    private func blockingRequest(_ method: String, _ path: String, _ json: Data?, token: String, pid: pid_t, socketPath: String) throws -> (status: Int, body: Data) {
        if let e = Self.preflight(socketPath: socketPath) { throw e }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw OwnerAPIError.io("socket() failed") }
        defer { close(fd) }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 60, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        let cap = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < cap else { throw OwnerAPIError.socketUnsafe("the path is longer than a unix socket allows (\(cap - 1) bytes); use a shorter OUTBOX_HOME") }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let rc = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) }
        }
        if rc != 0 { throw (errno == ECONNREFUSED || errno == ENOENT) ? OwnerAPIError.notRunning : OwnerAPIError.io("connect: errno \(errno)") }

        // The peer must be the server this app started. Otherwise close WITHOUT writing: the token never leaves the app.
        var peer: pid_t = 0
        var plen = socklen_t(MemoryLayout<pid_t>.size)
        if getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer, &plen) != 0 || peer != pid { throw OwnerAPIError.peerMismatch }

        let req = HTTPParser.request(method: method, path: path, json: json, token: token)
        try req.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var off = 0
            while off < raw.count {
                let n = write(fd, raw.baseAddress! + off, raw.count - off)
                if n < 0 { if errno == EINTR { continue }; throw OwnerAPIError.io("write: errno \(errno)") }
                off += n
            }
        }
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n < 0 { if errno == EINTR { continue }; throw OwnerAPIError.io("read: errno \(errno)") }
            if n == 0 { break }
            buf.append(chunk, count: n)
            if buf.count > HTTPParser.maxBytes { throw OwnerAPIError.badResponse("too large") }
            // Stop early once a complete response is in hand (the server closes anyway).
            if let r = try? HTTPParser.parse(buf, eof: false) { return (r.status, r.body) }
        }
        do { let r = try HTTPParser.parse(buf, eof: true); return (r.status, r.body) }
        catch { throw OwnerAPIError.badResponse("\(error)") }
    }
}
