// `swift test` on a machine with XCTest (full Xcode, CI): runs the module's own checks (Sources/NativeApproval/SelfTest). On a machine with
// only the Command Line Tools, run them with `swift run native-approval-selftest` instead.
#if canImport(XCTest)
import XCTest
import NativeApproval

final class NativeApprovalTests: XCTestCase {
    func testAllNativeApprovalChecksPass() async {
        let ok = await NativeApprovalSelfTest.run()
        XCTAssertTrue(ok, "see the FAIL lines in the test log")
    }
}
#endif
