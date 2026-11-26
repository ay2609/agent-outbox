import SwiftUI

struct BatchRef: Hashable { let id: String }
struct SetRef: Hashable { let id: String }
struct GroupRef: Hashable { let id: String }

// MARK: - Inbox

struct InboxView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var batches = Loader()
    @StateObject private var sets = Loader()

    var body: some View {
        let bs = batches.data?.arr("batches") ?? []
        let cs = sets.data?.arr("sets") ?? []
        let needs = bs.filter { b in
            let c = b.obj("counts")
            return b.str("status") != "cancelled" && b.str("status") != "drafting" && c.int("review") + c.int("draft") + c.int("failed") > 0
        }
        let needIds = Set(needs.map { $0.id })
        let active = bs.filter { b in
            let c = b.obj("counts")
            return !needIds.contains(b.id) && (["approved", "sending"].contains(b.str("status")) || c.int("approved") + c.int("sending") > 0)
        }
        let activeIds = Set(active.map { $0.id })
        let drafting = bs.filter { $0.str("status") == "drafting" && !needIds.contains($0.id) }
        let draftingIds = Set(drafting.map { $0.id })
        let closed = bs.filter { !needIds.contains($0.id) && !activeIds.contains($0.id) && !draftingIds.contains($0.id) }

        List {
            Section { StatusStrip(); ServerBanner(); ErrorLine(text: batches.error) }
            if bs.isEmpty && cs.isEmpty && batches.data != nil {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Nothing to review").font(.headline)
                        Text("When a Claude session drafts messages, they show up here. Nothing is ever sent without your approval.").foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                }
            }
            if !cs.isEmpty || !needs.isEmpty {
                Section("Needs your review") {
                    ForEach(rows(cs)) { r in NavigationLink(value: SetRef(id: r.id)) { SetRow(s: r.j) } }
                    ForEach(rows(needs)) { r in NavigationLink(value: BatchRef(id: r.id)) { BatchRow(b: r.j) } }
                }
            }
            if !active.isEmpty { Section("Approved and sending") { ForEach(rows(active)) { r in NavigationLink(value: BatchRef(id: r.id)) { BatchRow(b: r.j) } } } }
            if !drafting.isEmpty { Section("Still being drafted") { ForEach(rows(drafting)) { r in NavigationLink(value: BatchRef(id: r.id)) { BatchRow(b: r.j) } } } }
            if !closed.isEmpty { Section("Finished") { ForEach(rows(Array(closed.prefix(20)))) { r in NavigationLink(value: BatchRef(id: r.id)) { BatchRow(b: r.j, muted: true) } } } }
        }
        .navigationTitle("Inbox")
        .toolbar { ToolbarItem { Button { Task { await reload() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task(id: model.pendingCount) { await reload() }
        .task(id: model.reachable) { if model.reachable { await reload() } }
    }

    private func reload() async {
        await batches.load(model, "/api/batches")
        await sets.load(model, "/api/contact-changes?status=review")
    }
}

struct StatusStrip: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        let s = model.status
        let e = s.obj("exec")
        HStack(spacing: 6) {
            if model.killSwitch { Chip("Sending stopped", .bad) }
            Chip(model.isLive ? "Live" : "Dry run", model.isLive ? .warn : .neutral)
            if !e.isEmpty {
                Chip(e.bool("alive") ? "Sender up" : "Sender silent \(e.int("heartbeat_age_s") / 60) min", e.bool("alive") ? .good : .bad)
            } else { Chip("Sender not seen", .bad) }
            Chip(s.obj("pin").obj("effective").bool("valid") ? "Keys pinned" : "Keys not pinned", s.obj("pin").obj("effective").bool("valid") ? .good : .warn)
            Chip(model.hardened ? "Hardened" : "Simple mode", model.hardened ? .good : .neutral)
            Spacer()
            if model.killSwitch { Button("Resume sending") { Task { await model.resume() } } }
        }
    }
}

struct BatchRow: View {
    let b: J
    var muted = false
    var body: some View {
        let c = b.obj("counts")
        let toReview = c.int("review") + c.int("draft")
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(b.str("title")).font(.headline).lineLimit(1)
                Spacer()
                Text(timeAgo(b.str("created_at"))).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 5) {
                if toReview > 0 { Chip("\(toReview) to review", .info) }
                if c.int("approved") + c.int("sending") > 0 { Chip("\(c.int("approved") + c.int("sending")) approved", .good) }
                if c.int("sent") > 0 { Chip("\(c.int("sent")) sent", .good) }
                if c.int("failed") > 0 { Chip("\(c.int("failed")) failed", .bad) }
                if c.int("unknown") > 0 { Chip("\(c.int("unknown")) unconfirmed", .warn) }
                if c.int("skipped") > 0 { Chip("\(c.int("skipped")) skipped") }
                if b.int("warnings") > 0 { Chip(plural(b.int("warnings"), "warning"), .warn) }
                if b.int("new_contacts") > 0 { Chip(plural(b.int("new_contacts"), "new contact"), .info) }
                if b.str("status") == "cancelled" { Chip("cancelled") }
            }
            Text("\(plural(b.int("total"), "message")) from \(b.str("created_by").replacingOccurrences(of: "agent:", with: ""))")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
        .opacity(muted ? 0.65 : 1)
    }
}

struct SetRow: View {
    let s: J
    var body: some View {
        let c = s.obj("counts")
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(s.str("title", "Contact changes")).font(.headline).lineLimit(1)
                Spacer()
                Text(timeAgo(s.str("created_at"))).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 5) {
                Chip("Contacts", .info)
                if c.int("review") > 0 { Chip("\(c.int("review")) to review", .info) }
                if c.int("applied") > 0 { Chip("\(c.int("applied")) applied", .good) }
            }
        }.padding(.vertical, 3)
    }
}

// MARK: - Batch review

/// Warnings that hold a message back until "include anyway" (mirrors HELD_WARNINGS / UNSENDABLE_WARNINGS in src/owner-api/approval.ts).
private let heldCodes: Set<String> = ["unresolved_var", "duplicate_recipient"]
private let unsendableCodes: Set<String> = ["empty_body", "invalid_handle"]

struct BatchView: View {
    @EnvironmentObject var model: AppModel
    let id: String
    @StateObject private var loader = Loader()
    @StateObject private var action = Action()
    @State private var selected: Set<String> = []
    @State private var seeded = false
    @State private var anyway = false
    @State private var confirmCancel = false

    private func codes(_ d: J) -> Set<String> { Set(d.arr("warnings").map { $0.str("code") }) }
    private func isHeld(_ d: J) -> Bool { !codes(d).isDisjoint(with: heldCodes) }
    private func isUnsendable(_ d: J) -> Bool { !codes(d).isDisjoint(with: unsendableCodes) }
    /// Waiting for approval and not inside a live approval.
    private func wantsApproval(_ d: J) -> Bool {
        (d["covered_by"] == nil || d["covered_by"] is NSNull) && ["review", "failed", "approved"].contains(d.str("status"))
    }

    var body: some View {
        let batch = loader.data?.obj("batch") ?? [:]
        let drafts = loader.data?.arr("drafts") ?? []
        let held = drafts.filter { wantsApproval($0) && isHeld($0) && !isUnsendable($0) }
        let ids = drafts.filter { selected.contains($0.id) && !isUnsendable($0) && (!isHeld($0) || anyway) }.map { $0.id }
        let heldIds = anyway ? held.filter { selected.contains($0.id) }.map { $0.id } : []
        let closed = ["cancelled", "done"].contains(batch.str("status"))

        VStack(spacing: 0) {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Chip(model.isLive ? "Live: approved messages are really sent" : "Dry run: nothing is sent", model.isLive ? .warn : .neutral)
                            if !batch.isEmpty { Chip(batch.str("status")) }
                        }
                        Text("From \(batch.str("created_by").replacingOccurrences(of: "agent:", with: "")), \(timeAgo(batch.str("created_at")))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ErrorLine(text: loader.error)
                }
                if !held.isEmpty && !closed {
                    Section {
                        Toggle(isOn: $anyway) {
                            VStack(alignment: .leading) {
                                Text("Include \(held.count) with unfilled fields or exact duplicates anyway")
                                Text(anyway ? "They are in this approval." : "They are left out unless you turn this on.").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("\(plural(drafts.count, "message"))") {
                    ForEach(rows(drafts)) { r in
                        DraftRow(d: r.j, wants: wantsApproval(r.j), unsendable: isUnsendable(r.j), held: isHeld(r.j),
                                 selected: Binding(get: { selected.contains(r.id) }, set: { on in if on { selected.insert(r.id) } else { selected.remove(r.id) } }),
                                 onSkip: { toggleSkip(r.j) })
                    }
                }
            }
            Divider()
            HStack {
                ErrorLine(text: action.error)
                if let n = action.note { Text(n).font(.callout).foregroundStyle(.secondary) }
                Spacer()
                if !closed {
                    Button("Cancel batch", role: .destructive) { confirmCancel = true }.disabled(action.busy)
                    Button(model.approveInApp ? "Approve \(ids.count) with Touch ID…" : "Approve \(ids.count) in browser…") { approve(ids, heldIds) }
                        .keyboardShortcut(.defaultAction)
                        .disabled(ids.isEmpty || action.busy || model.killSwitch)
                }
            }.padding(12)
        }
        .navigationTitle(batch.str("title", "Batch"))
        .task(id: model.reachable) { await reload() }
        .alert("Cancel this batch?", isPresented: $confirmCancel) {
            Button("Cancel batch", role: .destructive) { cancel() }
            Button("Keep", role: .cancel) {}
        } message: { Text("Its messages are rejected and any approval is revoked.") }
    }

    private func reload() async {
        await loader.load(model, "/api/batches/\(id)")
        guard let d = loader.data else { return }
        let drafts = d.arr("drafts")
        if !seeded {
            seeded = true
            selected = Set(drafts.filter { wantsApproval($0) }.map { $0.id })
        } else {
            // Keep the owner's choices; drop ids that are no longer approvable.
            selected = selected.filter { id in drafts.contains { $0.id == id && wantsApproval($0) } }
        }
    }

    private func toggleSkip(_ d: J) {
        action.run {
            if d.str("status") == "skipped" { _ = try await model.post("/api/drafts/\(d.id)/include"); selected.insert(d.id) }
            else { _ = try await model.post("/api/drafts/\(d.id)/skip"); selected.remove(d.id) }
            await reload()
        }
    }
    private func cancel() {
        action.run { _ = try await model.post("/api/batches/\(id)/cancel"); await reload(); await model.refresh() }
    }
    private func approve(_ ids: [String], _ heldIds: [String]) {
        action.run {
            if model.approveInApp {
                let ok = try await model.approval.approveBatch(id, draftIds: ids, includeAnyway: heldIds)
                action.note = ok ? "Approved." : "Not approved."
                await reload(); await model.refresh()
            } else {
                action.note = "Approve in your browser, then come back."
                await model.openBrowser(then: "/batch/\(id)")
            }
        }
    }
}

struct DraftRow: View {
    let d: J
    let wants: Bool
    let unsendable: Bool
    let held: Bool
    @Binding var selected: Bool
    let onSkip: () -> Void

    var body: some View {
        let status = d.str("status")
        let covered = !(d["covered_by"] == nil || d["covered_by"] is NSNull)
        let skipped = status == "skipped"
        HStack(alignment: .top, spacing: 10) {
            if wants && !unsendable { Toggle("", isOn: $selected).labelsHidden().toggleStyle(.checkbox) }
            else { Color.clear.frame(width: 16) }
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(d.str("recipient_name", d.str("handle"))).font(.headline)
                    Text(d.str("handle")).font(.caption).foregroundStyle(.secondary)
                    Chip(d.str("service", "auto"))
                    if covered { Chip("Approved", .good) } else if status != "review" && status != "draft" { Chip(status, status == "failed" ? .bad : (status == "sent" ? .good : .neutral)) }
                    if d.bool("create_contact") { Chip("New contact", .info) }
                }
                Text(d.str("body")).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                ForEach(Array(d.arr("warnings").enumerated()), id: \.offset) { _, w in
                    Label(w.str("message"), systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                }
                if unsendable { Text("Can't be sent as it is.").font(.caption).foregroundStyle(.red) }
                else if held { Text("Held back until you include it anyway.").font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            if ["draft", "review", "failed", "skipped"].contains(status) {
                Button(skipped ? "Include" : "Skip", action: onSkip).buttonStyle(.link).font(.caption)
            }
        }
        .padding(.vertical, 4)
        .opacity(skipped ? 0.55 : 1)
    }
}
