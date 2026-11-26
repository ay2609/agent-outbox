import Foundation
import Darwin

/// Keeps the Agent Outbox server (Contents/MacOS/agent-outbox server --app-auth-fd 3) running while the app is open.
/// (SECURITY.md has the security model.)
///  - token: 32 random bytes (SecRandomCopyBytes), base64url, kept for this app launch (same across restarts);
///  - fd 3 of the child = read end of a pipe the app writes `token\n` into and closes;
///  - stdin of the child = a pipe the app keeps open: when the app dies the pipe closes and the server exits (lifeline);
///  - stdout / stderr go to <state>/logs/outboxd.{out,err}.log;
///  - restarts with backoff (1, 2, 4 ... 30 s; the counter resets after a run of 30 s or more).
/// Env passes through (OUTBOX_PORT, OUTBOX_HOME). Override the binary with AGENT_OUTBOX_SERVER_BIN (development).
final class Supervisor: ObservableObject, @unchecked Sendable {
    enum State: Equatable {
        case stopped, starting, running(pid_t), backoff(Int), failed(String)
        var isRunning: Bool { if case .running = self { return true }; return false }
        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting"
            case .running: return "Running"
            case .backoff(let s): return "Restarting in \(s) s"
            case .failed(let m): return m
            }
        }
    }

    @Published private(set) var state: State = .stopped
    /// Why the last start failed (kept while the state shows the backoff).
    @Published private(set) var lastFailure: String = ""
    let token: String
    private let stateDir: String
    private let command: [String]          // argv; argv[0] is the executable
    private let extraEnv: [String: String]
    private let lock = NSLock()
    private var _pid: pid_t?
    private var lifelineFD: Int32 = -1
    private var wanted = false
    private var failures = 0
    private var generation = 0

    var serverPID: pid_t? { lock.lock(); defer { lock.unlock() }; return _pid }

    /// `command` defaults to `[serverBin, "server", "--app-auth-fd", "3"]`; tests pass their own.
    init(stateDir: String = AppEnv.stateDir, command: [String]? = nil, extraEnv: [String: String] = [:]) {
        self.stateDir = stateDir
        self.command = command ?? [AppEnv.serverBin, "server", "--app-auth-fd", "3"]
        self.extraEnv = extraEnv
        var bytes = [UInt8](repeating: 0, count: 32)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            // Never fall back to a weak source: a token we cannot make means no server.
            token = ""
            return
        }
        token = b64url(Data(bytes))
    }

    private func publish(_ s: State) {
        DispatchQueue.main.async {
            if case .failed(let m) = s { self.lastFailure = m } else if case .running = s { self.lastFailure = "" }
            self.state = s
        }
    }

    func start() {
        lock.lock()
        if wanted { lock.unlock(); return }
        wanted = true; generation += 1
        let gen = generation
        lock.unlock()
        if token.isEmpty { publish(.failed("Could not create a secure token.")); return }
        spawn(gen)
    }

    /// Closes the lifeline (the server exits on stdin EOF), waits briefly, then SIGTERMs.
    func stop() {
        lock.lock()
        wanted = false; generation += 1
        let pid = _pid, fd = lifelineFD
        lifelineFD = -1
        lock.unlock()
        if fd >= 0 { close(fd) }
        if let pid {
            let deadline = Date().addingTimeInterval(3)
            while Date() < deadline, kill(pid, 0) == 0 { usleep(50_000) }
            if kill(pid, 0) == 0 { kill(pid, SIGTERM) }
        }
        publish(.stopped)
    }

    private func spawn(_ gen: Int) {
        publish(.starting)
        let fm = FileManager.default
        let logs = stateDir + "/logs"
        try? fm.createDirectory(atPath: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let exe = command[0]
        guard fm.isExecutableFile(atPath: exe) else {
            publish(.failed("The server program is missing: \(exe)"))
            scheduleRestart(gen, ranFor: 0)
            return
        }
        var tokenPipe: [Int32] = [0, 0], lifePipe: [Int32] = [0, 0]
        guard pipe(&tokenPipe) == 0, pipe(&lifePipe) == 0 else { publish(.failed("pipe() failed")); return }
        // Move every end to fd >= 10 (a pipe end that happened to be fd 0 to 3 would collide with the dup2 targets below: dup2(3, 3)
        // is a no-op that keeps close-on-exec, and the child would lose it) and mark them close-on-exec: only the descriptors
        // mapped below reach the child, and no other child of this app inherits them.
        func high(_ fd: Int32) -> Int32 { let n = fcntl(fd, F_DUPFD_CLOEXEC, 10); close(fd); return n }
        tokenPipe = tokenPipe.map(high); lifePipe = lifePipe.map(high)
        guard !tokenPipe.contains(-1), !lifePipe.contains(-1) else { publish(.failed("could not set up pipes")); return }

        var fa: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&fa)
        defer { posix_spawn_file_actions_destroy(&fa) }
        posix_spawn_file_actions_adddup2(&fa, tokenPipe[0], 3)
        posix_spawn_file_actions_adddup2(&fa, lifePipe[0], 0)
        posix_spawn_file_actions_addopen(&fa, 1, logs + "/outboxd.out.log", O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_addopen(&fa, 2, logs + "/outboxd.err.log", O_WRONLY | O_CREAT | O_APPEND, 0o600)
        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT))

        var env = ProcessInfo.processInfo.environment
        env["OUTBOX_HOME"] = stateDir
        for (k, v) in extraEnv { env[k] = v }
        let argv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { for p in argv { free(p) }; for p in envp { free(p) } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, exe, &fa, &attr, argv, envp)
        close(tokenPipe[0]); close(lifePipe[0])
        if rc != 0 {
            close(tokenPipe[1]); close(lifePipe[1])
            publish(.failed("Could not start the server (error \(rc))."))
            scheduleRestart(gen, ranFor: 0)
            return
        }
        // Hand over the token: one line, then close, so the server reads to EOF.
        let line = Array((token + "\n").utf8)
        _ = line.withUnsafeBytes { write(tokenPipe[1], $0.baseAddress, $0.count) }
        close(tokenPipe[1])

        lock.lock()
        _pid = pid; lifelineFD = lifePipe[1]
        lock.unlock()
        publish(.running(pid))
        let started = Date()
        Thread.detachNewThread { [weak self] in
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            self?.exited(pid: pid, gen: gen, ranFor: Date().timeIntervalSince(started))
        }
    }

    private func exited(pid: pid_t, gen: Int, ranFor: TimeInterval) {
        lock.lock()
        // Only the CURRENT child's lifeline is ours to close: after stop() + start() a newer child owns lifelineFD, and closing it
        // would make that server exit (stdin EOF).
        var fd: Int32 = -1
        if _pid == pid { _pid = nil; fd = lifelineFD; lifelineFD = -1 }
        let again = wanted && gen == generation
        lock.unlock()
        if fd >= 0 { close(fd) }
        if again { scheduleRestart(gen, ranFor: ranFor) }
    }

    private func scheduleRestart(_ gen: Int, ranFor: TimeInterval) {
        lock.lock()
        failures = ranFor >= 30 ? 1 : failures + 1
        let delay = min(30, 1 << min(failures - 1, 5))
        lock.unlock()
        publish(.backoff(delay))
        DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(delay)) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let ok = self.wanted && gen == self.generation && self._pid == nil
            self.lock.unlock()
            if ok { self.spawn(gen) }
        }
    }
}
