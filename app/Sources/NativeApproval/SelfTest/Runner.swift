import Foundation

/// The module's own checks, run by `native-approval-selftest` (swift run) and, where XCTest exists (full Xcode, CI), by `NativeApprovalTests`.
/// Software keys stand in for the Secure Enclave; the real one is only touched with AO_SE_TESTS=1 on a Mac that has it.
public enum NativeApprovalSelfTest {
    static let cases: [(String, () async throws -> Void)] = [
        ("SigVectorTests.testMessageBytesMatchTheSharedVectors", { try await SigVectorTests().testMessageBytesMatchTheSharedVectors() }),
        ("SigVectorTests.testReauthAndEnrollDigests", { try await SigVectorTests().testReauthAndEnrollDigests() }),
        ("SigVectorTests.testTSSignaturesVerifyWithCryptoKitAndWrongTagDoesNot", { try await SigVectorTests().testTSSignaturesVerifyWithCryptoKitAndWrongTagDoesNot() }),
        ("SigVectorTests.testKeyIdIsBase64urlOfSha256OfX963", { try await SigVectorTests().testKeyIdIsBase64urlOfSha256OfX963() }),
        ("SigVectorTests.testSignAcceptsOnlyAValidSignatureFromTheSigner", { try await SigVectorTests().testSignAcceptsOnlyAValidSignatureFromTheSigner() }),
        ("SigVectorTests.testBase64urlRoundTrip", { try await SigVectorTests().testBase64urlRoundTrip() }),
        ("PayloadTests.testSendParsesAndCountsAndReasonTemplates", { try await PayloadTests().testSendParsesAndCountsAndReasonTemplates() }),
        ("PayloadTests.testReasonTemplatesNeverCarryAgentText", { try await PayloadTests().testReasonTemplatesNeverCarryAgentText() }),
        ("PayloadTests.testSendChecksRefuseWhatDoesNotMatch", { try await PayloadTests().testSendChecksRefuseWhatDoesNotMatch() }),
        ("PayloadTests.testCreateContactIsShown", { try await PayloadTests().testCreateContactIsShown() }),
        ("PayloadTests.testContactsParsingAndChecks", { try await PayloadTests().testContactsParsingAndChecks() }),
        ("ApproverFlowTests.testApproveBatchEndToEndSignsTheSameBytesTheSheetShows", { try await ApproverFlowTests().testApproveBatchEndToEndSignsTheSameBytesTheSheetShows() }),
        ("ApproverFlowTests.testCancelAndMissingConfirmerSignNothing", { try await ApproverFlowTests().testCancelAndMissingConfirmerSignNothing() }),
        ("ApproverFlowTests.testALyingServerNeverReachesTheSheetOrTheKey", { try await ApproverFlowTests().testALyingServerNeverReachesTheSheetOrTheKey() }),
        ("ApproverFlowTests.testNoLocalKeyAndServerKeyListMustMatch", { try await ApproverFlowTests().testNoLocalKeyAndServerKeyListMustMatch() }),
        ("ApproverFlowTests.testPressOfApproveExpiresAfterSixtySeconds", { try await ApproverFlowTests().testPressOfApproveExpiresAfterSixtySeconds() }),
        ("ApproverFlowTests.testServerRefusalSurfacesItsMessage", { try await ApproverFlowTests().testServerRefusalSurfacesItsMessage() }),
        ("ApproverFlowTests.testApproveContactsUsesTheContactsTag", { try await ApproverFlowTests().testApproveContactsUsesTheContactsTag() }),
        ("ApproverFlowTests.testEnrollFirstRunWithSetupTokenSignsPossessionProof", { try await ApproverFlowTests().testEnrollFirstRunWithSetupTokenSignsPossessionProof() }),
        ("ApproverFlowTests.testEnrollWithRecoveryTokenAndWithoutAnyProof", { try await ApproverFlowTests().testEnrollWithRecoveryTokenAndWithoutAnyProof() }),
        ("ApproverFlowTests.testEnrollWithAnExistingKeyBindsTheReauthToTheNewKey", { try await ApproverFlowTests().testEnrollWithAnExistingKeyBindsTheReauthToTheNewKey() }),
        ("ApproverFlowTests.testEnrollWithoutTouchIDIsACleanRefusalWithNoFallback", { try await ApproverFlowTests().testEnrollWithoutTouchIDIsACleanRefusalWithNoFallback() }),
        ("ApproverFlowTests.testSeReauthSignsTheChallengeAndRejectsUnknownActions", { try await ApproverFlowTests().testSeReauthSignsTheChallengeAndRejectsUnknownActions() }),
        ("ApproverFlowTests.testStatusPicksTheLocalActiveKeyAndRemovesDeadBlobs", { try await ApproverFlowTests().testStatusPicksTheLocalActiveKeyAndRemovesDeadBlobs() }),
        ("ApproverFlowTests.testRevokeDeletesTheBlob", { try await ApproverFlowTests().testRevokeDeletesTheBlob() }),
        ("ApproverFlowTests.testOnlyOneSignatureInFlight", { try await ApproverFlowTests().testOnlyOneSignatureInFlight() }),
        ("ApproverFlowTests.testRealSecureEnclaveCreateIsACleanFailureWithoutTouchID", { try await ApproverFlowTests().testRealSecureEnclaveCreateIsACleanFailureWithoutTouchID() }),
    ]

    /// Runs every case; prints one line each and returns true when all passed.
    public static func run(filter: String? = nil) async -> Bool {
        var passed = 0, failed = 0
        for (name, body) in cases where filter == nil || name.contains(filter!) {
            _ = CheckLog.shared.drain()
            var problems: [String] = []
            do { try await body() } catch { problems.append("threw \(error)") }
            problems += CheckLog.shared.drain()
            if problems.isEmpty { print("PASS  \(name)"); passed += 1 }
            else { print("FAIL  \(name)"); problems.forEach { print("        \($0)" ) }; failed += 1 }
        }
        print("\n\(passed) passed, \(failed) failed")
        return failed == 0
    }
}
