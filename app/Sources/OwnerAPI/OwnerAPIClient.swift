import Foundation

/// One request to the owner API over the app channel.
/// SocketOwnerAPIClient is the real implementation; NativeApproval consumes this protocol and tests with a stub.
public protocol OwnerAPIClient: Sendable {
    func request(_ method: String, _ path: String, json: Data?) async throws -> (status: Int, body: Data)
}
