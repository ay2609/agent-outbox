import Foundation
import Darwin
import OwnerAPI

/// `Agent Outbox --selfcheck`: headless checks of everything that doesn't need a window.
/// Uses only temp directories. It never reads the real state directory, never touches LaunchAgents or login items.
enum SelfCheck {
    private static var passed = 0, failed = 0
    private static func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
        if ok { passed += 1; print("  ok   \(name)") } else { failed += 1; print("  FAIL \(name) \(detail())") }
    }
    private static func crlf(_ s: String) -> Data { Data(s.replacingOccurrences(of: "\n", with: "\r\n").utf8) }

    static func run() -> Int32 {
        print("Agent Outbox self-check")
        parser(); preflight(); socketClient(); supervisor(); migration(); setupAndLinks(); claude()
        print("\n\(passed) passed, \(failed) failed")
        return failed == 0 ? 0 : 1
    }

    // MARK: HTTP parser
    static func parser() {
        print("HTTP response parser")
        let cl = crlf("HTTP/1.1 200 OK\nContent-Type: application/json\nContent-Length: 11\n\n{\"ok\":true}")
        let r1 = try? HTTPParser.parse(cl, eof: false)
        check("Content-Length body", r1?.status == 200 && String(decoding: r1?.body ?? Data(), as: UTF8.self) == "{\"ok\":true}")
        check("Content-Length incomplete", (try? HTTPParser.parse(cl.dropLast(3), eof: false)) == nil)
        check("Content-Length truncated at EOF is an error", (try? HTTPParser.parse(cl.dropLast(3), eof: true)) == nil)
        let ch = crlf("HTTP/1.1 201 Created\nTransfer-Encoding: chunked\n\n5\nhello\n6;ext=1\n, worl\n1\nd\n0\n\n")
        let r2 = try? HTTPParser.parse(ch, eof: false)
        check("chunked body, several chunks and an extension", r2?.status == 201 && String(decoding: r2?.body ?? Data(), as: UTF8.self) == "hello, world")
        check("chunked incomplete", (try? HTTPParser.parse(ch.dropLast(5), eof: false)) == nil)
        var multibyte = crlf("HTTP/1.1 200 OK\nTransfer-Encoding: chunked\n\n")
        let utf = Data("héllo ✓".utf8)
        multibyte.append(Data("\(String(utf.count, radix: 16))\r\n".utf8)); multibyte.append(utf); multibyte.append(Data("\r\n0\r\n\r\n".utf8))
        check("chunk sizes count bytes, not characters", String(decoding: (try? HTTPParser.parse(multibyte, eof: false))?.body ?? Data(), as: UTF8.self) == "héllo ✓")
        let eofBody = crlf("HTTP/1.1 200 OK\nConnection: close\n\nuntil the end")
        check("body without length waits for EOF", (try? HTTPParser.parse(eofBody, eof: false)) == nil && String(decoding: (try? HTTPParser.parse(eofBody, eof: true))?.body ?? Data(), as: UTF8.self) == "until the end")
        let e204 = try? HTTPParser.parse(crlf("HTTP/1.1 204 No Content\n\n"), eof: false)
        check("204 has no body", e204?.status == 204 && e204?.body.isEmpty == true)
        check("garbage status line rejected", (try? HTTPParser.parse(crlf("NOPE\n\n"), eof: true)) == nil)
        check("bad chunk size rejected", (try? HTTPParser.parse(crlf("HTTP/1.1 200 OK\nTransfer-Encoding: chunked\n\nzz\nabc\n0\n\n"), eof: true)) == nil)
        let req = String(decoding: HTTPParser.request(method: "POST", path: "/api/stop", json: Data("{}".utf8), token: "TOK"), as: UTF8.self)
        check("request carries Host, Connection, X-Outbox, X-Outbox-App, Content-Length",
              req.hasPrefix("POST /api/stop HTTP/1.1\r\n") && req.contains("Host: agent-outbox\r\n") && req.contains("Connection: close\r\n")
              && req.contains("X-Outbox: 1\r\n") && req.contains("X-Outbox-App: TOK\r\n") && req.contains("Content-Length: 2\r\n") && req.hasSuffix("\r\n\r\n{}"))
    }

    // MARK: temp dirs and sockets
    static func tempDir() -> String {
        var t = Array("/tmp/aoc-XXXXXX".utf8CString)
        guard mkdtemp(&t) != nil else { fatalError("mkdtemp") }
        return String(cString: t)
    }
    static func listen(_ path: String) -> Int32 {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        let b = Array(path.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in for (i, x) in b.enumerated() { raw[i] = x }; raw[b.count] = 0 }
        let rc = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        precondition(rc == 0 && Darwin.listen(fd, 4) == 0, "bind/listen failed")
        return fd
    }

    // MARK: socket preflight
    static func preflight() {
        print("socket preflight (lstat checks)")
        let root = tempDir(); defer { try? FileManager.default.removeItem(atPath: root) }
        let run = root + "/run", sock = run + "/owner.sock"
        check("missing socket = not running", SocketOwnerAPIClient.preflight(socketPath: sock) == .notRunning)
        try? FileManager.default.createDirectory(atPath: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        FileManager.default.createFile(atPath: sock, contents: Data(), attributes: nil)
        if case .socketUnsafe? = SocketOwnerAPIClient.preflight(socketPath: sock) { check("regular file refused", true) } else { check("regular file refused", false) }
        try? FileManager.default.removeItem(atPath: sock)
        let fd = listen(sock); defer { close(fd) }
        check("real socket in a 0700 folder passes", SocketOwnerAPIClient.preflight(socketPath: sock) == nil)
        if case .socketUnsafe? = SocketOwnerAPIClient.preflight(socketPath: sock, uid: getuid() &+ 1) { check("socket owned by someone else refused", true) } else { check("socket owned by someone else refused", false) }
        chmod(run, 0o755)
        if case .socketUnsafe? = SocketOwnerAPIClient.preflight(socketPath: sock) { check("folder open to others refused", true) } else { check("folder open to others refused", false) }
        chmod(run, 0o700)
        let link = run + "/link.sock"
        symlink(sock, link)
        if case .socketUnsafe? = SocketOwnerAPIClient.preflight(socketPath: link) { check("symlink refused (lstat, not stat)", true) } else { check("symlink refused (lstat, not stat)", false) }
    }

    // MARK: full request over a socket, peer-pid check
    final class Capture: @unchecked Sendable { var bytes = Data(); let l = NSLock() }

    static func socketClient() {
        print("socket client")
        let root = tempDir(); defer { try? FileManager.default.removeItem(atPath: root) }
        let run = root + "/run"
        try? FileManager.default.createDirectory(atPath: run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let sock = run + "/owner.sock"
        let lfd = listen(sock); defer { close(lfd) }
        let cap = Capture()
        let body = Data("{\"hello\":\"native\"}".utf8)
        var resp = crlf("HTTP/1.1 200 OK\nContent-Type: application/json\nTransfer-Encoding: chunked\nConnection: close\n\n")
        resp.append(Data("5\r\n".utf8)); resp.append(body.prefix(5)); resp.append(Data("\r\n".utf8))
        resp.append(Data("\(String(body.count - 5, radix: 16))\r\n".utf8)); resp.append(body.dropFirst(5)); resp.append(Data("\r\n0\r\n\r\n".utf8))
        let serving = Thread {
            while true {
                let c = accept(lfd, nil, nil)
                if c < 0 { return }
                var tv = timeval(tv_sec: 1, tv_usec: 0)
                setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
                var buf = [UInt8](repeating: 0, count: 8192)
                let n = read(c, &buf, buf.count)
                if n > 0 { cap.l.lock(); cap.bytes.append(buf, count: n); cap.l.unlock(); resp.withUnsafeBytes { _ = write(c, $0.baseAddress, $0.count) } }
                close(c)
            }
        }
        serving.start()
        let sem = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: Result<(status: Int, body: Data), Error>?
        let good = SocketOwnerAPIClient(stateDir: root, token: { "TOKEN-123" }, expectedPID: { getpid() })
        Task { do { result = .success(try await good.request("POST", "/api/mode", json: Data("{\"mode\":\"dry\"}".utf8))) } catch { result = .failure(error) }; sem.signal() }
        sem.wait()
        if case .success(let r)? = result {
            check("request returns status and the de-chunked body", r.status == 200 && r.body == body)
        } else { check("request returns status and the de-chunked body", false, "\(String(describing: result))") }
        cap.l.lock(); let sent = String(decoding: cap.bytes, as: UTF8.self); cap.l.unlock()
        check("server saw X-Outbox-App token, X-Outbox, Host: agent-outbox, body",
              sent.contains("X-Outbox-App: TOKEN-123") && sent.contains("X-Outbox: 1") && sent.contains("Host: agent-outbox") && sent.hasSuffix("{\"mode\":\"dry\"}"), sent)

        cap.l.lock(); cap.bytes = Data(); cap.l.unlock()
        let bad = SocketOwnerAPIClient(stateDir: root, token: { "TOKEN-123" }, expectedPID: { getpid() &+ 1 })
        result = nil
        Task { do { result = .success(try await bad.request("GET", "/api/status", json: nil)) } catch { result = .failure(error) }; sem.signal() }
        sem.wait()
        if case .failure(let e)? = result, let oe = e as? OwnerAPIError { check("wrong peer pid is refused with the specified message", oe == .peerMismatch && oe.description == "Another program is answering for the Agent Outbox server.") }
        else { check("wrong peer pid is refused with the specified message", false) }
        usleep(150_000)
        cap.l.lock(); let leaked = cap.bytes.count; cap.l.unlock()
        check("nothing (no token) was written to the wrong peer", leaked == 0, "\(leaked) bytes")

        let none = SocketOwnerAPIClient(stateDir: root, token: { "T" }, expectedPID: { nil })
        result = nil
        Task { do { result = .success(try await none.request("GET", "/api/status", json: nil)) } catch { result = .failure(error) }; sem.signal() }
        sem.wait()
        if case .failure(let e)? = result { check("no supervised server = notRunning", (e as? OwnerAPIError) == .notRunning) } else { check("no supervised server = notRunning", false) }
    }

    // MARK: supervisor
    static func supervisor() {
        print("supervisor")
        let root = tempDir(); defer { try? FileManager.default.removeItem(atPath: root) }
        // A stand-in server: reads one line from fd 3, records it, then lives until stdin closes (the lifeline).
        let script = "IFS= read -r t <&3; printf '%s' \"$t\" > \"$OUTBOX_HOME/tok\"; echo started; cat > /dev/null; echo lifeline-closed > \"$OUTBOX_HOME/bye\""
        let sup = Supervisor(stateDir: root, command: ["/bin/sh", "-c", script])
        check("token is 43 base64url characters", sup.token.count == 43 && !sup.token.contains("+") && !sup.token.contains("/") && !sup.token.contains("="))
        sup.start()
        let deadline = Date().addingTimeInterval(5)
        while sup.serverPID == nil && Date() < deadline { usleep(50_000) }
        check("server spawned, pid known", sup.serverPID != nil)
        var got = ""
        while Date() < deadline { got = (try? String(contentsOfFile: root + "/tok", encoding: .utf8)) ?? ""; if !got.isEmpty { break }; usleep(50_000) }
        check("token arrived on fd 3 (without the newline)", got == sup.token, got)
        let out = (try? String(contentsOfFile: root + "/logs/outboxd.out.log", encoding: .utf8)) ?? ""
        check("stdout goes to logs/outboxd.out.log", out.contains("started"), out)
        let pid = sup.serverPID
        sup.stop()
        let d2 = Date().addingTimeInterval(5)
        while let p = pid, kill(p, 0) == 0, Date() < d2 { usleep(50_000) }
        check("closing the lifeline ends the server", FileManager.default.fileExists(atPath: root + "/bye"))
        check("stopped supervisor has no pid", sup.serverPID == nil)
        let missing = Supervisor(stateDir: root, command: ["/nonexistent/agent-outbox", "server"])
        missing.start(); usleep(200_000)
        check("missing binary does not crash, no pid", missing.serverPID == nil)
        missing.stop()
        check("default server binary comes from the bundle or AGENT_OUTBOX_SERVER_BIN", AppEnv.serverBin.hasSuffix("/agent-outbox") || AppEnv.env["AGENT_OUTBOX_SERVER_BIN"] != nil)
    }

    // MARK: migration and claude connect (injected runners and temp dirs only)
    static func migration() {
        print("migration (temp folder, recording runner; the real LaunchAgents are never touched)")
        let root = tempDir(); defer { try? FileManager.default.removeItem(atPath: root) }
        check("nothing to migrate in an empty folder", Migration.detect(agentsDir: root, loaded: { _ in false }).isEmpty)
        for l in Migration.labels { FileManager.default.createFile(atPath: root + "/\(l).plist", contents: Data("<plist/>".utf8)) }
        FileManager.default.createFile(atPath: root + "/com.claude.imessage-outbox.plist", contents: Data("<plist/>".utf8))
        check("both old agents detected, the private install ignored", Migration.detect(agentsDir: root, loaded: { _ in false }) == Migration.labels)
        nonisolated(unsafe) var calls: [String] = []
        let res = Migration.perform(agentsDir: root, uid: 501, loaded: { _ in false }) { exe, args in calls.append(([exe] + args).joined(separator: " ")); return (0, "") }
        check("bootout gui/<uid>/<label> for each", calls == Migration.labels.map { "/bin/launchctl bootout gui/501/\($0)" }, "\(calls)")
        check("plists removed, others kept", res.removed == Migration.labels && !FileManager.default.fileExists(atPath: root + "/io.github.ay2609.agent-outbox.plist") && FileManager.default.fileExists(atPath: root + "/com.claude.imessage-outbox.plist"))
        check("detect is empty afterwards", Migration.detect(agentsDir: root, loaded: { _ in false }).isEmpty)
        FileManager.default.createFile(atPath: root + "/io.github.ay2609.agent-outbox.plist", contents: Data("<plist/>".utf8))
        let failing = Migration.perform(agentsDir: root, uid: 501, loaded: { _ in false }) { _, _ in (5, "Boot-out failed: 5") }
        check("a failing bootout keeps the plist and reports", failing.removed.isEmpty && failing.problems.count == 1 && FileManager.default.fileExists(atPath: root + "/io.github.ay2609.agent-outbox.plist"))
    }

    static func setupAndLinks() {
        print("setup, recover command, deep links, hold reasons")
        let bin = "/Applications/Agent Outbox.app/Contents/MacOS/agent-outbox"
        check("recover command is the bundle's own binary, single-quoted", AppEnv.recoverCommand(bin: bin, home: nil) == "'\(bin)' recover")
        check("recover command carries OUTBOX_HOME when set", AppEnv.recoverCommand(bin: bin, home: "/tmp/it's") == "OUTBOX_HOME='/tmp/it'\\''s' '\(bin)' recover")
        let su = SetupInfo(["setup": ["done": true, "proof_available": "recovery_token", "recovery_expires_at": "2026-11-26T10:30:00.000Z"]])
        check("status.setup: done, recovery token open, opened 30 minutes before it expires",
              su.done && su.recoveryOpen && su.recoveryOpenedAt == parseISO("2026-11-26T10:00:00.000Z"))
        let none = SetupInfo(["setup": ["done": true, "proof_available": NSNull(), "recovery_expires_at": NSNull()]])
        check("status.setup: done with no proof means the Terminal step", none.done && none.proof == nil && !none.recoveryOpen)
        func link(_ s: String) -> DeepLink? { URL(string: s).flatMap(DeepLink.parse) }
        check("deep link: inbox", link("agent-outbox://inbox") == .inbox)
        check("deep link: batch", link("agent-outbox://batch/01HX-abc_9") == .batch("01HX-abc_9"))
        check("deep link: contact changes", link("agent-outbox://contacts/changes/s1") == .contactChanges("s1"))
        check("deep link: imports and groups", link("agent-outbox://imports/i1") == .importRef("i1") && link("agent-outbox://groups/g1") == .group("g1"))
        check("deep link: other schemes, unknown routes, odd ids and extra parts are ignored",
              link("https://batch/b1") == nil && link("agent-outbox://settings") == nil && link("agent-outbox://batch/b1/approve") == nil
              && link("agent-outbox://batch/a%20b") == nil && link("agent-outbox://batch") == nil && link("agent-outbox://contacts/s1") == nil)
        check("hold reasons: old pin, browser keys, no key", HoldReason.plain("pin version 2 holds browser passkeys, which Agent Outbox no longer accepts")?.contains("Touch ID") == true
              && HoldReason.plain("The pin file is version 2: it holds browser passkeys, which Agent Outbox no longer accepts.")?.contains("Touch ID") == true
              && HoldReason.plain("v4 pin must have exactly the keys")?.contains("Touch ID") == true
              && HoldReason.plain("WebAuthn keys are no longer accepted")?.contains("passkey") == true
              && HoldReason.plain("credential_id is not in the pin file")?.contains("doesn't trust any approval key") == true
              && HoldReason.plain("something unrelated") == nil && HoldReason.plain("") == nil)
    }

    static func claude() {
        print("Connect Claude Code (fake runner)")
        let bin = "/Applications/Agent Outbox.app/Contents/MacOS/agent-outbox"
        nonisolated(unsafe) var log: [[String]] = []
        let fresh = ClaudeConnect.connect(claude: "/x/claude", bin: bin, stateDirOverride: nil) { _, a in log.append(a); return a.starts(with: ["mcp", "get"]) ? (1, "not found") : (0, "ok") }
        check("adds with --scope user and the bundle binary", fresh.ok && log.last == ["mcp", "add", "--scope", "user", "agent-outbox", "--", bin, "mcp"], "\(log)")
        log = []
        let repoint = ClaudeConnect.connect(claude: "/x/claude", bin: bin, stateDirOverride: "/tmp/h") { _, a in log.append(a); return a.starts(with: ["mcp", "get"]) ? (0, "Command: bun run /old/src/mcp/index.ts") : (0, "ok") }
        check("an old registration is removed, then re-added with OUTBOX_HOME", repoint.ok && log.contains(["mcp", "remove", "--scope", "user", "agent-outbox"]) && log.last == ["mcp", "add", "--scope", "user", "agent-outbox", "-e", "OUTBOX_HOME=/tmp/h", "--", bin, "mcp"], "\(log)")
        let same = ClaudeConnect.connect(claude: "/x/claude", bin: bin, stateDirOverride: nil) { _, a in a.starts(with: ["mcp", "get"]) ? (0, "Command: \(bin) mcp") : (9, "should not run") }
        check("already registered to this app = no change", same.ok && same.message == "Already connected.")
        let json = ClaudeConnect.configJSON(bin: bin, stateDirOverride: nil)
        let parsed = parseJSON(Data(json.utf8)).obj("mcpServers").obj("agent-outbox")
        check("config JSON for other clients", parsed.str("command") == bin && (parsed["args"] as? [String]) == ["mcp"])
        check("claude lookup lists common folders", ClaudeConnect.candidates(env: ["PATH": "/a:/b"], home: "/h").prefix(2) == ["/a/claude", "/b/claude"] && ClaudeConnect.candidates(env: [:], home: "/h").contains("/h/.local/bin/claude"))
    }
}
