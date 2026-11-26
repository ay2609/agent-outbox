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
            Section { BannerStack(); StatusStrip(); ServerBanner(); ErrorLine(text: batches.error) }
            if bs.isEmpty && cs.isEmpty && batches.data != nil {
                Section {
                    EmptyState(symbol: "tray", title: "Nothing to review",
                               text: "When Claude or another agent drafts messages for you, they appear here. Nothing is sent until you approve it. To try it, ask Claude: \u{201C}Use Agent Outbox to draft a text to me that says hi.\u{201D}")
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
            if model.killSwitch { Chip("Sending stopped", .bad).help("Nothing is sent until you press Resume sending.") }
            Chip(model.isLive ? "Live" : "Dry run", model.isLive ? .warn : .neutral)
                .help(model.isLive ? "Approved messages are really sent." : "Approved messages are recorded but nothing is sent. Change this in Settings.")
            if !e.isEmpty {
                Chip(e.bool("alive") ? "Sender running" : "Sender silent \(e.int("heartbeat_age_s") / 60) min", e.bool("alive") ? .good : .bad)
                    .help("The sender is the helper that hands approved messages to Messages.")
            } else { Chip("Sender not running", .bad).help("The sender is the helper that hands approved messages to Messages. It starts with the app; if this stays red, open Settings > This app.") }
            // An empty v4 pin is valid but trusts nobody: the chip needs an active key the sender's pin also lists.
            let keyed = s.obj("native").bool("approve_in_app") && s.obj("pin").obj("effective").bool("valid")
            Chip(keyed ? "Approval key set" : "No approval key yet", keyed ? .good : .warn)
                .help(s.obj("pin").obj("effective").bool("valid") ? "The sender only trusts approvals signed with your key." : "Set up approval in Settings before you approve anything.")
            Chip(model.hardened ? "Hardened" : "Simple mode", model.hardened ? .good : .neutral)
                .help("Settings > Protection explains what this means.")
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
            Text("\(plural(b.int("total"), "message")), drafted by \(b.str("created_by").replacingOccurrences(of: "agent:", with: ""))")
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
                Chip("Contact changes", .info)
                if c.int("review") > 0 { Chip("\(c.int("review")) to review", .info) }
                if c.int("applied") > 0 { Chip("\(c.int("applied")) applied", .good) }
            }
        }.padding(.vertical, 3)
    }
}


// MARK: - Batch review

struct BatchView: View {
    @EnvironmentObject var model: AppModel
    let id: String
    @StateObject private var loader = Loader()
    @StateObject private var action = Action()
    @State private var anyway = false
    @State private var filter: BatchFilter = .all
    @State private var confirmCancel = false

    var body: some View {
        let batch = loader.data?.obj("batch") ?? [:]
        let drafts = loader.data?.arr("drafts") ?? []
        let approvals = loader.data?.arr("approvals") ?? []
        let groups = groupDrafts(drafts)
        // Same rules as the old browser page: everything driven by the drafts, not by batch.status.
        let approvable = drafts.filter(isApprovable)
        let noText = drafts.filter { wantsApproval($0) && !isApprovable($0) }.count   // empty or invalid number: can't be sent
        let held = approvable.filter(isHeldDraft)
        // Held messages are OUT unless the one "include anyway" switch is on; includeAnyway lists exactly those.
        let chosen = approvable.filter { !isHeldDraft($0) || anyway }
        let ids = chosen.map { $0.id }
        let heldIds = anyway ? held.map { $0.id } : []
        // Leaving out one message of a chain would send half of it, so a group with any warned message goes out whole.
        let warnedIds = groups.filter { g in g.drafts.contains { d in approvable.contains { $0.id == d.id } && !shownWarnings(d).isEmpty } }
            .flatMap { $0.drafts.filter { isTogglable($0) && $0.str("status") != "skipped" }.map { $0.id } }
        let closed = ["cancelled", "done"].contains(batch.str("status"))
        let cancelled = batch.str("status") == "cancelled"
        let shown = groups.filter { g in g.drafts.contains { filter.matches($0) } }
        let counts = Dictionary(grouping: drafts, by: { $0.str("status") }).mapValues { $0.count }

        VStack(spacing: 0) {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Chip(model.isLive ? "Live: approved messages are really sent" : "Dry run: nothing is sent", model.isLive ? .warn : .neutral)
                            if !batch.isEmpty { Chip(statusLabel(cancelled ? "cancelled" : approvable.isEmpty ? batch.str("status") : "review")) }
                            ForEach(counts.keys.sorted(), id: \.self) { k in
                                Chip("\(counts[k] ?? 0) \(k)", k == "failed" ? .bad : (k == "sent" ? .good : .neutral))
                            }
                        }
                        Text("Drafted by \(batch.str("created_by").replacingOccurrences(of: "agent:", with: "")), \(timeAgo(batch.str("created_at")))")
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
                Section {
                    if drafts.count > 1 {
                        Picker("Filter", selection: $filter) {
                            ForEach(BatchFilter.allCases) { f in
                                Text("\(f.title) \(groups.filter { g in g.drafts.contains { f.matches($0) } }.count)").tag(f)
                            }
                        }
                        .pickerStyle(.segmented).labelsHidden()
                        .listRowSeparator(.hidden)
                    }
                    if !warnedIds.isEmpty && !cancelled {
                        Button { excludeWarned(warnedIds) } label: { Label("Exclude all with warnings (\(warnedIds.count))", systemImage: "exclamationmark.triangle") }
                            .controlSize(.small).disabled(action.busy)
                            .help("Leaves out every message in a group that has a warning, whole groups at a time.")
                    }
                    if !drafts.isEmpty && shown.isEmpty {
                        Text("Nothing in this filter.").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 16)
                    }
                    ForEach(shown) { g in
                        if g.drafts.count == 1 {
                            DraftRow(d: g.drafts[0], held: isHeldDraft(g.drafts[0]), heldOut: isHeldDraft(g.drafts[0]) && !anyway,
                                     onToggle: { on in toggleGroup(g, on) }, onChanged: changed)
                                .padding(10).background(cardShape)
                        } else {
                            GroupCard(g: g, anyway: anyway, onToggle: { on in toggleGroup(g, on) }, onChanged: changed)
                        }
                    }
                    .listRowSeparator(.hidden)
                } header: { Text(plural(drafts.count, "message")) }
                if !approvals.isEmpty {
                    Section("Approvals") { ForEach(rows(approvals)) { a in ApprovalRow(a: a.j) } }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                if action.note == nil, action.error == nil, !closed, let h = model.approvalHint {
                    Label(h, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if !closed && !held.isEmpty && !anyway {
                    Text("\(plural(held.count, "message")) with unfilled fields or exact duplicates will be held back unless you include \(held.count == 1 ? "it" : "them").")
                        .font(.caption).foregroundStyle(.red)
                }
                if !closed && noText > 0 {
                    Text("\(plural(noText, "message")) can't be sent (empty or invalid number).").font(.caption).foregroundStyle(.red)
                }
                HStack {
                    ErrorLine(text: action.error)
                    if let n = action.note { Text(n).font(.callout).foregroundStyle(.secondary) }
                    Spacer()
                    if !closed {
                        Button("Cancel batch", role: .destructive) { confirmCancel = true }.disabled(action.busy)
                        Button { approve(ids, heldIds) } label: {
                            Label(ids.isEmpty ? "Nothing to approve" : "Approve \(plural(ids.count, "message")) to \(plural(peopleCount(chosen), "person", "people"))",
                                  systemImage: "touchid")
                        }
                        .keyboardShortcut(.defaultAction)
                        .disabled(ids.isEmpty || action.busy || model.killSwitch || !model.approveInApp)
                        .help("Asks for Touch ID. You are signing exactly this list.")
                    }
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

    private var cardShape: some View {
        RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.3)))
    }
    private func changed() { Task { await reload(); await model.refresh() } }
    private func reload() async { await loader.load(model, "/api/batches/\(id)") }

    /// One action for a whole group (or one message): on = include every skipped message, off = skip every included one.
    /// Same per-message routes as before (/api/drafts/:id/include and /skip).
    private func toggleGroup(_ g: DraftGroup, _ on: Bool) {
        let targets = g.drafts.filter { isTogglable($0) && (on ? $0.str("status") == "skipped" : $0.str("status") != "skipped") }
        guard !targets.isEmpty else { return }
        action.run {
            for d in targets { _ = try await model.post("/api/drafts/\(d.id)/\(on ? "include" : "skip")") }
            await reload()
        }
    }
    private func excludeWarned(_ ids: [String]) {
        action.run {
            for did in ids { _ = try await model.post("/api/drafts/\(did)/skip") }
            action.note = "\(plural(ids.count, "message")) with warnings left out."
            await reload()
        }
    }
    private func cancel() {
        action.run { _ = try await model.post("/api/batches/\(id)/cancel"); await reload(); await model.refresh() }
    }
    private func approve(_ ids: [String], _ heldIds: [String]) {
        action.run {
            guard model.approveInApp else { throw APIFailure(status: 0, code: "approval_off", message: model.approvalHint ?? "Approving isn't possible right now.") }
            let ok = try await model.approval.approveBatch(id, draftIds: ids, includeAnyway: heldIds)
            action.note = ok ? "Approved." : "Not approved."
            await reload(); await model.refresh()
        }
    }
}

/// One existing approval of the batch: how many messages, when signed, live or dry, still valid.
struct ApprovalRow: View {
    let a: J
    var body: some View {
        let n = a.int("items")
        let until = parseISO(a.str("not_after"))
        HStack(spacing: 6) {
            Text("\(plural(n, "message")), signed \(timeAgo(a.str("created_at")))").font(.callout)
            Chip(a.str("transport") == "live" ? "live" : "dry run", a.str("transport") == "live" ? .warn : .neutral)
            if !a.str("revoked_at").isEmpty { Chip("revoked") }
            else if let u = until, u < Date() { Chip("expired") }
            else if let u = until { Chip("valid until \(u.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute()))", .good) }
            Spacer()
        }
    }
}

/// Chips for a set of drafts' warnings plus the contact facts, shared by the group header and a single row.
struct WarningChips: View {
    let drafts: [J]
    var body: some View {
        let first = drafts.first { $0["contact"] is J } ?? drafts[0]
        let contact = first.obj("contact")
        let hasNew = drafts.contains { $0["proposed_contact"] is J }
        HStack(spacing: 5) {
            if !contact.isEmpty { Chip("Contact: \(contact.str("display_name", "(no name)"))", .info) }
            if !contact.isEmpty && first["number_in_contact"] as? Bool == false {
                Chip("Number not in contact", .bad).help("This contact's numbers: \(contact.strs("handles").map(prettyHandle).joined(separator: ", "))")
            }
            if hasNew { Chip("New contact", .info) }
            ForEach(mergedWarnings(drafts), id: \.code) { w in
                Chip(labelFor(warning: w.code), heldCodes.contains(w.code) || unsendableCodes.contains(w.code) ? .bad : .warn).help(w.messages.joined(separator: "\n"))
            }
        }
    }
}

struct IncludeSwitch: View {
    @Binding var isOn: Bool
    var body: some View {
        HStack(spacing: 6) {
            Text("Include").font(.caption).foregroundStyle(.secondary)
            Toggle("Include", isOn: $isOn).labelsHidden().toggleStyle(.switch).controlSize(.small)
        }
    }
}

/// One recipient with several messages: one bordered box, one Include switch, merged warnings, then the messages in order.
struct GroupCard: View {
    let g: DraftGroup
    let anyway: Bool
    let onToggle: (Bool) -> Void
    var onChanged: () -> Void = {}
    @EnvironmentObject var model: AppModel

    var body: some View {
        let togglable = g.drafts.filter(isTogglable)
        let left = togglable.filter { $0.str("status") == "skipped" }.count
        let checked = !togglable.isEmpty && left == 0
        let mixed = left > 0 && left < togglable.count
        let warnings = mergedWarnings(g.drafts)
        let contactId = g.drafts.map { $0.str("contact_id") }.first { !$0.isEmpty } ?? ""
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 1) {
                    if !g.name.isEmpty { Text(g.name).font(.headline) }
                    Text(prettyHandle(g.handle)).font(g.name.isEmpty ? .headline : .subheadline).foregroundStyle(g.name.isEmpty ? .primary : .secondary)
                    Text(plural(g.drafts.count, "message")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if !contactId.isEmpty { NavigationLink(value: ContactRef(id: contactId)) { Text("Contact") }.buttonStyle(.link).font(.caption) }
                if !togglable.isEmpty {
                    IncludeSwitch(isOn: Binding(get: { checked }, set: { onToggle($0) }))
                        .help("Include all \(g.drafts.count) messages to \(g.name.isEmpty ? prettyHandle(g.handle) : g.name), or leave them all out.")
                }
            }
            if mixed { Text("Some messages are left out.").font(.caption).foregroundStyle(.secondary) }
            WarningChips(drafts: g.drafts)
            ForEach(warnings, id: \.code) { w in
                ForEach(w.messages, id: \.self) { m in Label(m, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            }
            VStack(spacing: 0) {
                ForEach(Array(g.drafts.enumerated()), id: \.element.id) { i, d in
                    if i > 0 { Divider().padding(.vertical, 8) }
                    DraftRow(d: d, held: isHeldDraft(d), heldOut: isHeldDraft(d) && !anyway, grouped: true, index: i + 1, total: g.drafts.count,
                             onToggle: { _ in }, onChanged: onChanged)
                }
            }
            .padding(.leading, 10)
            .overlay(alignment: .leading) { Rectangle().fill(Color.secondary.opacity(0.3)).frame(width: 2) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.3))))
        .opacity(!togglable.isEmpty && left == togglable.count ? 0.6 : 1)
    }
}

struct DraftRow: View {
    let d: J
    let held: Bool
    /// Held back and not included: left out of the approval until "include anyway" is on.
    var heldOut = false
    /// Inside a recipient group: no recipient line, no warnings (they are in the group header), numbered "1 of 2".
    var grouped = false
    var index = 1
    var total = 1
    let onToggle: (Bool) -> Void
    var onChanged: () -> Void = {}
    @EnvironmentObject var model: AppModel
    @StateObject private var action = Action()
    @State private var editing = false
    @State private var text = ""
    @State private var service = "auto"
    @State private var createContact = false

    private var editable: Bool { ["draft", "review", "approved", "skipped", "failed"].contains(d.str("status")) }

    private func save() {
        var patch: J = [:]
        if text != d.str("body") { patch["body"] = text }
        if service != d.str("service", "auto") { patch["service"] = service }
        if d["proposed_contact"] is J, createContact != d.bool("create_contact") { patch["create_contact"] = createContact }
        if patch.isEmpty { editing = false; return }
        action.run { _ = try await model.call("PATCH", "/api/drafts/\(d.id)", patch); editing = false; onChanged() }
    }

    var body: some View {
        let status = d.str("status")
        let skipped = status == "skipped"
        let unsendable = isUnsendableDraft(d)
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if grouped {
                    Text("\(index) of \(total)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 1) {
                        if !d.str("recipient_name").isEmpty { Text(d.str("recipient_name")).font(.headline) }
                        Text(prettyHandle(d.str("handle"))).font(d.str("recipient_name").isEmpty ? .headline : .subheadline)
                            .foregroundStyle(d.str("recipient_name").isEmpty ? .primary : .secondary)
                    }
                }
                if d.str("service", "auto") != "auto" { Chip(d.str("service")) }
                if isCovered(d) { Chip("Approved", .good) }
                else if status == "approved" { Chip("Approval ended", .warn).help("Its approval ran out or was cancelled. Approve it again.") }
                else if status != "review" && status != "draft" { Chip(statusLabel(status), status == "failed" ? .bad : (status == "sent" ? .good : .neutral)) }
                if d.bool("create_contact") { Chip("New contact", .info) }
                Spacer(minLength: 0)
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    if editable && !editing {
                        Button("Edit") { text = d.str("body"); service = d.str("service", "auto"); createContact = d.bool("create_contact"); editing = true }
                            .buttonStyle(.link).font(.caption)
                    }
                    if !grouped, !d.str("contact_id").isEmpty {
                        NavigationLink(value: ContactRef(id: d.str("contact_id"))) { Text("Contact") }.buttonStyle(.link).font(.caption)
                    }
                    if !grouped && isTogglable(d) {
                        IncludeSwitch(isOn: Binding(get: { !skipped }, set: { onToggle($0) }))
                            .help("Include this message in the approval, or leave it out.")
                    }
                }
            }
            if !grouped { WarningChips(drafts: [d]) }
            if editing {
                TextEditor(text: $text).font(.body).frame(minHeight: 90).padding(4)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.4)))
                HStack {
                    Picker("Send as", selection: $service) { Text("Automatic").tag("auto"); Text("iMessage").tag("iMessage"); Text("SMS").tag("SMS") }
                        .pickerStyle(.menu).fixedSize()
                    if d["proposed_contact"] is J { Toggle("Offer to add as a contact", isOn: $createContact).toggleStyle(.checkbox) }
                    Spacer()
                    Button("Cancel") { editing = false; action.error = nil }
                    Button("Save") { save() }.keyboardShortcut(.defaultAction).disabled(action.busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if status == "approved" { Text("Saving changes drops this message back to review: its approval no longer matches.").font(.caption).foregroundStyle(.secondary) }
                ErrorLine(text: action.error)
            } else {
                Text(d.str("body")).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            }
            if !grouped {
                ForEach(Array(shownWarnings(d).enumerated()), id: \.offset) { _, w in
                    Label(w.message, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
                }
            }
            let cands = d.arr("candidates")
            if !cands.isEmpty && editable && !editing {
                Text("This could be one of your contacts:").font(.caption).foregroundStyle(.secondary)
                ForEach(rows(cands, idKey: "contact_id")) { c in
                    Button("Use \(c.j.str("display_name"))\(c.j.str("org").isEmpty ? "" : " (\(c.j.str("org")))")") {
                        action.run { _ = try await model.call("PATCH", "/api/drafts/\(d.id)", ["contact_id": c.id]); onChanged() }
                    }.buttonStyle(.link).font(.caption).disabled(action.busy)
                }
                ErrorLine(text: action.error)
            }
            if unsendable { Text("Can't be sent as it is.").font(.caption).foregroundStyle(.red) }
            else if held && heldOut && wantsApproval(d) { Text("Left out of this approval until you include it anyway.").font(.caption).foregroundStyle(.secondary) }
        }
        .opacity(skipped ? 0.55 : 1)
        .onAppear {   // dev only (screenshots): AGENT_OUTBOX_DEV_EDIT=<phone> opens that message's editor
            if AppEnv.isDev, AppEnv.env["AGENT_OUTBOX_DEV_EDIT"] == d.str("handle"), editable, !editing {
                text = d.str("body"); service = d.str("service", "auto"); createContact = d.bool("create_contact"); editing = true
            }
        }
    }
}
