import SwiftUI
import AppKit

// Development aids, honoured only when AGENT_OUTBOX_DEV=1 (or the app isn't a real bundle). They exist so the UX round can drive the
// real app without clicks. Nothing here runs in a normal install.
//   AGENT_OUTBOX_DEV_SHEET=send|send-live|contacts   show the approval confirm sheet with a fake payload
//   AGENT_OUTBOX_DEV_APPEARANCE=light|dark   force the appearance
//   AGENT_OUTBOX_DEV_TOUCHID=1         pretend Touch ID is available (screens only; signing still fails here)
//   AGENT_OUTBOX_DEV_TAB=audit         Activity tab; AGENT_OUTBOX_DEV_EDIT=<phone> open that message's editor
//   AGENT_OUTBOX_DEV_SIZE=940x1000   resize the main window
//   AGENT_OUTBOX_DEV_URL=agent-outbox://batch/b1   handle a deep link a few seconds after launch
//   AGENT_OUTBOX_DEV_ACTION=stop|resume   press Stop all sending / Resume sending
//   AGENT_OUTBOX_DEV_MENU=1            pop open the menu bar menu a few seconds after launch
//   AGENT_OUTBOX_START_STEP=0...4      first-run step; AGENT_OUTBOX_LAUNCHAGENTS_DIR=<dir> fake old LaunchAgents for the migration screen

/// Dev runs never run launchctl.
let devNoopRunner: CommandRunner = { _, _ in (0, "") }
/// Dev runs never touch the real `claude` registration: `mcp get` says "not found", `mcp add` pretends to work.
let devClaudeRunner: CommandRunner = { _, args in args.contains("get") ? (1, "No MCP server found") : (0, "stubbed in development") }

extension AppModel {
    func devHooksAtLaunch() {
        guard AppEnv.isDev else { return }
        if let a = AppEnv.env["AGENT_OUTBOX_DEV_APPEARANCE"] {
            Task { @MainActor in NSApp.appearance = NSAppearance(named: a == "dark" ? .darkAqua : .aqua) }
        }
        if let z = AppEnv.env["AGENT_OUTBOX_DEV_SIZE"] {   // "940x1000"
            let d = z.split(separator: "x").compactMap { Double($0) }
            if d.count == 2 { Task { @MainActor in
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                for w in NSApp.windows where w.canBecomeMain { w.setContentSize(NSSize(width: d[0], height: d[1])); w.center() }
            } }
        }
        if let k = AppEnv.env["AGENT_OUTBOX_DEV_SHEET"], !k.isEmpty {
            Task { @MainActor in try? await Task.sleep(nanoseconds: 3_500_000_000); self.approval.devPreview(kind: k) }
        }
        if let r = AppEnv.env["AGENT_OUTBOX_DEV_URL"], let u = URL(string: r) {   // a link such as agent-outbox://batch/b1
            Task { @MainActor in try? await Task.sleep(nanoseconds: 5_000_000_000); self.handle(url: u) }
        }
        if let a = AppEnv.env["AGENT_OUTBOX_DEV_ACTION"], a == "stop" || a == "resume" {   // the menu's "Stop all sending" / "Resume sending"
            Task { @MainActor in try? await Task.sleep(nanoseconds: 4_000_000_000); if a == "stop" { await self.stopAll() } else { await self.resume() } }
        }
        if AppEnv.env["AGENT_OUTBOX_DEV_MENU"] == "1" {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                for w in NSApp.windows where String(describing: type(of: w)).contains("StatusBar") {
                    if let b = findButton(w.contentView) { b.performClick(nil); break }
                }
            }
        }
    }
    private func findButton(_ v: NSView?) -> NSStatusBarButton? {
        guard let v else { return nil }
        if let b = v as? NSStatusBarButton { return b }
        for s in v.subviews { if let b = findButton(s) { return b } }
        return nil
    }
}
