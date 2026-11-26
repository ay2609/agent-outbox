import SwiftUI
import OwnerAPI
import AppKit

enum NavItem: String, CaseIterable, Identifiable {
    case inbox = "Inbox", contacts = "Contacts", groups = "Groups", changes = "Contact changes", imports = "Imports", activity = "Activity",
         aiDraft = "AI drafts", settings = "Settings"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .inbox: return "tray"
        case .contacts: return "person.crop.circle"
        case .groups: return "person.3"
        case .changes: return "person.crop.circle.badge.questionmark"
        case .imports: return "square.and.arrow.down"
        case .activity: return "clock.arrow.circlepath"
        case .aiDraft: return "sparkles"
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
    @Published var setup = SetupInfo()
    @Published var nav: NavItem = .inbox
    @Published var path = NavigationPath()     // the detail column's stack (batch, contact set, group, import, contact)
    @Published var onboarded: Bool
    @Published var oldAgents: [String]
    @Published var flash: String?
    /// "N approvals made in the browser were cancelled" (shown once, from the server's migration audit row).
    @Published var migrationNotice: String?
    /// After a Touch ID change: the old keys the server still lists as active, offered for removal once a new key is set up.
    @Published var staleKeys: [J] = []
    /// The one-time "Agent Outbox no longer uses the browser" screen was put away for this launch.
    @Published var gateDismissed = false

    private var pollTask: Task<Void, Never>?
    private var ticks = 0
    private var checkedExecVersion = false
    private var checkedMigrationNotice = false
    private var wasChanged = false

    private static var onboardedKey: String { "onboarded:" + AppEnv.stateDir }
    private static var noticeKey: String { "v7notice:" + AppEnv.stateDir }

    init() {
        let sup = Supervisor()
        supervisor = sup
        let token = sup.token
        api = SocketOwnerAPIClient(token: { token }, expectedPID: { [weak sup] in sup?.serverPID })
        approval = ApprovalBridge(api: api)
        let e = AppEnv.env
        onboarded = e["AGENT_OUTBOX_FORCE_ONBOARDING"] == "1" ? false : (e["AGENT_OUTBOX_SKIP_ONBOARDING"] == "1" || UserDefaults.standard.bool(forKey: Self.onboardedKey))
        oldAgents = e["AGENT_OUTBOX_SKIP_MIGRATION"] == "1" ? [] : Migration.detect()
        // Dev/screenshot aid: AGENT_OUTBOX_START_NAV=settings, AGENT_OUTBOX_START_PATH=batch:b1 (or set:<id>, group:<id>, import:<id>, contact:<id>).
        if let n = e["AGENT_OUTBOX_START_NAV"], let item = NavItem.allCases.first(where: { $0.rawValue.lowercased() == n.lowercased() || $0.rawValue.lowercased().replacingOccurrences(of: " ", with: "") == n.lowercased() }) { nav = item }
        if let sp = e["AGENT_OUTBOX_START_PATH"] {
            let parts = sp.split(separator: ":").map(String.init)
            if parts.count == 2 {
                switch parts[0] {
                case "batch": path.append(BatchRef(id: parts[1]))
                case "set": path.append(SetRef(id: parts[1]))
                case "group": path.append(GroupRef(id: parts[1]))
                case "import": path.append(ImportRef(id: parts[1]))
                case "contact": path.append(ContactRef(id: parts[1]))
                default: break
                }
            }
        }
        if AppEnv.isDev && e["AGENT_OUTBOX_DEV_NOGATE"] == "1" { gateDismissed = true }   // screenshots: skip the one-time Touch ID screen
        devHooksAtLaunch()
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
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
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
            throw APIFailure(status: code, code: j.str("error", "error"), message: j.str("message", "Request failed (\(code))."), data: j)
        }
        return j
    }
    func get(_ path: String) async throws -> J { try await call("GET", path) }
    func post(_ path: String, _ body: Any = [String: Any]()) async throws -> J { try await call("POST", path, body) }

    func refresh() async {
        do {
            let s = try await get("/api/status")
            status = s
            setup = SetupInfo(s)
            reachable = true; connectionError = nil
            sending.value = s.obj("counts").int("drafts_approved") > 0
            ticks += 1
            // Touch ID state is cheap to read, but the key list needs the server: every 2nd round is enough.
            if ticks % 2 == 1 || !setup.done { native = await approval.nativeStatus(); noteTouchIDChange() }
            await checkExecutorVersion(s)
            await checkMigrationNotice()
        } catch {
            reachable = false
            if !native.touchIDAvailable && native.touchIDReason == nil { native = await approval.nativeStatus() }   // Touch ID needs no server
            connectionError = (error as? OwnerAPIError)?.description ?? error.localizedDescription
        }
    }

    /// An old sender from a previous bundle can still be running: restart the login item so the bundled one takes over (once per launch).
    private func checkExecutorVersion(_ s: J) async {
        guard !checkedExecVersion, !AppEnv.isDev else { return }
        let e = s.obj("exec")
        guard !e.isEmpty, e.bool("alive") else { return }
        checkedExecVersion = true
        if let bundled = LoginItems.bundledExecutorVersion(), !bundled.isEmpty, e.str("version") != bundled { _ = LoginItems.restartExecutor() }
    }

    private func checkMigrationNotice() async {
        guard !checkedMigrationNotice else { return }
        checkedMigrationNotice = true
        guard !UserDefaults.standard.bool(forKey: Self.noticeKey) else { return }
        guard let r = try? await get("/api/activity?limit=200") else { checkedMigrationNotice = false; return }
        UserDefaults.standard.set(true, forKey: Self.noticeKey)
        if let row = r.arr("audit").first(where: { $0.str("action") == "migration.v7" }) {
            let d = row.obj("details")
            let n = d.int("revoked_approvals") + d.int("revoked_contact_approvals")
            if n > 0 { migrationNotice = "\(plural(n, "approval")) made in the browser \(n == 1 ? "was" : "were") cancelled. Approve \(n == 1 ? "it" : "them") again with Touch ID." }
        }
    }

    /// When the fingerprint set changes, remember to offer removal of the dead keys after the next enrolment.
    private func noteTouchIDChange() {
        if native.touchIDChanged { wasChanged = true }
    }

    // MARK: Derived

    var pendingCount: Int { status.obj("counts").int("batches_review") + status.obj("counts").int("contact_sets_review") }
    var killSwitch: Bool { status.bool("kill_switch") }
    var isLive: Bool { status.str("transport") == "live" }
    var hardened: Bool { status.obj("pin").str("mode") == "hardened" }
    var keysActive: Int { max(native.keysActive, status.obj("native").int("keys_active")) }
    /// Approve is possible only with Touch ID here, a local active key, and a pin that trusts it. There is no other way to approve.
    var approveInApp: Bool { native.canApproveInApp && status.obj("native").bool("approve_in_app") }
    /// The pin the sender uses lists a revoked key (hardened mode): needs the command re-run.
    var pinNeedsUpdate: Bool { status.obj("native").bool("pin_needs_update") }
    /// An existing install (set up before, no key now) or a changed Touch ID set: the one-time Terminal step.
    var needsKeySetup: Bool { reachable && onboarded && keysActive == 0 && setup.done && !native.hasLocalKey || (reachable && native.touchIDChanged) }
    /// Why Approve is disabled, in one line (nil when it is possible).
    var approvalHint: String? {
        if killSwitch { return "Sending is stopped, so nothing can be approved. Press Resume sending first." }
        if !native.touchIDAvailable { return native.touchIDReason ?? "Touch ID isn't available on this Mac, so approving is off." }
        if native.touchIDChanged { return "Touch ID changed, so your approval key no longer works. Set up Touch ID again in Settings." }
        if approveInApp { return nil }
        if keysActive == 0 { return "Set up Touch ID in Settings before you approve anything." }
        if !native.hasLocalKey { return "The approval keys belong to another Mac. Set up Touch ID on this one in Settings." }
        return "The sender doesn't trust your key yet. Run the harden command in Settings."
    }
    /// The sender's own reason for holding approved messages, in plain words (nil when it isn't holding).
    var senderHold: String? {
        let e = status.obj("exec")
        let raw = e.str("last_error")
        let problems = status.obj("pin").obj("effective").strs("problems").joined(separator: " ")
        if let t = HoldReason.plain(raw) ?? HoldReason.plain(problems) { return t }
        if !e.isEmpty, e["pin_file_ok"] as? Bool == false { return "The sender can't use the approval key file: \(problems.isEmpty ? "see Settings > Protection." : problems)" }
        return nil
    }

    // MARK: Actions

    func stopAll() async {
        do { let r = try await post("/api/stop"); flash = "Stopped. \(plural(r.int("revoked_approvals"), "approval")) revoked."; await refresh() }
        catch { flash = error.localizedDescription }
    }
    func resume() async {
        do { _ = try await post("/api/resume"); flash = "Sending is allowed again."; await refresh() }
        catch { flash = error.localizedDescription }
    }

    /// Makes this Mac's Touch ID key. After a Touch ID change, the old keys are then offered for removal.
    func enrollThisMac() async throws {
        let changed = wasChanged || native.touchIDChanged
        let id = try await approval.enroll(label: Host.current().localizedName ?? "This Mac")
        await refresh()
        if changed, let list = try? await get("/api/native-keys") {
            staleKeys = list.arr("keys").filter { $0.str("status") == "active" && $0.str("key_id") != id }
        }
        wasChanged = false
        flash = "Touch ID is set up."
    }

    func cancelRecovery() async {
        do { let r = try await post("/api/recovery/cancel"); flash = r.bool("cancelled") ? "Recovery cancelled." : "Recovery was not open."; await refresh() }
        catch { flash = error.localizedDescription }
    }

    /// Opens the page for a deep link. Navigation only; ignored while a confirm sheet is up.
    func handle(url: URL) {
        guard approval.sheet == nil, let link = DeepLink.parse(url) else { return }
        let target: NavItem
        var ref: AnyHashable?
        switch link {
        case .inbox: target = .inbox
        case .batch(let id): target = .inbox; ref = BatchRef(id: id)
        case .contactChanges(let id): target = .changes; ref = SetRef(id: id)
        case .importRef(let id): target = .imports; ref = ImportRef(id: id)
        case .group(let id): target = .groups; ref = GroupRef(id: id)
        }
        if !onboarded { return }
        showMainWindow()
        Task { @MainActor in
            if nav != target { nav = target; try? await Task.sleep(nanoseconds: 80_000_000) }
            path = NavigationPath()
            if let r = ref as? BatchRef { path.append(r) }
            else if let r = ref as? SetRef { path.append(r) }
            else if let r = ref as? ImportRef { path.append(r) }
            else if let r = ref as? GroupRef { path.append(r) }
        }
    }

    func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        for w in NSApp.windows where w.canBecomeMain { w.makeKeyAndOrderFront(nil); break }
    }
}
