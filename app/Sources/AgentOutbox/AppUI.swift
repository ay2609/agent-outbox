import SwiftUI
import AppKit

// MARK: - Root window

/// Shows the confirm sheet the approval bridge asks for (NativeApproval's ApprovalConfirmView, wrapped in ApprovalBridge.swift).
struct ApprovalSheetHost: ViewModifier {
    @ObservedObject var bridge: ApprovalBridge
    func body(content: Content) -> some View {
        content.sheet(item: $bridge.sheet) { $0.view }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if !model.oldAgents.isEmpty { MigrationView() }
            else if !model.onboarded { OnboardingView(supervisor: model.supervisor) }
            else if model.needsKeySetup && !model.gateDismissed { KeySetupGate() }
            else { MainView() }
        }
        .frame(minWidth: 760, minHeight: 520)
        .modifier(ApprovalSheetHost(bridge: model.approval))
        .overlay(alignment: .bottom) {
            if let f = model.flash {
                Text(f).padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule()).padding(.bottom, 14)
                    .task(id: f) { try? await Task.sleep(nanoseconds: 4_000_000_000); if model.flash == f { model.flash = nil } }
            }
        }
    }
}

struct MainView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { Optional(model.nav) }, set: { if let n = $0 { model.nav = n } })) {
                ForEach(NavItem.allCases) { item in
                    NavigationLink(value: item) {
                        Label(item.rawValue, systemImage: item.symbol)
                            .badge(item == .inbox ? model.pendingCount : 0)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 6) {
                    Circle().fill(model.reachable ? Color.green : Color.orange).frame(width: 8, height: 8)
                    Text(model.reachable ? "Server running" : "Server starting").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }.padding(10)
            }
        } detail: {
            Group {
                NavigationStack(path: $model.path) {
                    Group {
                        switch model.nav {
                        case .inbox: InboxView()
                        case .contacts: ContactsView()
                        case .groups: GroupsView()
                        case .changes: ContactChangeSetsView()
                        case .imports: ImportsView()
                        case .activity: ActivityView()
                        case .aiDraft: AiDraftView()
                        case .settings: SettingsView()
                        }
                    }
                    .navigationDestination(for: BatchRef.self) { BatchView(id: $0.id) }
                    .navigationDestination(for: SetRef.self) { ContactSetView(id: $0.id) }
                    .navigationDestination(for: GroupRef.self) { GroupDetailView(id: $0.id) }
                    .navigationDestination(for: ImportRef.self) { ImportDetailView(id: $0.id) }
                    .navigationDestination(for: ContactRef.self) { ContactDetailView(id: $0.id) }
                }
                .onChange(of: model.nav) { _ in model.path = NavigationPath() }
            }
        }
    }
}

// MARK: - Menu bar

struct MenuBarContent: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if model.pendingCount > 0 {
            Text("\(plural(model.pendingCount, "item")) waiting for review")
        } else {
            Text(model.reachable ? "Nothing waiting" : "Server starting")
        }
        if model.killSwitch { Text("Sending is stopped") }
        Divider()
        Button("Open Agent Outbox") { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
            .keyboardShortcut("o")
        Divider()
        if model.killSwitch {
            Button("Resume sending") { Task { await model.resume() } }
        } else {
            Button("Stop all sending") { Task { await model.stopAll() } }.disabled(!model.reachable)
        }
        Divider()
        Button("Check for Updates…") { AppUpdater.shared.checkForUpdates() }.disabled(!AppUpdater.shared.canCheckForUpdates)
        Divider()
        Button("Quit Agent Outbox") { model.shutdown(); NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

struct MenuBarLabel: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if model.pendingCount > 0 {
            Label("\(model.pendingCount)", systemImage: "tray.full")
        } else {
            Image(systemName: model.killSwitch ? "tray.fill" : "tray")
        }
    }
}

// MARK: - App

struct AgentOutboxApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        Window("Agent Outbox", id: "main") {
            RootView().environmentObject(model)
                .onOpenURL { model.handle(url: $0) }
        }
        .defaultSize(width: 940, height: 640)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { AppUpdater.shared.checkForUpdates() }.disabled(!AppUpdater.shared.canCheckForUpdates)
            }
        }
        MenuBarExtra {
            MenuBarContent().environmentObject(model)
        } label: {
            MenuBarLabel().environmentObject(model)
        }
    }
}
