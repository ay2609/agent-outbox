import Foundation

/// What the dry writer records about one write, and what the live one ignores.
public struct WriteContext {
    public let changeId: String
    public let approvalId: String?          // nil for auto-applied creates
    public let kind: String                 // create | update | undo
    public let targetMacosId: String?
    /// The parsed payload_json, for the dry log.
    public let payload: [String: Any]
}

/// The only way contact changes reach the address book. `LiveContactsWriter` saves through CNContactStore (via the provider);
/// `DryContactsWriter` appends to logs/dry-contacts.jsonl and touches nothing. Which one runs is decided per change, from the
/// signed manifest (or, for auto creates, the setting) AND the pin policy (trusted pin, hardened or simple), never by a DB value alone.
public protocol ContactsWriter: AnyObject {
    var name: String { get }                // "dry" | "live"
    /// Returns the new contact's identifier ("dry:<change_id>" for the dry writer).
    func create(_ n: NewContact, _ ctx: WriteContext) throws -> String
    func update(identifier: String, edit: ContactEdit, _ ctx: WriteContext) throws
    func delete(identifier: String, _ ctx: WriteContext) throws
}

public final class LiveContactsWriter: ContactsWriter {
    public let name = "live"
    private let provider: ContactsProvider
    public init(provider: ContactsProvider) { self.provider = provider }

    public func create(_ n: NewContact, _ ctx: WriteContext) throws -> String { try provider.createContact(n) }
    public func update(identifier: String, edit: ContactEdit, _ ctx: WriteContext) throws { try provider.updateContact(identifier: identifier, edit: edit) }
    public func delete(identifier: String, _ ctx: WriteContext) throws { try provider.deleteContact(identifier: identifier) }
}

/// Appends `{"at","change_id","approval_id","kind","target_macos_id","payload"}` to dry-contacts.jsonl.
public final class DryContactsWriter: ContactsWriter {
    public let name = "dry"
    private let logPath: String
    private let clock: () -> Date
    public init(logPath: String, clock: @escaping () -> Date = Date.init) { self.logPath = logPath; self.clock = clock }

    private func log(_ ctx: WriteContext) throws {
        let rec: [String: Any] = [
            "at": Time.iso(clock()), "change_id": ctx.changeId, "approval_id": ctx.approvalId.map { $0 as Any } ?? NSNull(),
            "kind": ctx.kind, "target_macos_id": ctx.targetMacosId.map { $0 as Any } ?? NSNull(), "payload": ctx.payload,
        ]
        guard let line = JSON.data(rec), appendLine(line, to: logPath) else { throw ExecError("could not append to \(logPath)") }
    }

    public func create(_ n: NewContact, _ ctx: WriteContext) throws -> String { try log(ctx); return "dry:" + ctx.changeId }
    public func update(identifier: String, edit: ContactEdit, _ ctx: WriteContext) throws { try log(ctx) }
    public func delete(identifier: String, _ ctx: WriteContext) throws { try log(ctx) }
}
