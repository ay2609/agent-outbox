// Tiny check helpers for the self-test (the toolchain on this Mac has neither XCTest nor Swift Testing's macros without full Xcode).
// Failures are collected, and the runner reports them per case.
import Foundation

final class CheckLog: @unchecked Sendable {
    static let shared = CheckLog()
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
    func drain() -> [String] { lock.lock(); defer { lock.unlock() }; let r = items; items = []; return r }
}

private func note(_ msg: String, _ file: StaticString, _ line: UInt) { CheckLog.shared.add("\((String(describing: file) as NSString).lastPathComponent):\(line) \(msg)") }

func expectEq<T: Equatable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) rethrows {
    let x = try a(), y = try b()
    if x != y { note(msg.isEmpty ? "\(x) is not equal to \(y)" : msg, file, line) }
}
func expectTrue(_ e: @autoclosure () throws -> Bool, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) rethrows {
    if !(try e()) { note(msg.isEmpty ? "expected true" : msg, file, line) }
}
func expectFalse(_ e: @autoclosure () throws -> Bool, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) rethrows {
    if try e() { note(msg.isEmpty ? "expected false" : msg, file, line) }
}
func expectNil<T>(_ e: @autoclosure () throws -> T?, file: StaticString = #filePath, line: UInt = #line) rethrows {
    if let v = try e() { note("expected nil, got \(v)", file, line) }
}
func expectNoThrow<T>(_ e: @autoclosure () throws -> T, file: StaticString = #filePath, line: UInt = #line) {
    do { _ = try e() } catch { note("threw \(error)", file, line) }
}
func fail(_ msg: String, file: StaticString = #filePath, line: UInt = #line) { note(msg, file, line) }
