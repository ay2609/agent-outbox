import Foundation

public struct SendRequest {
    public let draftId: String
    public let approvalId: String
    public let handle: String
    public let service: String   // iMessage | SMS | auto
    public let body: String
    public init(draftId: String, approvalId: String, handle: String, service: String, body: String) {
        self.draftId = draftId; self.approvalId = approvalId; self.handle = handle; self.service = service; self.body = body
    }
}

public enum SendOutcome {
    /// Handed to Messages (delivery is unconfirmed in v1).
    case sent(serviceUsed: String)
    /// Failed before anything was handed off. Retryable.
    case failedBeforeHandoff(String)
    /// Ambiguous (timeout etc.). Never retried automatically.
    case unknown(String)
}

public protocol Transport: AnyObject {
    var name: String { get }          // "dry" | "live"
    func send(_ r: SendRequest) -> SendOutcome
    /// Read-only readiness check run before the first live send (nil = ready, else why not). Dry has nothing to check.
    func preflight() -> String?
}

public extension Transport {
    func preflight() -> String? { nil }
}

/// Appends `{"at","draft_id","approval_id","to","service","body"}` to dry-sends.jsonl and sends nothing.
public final class DryTransport: Transport {
    public let name = "dry"
    private let logPath: String
    private let clock: () -> Date

    public init(logPath: String, clock: @escaping () -> Date = Date.init) {
        self.logPath = logPath
        self.clock = clock
    }

    public func send(_ r: SendRequest) -> SendOutcome {
        let obj: [String: Any] = [
            "at": Time.iso(clock()), "draft_id": r.draftId, "approval_id": r.approvalId,
            "to": r.handle, "service": r.service, "body": r.body,
        ]
        guard let line = JSON.data(obj) else { return .failedBeforeHandoff("could not encode dry-send record") }
        let ok = appendLine(line, to: logPath)
        return ok ? .sent(serviceUsed: r.service == "auto" ? "iMessage" : r.service) : .failedBeforeHandoff("could not append to \(logPath)")
    }
}

/// Real sending through Messages.app with in-process NSAppleScript. Compiled but NEVER run during development:
/// only `outbox-exec run` constructs it, and only when the settings say live AND the effective pin file is valid.
public final class LiveMessagesTransport: Transport {
    public let name = "live"
    public init() {}

    /// AppleScript error numbers that mean "we can't tell whether Messages took it": no automatic retry, no SMS fallback.
    static let ambiguousErrors: Set<Int> = [-1712, -609, -600, -10004]

    public func send(_ r: SendRequest) -> SendOutcome {
        let services: [String]
        switch r.service {
        case "auto": services = ["iMessage", "SMS"]
        case "iMessage", "SMS": services = [r.service]
        default: return .failedBeforeHandoff("unknown service \(r.service)")
        }
        var lastError = "no attempt"
        for (i, svc) in services.enumerated() {
            let source: String
            do { source = try AppleScriptSource.script(handle: r.handle, body: r.body, service: svc) }
            catch { return .failedBeforeHandoff("refused to build script: \(error)") }
            let (ok, num, msg) = run(source)
            if ok { return .sent(serviceUsed: svc) }
            lastError = "\(svc): error \(num): \(msg)"
            if Self.ambiguousErrors.contains(num) { return .unknown(lastError) }
            _ = i   // auto: an iMessage error before hand-off falls through to SMS
        }
        return .failedBeforeHandoff(lastError)
    }

    /// Fixed script, no inputs: reads the iMessage account id from Messages. Triggers the Automation prompt for THIS
    /// binary when the daemon first goes live, so the user can click Allow before any approved message is attempted.
    public static let preflightScript = """
    tell application "Messages"
    \twith timeout of 30 seconds
    \t\treturn id of (1st account whose service type = iMessage)
    \tend timeout
    end tell
    """

    public func preflight() -> String? {
        let (ok, num, msg) = run(Self.preflightScript)
        if ok { return nil }
        if num == -1743 { return "Automation permission for Messages has not been granted to outbox-exec (error -1743): approve the prompt on the Mac's screen, or see deploy/README.md" }
        return "Messages preflight failed (error \(num)): \(msg)"
    }

    private func run(_ source: String) -> (Bool, Int, String) {
        guard Thread.isMainThread else { return (false, 0, "NSAppleScript must run on the main thread") }
        guard let script = NSAppleScript(source: source) else { return (false, 0, "script did not compile") }
        var info: NSDictionary?
        _ = script.executeAndReturnError(&info)
        if let info {
            let n = (info[NSAppleScript.errorNumber] as? Int) ?? 0
            let m = (info[NSAppleScript.errorMessage] as? String) ?? "unknown AppleScript error"
            return (false, n, m)
        }
        return (true, 0, "")
    }
}
