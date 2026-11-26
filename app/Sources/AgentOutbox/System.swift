import Foundation
import ServiceManagement

// MARK: - Login items (SMAppService)

/// Two login items: the app itself (`SMAppService.mainApp`) and the sender (`SMAppService.agent`), a LaunchAgent plist shipped at
/// Contents/Library/LaunchAgents/<label>.plist whose BundleProgram is Contents/Helpers/OutboxExec.app/Contents/MacOS/outbox-exec.
/// Registration only happens from a real bundle and never in dev runs (AGENT_OUTBOX_DEV=1 or not an .app): see AppEnv.isDev.
enum LoginItems {
    static let execLabel = "io.github.ay2609.agent-outbox.exec"
    static var execPlistName: String { execLabel + ".plist" }
    static var execPlistPresent: Bool {
        FileManager.default.fileExists(atPath: AppEnv.bundlePath + "/Contents/Library/LaunchAgents/" + execPlistName)
    }

    struct Summary: Equatable { var app: String; var executor: String; var needsApproval: Bool }

    static func summary() -> Summary {
        if AppEnv.isDev { return Summary(app: "not registered (development run)", executor: "not registered (development run)", needsApproval: false) }
        let a = SMAppService.mainApp.status, e = SMAppService.agent(plistName: execPlistName).status
        return Summary(app: describe(a), executor: execPlistPresent ? describe(e) : "missing from the app bundle", needsApproval: a == .requiresApproval || e == .requiresApproval)
    }

    /// Registers both items. Returns a plain-English problem, or nil.
    @discardableResult
    static func register() -> String? {
        if AppEnv.isDev { return nil }
        var problems: [String] = []
        do { if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() } }
        catch { problems.append("Open at login: \(error.localizedDescription)") }
        if execPlistPresent {
            let svc = SMAppService.agent(plistName: execPlistName)
            do { if svc.status != .enabled { try svc.register() } }
            catch { problems.append("Sender: \(error.localizedDescription)") }
        } else { problems.append("The sender's login item is missing from the app bundle.") }
        return problems.isEmpty ? nil : problems.joined(separator: " ")
    }

    static func unregister() {
        if AppEnv.isDev { return }
        try? SMAppService.mainApp.unregister()
        try? SMAppService.agent(plistName: execPlistName).unregister()
    }

    static func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }

    private static func describe(_ s: SMAppService.Status) -> String {
        switch s {
        case .enabled: return "on"
        case .notRegistered: return "off"
        case .requiresApproval: return "waiting for you to allow it in System Settings"
        case .notFound: return "not found"
        @unknown default: return "unknown"
        }
    }
}

// MARK: - Running commands

typealias CommandRunner = (_ exe: String, _ args: [String]) -> (code: Int32, out: String)

/// Runs a command and returns exit code + combined output. Times out after `timeout` seconds.
func runCommand(_ exe: String, _ args: [String], env: [String: String]? = nil, timeout: TimeInterval = 30) -> (code: Int32, out: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let env { p.environment = ProcessInfo.processInfo.environment.merging(env) { $1 } }
    let pipe = Pipe()
    p.standardOutput = pipe; p.standardError = pipe
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return (127, "could not run \(exe): \(error.localizedDescription)") }
    var data = Data()
    let reader = DispatchQueue(label: "cmd.read")
    let done = DispatchSemaphore(value: 0)
    reader.async { data = pipe.fileHandleForReading.readDataToEndOfFile(); done.signal() }
    let deadline = Date().addingTimeInterval(timeout)
    while p.isRunning && Date() < deadline { usleep(50_000) }
    if p.isRunning { p.terminate() }
    p.waitUntilExit()
    _ = done.wait(timeout: .now() + 2)
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
}

let realRunner: CommandRunner = { exe, args in runCommand(exe, args) }

// MARK: - Migration from the developer install (install.sh LaunchAgents)

/// The old install ran two LaunchAgents from ~/Library/LaunchAgents. The app replaces them: `launchctl bootout` each, delete the
/// plists, keep the state directory (database, keys, pin). Testable: directory, uid and the command runner are injected.
/// NEVER call `perform` from the self-check against the real LaunchAgents folder.
enum Migration {
    static let labels = ["io.github.ay2609.agent-outbox", "io.github.ay2609.agent-outbox.exec"]

    /// A label counts when its plist exists, or (real runs only) launchd still has it loaded with the plist already gone.
    static func detect(agentsDir: String = AppEnv.launchAgentsDir, uid: uid_t = getuid(),
                       loaded: (String) -> Bool = { label in !AppEnv.isDev && isLoaded(label, uid: getuid()) }) -> [String] {
        labels.filter { FileManager.default.fileExists(atPath: agentsDir + "/" + $0 + ".plist") || loaded($0) }
    }

    static func isLoaded(_ label: String, uid: uid_t) -> Bool {
        realRunner("/bin/launchctl", ["print", "gui/\(uid)/\(label)"]).code == 0
    }

    /// Dev runs stub launchctl, so they must not delete the real plists either (only an injected test folder).
    static var mayDeleteIn: (String) -> Bool = { dir in !AppEnv.isDev || dir != NSHomeDirectory() + "/Library/LaunchAgents" }

    struct Result: Equatable { var removed: [String]; var problems: [String]; var commands: [String] }

    static func perform(agentsDir: String = AppEnv.launchAgentsDir, uid: uid_t = getuid(),
                        loaded: (String) -> Bool = { label in !AppEnv.isDev && isLoaded(label, uid: getuid()) },
                        run: CommandRunner = AppEnv.isDev ? devNoopRunner : realRunner) -> Result {
        var res = Result(removed: [], problems: [], commands: [])
        for label in detect(agentsDir: agentsDir, uid: uid, loaded: loaded) {
            let args = ["bootout", "gui/\(uid)/\(label)"]
            res.commands.append("launchctl " + args.joined(separator: " "))
            let r = run("/bin/launchctl", args)
            // 3 / 113: "no such process / could not find service": already not loaded, which is fine.
            if r.code != 0 && r.code != 3 && r.code != 113 && !r.out.contains("No such process") && !r.out.contains("Could not find service") {
                res.problems.append("\(label): \(r.out.trimmingCharacters(in: .whitespacesAndNewlines))")
                continue
            }
            let plist = agentsDir + "/" + label + ".plist"
            guard mayDeleteIn(agentsDir) else { res.removed.append(label); continue }
            if !FileManager.default.fileExists(atPath: plist) { res.removed.append(label); continue }
            do { try FileManager.default.removeItem(atPath: plist); res.removed.append(label) }
            catch { res.problems.append("\(label).plist: \(error.localizedDescription)") }
        }
        return res
    }
}

// MARK: - Connect Claude Code

enum ClaudeConnect {
    static let name = "agent-outbox"

    /// Where `claude` may live. A Finder-launched app has a bare PATH, so common install folders are tried too.
    static func candidates(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory()) -> [String] {
        var dirs = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        dirs += [home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", home + "/.claude/local", home + "/.npm-global/bin", home + "/.bun/bin", home + "/.volta/bin"]
        var seen = Set<String>()
        return dirs.filter { seen.insert($0).inserted }.map { $0 + "/claude" }
    }

    static func find(env: [String: String] = ProcessInfo.processInfo.environment, home: String = NSHomeDirectory(), run: CommandRunner = realRunner) -> String? {
        for c in candidates(env: env, home: home) where FileManager.default.isExecutableFile(atPath: c) { return c }
        // Last try: the login shell's PATH (nvm and friends).
        let r = run("/bin/zsh", ["-lc", "command -v claude"])
        let p = r.out.split(separator: "\n").last.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        return r.code == 0 && p.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: p) ? p : nil
    }

    /// The JSON block for Claude Desktop, Cursor and other MCP clients.
    static func configJSON(bin: String = AppEnv.mcpBin, stateDirOverride: String? = ProcessInfo.processInfo.environment["OUTBOX_HOME"]) -> String {
        var server: [String: Any] = ["command": bin, "args": ["mcp"]]
        if let o = stateDirOverride, !o.isEmpty { server["env"] = ["OUTBOX_HOME": o] }
        let d = try? JSONSerialization.data(withJSONObject: ["mcpServers": [name: server]], options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        return String(decoding: d ?? Data(), as: UTF8.self)
    }

    /// `claude mcp add --scope user agent-outbox [-e OUTBOX_HOME=...] -- <bin> mcp`. If a registration already points elsewhere (the old
    /// bun path), it is removed first (re-point). Returns a message and whether it worked.
    static func connect(claude: String, bin: String = AppEnv.mcpBin, stateDirOverride: String? = ProcessInfo.processInfo.environment["OUTBOX_HOME"],
                        run: CommandRunner = AppEnv.isDev ? devClaudeRunner : realRunner) -> (ok: Bool, message: String) {
        let get = run(claude, ["mcp", "get", name])
        if get.code == 0 {
            if get.out.contains(bin) { return (true, "Already connected.") }
            _ = run(claude, ["mcp", "remove", "--scope", "user", name])
        }
        var args = ["mcp", "add", "--scope", "user", name]
        if let o = stateDirOverride, !o.isEmpty { args += ["-e", "OUTBOX_HOME=\(o)"] }
        args += ["--", bin, "mcp"]
        let r = run(claude, args)
        return r.code == 0 ? (true, "Connected. Start a new Claude Code session to use it.") : (false, r.out.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
