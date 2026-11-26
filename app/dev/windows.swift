// Lists windows of processes whose name contains the argument (dev helper: swift app/dev/windows.swift AgentOutbox).
import CoreGraphics
import Foundation
let needle = CommandLine.arguments.dropFirst().first ?? "AgentOutbox"
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list where ((w[kCGWindowOwnerName as String] as? String) ?? "").contains(needle) {
    print(w[kCGWindowNumber as String] ?? "", w[kCGWindowOwnerName as String] ?? "", w[kCGWindowName as String] ?? "", w[kCGWindowBounds as String] ?? "", "layer", w[kCGWindowLayer as String] ?? "", "onscreen", w[kCGWindowIsOnscreen as String] ?? "no")
}
