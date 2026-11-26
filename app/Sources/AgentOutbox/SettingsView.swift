import SwiftUI

extension AppModel {
    /// Live / Dry run. Dry needs no confirmation. Live needs a sign-in confirmation when something changes: Touch ID through the app's
    /// Secure Enclave key when one is active (se_reauth), otherwise the browser.
    func setMode(_ mode: String) async throws {
        do { _ = try await post("/api/mode", ["mode": mode]) }
        catch let e as APIFailure where e.code == "reauth_required" {
            let haveKey = native.keysActive > 0 || status.obj("native").int("keys_active") > 0
            guard haveKey else {
                await openBrowser(then: "/settings")
                throw APIFailure(status: 403, code: e.code, message: "Going live needs Touch ID. Finish it in your browser, or set up Touch ID in this app first.")
            }
            let r = try await approval.seReauth(action: "mode_live")
            _ = try await post("/api/mode", ["mode": mode, "se_reauth": r])
        }
        await refresh()
    }
}

private struct PacingPreset { let name: String; let min: Int; let max: Int; let cap: Int; let qs: String; let qe: String }
private let gentle = PacingPreset(name: "Gentle", min: 30, max: 90, cap: 150, qs: "", qe: "")
private let careful = PacingPreset(name: "Careful", min: 120, max: 300, cap: 50, qs: "21:00", qe: "09:00")

private func secs(_ s: Int) -> String { s < 90 ? "\(s) s" : "\(Int((Double(s) / 60).rounded())) min" }
private func describePacing(_ p: J) -> String {
    let mn = p.int("min_s"), mx = p.int("max_s")
    var out = mn == mx ? "A pause of \(secs(mn)) between messages" : "A pause of \(secs(mn)) to \(secs(mx)) between messages"
    if p.int("daily_cap") > 0 { out += ", up to \(p.int("daily_cap")) a day" }
    if !p.str("quiet_start").isEmpty && !p.str("quiet_end").isEmpty { out += ", none from \(p.str("quiet_start")) to \(p.str("quiet_end"))" }
    return out + "."
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var settings = Loader()
    @StateObject private var passkeys = Loader()
    @StateObject private var nativeKeys = Loader()
    @StateObject private var action = Action()
    @State private var loginSummary = LoginItems.summary()
    @State private var copied = false

    var body: some View {
        let st = settings.data?.obj("settings") ?? [:]
        let pacing = st.obj("pacing")
        let pin = model.status.obj("pin")
        let keys = nativeKeys.data?.arr("keys") ?? []
        let pk = passkeys.data?.arr("passkeys") ?? []
        Form {
            Section { ServerBanner(); ErrorLine(text: action.error ?? settings.error); if let n = action.note { Text(n).foregroundStyle(.secondary) } }

            Section("Sending") {
                Picker("Mode", selection: Binding(get: { model.isLive ? "live" : "dry" }, set: { m in
                    action.run { try await model.setMode(m); await settings.load(model, "/api/settings") }
                })) {
                    Text("Dry run").tag("dry"); Text("Live").tag("live")
                }.pickerStyle(.segmented).disabled(action.busy)
                Text(model.isLive ? "Live: messages you approve with Touch ID are really sent." : "Dry run: approved messages are recorded but nothing is sent.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    if model.killSwitch {
                        Chip("Sending stopped", .bad)
                        Button("Resume sending") { Task { await model.resume() } }
                    } else {
                        Button("Stop all sending", role: .destructive) { Task { await model.stopAll() } }
                        Text("Revokes every approval that hasn't been sent.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            Section("Spread out messages") {
                if !pacing.isEmpty {
                    Picker("Pace", selection: Binding(get: { presetName(pacing) }, set: { setPace($0) })) {
                        Text("Off").tag("off"); Text("Gentle").tag("gentle"); Text("Careful").tag("careful")
                        if presetName(pacing) == "custom" { Text("Custom").tag("custom") }
                    }.pickerStyle(.segmented).disabled(action.busy)
                    Text(pacing.bool("enabled") ? describePacing(pacing) : "Messages are sent one after another without a pause.").font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Approval keys") {
                if keys.isEmpty && pk.isEmpty { Text("No approval key yet.").foregroundStyle(.secondary) }
                ForEach(rows(keys, idKey: "key_id")) { r in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.j.str("label", "Touch ID key")).font(.headline)
                            Text("Touch ID on this Mac, \(r.j.str("status"))\(r.j.bool("in_effective_pin") ? ", in the sender's pin" : "")").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if r.j.str("status") != "revoked" {
                            Button("Revoke", role: .destructive) { action.run { _ = try await model.post("/api/native-keys/\(r.id)/revoke"); await nativeKeys.load(model, "/api/native-keys") } }
                        }
                    }
                }
                ForEach(rows(pk, idKey: "credential_id")) { r in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.j.str("label", "Passkey")).font(.headline)
                            Text("Browser passkey, \(r.j.str("purpose") == "approve" ? "approval" : "sign-in")").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                HStack {
                    Button("Set up Touch ID in this app") {
                        action.run {
                            _ = try await model.approval.enroll(label: Host.current().localizedName ?? "This Mac")
                            await nativeKeys.load(model, "/api/native-keys"); await model.refresh()
                        }
                    }.disabled(!model.native.touchIDAvailable || action.busy)
                    Button("Add a browser passkey") { Task { await model.openBrowser(then: "/settings") } }
                }
                if !model.native.touchIDAvailable { Text("Touch ID setup in the app isn't available here; approvals use the browser.").font(.caption).foregroundStyle(.secondary) }
            }

            Section("Protection") {
                HStack {
                    Chip(model.hardened ? "Hardened" : "Simple mode", model.hardened ? .good : .warn)
                    Spacer()
                }
                Text(model.hardened
                     ? "The sender trusts only the key file an administrator installed. After you change a key or policy, run the command again."
                     : "Simple mode is the default. A program running as you, outside its sandbox, could write its own key into the pin file and approve its own messages. Hardening copies the pin to a folder only an administrator can change.")
                    .font(.callout).foregroundStyle(.secondary)
                if let cmd = pin["install_command"] as? String, !cmd.isEmpty {
                    Text(cmd).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
                    HStack {
                        Button(copied ? "Copied" : "Copy harden command") { copyToPasteboard(cmd); copied = true }
                        Text("Paste it into Terminal. It asks for your password.").font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    Text("The harden command appears once an approval key exists.").font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("This app") {
                LabeledContent("Server", value: model.supervisor.state.label)
                LabeledContent("Open at login", value: loginSummary.app)
                LabeledContent("Sender (login item)", value: loginSummary.executor)
                HStack {
                    Button("Register login items") { if let p = LoginItems.register() { action.error = p }; loginSummary = LoginItems.summary() }.disabled(AppEnv.isDev)
                    if loginSummary.needsApproval { Button("Open Login Items settings") { LoginItems.openSystemSettings() } }
                    Button("Run setup again") { model.restartOnboarding() }
                }
                if AppEnv.isDev { Text("Development run: login items are not registered.").font(.caption).foregroundStyle(.secondary) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .task(id: model.reachable) {
            if model.reachable {
                await settings.load(model, "/api/settings"); await passkeys.load(model, "/api/passkeys")
                await nativeKeys.load(model, "/api/native-keys")   // 404 before the native-approval server lands: the list stays empty
                if nativeKeys.data == nil { nativeKeys.error = nil }
            }
        }
    }

    private func presetName(_ p: J) -> String {
        guard p.bool("enabled") else { return "off" }
        for (n, x) in [("gentle", gentle), ("careful", careful)] where p.int("min_s") == x.min && p.int("max_s") == x.max && p.int("daily_cap") == x.cap && p.str("quiet_start") == x.qs && p.str("quiet_end") == x.qe { return n }
        return "custom"
    }
    private func setPace(_ n: String) {
        let body: J
        switch n {
        case "off": body = ["enabled": false]
        case "gentle": body = ["enabled": true, "min_s": gentle.min, "max_s": gentle.max, "daily_cap": gentle.cap, "quiet_start": gentle.qs, "quiet_end": gentle.qe]
        case "careful": body = ["enabled": true, "min_s": careful.min, "max_s": careful.max, "daily_cap": careful.cap, "quiet_start": careful.qs, "quiet_end": careful.qe]
        default: return
        }
        action.run { _ = try await model.call("PATCH", "/api/settings", ["pacing": body]); await settings.load(model, "/api/settings") }
    }
}
