import SwiftUI

// Setting up Touch ID, in every place it is needed: first run, an existing install (the one-time Terminal step), a changed Touch ID set.
// The app never runs `recover` itself and never writes the recovery or setup token: the owner types the command in Terminal.

/// A command in a box with a Copy button.
struct CommandBox: View {
    let command: String
    var label = "Copy command"
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
            Button(copied ? "Copied" : label) { copyToPasteboard(command); copied = true }
        }
    }
}

/// This Mac can't do Touch ID: say why, plainly. Approving, setting up and going live are off; drafting, Inbox, editing, Stop and Settings work.
struct TouchIDNeededCard: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Touch ID is needed", systemImage: "touchid").font(.headline).foregroundStyle(.orange)
            Text(model.native.touchIDReason ?? "Touch ID isn't available on this Mac.").fixedSize(horizontal: false, vertical: true)
            Text("Agents can still draft, and you can read, edit and cancel drafts here. Nothing can be approved on this Mac.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// The Terminal step: show the exact recover command, wait for the owner to run it (the app polls the server for the recovery token file).
struct RecoverStep: View {
    @EnvironmentObject var model: AppModel
    var changed: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if changed {
                Text("Touch ID changed on this Mac (a fingerprint was added or removed), so your old approval key stopped working. That is a safety feature. Set up approval again. Confirm it's you in Terminal first:")
            } else {
                Text("Agent Outbox now approves messages with Touch ID, in this app. Because this Mac was already set up, confirm it's you in Terminal first:")
            }
            Text("1. Open Terminal and paste this line, then press Return.").font(.callout.weight(.medium))
            CommandBox(command: AppEnv.recoverCommand, label: "Copy the command")
            Text("2. Come back here. This window notices on its own and shows a Set up Touch ID button.").font(.callout.weight(.medium))
            HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Waiting for the Terminal step…").font(.caption).foregroundStyle(.secondary) }
        }.fixedSize(horizontal: false, vertical: true)
    }
}

struct KeySetupCard: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var action = Action()

    var body: some View {
        let n = model.native
        let proof = model.setup.proof
        let haveKey = model.keysActive > 0 && n.hasLocalKey && !n.touchIDChanged
        let needsTerminal = (proof == nil && model.setup.done) || (proof == "se_reauth" && (!n.hasLocalKey || n.touchIDChanged))
        VStack(alignment: .leading, spacing: 10) {
            if !n.touchIDAvailable {
                TouchIDNeededCard()
            } else if haveKey {
                Label("Approval is set up on this Mac", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else if needsTerminal {
                RecoverStep(changed: n.touchIDChanged)
            } else if let proof {
                if n.touchIDChanged { Text("Touch ID changed on this Mac, so your old key stopped working. Set up approval again.") }
                if proof == "recovery_token" { Text("Confirmed in Terminal. Now set up Touch ID on this Mac.") }
                Button("Set up Touch ID") { action.run { try await model.enrollThisMac() } }
                    .keyboardShortcut(.defaultAction).disabled(action.busy)
                Text(proof == "recovery_token" ? "Recovery is open, so the app can set up a new key now. You will touch the sensor once."
                     : proof == "setup_token" ? "You will touch the sensor once. Agent Outbox confirms it's you with a one-time file in its own folder."
                     : "Touch ID asks twice: once with your existing key, once for the new one.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Preparing the first-run setup…").foregroundStyle(.secondary) }
            }
            ErrorLine(text: action.error)
        }
    }
}

/// One-time screen for an existing install (setup done, no key on this Mac) or after a Touch ID change.
struct KeySetupGate: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "touchid").font(.system(size: 40)).foregroundStyle(.tint)
                Text(model.native.touchIDChanged ? "Set up Touch ID again" : "Set up Touch ID").font(.title2.bold())
                KeySetupCard()
                StaleKeysCard()
                HStack {
                    Spacer()
                    Button("Not now") { model.gateDismissed = true }
                }
                Text("Not now keeps everything else working: agents can draft, and you can read, edit and cancel. Approving needs Touch ID.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(28).frame(maxWidth: 600, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
}

/// After a Touch ID change: the old keys the server still lists, default ticked, to revoke now.
struct StaleKeysCard: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var action = Action()
    @State private var unticked: Set<String> = []
    var body: some View {
        let keys = model.staleKeys
        if !keys.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Remove the old keys?").font(.headline)
                Text("These keys can't sign any more because Touch ID changed. Removing them keeps your key list clean. You can untick any you want to keep.")
                    .font(.callout).foregroundStyle(.secondary)
                ForEach(rows(keys, idKey: "key_id")) { r in
                    Toggle(isOn: Binding(get: { !unticked.contains(r.id) }, set: { on in if on { unticked.remove(r.id) } else { unticked.insert(r.id) } })) {
                        Text(r.j.str("label", "Touch ID key"))
                    }.toggleStyle(.checkbox)
                }
                HStack {
                    Button("Remove selected") {
                        action.run {
                            for k in keys where !unticked.contains(k.str("key_id")) { try await model.approval.revoke(keyId: k.str("key_id")) }
                            model.staleKeys = []; await model.refresh()
                        }
                    }.disabled(action.busy)
                    Button("Keep them") { model.staleKeys = [] }
                }
                ErrorLine(text: action.error)
            }
            .padding(12).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// Banners at the top of the Inbox and Settings: recovery open, a migration notice, hardened pin out of date, sender holding, Touch ID missing.
/// (Put inside a List section: a safe-area inset on the whole detail column blanked the window.)
struct BannerStack: View {
    @EnvironmentObject var model: AppModel
    /// Settings shows the Touch ID card itself, so it passes false there instead of repeating the banner.
    var showTouchID = true
    var body: some View {
        VStack(spacing: 8) {
            if model.setup.recoveryOpen {
                let opened = model.setup.recoveryOpenedAt.map { $0.formatted(date: .omitted, time: .shortened) } ?? "a moment ago"
                banner(.orange, "lock.open", "Recovery opened at \(opened)",
                       "Someone ran the recover command in Terminal. If that wasn't you, press Cancel recovery.") {
                    Button("Cancel recovery") { Task { await model.cancelRecovery() } }
                }
            }
            if let n = model.migrationNotice {
                banner(.blue, "info.circle", "Cancelled", n) { Button("OK") { model.migrationNotice = nil } }
            }
            if model.pinNeedsUpdate {
                let cmd = model.status.obj("pin").str("install_command")
                VStack(alignment: .leading, spacing: 8) {
                    Label("Your installed pin still trusts a key you revoked", systemImage: "exclamationmark.octagon.fill").font(.headline).foregroundStyle(.red)
                    Text("Run this command to finish:" + (model.keysActive == 0 ? " Until then, Stop all sending is the only way to block it." : ""))
                        .font(.callout)
                    if !cmd.isEmpty { CommandBox(command: cmd, label: "Copy harden command") }
                    if model.keysActive == 0 && !model.killSwitch { Button("Stop all sending", role: .destructive) { Task { await model.stopAll() } } }
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            }
            if let off = model.senderOff {
                banner(.orange, "exclamationmark.triangle", "The sender isn't running", off) {
                    Button("Open Login Items") { LoginItems.openSystemSettings() }
                }
            }
            if let hold = model.senderHold {
                banner(.orange, "pause.circle", "The sender is holding approved messages", hold) { EmptyView() }
            }
            if !showTouchID {
            } else if model.native.touchIDReason != nil && model.reachable && model.onboarded {
                banner(.orange, "touchid", "Touch ID isn't available", (model.native.touchIDReason ?? "") + " Approving is off.") { EmptyView() }
            } else if model.needsKeySetup && model.gateDismissed {
                banner(.orange, "touchid", "Set up Touch ID to approve", "Agents can draft, but nothing can be approved until Touch ID is set up.") {
                    Button("Set up…") { model.gateDismissed = false }
                }
            }
            StaleKeysCard()
        }
    }

    private func banner<A: View>(_ tone: Color, _ symbol: String, _ title: String, _ text: String, @ViewBuilder actions: () -> A) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tone)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.semibold))
                Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            actions()
        }
        .padding(10).background(tone.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}
