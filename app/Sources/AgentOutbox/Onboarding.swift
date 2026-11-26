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
            Text("Agent Outbox found services from the developer install (install.sh) running in the background. The app runs the server and the sender itself now, so the old ones need to go. Your messages, contacts, keys and settings stay exactly where they are.")
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
            Text("Not now starts the app anyway, but the old server holds the port, so the app's server can't start until they are removed.").font(.caption).foregroundStyle(.secondary)
        }
        .padding(28).frame(maxWidth: 560)
    }
}

// MARK: - Onboarding

struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var supervisor: Supervisor
    enum Step: Int, CaseIterable { case mac, services, claude, approval, test }
    @State private var step: Step = .mac
    @StateObject private var action = Action()
    @State private var claudePath: String?
    @State private var claudeSearched = false
    @State private var connectMsg: String?
    @State private var configCopied = false
    @State private var loginProblem: String?
    @State private var testSet = false

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
            Spacer(minLength: 12)
            ErrorLine(text: action.error)
        }
        .padding(28).frame(maxWidth: 600, minHeight: 440, alignment: .topLeading)
    }

    private func header(_ symbol: String, _ title: String, _ sub: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: symbol).font(.system(size: 36)).foregroundStyle(.tint)
            Text(title).font(.title2.bold())
            Text(sub).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.bottom, 14)
    }
    private func nav(next: String = "Continue", enabled: Bool = true, skip: String? = nil, _ go: @escaping () -> Void) -> some View {
        HStack {
            if step != .mac { Button("Back") { step = Step(rawValue: step.rawValue - 1)! } }
            Spacer()
            if let skip { Button(skip) { go() } }
            Button(next) { go() }.keyboardShortcut(.defaultAction).disabled(!enabled)
        }.padding(.top, 8)
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
        let ok = v.majorVersion >= 13 && arm
        return VStack(alignment: .leading) {
            header("macwindow", "Welcome to Agent Outbox", "AI agents draft your messages. You read them here and approve with Touch ID. Only then does your Mac send them.")
            Label("macOS \(v.majorVersion).\(v.minorVersion) on \(arm ? "Apple silicon" : "an Intel Mac")", systemImage: ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(ok ? Color.green : Color.red)
            if !ok { Text("Agent Outbox needs macOS 13 or later on a Mac with Apple silicon.").foregroundStyle(.secondary) }
            nav(enabled: ok) { advance() }
        }
    }

    // 2. Services
    private var servicesStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            header("server.rack", "Start the services", "The app runs a small server and a sender in the background. Messages and keys stay on this Mac.")
            Label(model.reachable ? "Server is running" : supervisor.state.label, systemImage: model.reachable ? "checkmark.circle.fill" : "circle.dotted")
                .foregroundStyle(model.reachable ? Color.green : Color.secondary)
            if !model.reachable && !supervisor.lastFailure.isEmpty { Text(supervisor.lastFailure).font(.caption).foregroundStyle(.red) }
            let login = LoginItems.summary()
            Label("Open at login: \(login.app)", systemImage: "power")
            Label("Sender: \(login.executor)", systemImage: "paperplane")
            HStack {
                Button("Open at login") { loginProblem = LoginItems.register() }.disabled(AppEnv.isDev)
                if login.needsApproval { Button("Allow in System Settings") { LoginItems.openSystemSettings() } }
            }
            ErrorLine(text: loginProblem)
            if AppEnv.isDev { Text("Development run: login items are not registered.").font(.caption).foregroundStyle(.secondary) }
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
                        connectMsg = r.message
                        if !r.ok { throw APIFailure(status: 0, code: "claude", message: r.message) }
                    }
                }.disabled(action.busy)
                if action.busy { ProgressView().controlSize(.small) }
            }
            if let m = connectMsg, action.error == nil { Text(m).font(.callout).foregroundStyle(.secondary) }
            DisclosureGroup("Claude Desktop, Cursor and other apps") {
                Text(ClaudeConnect.configJSON()).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading).background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                Button(configCopied ? "Copied" : "Copy") { copyToPasteboard(ClaudeConnect.configJSON()); configCopied = true }
            }
            nav(skip: "Skip") { advance() }
        }
    }

    // 4. Approval
    private var approvalStep: some View {
        let haveKey = model.native.keysActive > 0 || model.status.obj("native").int("keys_active") > 0
            || model.status.int("passkeys") > 0
        return VStack(alignment: .leading, spacing: 10) {
            header("touchid", "Set up approval", model.native.touchIDAvailable
                   ? "Messages only send after you approve them with Touch ID. Set up the key that does it."
                   : "Messages only send after you approve them. This Mac can't use Touch ID inside the app, so approvals use a passkey in your browser.")
            if haveKey {
                Label("Approval is set up", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else if model.native.touchIDAvailable {
                Button("Set up Touch ID") {
                    action.run { _ = try await model.approval.enroll(label: Host.current().localizedName ?? "This Mac"); await model.refresh() }
                }.disabled(action.busy)
            } else {
                Button("Set up in your browser") { action.run { await model.openBrowser() } }.disabled(action.busy)
                Text("Create the sign-in and approval passkeys there, then come back.").font(.caption).foregroundStyle(.secondary)
            }
            nav(skip: haveKey ? nil : "Later") { advance() }
        }
    }

    // 5. Dry-run test
    private var testStep: some View {
        VStack(alignment: .leading, spacing: 10) {
            header("checkmark.seal", "Send a test in Dry run", "Dry run records what would be sent but sends nothing. Ask Claude to draft a message to yourself and watch it arrive in the Inbox.")
            Text("“Use Agent Outbox to draft a text to me that says hi.”").font(.callout.italic())
                .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            Button("Copy this prompt") { copyToPasteboard("Use Agent Outbox to draft a text to me that says hi.") }
            if model.pendingCount > 0 { Label("A draft arrived. You're all set.", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            if testSet { Text("Dry run is on for the test. Switch to Live in Settings when you're ready; every message still needs your Touch ID.").font(.caption).foregroundStyle(.secondary) }
            nav(next: "Finish") { model.finishOnboarding() }
        }
        .task { do { try await model.setMode("dry"); testSet = true } catch { testSet = false } }
    }
}
