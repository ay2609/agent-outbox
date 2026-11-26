import SwiftUI

// MARK: - Contacts

struct ContactsView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var action = Action()
    @State private var query = ""
    @State private var list: [J] = []
    @State private var total = 0
    @State private var hasMore = false
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            Section {
                ServerBanner()
                ErrorLine(text: error ?? action.error)
                if let n = action.note { Text(n).font(.callout).foregroundStyle(.secondary) }
            }
            if list.isEmpty && !loading && error == nil && query.isEmpty {
                Section {
                    EmptyState(symbol: "person.crop.circle", title: "No contacts yet",
                               text: "Press Sync from Contacts (top right) to read your address book. macOS asks once whether Agent Outbox may see your contacts. Contacts that agents propose appear under Contact changes, and nothing is added until you approve it.")
                }
            } else if list.isEmpty && !loading && error == nil {
                Section { Text("No contact matches \u{201C}\(query)\u{201D}.").foregroundStyle(.secondary) }
            }
            Section(list.isEmpty ? "" : "\(total) contacts") {
                ForEach(rows(list)) { r in NavigationLink(value: ContactRef(id: r.id)) { ContactRow(c: r.j) } }
                if hasMore { Button("Load more") { Task { await load(reset: false) } }.disabled(loading) }
            }
        }
        .navigationTitle("Contacts")
        .searchable(text: $query, prompt: "Search name, number or email")
        .onSubmit(of: .search) { Task { await load(reset: true) } }
        .onChange(of: query) { q in if q.isEmpty { Task { await load(reset: true) } } }
        .toolbar {
            ToolbarItem {
                Button { action.run { _ = try await model.post("/api/contacts/sync"); action.note = "Asked the sender to refresh your address book." } } label: {
                    Label("Sync from Contacts", systemImage: "arrow.triangle.2.circlepath")
                }
            }
        }
        .task(id: model.reachable) { if model.reachable { await load(reset: true) } }
    }

    private func load(reset: Bool) async {
        loading = true; defer { loading = false }
        let offset = reset ? 0 : list.count
        let q = query.trimmingCharacters(in: .whitespaces).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        do {
            let r = try await model.get("/api/contacts?limit=100&offset=\(offset)&q=\(q)")
            let page = r.arr("contacts")
            list = reset ? page : list + page
            total = r.int("matched", r.int("total")); hasMore = r.bool("has_more"); error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct ContactRow: View {
    let c: J
    var body: some View {
        let handles = c.arr("phones").map { $0.str("e164") } + c.arr("emails").map { $0.str("email") }
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(c.str("display_name", "(no name)")).font(.headline)
                if !c.str("org").isEmpty { Text(c.str("org")).foregroundStyle(.secondary) }
            }
            if !handles.isEmpty { Text(handles.joined(separator: "  ")).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
        }.padding(.vertical, 2)
    }
}

// MARK: - Groups

struct GroupsView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var loader = Loader()
    @StateObject private var action = Action()
    @State private var newName = ""

    var body: some View {
        let groups = loader.data?.arr("groups") ?? []
        List {
            if !model.reachable || loader.error != nil || action.error != nil { Section { ServerBanner(); ErrorLine(text: loader.error ?? action.error) } }
            Section("Saved groups") {
                if groups.isEmpty && loader.data != nil {
                    Text("No groups yet. A group is a saved list of people you message together. Ask Claude to save one, or name one below.").foregroundStyle(.secondary)
                }
                ForEach(rows(groups)) { r in
                    NavigationLink(value: GroupRef(id: r.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.j.str("name")).font(.headline)
                            Text("\(plural(r.j.int("members"), "member"))\(r.j.str("description").isEmpty ? "" : ", " + r.j.str("description"))").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section("New group") {
                HStack {
                    TextField("Group name", text: $newName)
                    Button("Create") {
                        let n = newName.trimmingCharacters(in: .whitespaces)
                        guard !n.isEmpty else { return }
                        action.run { _ = try await model.post("/api/groups", ["name": n]); newName = ""; await loader.load(model, "/api/groups") }
                    }.disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || action.busy)
                }
            }
        }
        .navigationTitle("Groups")
        .task(id: model.reachable) { if model.reachable { await loader.load(model, "/api/groups") } }
    }
}

struct GroupDetailView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let id: String
    @StateObject private var loader = Loader()
    @StateObject private var action = Action()
    @State private var confirmDelete = false

    var body: some View {
        let g = loader.data?.obj("group") ?? [:]
        let members = loader.data?.arr("members") ?? []
        List {
            if loader.error != nil || action.error != nil { Section { ErrorLine(text: loader.error ?? action.error) } }
            Section("\(plural(members.count, "member"))") {
                if members.isEmpty && loader.data != nil { Text("No one in this group yet. Ask Claude to add people to it.").foregroundStyle(.secondary) }
                ForEach(rows(members, idKey: "handle")) { r in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.j.str("name", r.j.str("handle"))).font(.headline)
                            Text(r.j.str("handle")).font(.caption).foregroundStyle(.secondary)
                            if !r.j.obj("contact").str("id").isEmpty { NavigationLink("Contact", value: ContactRef(id: r.j.obj("contact").str("id"))).buttonStyle(.link).font(.caption) }
                        }
                        Spacer()
                        Button("Remove") { action.run { _ = try await model.post("/api/groups/\(id)/remove", ["handles": [r.j.str("handle")]]); await reload() } }
                            .buttonStyle(.link).font(.caption)
                    }
                }
            }
        }
        .navigationTitle(g.str("name", "Group"))
        .toolbar { ToolbarItem { Button("Delete group", role: .destructive) { confirmDelete = true } } }
        .alert("Delete this group?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { action.run { _ = try await model.call("DELETE", "/api/groups/\(id)"); dismiss() } }
            Button("Keep", role: .cancel) {}
        } message: { Text("The people stay in your contacts; only the saved list is removed.") }
        .task { await reload() }
    }
    private func reload() async { await loader.load(model, "/api/groups/\(id)") }
}

// MARK: - Contact changes

struct ContactChangeSetsView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var loader = Loader()
    var body: some View {
        let sets = loader.data?.arr("sets") ?? []
        List {
            if !model.reachable || loader.error != nil { Section { ServerBanner(); ErrorLine(text: loader.error) } }
            Section("Contact changes") {
                if sets.isEmpty && loader.data != nil { Text("No contact changes yet. When an agent proposes new contacts or edits, you review them here and nothing touches your address book until you approve.").foregroundStyle(.secondary) }
                ForEach(rows(sets)) { r in NavigationLink(value: SetRef(id: r.id)) { SetRow(s: r.j) } }
            }
        }
        .navigationTitle("Contact changes")
        .task(id: model.pendingCount) { await loader.load(model, "/api/contact-changes") }
        .task(id: model.reachable) { if model.reachable { await loader.load(model, "/api/contact-changes") } }
    }
}

struct ContactSetView: View {
    @EnvironmentObject var model: AppModel
    let id: String
    @StateObject private var loader = Loader()
    @StateObject private var action = Action()
    @State private var selected: Set<String> = []
    @State private var seeded = false
    @State private var confirmCancel = false

    var body: some View {
        let set = loader.data?.obj("set") ?? [:]
        let changes = loader.data?.arr("changes") ?? []
        let live = loader.data?.str("contacts_transport") == "live"
        let pickable = changes.filter { $0.str("status") == "review" }
        let ids = changes.filter { selected.contains($0.id) }.map { $0.id }
        VStack(spacing: 0) {
            List {
                Section {
                    HStack(spacing: 6) {
                        Chip(live ? "Live: approved changes are written to your address book" : "Dry run: your address book is not changed", live ? .warn : .neutral)
                        if !set.isEmpty { Chip(statusLabel(set.str("status"))) }
                    }
                    ErrorLine(text: loader.error)
                }
                Section("\(plural(changes.count, "change"))") {
                    ForEach(rows(changes)) { r in
                        HStack(alignment: .top, spacing: 10) {
                            if r.j.str("status") == "review" {
                                Toggle("", isOn: Binding(get: { selected.contains(r.id) }, set: { on in if on { selected.insert(r.id) } else { selected.remove(r.id) } }))
                                    .labelsHidden().toggleStyle(.checkbox)
                            } else { Color.clear.frame(width: 16) }
                            ChangeCard(ch: r.j)
                        }
                    }
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                if action.note == nil, action.error == nil, !pickable.isEmpty, let h = model.approvalHint {
                    Label(h, systemImage: "info.circle").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack {
                ErrorLine(text: action.error)
                if let n = action.note { Text(n).font(.callout).foregroundStyle(.secondary) }
                Spacer()
                if !pickable.isEmpty {
                    Button("Reject selected") { act { _ = try await model.post("/api/contact-changes/\(id)/reject", ["change_ids": ids]) } }.disabled(ids.isEmpty || action.busy)
                    Button("Cancel set", role: .destructive) { confirmCancel = true }.disabled(action.busy)
                    Button("Approve \(ids.count) with Touch ID…") { approve(ids) }
                        .keyboardShortcut(.defaultAction).disabled(ids.isEmpty || action.busy || model.killSwitch || !model.approveInApp)
                }
                }
            }.padding(12)
        }
        .navigationTitle(set.str("title", "Contact changes"))
        .alert("Cancel this set?", isPresented: $confirmCancel) {
            Button("Cancel set", role: .destructive) { act { _ = try await model.post("/api/contact-changes/\(id)/cancel") } }
            Button("Keep", role: .cancel) {}
        }
        .task(id: model.reachable) { await reload() }
    }

    private func act(_ f: @escaping () async throws -> Void) {
        action.run { try await f(); await reload(); await model.refresh() }
    }
    private func reload() async {
        await loader.load(model, "/api/contact-changes/\(id)")
        let pick = (loader.data?.arr("changes") ?? []).filter { $0.str("status") == "review" }.map { $0.id }
        if !seeded { seeded = true; selected = Set(pick) } else { selected = selected.intersection(pick) }
    }
    private func approve(_ ids: [String]) {
        action.run {
            guard model.approveInApp else { throw APIFailure(status: 0, code: "approval_off", message: model.approvalHint ?? "Approving isn't possible right now.") }
            let ok = try await model.approval.approveContacts(id, changeIds: ids)
            action.note = ok ? "Approved." : "Not approved."
            await reload(); await model.refresh()
        }
    }
}

struct ChangeCard: View {
    let ch: J
    var body: some View {
        let kind = ch.str("kind")
        let p = ch.obj("payload")
        let name = [p.str("given_name"), p.str("family_name")].filter { !$0.isEmpty }.joined(separator: " ")
        let before = ch.obj("before")
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title(kind, name, before)).font(.headline)
                if ch.str("status") != "review" { Chip(statusLabel(ch.str("status")), ch.str("status") == "applied" ? .good : (ch.str("status") == "failed" ? .bad : .neutral)) }
            }
            ForEach(lines(p, before: before), id: \.self) { Text($0).font(.callout).foregroundStyle(.secondary) }
            if !ch.str("note").isEmpty { Text(ch.str("note").prefix(1).uppercased() + ch.str("note").dropFirst()).font(.caption).foregroundStyle(.secondary) }
            if let e = ch["error"] as? String, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.red) }
        }.padding(.vertical, 3)
    }
    private func title(_ kind: String, _ name: String, _ before: J) -> String {
        let who = name.isEmpty ? before.str("display_name", "contact") : name
        switch kind {
        case "create": return "Add \(who)"
        case "edit", "update": return "Edit \(before.str("display_name", who))"
        case "undo": return "Undo a change"
        default: return "\(kind.capitalized) \(who)"
        }
    }
    private func lines(_ p: J, before: J) -> [String] {
        var out: [String] = []
        // An edit carries the fields it changes under "set"; show each as "Company: old to new" so nothing changes unseen.
        if let set = p["set"] as? J {
            let names = ["given_name": "First name", "family_name": "Last name", "nickname": "Nickname", "org": "Company"]
            for k in ["given_name", "family_name", "nickname", "org"] {
                guard let new = set[k] as? String else { continue }
                let old = before.str(k)
                out.append("\(names[k] ?? k): " + (old.isEmpty ? "" : "\(old) to ") + (new.isEmpty ? "(removed)" : new))
            }
        }
        let labels = ["nickname": "Nickname", "org": "Company", "phones": "Phone", "emails": "Email", "groups": "Groups"]
        let order = ["nickname", "org", "phones", "emails", "groups"]
        for (k, v) in p.sorted(by: { (order.firstIndex(of: $0.key) ?? 99, $0.key) < (order.firstIndex(of: $1.key) ?? 99, $1.key) }) {
            let label = labels[k] ?? k.replacingOccurrences(of: "_", with: " ").capitalized
            if let s = v as? String, !s.isEmpty, k != "given_name", k != "family_name" { out.append("\(label): \(s)") }
            else if let a = v as? [J], !a.isEmpty {
                out.append("\(label): " + a.map { $0.str("e164", $0.str("email", $0.str("label"))) }.joined(separator: ", "))
            } else if let a = v as? [String], !a.isEmpty { out.append("\(label): " + a.joined(separator: ", ")) }
        }
        return out
    }
}
