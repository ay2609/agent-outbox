import SwiftUI
import UniformTypeIdentifiers

struct ImportRef: Hashable { let id: String }
struct ContactRef: Hashable { let id: String }

/// Country the phone numbers without a "+" are read in.
let phoneRegions: [(String, String)] = [("US", "United States"), ("CA", "Canada"), ("GB", "United Kingdom"), ("IE", "Ireland"), ("AU", "Australia"), ("NZ", "New Zealand"), ("IN", "India"),
    ("DE", "Germany"), ("FR", "France"), ("ES", "Spain"), ("IT", "Italy"), ("NL", "Netherlands"), ("MX", "Mexico"), ("BR", "Brazil"), ("JP", "Japan"), ("CN", "China"), ("SG", "Singapore"),
    ("AE", "UAE"), ("ZA", "South Africa")]

struct RegionPicker: View {
    @Binding var region: String
    var body: some View {
        Picker("Phone region", selection: $region) { ForEach(phoneRegions, id: \.0) { Text("\($0.1) (\($0.0))").tag($0.0) } }
            .pickerStyle(.menu).fixedSize()
    }
}

// MARK: - Imports list and upload

struct ImportsView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var loader = Loader()
    @StateObject private var action = Action()
    @AppStorage("outbox:region") private var region = "US"
    @State private var paste = ""
    @State private var picking = false

    var body: some View {
        let imports = loader.data?.arr("imports") ?? []
        List {
            if !model.reachable || loader.error != nil || action.error != nil { Section { ServerBanner(); ErrorLine(text: loader.error ?? action.error) } }
            Section {
                Text("Upload a spreadsheet or contact file (CSV, Excel, Numbers, vCard, JSON). You confirm how the columns map, then write one message template that personalises for each row.")
                    .font(.callout).foregroundStyle(.secondary)
                RegionPicker(region: $region)
                Text("Numbers written without a + are read as this country's.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Choose a file…") { picking = true }.disabled(action.busy)
                    if action.busy { ProgressView().controlSize(.small) }
                }
                DisclosureGroup("Or paste a table") {
                    TextEditor(text: $paste).font(.system(.body, design: .monospaced)).frame(minHeight: 90)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.4)))
                    Text("For example: name,phone then Sam Lee,555 123 4567 on the next line.").font(.caption).foregroundStyle(.secondary)
                    Button("Read pasted table") { upload(["text": paste, "filename": "pasted.csv", "region": region]) }
                        .disabled(action.busy || paste.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            Section("Earlier imports") {
                if imports.isEmpty && loader.data != nil { Text("No imports yet.").foregroundStyle(.secondary) }
                ForEach(rows(imports)) { r in
                    NavigationLink(value: ImportRef(id: r.id)) {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack { Text(r.j.str("filename")).font(.headline).lineLimit(1); Spacer(); Text(timeAgo(r.j.str("created_at"))).font(.caption).foregroundStyle(.secondary) }
                            HStack(spacing: 5) {
                                Chip("\(r.j.int("row_count")) rows"); Chip(r.j.str("kind"))
                                if !r.j.str("sheet").isEmpty { Chip("sheet: \(r.j.str("sheet"))") }
                                if !r.j.bool("confirmed") { Chip("mapping to confirm", .warn) }
                            }
                        }.padding(.vertical, 2)
                    }
                }
            }
        }
        .navigationTitle("Imports")
        .fileImporter(isPresented: $picking, allowedContentTypes: [.data], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { action.error = "That file couldn't be read."; return }
            if data.count > 25 * 1024 * 1024 { action.error = "That file is over 25 MB."; return }
            if data.isEmpty { action.error = "That file is empty."; return }
            upload(["filename": String(url.lastPathComponent.prefix(200)), "data_b64": data.base64EncodedString(), "region": region])
        }
        .task(id: model.reachable) { if model.reachable { await loader.load(model, "/api/imports") } }
    }

    /// Uploads are JSON: `{filename, data_b64}` for a file, or `{text, filename}` for pasted text.
    private func upload(_ body: J) {
        action.run {
            let r = try await model.post("/api/imports", body)
            let id = r.str("import_id", r.str("id"))
            await loader.load(model, "/api/imports")
            if !id.isEmpty { model.path.append(ImportRef(id: id)) }
        }
    }
}

// MARK: - One import: sheet and region, column mapping, what matched, save as a group, message template, create the batch

private let mappingFields: [(key: String, label: String)] = [
    ("display_name", "Full name"), ("given_name", "First name"), ("family_name", "Last name"), ("phone", "Phone"), ("email", "Email"),
    ("org", "Company"), ("notes", "Notes"), ("tags", "Tags")]
private let standardVars = ["first_name", "last_name", "full_name", "name", "org"]

struct ImportDetailView: View {
    @EnvironmentObject var model: AppModel
    let id: String
    @StateObject private var loader = Loader()
    @StateObject private var action = Action()
    @StateObject private var group = Action()
    @AppStorage("outbox:region") private var region = "US"
    @State private var columnFor: [String: String] = [:]
    @State private var confidence: [String: Double] = [:]
    @State private var dirty = false
    @State private var template = "Hi {{first_name|there}}, "
    @State private var title = ""
    @State private var createNew = true
    @State private var previews: [J] = []
    @State private var matchFilter = ""
    @State private var rowList: [J] = []
    @State private var rowsTotal = 0
    @State private var groupName = ""
    @State private var seeded = false

    var body: some View {
        let imp = loader.data ?? [:]
        let columns = imp.strs("columns")
        let counts = imp.obj("counts")
        let mapping = imp.obj("mapping")
        let confirmed = mapping.bool("confirmed") && !dirty
        List {
            if loader.error != nil || action.error != nil { Section { ErrorLine(text: loader.error ?? action.error) } }
            Section {
                HStack(spacing: 6) {
                    Chip(imp.str("kind"))
                    if !imp.str("sheet").isEmpty { Chip("sheet: \(imp.str("sheet"))") }
                    Chip("\(columns.count) columns")
                    if confirmed { Chip("mapping confirmed", .good) } else { Chip("confirm the mapping", .warn) }
                }
                let sheets = imp.strs("sheets")
                if sheets.count > 1 {
                    Picker("Sheet", selection: Binding(get: { imp.str("sheet", sheets.first ?? "") }, set: { reread(sheet: $0) })) {
                        ForEach(sheets, id: \.self) { Text($0).tag($0) }
                    }.pickerStyle(.menu).fixedSize().disabled(action.busy)
                }
                HStack {
                    RegionPicker(region: $region)
                    Button("Re-read with this region") { reread(sheet: nil) }.disabled(action.busy)
                }
                Text("Numbers without a + are read as this country's. Re-reading makes a new import from the same file.").font(.caption).foregroundStyle(.secondary)
                ForEach(imp.strs("warnings"), id: \.self) { Label($0, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            }

            Section("1. Columns") {
                ForEach(mappingFields, id: \.key) { f in
                    HStack {
                        Text(f.label).frame(width: 110, alignment: .leading)
                        Picker("", selection: Binding(get: { columnFor[f.key] ?? "" }, set: { setColumn(f.key, $0) })) {
                            Text("Not used").tag("")
                            ForEach(columns, id: \.self) { Text($0).tag($0) }
                        }.labelsHidden().pickerStyle(.menu)
                        if columnFor[f.key] != nil, let c = confidence[f.key] { Chip("\(Int((c * 100).rounded()))%", c >= 0.8 ? .good : .warn).help("How sure the match is") }
                        Spacer()
                    }
                }
                Button("Confirm mapping") { confirmMapping(imp) }.disabled(action.busy || confirmed)
            }

            Section("2. What matched") {
                Picker("Show", selection: $matchFilter) {
                    Text("All \(imp.int("row_count"))").tag("")
                    Text("\(counts.int("matched")) matched").tag("matched")
                    Text("\(counts.int("new")) new").tag("new")
                    Text("\(counts.int("ambiguous")) ambiguous").tag("ambiguous")
                    Text("\(counts.int("invalid")) invalid").tag("invalid")
                    Text("\(counts.int("duplicate")) duplicate").tag("duplicate")
                }.pickerStyle(.menu).fixedSize()
                ForEach(Array(rowList.enumerated()), id: \.offset) { _, r in ImportRow(r: r) }
                if rowList.isEmpty && loader.data != nil { Text("No rows\(matchFilter.isEmpty ? "" : " marked \(matchFilter)").").foregroundStyle(.secondary) }
                if rowList.count < rowsTotal { Button("Show more (\(rowList.count) of \(rowsTotal))") { Task { await loadRows(reset: false) } } }
            }

            if confirmed {
                Section("Save as a group") {
                    Text("Keep these people as a group so you can message them again later. Rows without a usable number are skipped.").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("Group name", text: $groupName)
                        Button("Save rows as a group") { saveGroup(imp) }.disabled(group.busy || groupName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    ErrorLine(text: group.error)
                    if let n = group.note { Text(n).font(.callout).foregroundStyle(.secondary) }
                }
            }

            Section("3. Message") {
                TextEditor(text: $template).font(.body).frame(minHeight: 110).disabled(!confirmed)
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.4)))
                let extra = Array(mapping.obj("vars").keys.sorted())
                let slugs = extra.isEmpty ? columns.filter { c in !columnFor.values.contains(c) }.map(slug) : extra
                ScrollView(.horizontal) {
                    HStack { ForEach(standardVars + slugs, id: \.self) { v in Button("{{\(v)}}") { template += "{{\(v)}}" }.disabled(!confirmed) } }
                }
                Text("Use {{first_name|there}} to fall back to \"there\" when a name is empty. Buttons add a field at the end.").font(.caption).foregroundStyle(.secondary)
                if confirmed {
                    ForEach(Array(previews.enumerated()), id: \.offset) { _, p in
                        VStack(alignment: .leading, spacing: 3) {
                            Text("\(p.str("name", "(no name)")) · \(p.str("to"))").font(.caption).foregroundStyle(.secondary)
                            Text(p.str("body")).textSelection(.enabled)
                            HStack(spacing: 5) {
                                ForEach(p.strs("unresolved"), id: \.self) { Chip("unknown \($0)", .warn) }
                                ForEach(p.strs("empty"), id: \.self) { Chip("empty \($0)", .warn) }
                            }
                        }.padding(8).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                    }
                }
                TextField("Batch title", text: $title)
                Toggle("Offer to add new numbers to Contacts", isOn: $createNew).toggleStyle(.checkbox)
                Button("Create batch for review") { createBatch() }
                    .keyboardShortcut(.defaultAction).disabled(!confirmed || action.busy || template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .navigationTitle(imp.str("filename", "Import"))
        .task(id: id) { await reload() }
        .task(id: matchFilter + String(describing: loader.data?.obj("counts")) + String(mapping.bool("confirmed"))) { if loader.data != nil { await loadRows(reset: true) } }
        .task(id: template + String(confirmed)) {
            guard confirmed, !template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { previews = []; return }
            try? await Task.sleep(nanoseconds: 350_000_000)
            if Task.isCancelled { return }
            if let r = try? await model.post("/api/imports/\(id)/preview", ["template": template, "rows": 3]) { previews = r.arr("previews") }
        }
    }

    private func slug(_ c: String) -> String {
        c.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: "_")
    }

    private func setColumn(_ key: String, _ column: String) {
        dirty = true
        if column.isEmpty { columnFor[key] = nil; confidence[key] = nil } else { columnFor[key] = column; confidence[key] = 1 }
    }

    private func reload() async {
        await loader.load(model, "/api/imports/\(id)?limit=1")
        guard let imp = loader.data else { return }
        if !dirty {
            let f = imp.obj("mapping").obj("fields")
            columnFor = f.compactMapValues { ($0 as? J)?["column"] as? String }
            confidence = f.compactMapValues { ($0 as? J).flatMap { ($0["confidence"] as? Double) ?? ($0["confidence"] as? Int).map(Double.init) } }
        }
        if !seeded {
            seeded = true
            if title.isEmpty { title = "Message to " + (imp.str("filename") as NSString).deletingPathExtension }
            if groupName.isEmpty { groupName = (imp.str("filename") as NSString).deletingPathExtension }
            let r = imp.obj("mapping").str("region")
            if phoneRegions.contains(where: { $0.0 == r }) { region = r }
        }
    }

    private func loadRows(reset: Bool) async {
        let offset = reset ? 0 : rowList.count
        let q = matchFilter.isEmpty ? "" : "&match=\(matchFilter)"
        guard let r = try? await model.get("/api/imports/\(id)?limit=25&offset=\(offset)\(q)") else { return }
        rowList = reset ? r.arr("rows") : rowList + r.arr("rows")
        rowsTotal = r.int("rows_total")
    }

    private func confirmMapping(_ imp: J) {
        action.run {
            var fields: J = [:]
            for (k, c) in columnFor { fields[k] = ["column": c, "confidence": confidence[k] ?? 1] as J }
            _ = try await model.call("PUT", "/api/imports/\(id)/mapping", ["fields": fields, "vars": imp.obj("mapping").obj("vars"), "confirmed": true, "region": region])
            dirty = false
            await reload()
            model.flash = "Mapping saved."
        }
    }

    /// A different sheet or phone region means re-reading the stored file: that makes a new import, and we move to it.
    private func reread(sheet: String?) {
        let current = loader.data?.str("sheet") ?? ""
        action.run {
            var body: J = ["region": region]
            if let s = sheet ?? (current.isEmpty ? nil : current) { body["sheet"] = s }
            let r = try await model.post("/api/imports/\(id)/reingest", body)
            let nid = r.str("import_id", r.str("id"))
            model.flash = "File read again as a new import."
            if !nid.isEmpty { model.path.append(ImportRef(id: nid)) }
        }
    }

    private func createBatch() {
        action.run {
            let r = try await model.post("/api/imports/\(id)/batch", ["title": title.trimmingCharacters(in: .whitespaces).isEmpty ? "Imported messages" : title, "template": template, "create_new_contacts": createNew])
            let skipped = (r["skipped"] as? [Any])?.count ?? 0
            model.flash = "\(plural(r.int("drafts"), "draft")) created\(skipped > 0 ? ", \(skipped) skipped" : "")."
            await model.refresh()
            if !r.str("batch_id").isEmpty { model.path.append(BatchRef(id: r.str("batch_id"))) }
        }
    }

    private func saveGroup(_ imp: J) {
        let name = groupName.trimmingCharacters(in: .whitespaces)
        group.run {
            var gid: String
            do { gid = try await model.post("/api/groups", ["name": name]).obj("group").str("id") }
            catch let e as APIFailure where e.code == "group_exists" {
                gid = e.data.str("id", e.data.obj("details").str("id"))   // a group with that name exists already: add the rows to it
                if gid.isEmpty { throw e }
            }
            let r = try await model.post("/api/groups/\(gid)/members", ["from_import": ["import_id": id]])
            let skipped = (r["invalid"] as? [Any])?.count ?? 0, already = (r["already"] as? [Any])?.count ?? 0, added = (r["added"] as? [Any])?.count ?? 0
            group.note = "\(added) added\(already > 0 ? ", \(already) already there" : "")\(skipped > 0 ? ", \(skipped) skipped" : "")."
            model.path.append(GroupRef(id: gid))
        }
    }
}

struct ImportRow: View {
    let r: J
    var body: some View {
        let n = r["normalized"] as? J ?? r
        let name = n.str("display_name").isEmpty ? [n.str("given_name"), n.str("family_name")].filter { !$0.isEmpty }.joined(separator: " ") : n.str("display_name")
        let match = r.str("match")
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(name.isEmpty ? "(no name)" : name).font(.headline)
                if !match.isEmpty { Chip(match, match == "matched" ? .good : match == "new" ? .info : match == "invalid" ? .bad : .warn) }
                Spacer()
                Text("row \(r.int("row_index") + 1)").font(.caption).foregroundStyle(.secondary)
            }
            Text(n.str("phone_e164", n.str("email", "no phone or email"))).font(.caption).foregroundStyle(.secondary)
            ForEach(r.arr("issues").map { $0.str("message") }, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
        }.padding(.vertical, 2)
    }
}

// MARK: - Contact detail

struct ContactDetailView: View {
    @EnvironmentObject var model: AppModel
    let id: String
    @StateObject private var loader = Loader()

    var body: some View {
        let c = loader.data?.obj("contact") ?? [:]
        List {
            if loader.error != nil { Section { ErrorLine(text: loader.error) } }
            Section {
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.str("display_name", "(no name)")).font(.title2.bold())
                    if !c.str("org").isEmpty { Text(c.str("org")).foregroundStyle(.secondary) }
                    if !c.str("nickname").isEmpty { Text("Nickname: \(c.str("nickname"))").font(.callout).foregroundStyle(.secondary) }
                }
            }
            let phones = c.arr("phones"), emails = c.arr("emails")
            if !phones.isEmpty {
                Section("Phone") { ForEach(Array(phones.enumerated()), id: \.offset) { _, p in LabeledContent(p.str("label", "phone"), value: p.str("e164")).textSelection(.enabled) } }
            }
            if !emails.isEmpty {
                Section("Email") { ForEach(Array(emails.enumerated()), id: \.offset) { _, e in LabeledContent(e.str("label", "email"), value: e.str("email")).textSelection(.enabled) } }
            }
            if !c.strs("tags").isEmpty { Section("Tags") { HStack { ForEach(c.strs("tags"), id: \.self) { Chip($0) } } } }
            if !c.str("notes").isEmpty { Section("Notes") { Text(c.str("notes")).textSelection(.enabled) } }
            Section("Source") {
                LabeledContent("From", value: c.str("source") == "macos" ? "Your address book" : c.str("source") == "import" ? "An import" : c.str("source").capitalized)
                if !c.str("synced_at").isEmpty { LabeledContent("Last synced", value: timeAgo(c.str("synced_at"))) }
                if !c.str("updated_at").isEmpty { LabeledContent("Updated", value: timeAgo(c.str("updated_at"))) }
                Text("Agents propose edits under Contact changes; nothing in your address book changes until you approve it with Touch ID.").font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(c.str("display_name", "Contact"))
        .task(id: id) { await loader.load(model, "/api/contacts/\(id)") }
    }
}
