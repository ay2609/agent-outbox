import Foundation

/// One request to the owner API over the app channel (local-docs/APP-SECURITY-C.md section 7).
/// Track B owns the socket implementation; NativeApproval consumes this protocol and tests with a stub.
public protocol OwnerAPIClient: Sendable {
    func request(_ method: String, _ path: String, json: Data?) async throws -> (status: Int, body: Data)
}
