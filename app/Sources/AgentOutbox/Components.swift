import SwiftUI
import AppKit

enum Tone { case neutral, good, warn, bad, info
    var color: Color {
        switch self { case .neutral: return .secondary; case .good: return .green; case .warn: return .orange; case .bad: return .red; case .info: return .blue }
    }
}

struct Chip: View {
    let text: String
    var tone: Tone = .neutral
    init(_ text: String, _ tone: Tone = .neutral) { self.text = text; self.tone = tone }
    var body: some View {
        Text(text)
            .font(.caption)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(tone.color.opacity(0.15), in: Capsule())
            .foregroundStyle(tone == .neutral ? Color.secondary : tone.color)
    }
}

struct ErrorLine: View {
    let text: String?
    var body: some View {
        if let text, !text.isEmpty {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.callout).foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Plain-words status for a batch or contact set (the server's words are short codes).
func statusLabel(_ s: String) -> String {
    switch s {
    case "review": return "Waiting for your review"
    case "drafting", "draft": return "Still being drafted"
    case "approved": return "Approved"
    case "sending", "applying": return "Sending"
    case "done": return "Finished"
    case "cancelled": return "Cancelled"
    case "applied": return "Applied"
    case "failed": return "Failed"
    case "skipped": return "Skipped"
    default: return s.prefix(1).uppercased() + s.dropFirst()
    }
}

/// An empty list explained: what goes here and what to do.
struct EmptyState: View {
    let symbol: String
    let title: String
    let text: String
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 34)).foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(text).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 36)
    }
}

struct SectionTitle: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View { Text(text).font(.headline).padding(.top, 8) }
}

/// The server isn't answering (starting, restarting or broken).
struct ServerBanner: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if !model.reachable {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.supervisor.state.isRunning ? "Waiting for the server" : model.supervisor.state.label).font(.callout.weight(.medium))
                    if let e = model.connectionError, model.supervisor.state.isRunning || !model.supervisor.lastFailure.isEmpty {
                        Text(model.supervisor.lastFailure.isEmpty ? e : model.supervisor.lastFailure).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(10)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

func copyToPasteboard(_ s: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(s, forType: .string)
}

/// Loads one owner-API path into `data` and keeps it fresh when `tick` changes.
@MainActor
final class Loader: ObservableObject {
    @Published var data: J?
    @Published var error: String?
    @Published var loading = false
    func load(_ model: AppModel, _ path: String) async {
        loading = true
        defer { loading = false }
        do { data = try await model.get(path); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

/// Runs an async action with a busy flag and an error line.
@MainActor
final class Action: ObservableObject {
    @Published var busy = false
    @Published var error: String?
    @Published var note: String?
    func run(_ f: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil; note = nil
        Task { [weak self] in
            do { try await f() } catch { self?.error = error.localizedDescription }
            self?.busy = false
        }
    }
}
