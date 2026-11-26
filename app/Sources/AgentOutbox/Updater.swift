import AppKit
import Foundation

/// Update check for the ad-hoc-signed, hardened-runtime app: reads the appcast (Sparkle-format RSS at SUFeedURL-like
/// `AOUpdateFeedURL` in Info.plist), compares CFBundleVersion, and sends the user to the GitHub release page to
/// download the new DMG. It never downloads or installs anything itself.
///
/// Why not Sparkle: Sparkle.framework is signed by someone else, and a hardened-runtime app only loads frameworks with
/// the same Team ID. Ad-hoc signing has none, so dyld refuses ("different Team IDs") unless the app carries
/// `com.apple.security.cs.disable-library-validation`, which the security contract (APP-SECURITY-C section 10) forbids
/// on the outer app. Verified 2026-11-25; see the packaging notes in CLAUDE.md. The appcast stays Sparkle-compatible, so
/// switching later is a packaging change, not a feed change.
///
/// Track B wires it up:
///   - a "Check for Updates…" menu item calling `AppUpdater.shared.checkForUpdates()`, disabled while
///     `AppUpdater.shared.canCheckForUpdates` is false;
///   - `AppUpdater.shared.busyCheck = { supervisor.batchIsSending }` (the alert then says to update after the batch);
///   - optionally `AppUpdater.shared.checkInBackgroundIfDue()` once at launch (at most one check per 24 h, silent
///     unless a newer version exists that the user has not already been told about).
@MainActor
final class AppUpdater: NSObject {
    static let shared = AppUpdater()

    /// Set by the shell: true while a batch is sending.
    var busyCheck: () -> Bool = { false }

    private(set) var isChecking = false
    private let defaults = UserDefaults.standard
    private let lastCheckKey = "AOUpdateLastCheck"
    private let lastToldKey = "AOUpdateLastToldBuild"

    private var feedURL: URL? {
        (Bundle.main.object(forInfoDictionaryKey: "AOUpdateFeedURL") as? String).flatMap(URL.init(string:))
    }
    private var currentBuild: Int { Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0 }
    private var currentVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?" }

    /// False when running unbundled (`swift run`: no feed URL) or while a check is in flight.
    var canCheckForUpdates: Bool { feedURL != nil && !isChecking }

    /// User-initiated check: always reports the result (new version, up to date, or the error).
    func checkForUpdates() { Task { await run(interactive: true) } }

    /// Launch-time check: silent unless there is a newer build the user has not been told about yet.
    func checkInBackgroundIfDue() {
        let last = defaults.object(forKey: lastCheckKey) as? Date ?? .distantPast
        guard Date().timeIntervalSince(last) > 24 * 3600 else { return }
        Task { await run(interactive: false) }
    }

    private func run(interactive: Bool) async {
        guard let feedURL, !isChecking else { return }
        isChecking = true
        defer { isChecking = false }
        do {
            var req = URLRequest(url: feedURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
            req.setValue("AgentOutbox/\(currentVersion)", forHTTPHeaderField: "User-Agent")
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            defaults.set(Date(), forKey: lastCheckKey)
            guard let item = AppcastParser.firstItem(in: data) else { throw URLError(.cannotParseResponse) }
            if item.build > currentBuild {
                if !interactive && defaults.integer(forKey: lastToldKey) >= item.build { return }
                defaults.set(item.build, forKey: lastToldKey)
                present(newer: item)
            } else if interactive {
                info("Agent Outbox is up to date", "You have version \(currentVersion), the newest one.")
            }
        } catch {
            if interactive { info("Couldn't check for updates", error.localizedDescription) }
        }
    }

    private func present(newer item: AppcastParser.Item) {
        let alert = NSAlert()
        alert.messageText = "Agent Outbox \(item.version) is available"
        var text = "You have \(currentVersion). Download the new version, quit Agent Outbox and drag the new app into Applications."
        if busyCheck() { text += "\n\nA batch is sending right now: update after it finishes." }
        alert.informativeText = text
        alert.addButton(withTitle: "Download")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn, let url = item.pageURL { NSWorkspace.shared.open(url) }
    }

    private func info(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
    }
}

/// Reads the newest `<item>` of a Sparkle-format appcast: sparkle:version (build), sparkle:shortVersionString, link.
enum AppcastParser {
    struct Item { var build: Int; var version: String; var pageURL: URL? }

    static func firstItem(in data: Data) -> Item? {
        let p = XMLParser(data: data)
        let d = Delegate()
        p.delegate = d
        p.parse()
        return d.item
    }

    private final class Delegate: NSObject, XMLParserDelegate {
        var item: Item?
        private var inItem = false, done = false
        private var path = "", text = ""
        private var build = 0, version = "", link = ""

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
            guard !done else { return }
            if name == "item" { inItem = true; build = 0; version = ""; link = "" }
            if inItem, name == "enclosure" {
                if let v = attributes["sparkle:version"], let b = Int(v) { build = b }
                if let v = attributes["sparkle:shortVersionString"] { version = v }
            }
            text = ""
        }
        func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }
        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            guard inItem, !done else { return }
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            switch name {
            case "sparkle:version": build = Int(t) ?? build
            case "sparkle:shortVersionString": version = t
            case "link": link = t
            case "item":
                done = true
                item = Item(build: build, version: version.isEmpty ? String(build) : version, pageURL: URL(string: link))
            default: break
            }
        }
    }
}
