import SwiftUI

// MARK: - Migration from the developer install

struct MigrationView: View {
    @EnvironmentObject var model: AppModel
    @State private var result: Migration.Result?
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image(systemName: "arrow.triangle.2.circlepath.circle").font(.system(size: 40)).foregroundStyle(.tint)
            Text("Move over from the earlier install").font(.title2.bold())
            Text("Agent Outbox found services from the earlier developer install running in the background. The app runs the server and the sender itself now, so the old ones need to go. Your messages, contacts, keys and settings stay exactly where they are.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(model.oldAgents, id: \.self) { Label($0, systemImage: "gearshape.2").font(.callout.monospaced()) }
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            Text("macOS will ask once more for Messages and Contacts access, because the sender is a new program.").font(.callout).foregroundStyle(.secondary)
            if let r = result, !r.problems.isEmpty {
                ForEach(r.problems, id: \.self) { ErrorLine(text: $0) }
            }
            HStack {
                Button("Not now") { model.oldAgents = []; model.startServices() }
                Spacer()
                Button("Remove the old services") {
                    working = true
                    Task.detached {
                        let r = Migration.perform()
                        await MainActor.run {
                            result = r; working = false
                            model.oldAgents = Migration.detect()
                            if model.oldAgents.isEmpty { model.startServices() }
                        }
                    }
                }.keyboardShortcut(.defaultAction).disabled(working)
            }
            Text("Not now starts the app anyway, but the old services can hold the sender's files, so remove them soon.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(28).frame(maxWidth: 560)
    }
}

// MARK: - Onboarding

struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var supervisor: Supervisor
    enum Step: Int, CaseIterable { case mac, services, claude, approval, test }
    @State private var step: Step = AppEnv.isDev ? (Int(AppEnv.env["AGENT_OUTBOX_START_STEP"] ?? "").flatMap { Step(rawValue: $0) } ?? .mac) : .mac
    @StateObject private var action = Action()
    @State private var claudePath: String?
    @State private var claudeSearched = false
    @State private var connectMsg: String?
    @State private var connectOK = false
    @State private var configCopied = false
    @State private var loginProblem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                ForEach(Step.allCases, id: \.rawValue) { s in
                    Capsule().fill(s.rawValue <= step.rawValue ? Color.accentColor : Color.secondary.opacity(0.25)).frame(height: 4)
                }
            }.padding(.bottom, 22)
            Group {
                switch step {
                case .mac: macStep
                case .services: servicesStep
                case .claude: claudeStep
                case .approval: approvalStep
                case .test: testStep
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
            ErrorLine(text: action.error).padding(.top, 6)
        }
        .padding(28).frame(maxWidth: 580, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity)
    }

    private func header(_ symbol: String, _ title: String, _ sub: String, appIcon: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if appIcon { Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 72, height: 72) }
            else { Image(systemName: symbol).font(.system(size: 36)).foregroundStyle(.tint) }
            Text(title).font(.title2.bold())
            Text(sub).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.bottom, 14)
    }
    /// The footer, pinned to the bottom of the window. `showNext: false` leaves only the skip button (the step isn't done yet).
    private func nav(next: String = "Continue", enabled: Bool = true, skip: String? = nil, showNext: Bool = true, _ go: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            Spacer(minLength: 16)
            Divider().padding(.bottom, 12)
            HStack {
                if step != .mac { Button("Back") { step = Step(rawValue: step.rawValue - 1)! } }
                Spacer()
                if let skip { Button(skip) { go() } }
                if showNext { Button(next) { go() }.keyboardShortcut(.defaultAction).disabled(!enabled) }
            }
        }
    }
    private func advance() { if let n = Step(rawValue: step.rawValue + 1) { step = n } else { model.finishOnboarding() } }

    // 1. macOS check
    private var macStep: some View {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        #if arch(arm64)
        let arm = true
        #else
        let arm = false
        #endif
        let ok = v.majorVersion >= 14 && arm
        return VStack(alignment: .leading) {
            header("macwindow", "Welcome to Agent Outbox", "AI agents draft your messages. You read them here and approve them. Only then does your Mac send them.", appIcon: true)
            VStack(alignment: .leading, spacing: 8) {
                Text("Setting up takes about a minute:").font(.callout.weight(.medium))
                Label("Start Agent Outbox in the background", systemImage: "1.circle")
                Label("Connect Claude Code, or another agent", systemImage: "2.circle")
                Label("Set up approval, so only you can send", systemImage: "3.circle")
                Label("Try it with a message that isn't sent", systemImage: "4.circle")
            }.foregroundStyle(.secondary).padding(.bottom, 14)
            Label("macOS \(v.majorVersion).\(v.minorVersion) on \(arm ? "Apple silicon" : "an Intel Mac")", systemImage: ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(ok ? Color.green : Color.red)
            if !ok { Text("Agent Outbox needs macOS 14 or later on a Mac with Apple silicon.").foregroundStyle(.secondary) }
            Label(model.native.touchIDAvailable ? "Touch ID is ready" : "Touch ID isn't ready", systemImage: model.native.touchIDAvailable ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(model.native.touchIDAvailable ? Color.green : Color.orange).padding(.top, 4)
            if !model.native.touchIDAvailable, let r = model.native.touchIDReason { Text(r).font(.caption).foregroundStyle(.secondary) }
            nav(enabled: ok) { advance() }
        }
    }

    // 2. Services
    private var servicesStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            header("server.rack", "Start Agent Outbox", "Agent Outbox keeps your drafts in a small local service and hands approved messages to Messages through a sender. Everything stays on this Mac.")
            Label(model.reachable ? "Local service is running" : supervisor.state.label, systemImage: model.reachable ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(model.reachable ? Color.green : Color.secondary)
            if !model.reachable && !supervisor.lastFailure.isEmpty { Text(supervisor.lastFailure).font(.caption).foregroundStyle(.red) }
            let login = LoginItems.summary()
            Label("Open at login: \(login.app)", systemImage: "power")
            Label("Sender: \(login.executor)", systemImage: "paperplane")
            HStack {
                Button("Turn on Open at login") { loginProblem = LoginItems.register() }.disabled(AppEnv.isDev)
                if login.needsApproval { Button("Allow in System Settings") { LoginItems.openSystemSettings() } }
            }
            ErrorLine(text: loginProblem)
            if AppEnv.isDev { Text("Test run: Open at login and the sender stay off, so nothing on this Mac changes. Press Continue.").font(.caption).foregroundStyle(.secondary) }
            nav(enabled: model.reachable) { advance() }
        }
    }

    // 3. Claude Code
    private var claudeStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            header("terminal", "Connect Claude Code", "Agents draft through a small tool called Agent Outbox. Connect it to Claude Code with one click, or copy the settings for another app.")
            if claudeSearched {
                if let p = claudePath {
                    Label("Found Claude Code at \(p)", systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.green)
                } else {
                    Label("Claude Code wasn't found on this Mac.", systemImage: "questionmark.circle").font(.callout).foregroundStyle(.secondary)
                }
            }
            HStack {
                Button("Connect Claude Code") {
                    action.run {
                        let found = await Task.detached { ClaudeConnect.find() }.value
                        claudePath = found; claudeSearched = true
                        guard let found else { connectMsg = nil; return }
                        let r = await Task.detached { ClaudeConnect.connect(claude: found) }.value
                        connectMsg = r.message; connectOK = r.ok
                        if !r.ok { throw APIFailure(status: 0, code: "claude", message: r.message) }
                    }
                }.disabled(action.busy)
                if action.busy { ProgressView().controlSize(.small) }
            }
            if let m = connectMsg, action.error == nil { Label(m, systemImage: connectOK ? "checkmark.circle.fill" : "info.circle").font(.callout).foregroundStyle(connectOK ? Color.green : Color.secondary) }
            DisclosureGroup("Claude Desktop, Cursor and other apps") {
                Text(ClaudeConnect.configJSON()).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading).background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                Button(configCopied ? "Copied" : "Copy") { copyToPasteboard(ClaudeConnect.configJSON()); configCopied = true }
            }
            nav(skip: connectOK ? nil : "Skip for now") { advance() }
        }
    }

    // 4. Approval
    private var approvalStep: some View {
        let haveKey = model.keysActive > 0 && model.native.hasLocalKey && !model.native.touchIDChanged
        return VStack(alignment: .leading, spacing: 10) {
            header("touchid", "Set up approval", model.native.touchIDAvailable
                   ? "Messages only send after you approve them with your fingerprint. Set up the key that does it."
                   : "Messages only send after you approve them with your fingerprint, and this Mac can't do that right now.")
            KeySetupCard()
            nav(skip: haveKey ? nil : "Not now", showNext: haveKey) { advance() }
        }
    }

    // 5. Start mode + test. Fresh installs start Live; the owner can pick Dry run here (or later in Settings).
    private var testStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            header("checkmark.seal", "Choose how to start", "Live sends the messages you approve. Dry run records what would be sent and sends nothing, which is a safe way to try it first. Either way, nothing goes out without your Touch ID.")
            Picker("Start in", selection: Binding(get: { model.isLive ? "live" : "dry" }, set: { m in
                action.run { try await model.setMode(m) }
            })) {
                Text("Live").tag("live"); Text("Dry run").tag("dry")
            }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 260).disabled(action.busy)
            Text(model.isLive ? "Live: messages you approve with Touch ID are really sent." : "Dry run: approved messages are recorded but nothing is sent. Switch to Live in Settings when you're ready.")
                .font(.caption).foregroundStyle(.secondary)
            Text("Try it: ask Claude to draft a message to yourself and watch it arrive in the Inbox.").font(.callout).padding(.top, 6)
            Text("“Use Agent Outbox to draft a text to me that says hi.”").font(.callout.italic())
                .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            Button("Copy this prompt") { copyToPasteboard("Use Agent Outbox to draft a text to me that says hi.") }
            if model.pendingCount > 0 { Label("A draft arrived. You're all set.", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            nav(next: "Finish") { model.finishOnboarding() }
        }
    }
}
