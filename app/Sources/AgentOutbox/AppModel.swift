import SwiftUI
import OwnerAPI
import AppKit

enum NavItem: String, CaseIterable, Identifiable {
    case inbox = "Inbox", contacts = "Contacts", groups = "Groups", changes = "Contact changes", settings = "Settings"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .inbox: return "tray"
        case .contacts: return "person.crop.circle"
        case .groups: return "person.3"
        case .changes: return "person.crop.circle.badge.questionmark"
        case .settings: return "gearshape"
        }
    }
}

/// Thread-safe flag for AppUpdater.busyCheck (called off the main actor).
final class SendingFlag: @unchecked Sendable {
    private let l = NSLock(); private var v = false
    var value: Bool { get { l.lock(); defer { l.unlock() }; return v } set { l.lock(); v = newValue; l.unlock() } }
}

@MainActor
final class AppModel: ObservableObject {
    let supervisor: Supervisor
    let api: SocketOwnerAPIClient
    let approval: ApprovalBridge
    private let sending = SendingFlag()

    @Published var status: J = [:]
    @Published var reachable = false
    @Published var connectionError: String?
    @Published var native = BridgeNativeStatus()
    @Published var nav: NavItem = .inbox
    @Published var path = NavigationPath()     // the detail column's stack (batch, contact set, group)
    @Published var onboarded: Bool
    @Published var oldAgents: [String]
    @Published var flash: String?

    private var pollTask: Task<Void, Never>?
    private var ticks = 0

    private static var onboardedKey: String { "onboarded:" + AppEnv.stateDir }

    init() {
        let sup = Supervisor()
        supervisor = sup
        let token = sup.token
        api = SocketOwnerAPIClient(token: { token }, expectedPID: { [weak sup] in sup?.serverPID })
        approval = ApprovalBridge(api: api)
        let e = AppEnv.env
        onboarded = e["AGENT_OUTBOX_FORCE_ONBOARDING"] == "1" ? false : (e["AGENT_OUTBOX_SKIP_ONBOARDING"] == "1" || UserDefaults.standard.bool(forKey: Self.onboardedKey))
        oldAgents = e["AGENT_OUTBOX_SKIP_MIGRATION"] == "1" ? [] : Migration.detect()
        // Dev/screenshot aid: AGENT_OUTBOX_START_NAV=settings, AGENT_OUTBOX_START_PATH=batch:b1 (or set:<id>, group:<id>).
        if let n = e["AGENT_OUTBOX_START_NAV"], let item = NavItem.allCases.first(where: { $0.rawValue.lowercased() == n.lowercased() }) { nav = item }
        if let sp = e["AGENT_OUTBOX_START_PATH"] {
            let parts = sp.split(separator: ":").map(String.init)
            if parts.count == 2 {
                switch parts[0] {
                case "batch": path.append(BatchRef(id: parts[1]))
                case "set": path.append(SetRef(id: parts[1]))
                case "group": path.append(GroupRef(id: parts[1]))
                default: break
                }
            }
        }
        let flag = sending
        AppUpdater.shared.busyCheck = { flag.value }
        // Old LaunchAgents hold the port: wait for the owner's decision (Migration screen) before starting the server.
        if oldAgents.isEmpty { startServices() }
    }

    func startServices() {
        supervisor.start()
        if pollTask == nil {
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refresh()
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                }
            }
        }
    }

    func shutdown() { pollTask?.cancel(); pollTask = nil; supervisor.stop() }

    func finishOnboarding() {
        UserDefaults.standard.set(true, forKey: Self.onboardedKey)
        onboarded = true
    }
    func restartOnboarding() { UserDefaults.standard.set(false, forKey: Self.onboardedKey); onboarded = false }

    // MARK: API

    @discardableResult
    func call(_ method: String, _ path: String, _ body: Any? = nil) async throws -> J {
        let (code, data) = try await api.request(method, path, json: body.map(jsonData))
        let j = parseJSON(data)
        if code >= 400 {
            throw APIFailure(status: code, code: j.str("error", "error"), message: j.str("message", "Request failed (\(code))."))
        }
        return j
    }
    func get(_ path: String) async throws -> J { try await call("GET", path) }
    func post(_ path: String, _ body: Any = [String: Any]()) async throws -> J { try await call("POST", path, body) }

    func refresh() async {
        do {
            let s = try await get("/api/status")
            status = s
            reachable = true; connectionError = nil
            sending.value = s.obj("counts").int("drafts_approved") > 0
            ticks += 1
            if ticks % 4 == 1 { native = await approval.nativeStatus() }
        } catch {
            reachable = false
            connectionError = (error as? OwnerAPIError)?.description ?? error.localizedDescription
        }
    }

    // MARK: Derived

    var pendingCount: Int { status.obj("counts").int("batches_review") + status.obj("counts").int("contact_sets_review") }
    var killSwitch: Bool { status.bool("kill_switch") }
    var isLive: Bool { status.str("transport") == "live" }
    var hardened: Bool { status.obj("pin").str("mode") == "hardened" }
    /// C's `/api/status` `native.approve_in_app`: sign in the app (true) or approve in the browser (false / absent).
    var approveInApp: Bool { status.obj("native").bool("approve_in_app") }
    var origin: String { status.str("origin", AppEnv.origin) }

    // MARK: Actions

    func stopAll() async {
        do { let r = try await post("/api/stop"); flash = "Stopped. \(plural(r.int("revoked_approvals"), "approval")) revoked."; await refresh() }
        catch { flash = error.localizedDescription }
    }
    func resume() async {
        do { _ = try await post("/api/resume"); flash = "Sending is allowed again."; await refresh() }
        catch { flash = error.localizedDescription }
    }

    /// Opens the dashboard in the default browser, signed in through a one-time link (POST /api/app/browser-link).
    /// `then`: a dashboard hash (for example "/batches/<id>") opened right after, because the link page lands on the inbox.
    func openBrowser(then hash: String? = nil) async {
        var url = origin
        if let r = try? await post("/api/app/browser-link"), !r.str("url").isEmpty { url = r.str("url") }
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
        if let hash, let u = URL(string: origin + "/#" + hash) {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            NSWorkspace.shared.open(u)
        }
    }

    func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        for w in NSApp.windows where w.canBecomeMain { w.makeKeyAndOrderFront(nil); break }
    }
}
