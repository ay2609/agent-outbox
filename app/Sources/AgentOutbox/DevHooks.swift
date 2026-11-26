import SwiftUI
import AppKit

// Development aids, honoured only when AGENT_OUTBOX_DEV=1 (or the app isn't a real bundle). They exist so the UX round can drive the
// real app without clicks. Nothing here runs in a normal install.
//   AGENT_OUTBOX_DEV_OPEN_LOG=<file>   URLs the app would open are appended there instead of opening a browser (any dev run)
//   AGENT_OUTBOX_DEV_SHEET=send|send-live|contacts   show the approval confirm sheet with a fake payload
//   AGENT_OUTBOX_DEV_APPEARANCE=light|dark   force the appearance
//   AGENT_OUTBOX_DEV_SIZE=940x1000   resize the main window
//   AGENT_OUTBOX_DEV_OPEN_BROWSER=/batch/<id>   do what Approve does without a click (the URL goes to the open log)
//   AGENT_OUTBOX_DEV_ACTION=stop|resume   press Stop all sending / Resume sending
//   AGENT_OUTBOX_DEV_MENU=1            pop open the menu bar menu a few seconds after launch
//   AGENT_OUTBOX_START_STEP=0...4      first-run step; AGENT_OUTBOX_LAUNCHAGENTS_DIR=<dir> fake old LaunchAgents for the migration screen

/// Opens a URL in the default browser. Dev runs log it (and don't open anything) so a test can check what would have opened.
func openExternal(_ url: URL) {
    if AppEnv.isDev {
        if let f = AppEnv.env["AGENT_OUTBOX_DEV_OPEN_LOG"], !f.isEmpty {
            let line = Data((url.absoluteString + "\n").utf8)
            if let h = FileHandle(forWritingAtPath: f) { h.seekToEndOfFile(); h.write(line); try? h.close() } else { FileManager.default.createFile(atPath: f, contents: line) }
        }
        return
    }
    NSWorkspace.shared.open(url)
}

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
        if let r = AppEnv.env["AGENT_OUTBOX_DEV_OPEN_BROWSER"], !r.isEmpty {   // like pressing "Open in browser" / Approve: logs the URL
            Task { @MainActor in try? await Task.sleep(nanoseconds: 5_000_000_000); await self.openBrowser(then: r == "/" ? nil : r) }
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
