import SwiftUI

/// The confirm sheet: every recipient, every message body, every proposed contact, a LIVE banner and the counts the Touch ID reason uses,
/// all drawn from `ApprovalPayload`, i.e. from the exact manifest bytes that get signed. The app presents it (a sheet over the batch);
/// it never builds its own signing UI. Pressing Approve is what allows the one signature that follows (valid for 60 seconds).
public struct ApprovalConfirmView: View {
    public let payload: ApprovalPayload
    public let onApprove: () -> Void
    public let onCancel: () -> Void

    public init(payload: ApprovalPayload, onApprove: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.payload = payload; self.onApprove = onApprove; self.onCancel = onCancel
    }

    private var title: String {
        switch payload.kind {
        case .send:
            let n = payload.itemCount, p = payload.peopleCount
            return "Approve \(n) \(n == 1 ? "message" : "messages") to \(p) \(p == 1 ? "person" : "people")"
        case .contacts:
            let n = payload.itemCount
            return "Approve \(n) contact \(n == 1 ? "change" : "changes")"
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.title2.weight(.semibold))
                if payload.isLive {
                    Label(payload.kind == .send ? "LIVE: these messages will really be sent" : "LIVE: these contacts will really be changed", systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.semibold)).foregroundColor(.white)
                        .padding(.horizontal, 10).padding(.vertical, 6).background(Color.red, in: RoundedRectangle(cornerRadius: 6))
                } else {
                    Label(payload.kind == .send ? "Dry run: nothing is sent" : "Dry run: nothing is changed", systemImage: "checkmark.shield")
                        .font(.callout).foregroundColor(.secondary)
                }
            }
            .padding(16)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if payload.kind == .send {
                        ForEach(payload.recipients) { r in recipientRow(r) }
                    } else {
                        ForEach(payload.changes) { c in changeRow(c) }
                    }
                }
                .padding(16)
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                Text("Touch ID only appears right after you press Approve in Agent Outbox. If it appears at any other time, press Cancel.")
                    .font(.footnote).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                    Button(action: onApprove) { Label("Approve with Touch ID", systemImage: "touchid") }
                        .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                }
            }
            .padding(16)
        }
        .frame(minWidth: 460, idealWidth: 540, minHeight: 360, idealHeight: 520)
    }

    @ViewBuilder private func recipientRow(_ r: ApprovalPayload.Recipient) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if !r.name.isEmpty { Text(r.name).font(.headline) }
                Text(r.to).font(.callout.monospaced()).foregroundColor(.secondary)
                Text(r.service == "auto" ? "iMessage or SMS" : r.service).font(.caption).foregroundColor(.secondary)
            }
            Text(r.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
            if let c = r.createContact {
                Label("Also adds a contact: \(c.line)", systemImage: "person.crop.circle.badge.plus").font(.callout).foregroundColor(.orange)
            }
        }
    }

    @ViewBuilder private func changeRow(_ c: ApprovalPayload.ContactChange) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(c.kind == "create" ? "New contact" : c.kind == "undo" ? "Undo a change" : "Edit a contact").font(.headline)
            ForEach(Array(c.lines.enumerated()), id: \.offset) { _, line in Text(line).textSelection(.enabled).font(.callout) }
        }
        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// Connects `NativeApprover.confirmer` to SwiftUI: `confirm` publishes the payload and suspends until the owner decides.
/// Present it with `.sheet(item: coordinator.pendingBinding) { ApprovalConfirmView(payload: $0, onApprove: coordinator.approve, onCancel: coordinator.cancel) }`.
public final class ApprovalConfirmCoordinator: ObservableObject, ApprovalConfirming, @unchecked Sendable {
    @Published public private(set) var pending: ApprovalPayload?
    private var continuation: CheckedContinuation<Bool, Never>?

    public init() {}

    public func confirm(_ payload: ApprovalPayload) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            DispatchQueue.main.async {
                self.resolve(false)                 // a newer request supersedes an older one: that one is cancelled, never approved
                self.pending = payload
                self.continuation = cont
            }
        }
    }

    @MainActor public func approve() { resolve(true) }
    @MainActor public func cancel() { resolve(false) }

    /// For `.sheet(item:)`: dismissing the sheet (set to nil) cancels.
    public var pendingBinding: Binding<ApprovalPayload?> {
        Binding(get: { self.pending }, set: { if $0 == nil { self.resolve(false) } })
    }

    private func resolve(_ approved: Bool) {
        let c = continuation
        continuation = nil
        pending = nil
        c?.resume(returning: approved)
    }
}
