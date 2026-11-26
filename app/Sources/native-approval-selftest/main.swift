// `swift run native-approval-selftest [filter]`: the NativeApproval checks without XCTest (the Command Line Tools have neither XCTest nor
// Swift Testing's macros). Exits 1 when any case fails.
import Foundation
import NativeApproval

let filter = CommandLine.arguments.dropFirst().first
let ok = await NativeApprovalSelfTest.run(filter: filter)
exit(ok ? 0 : 1)
