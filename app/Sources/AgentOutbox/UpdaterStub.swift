import Foundation

// TEMPORARY STUB (track B). Track A writes the real `Updater.swift` with `AppUpdater.shared`
// { checkForUpdates(), canCheckForUpdates, busyCheck }.
// AT MERGE: delete THIS file (UpdaterStub.swift). Nothing else changes; if A's property types differ
// (for example busyCheck is `@MainActor () -> Bool`), adjust the single assignment in AppModel.init.
final class AppUpdater {
    static let shared = AppUpdater()
    var canCheckForUpdates: Bool { false }
    /// Return true while a batch is sending, so an update waits.
    var busyCheck: (() -> Bool)?
    func checkForUpdates() {}
}
