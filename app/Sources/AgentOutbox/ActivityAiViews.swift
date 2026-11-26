import SwiftUI

// MARK: - Activity

struct ActivityView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = (AppEnv.isDev ? ProcessInfo.processInfo.environment["AGENT_OUTBOX_DEV_TAB"] : nil) ?? "sends"   // dev: AGENT_OUTBOX_DEV_TAB=audit for screenshots
    @State private var sends: [J] = []
    @State private var audit: [J] = []
    @State private var sendsBefore: String?
    @State private var auditBefore: Int?
    @State private var loaded = false
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        List {
            Section {
                ServerBanner()
                Picker("", selection: $tab) { Text("Sends").tag("sends"); Text("Audit log").tag("audit") }.pickerStyle(.segmented).labelsHidden()
                ErrorLine(text: error)
            }
            if tab == "sends" {
                Section {
                    if sends.isEmpty && loaded { EmptyState(symbol: "paperplane", title: "No sends yet", text: "Each attempt by the sender shows up here, including dry runs.") }
                    ForEach(Array(sends.enumerated()), id: \.offset) { _, s in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(s.str("recipient_name", s.str("handle"))).font(.headline)
                                Chip(s.str("result", "sending"), s.str("result") == "sent" ? .good : s.str("result") == "failed" ? .bad : s.str("result") == "unknown" ? .warn : .info)
                            }
                            Text(s.str("preview")).font(.callout)
                            Text("\(s.str("transport")) · attempt \(s.int("attempt")) · \(when(s.str("started_at")))\(s.str("error").isEmpty ? "" : " · " + s.str("error"))")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 2)
                    }
                    if sendsBefore != nil { Button("Load more") { Task { await load(reset: false) } }.disabled(loading) }
                }
            } else {
                Section {
                    ForEach(Array(audit.enumerated()), id: \.offset) { _, a in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { Text(auditTitle(a.str("action"))).font(.headline); Spacer(); Text(a.str("actor")).font(.caption).foregroundStyle(.secondary) }
                            Text(when(a.str("at"))).font(.caption).foregroundStyle(.secondary)
                            let d = a.obj("details")
                            if !d.isEmpty { Text(String(decoding: jsonData(d), as: UTF8.self).prefix(160)).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary) }
                        }.padding(.vertical, 2)
                    }
                    if auditBefore != nil { Button("Load more") { Task { await load(reset: false) } }.disabled(loading) }
                }
            }
        }
        .navigationTitle("Activity")
        .toolbar { ToolbarItem { Button { Task { await load(reset: true) } } label: { Label("Refresh", systemImage: "arrow.clockwise") } } }
        .task(id: model.reachable) { if model.reachable { await load(reset: true) } }
    }

    private func when(_ iso: String) -> String {
        guard let d = parseISO(iso) else { return iso }
        return d.formatted(date: .abbreviated, time: .shortened)
    }

    private func load(reset: Bool) async {
        loading = true; defer { loading = false }
        var q = "limit=40"
        if !reset {
            if tab == "sends", let b = sendsBefore { q += "&sends_before=\(b.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? b)" }
            if tab == "audit", let b = auditBefore { q += "&audit_before=\(b)" }
        }
        do {
            let r = try await model.get("/api/activity?\(q)")
            let next = r.obj("next")
            if reset {
                sends = r.arr("sends"); audit = r.arr("audit")
                sendsBefore = next["sends_before"] as? String; auditBefore = next["audit_before"] as? Int
            } else if tab == "sends" { sends += r.arr("sends"); sendsBefore = next["sends_before"] as? String }
            else { audit += r.arr("audit"); auditBefore = next["audit_before"] as? Int }
            loaded = true; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

/// Plain words for the audit log's action ids; anything unknown is shown as its id with the punctuation softened.
func auditTitle(_ action: String) -> String {
    let known: [String: String] = [
        "batch.create": "Batch drafted", "batch.status": "Batch status changed", "batch.cancel": "Batch cancelled",
        "approval.create": "Batch approved", "approval.revoke": "Approval revoked",
        "contact_approval.create": "Contact changes approved", "contact_approval.revoke": "Contact approval revoked", "contact_approval.restore": "Contact approval restored",
        "contact_changes.propose": "Contact changes proposed", "contact_changes.from_import": "Contacts made from an import", "contact_changes.cancel": "Contact changes cancelled",
        "contact_changes.reject": "Contact change rejected", "contact_changes.undo_request": "Contact change undo requested",
        "contacts.sync": "Contacts synced", "contacts.sync_requested": "Contacts sync requested",
        "draft.edit": "Message edited", "draft.skip": "Message skipped", "draft.skip_many": "Messages skipped", "draft.include": "Message included", "draft.include_many": "Messages included",
        "group.create": "Group created", "group.add": "People added to a group", "group.remove": "People removed from a group", "group.rename": "Group renamed", "group.delete": "Group deleted",
        "import.create": "File imported", "import.mapping": "Columns confirmed", "import.batch": "Batch made from an import", "import.reingest": "Import re-read",
        "native_key.activate": "Touch ID key activated", "native_key.revoke": "Touch ID key revoked", "native_key.enroll_options": "Touch ID setup started",
        "recovery.create": "Recovery opened", "recovery.cancel": "Recovery cancelled", "stop.undo": "Sending resumed",
        "migration.v7": "Upgraded from the browser version", "setup.live_defaults": "First-run defaults set",
    ]
    return known[action] ?? action.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: ": ").capitalized
}

// MARK: - AI drafts: prompts to paste into the user's own agent

private struct PromptCard { let title: String; var hint: String? = nil; let text: String }
private struct PromptSection { let title: String; let prompts: [PromptCard] }

// Static on purpose: nothing here talks to the server. [Brackets] are for you to fill in.
private let promptSections: [PromptSection] = [
    PromptSection(title: "Text people", prompts: [
        PromptCard(title: "Text one person",
                   text: "Use agent-outbox to text [name]: [what you want to say]. Keep it short and in my voice, like a real text. Find them in my contacts first, and if more than one person matches, ask me which. Leave it as a draft for me to approve."),
        PromptCard(title: "Text several people, one by one", hint: "Each message is written for that person, not pasted.",
                   text: "Use agent-outbox to draft a personalised message to each of [names]: [what to say]. Use a real detail about each person that you know from my contacts or from me, not just their name, and don't invent anything. Put them all in one batch, then tell me who you drafted for and who you skipped. I'll review and approve it."),
    ]),
    PromptSection(title: "From a file", prompts: [
        PromptCard(title: "Message everyone in a spreadsheet",
                   text: "Here's a spreadsheet: [path to the file]. Use agent-outbox to ingest it and check that the columns are mapped right (name, phone number or email). Then draft [what to say] to every row, using the other columns to make each message personal. Put them in one batch, and show me any rows you skipped and why. Leave everything for me to approve."),
    ]),
    PromptSection(title: "Contacts", prompts: [
        PromptCard(title: "Add people to my contacts",
                   text: "Add these people to my contacts with agent-outbox: [paste your list: one person per line, name and number or email]. Nothing is added until I approve it with Touch ID, so tell me who you drafted for my approval, who was already in my contacts, and anything you couldn't use."),
        PromptCard(title: "Make contacts from a file and save them as a group",
                   text: "From [path to the file], use agent-outbox to make contacts and save them as the group '[Book club]'. People who are already in my contacts still go in the group; new contacts wait for my Touch ID approval. Show me any rows you couldn't use."),
    ]),
    PromptSection(title: "Groups", prompts: [
        PromptCard(title: "Save people as a group",
                   text: "Save [names] as the agent-outbox group '[group name]'. Look each person up in my contacts first, and ask me if a name matches more than one person."),
        PromptCard(title: "Invite a group",
                   text: "Draft a personalised invite to everyone in my group '[group name]' with agent-outbox: [what, when, where, and how to reply]. Write each message separately, with a real detail about that person when you know one, and put them in one batch for me to review."),
        PromptCard(title: "Add people to a group",
                   text: "Add [people] to my group '[group name]' with agent-outbox. Tell me who was added and who was already in it."),
        PromptCard(title: "Rename a group or remove someone",
                   text: "Rename my agent-outbox group '[old name]' to '[new name]' and remove [name] from it. Then list the members so I can check."),
    ]),
    PromptSection(title: "Check on things", prompts: [
        PromptCard(title: "What got sent",
                   text: "What did agent-outbox send today, and did anything fail? Give me a short list: who, when, and what happened."),
        PromptCard(title: "What is waiting for me",
                   text: "Which of my agent-outbox batches are still waiting for my approval? List each one with its title, how many messages it has, and its review link."),
    ]),
]

struct AiDraftView: View {
    @State private var copiedTitle: String?

    var body: some View {
        List {
            Section {
                Text("Paste one of these into Claude Code (or any agent with the agent-outbox tools). It drafts the messages; they appear in your Inbox and nothing sends until you approve with Touch ID.")
                    .foregroundStyle(.secondary)
                Text("Big batch? With \"Spread out messages\" on in Settings, approved messages go out slowly, a few a minute, so a long list can take hours. Your agent can see that setting and tell you how long it will take.")
                    .font(.callout)
                Text("The agent has no agent-outbox tools? It can use the command line instead: \(AppEnv.shellQuote(AppEnv.serverBin)) cli --help")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(promptSections, id: \.title) { s in
                Section(s.title) {
                    ForEach(s.prompts, id: \.title) { p in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(p.title).font(.headline)
                            if let h = p.hint { Text(h).font(.caption).foregroundStyle(.secondary) }
                            Text(Self.highlighted(p.text)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                            Button(copiedTitle == p.title ? "Copied. Paste it into your agent." : "Copy") { copyToPasteboard(p.text); copiedTitle = p.title }
                        }.padding(.vertical, 4)
                    }
                }
            }
            Section {
                Text("Fill in the [bracketed] parts before you paste. Tips for agents: groups are saved lists of people (look one up by name with outbox_get_group, or list them with outbox_list_groups), and a personalised message per person beats one template.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("AI drafts")
    }

    /// The [fill-in] parts in the accent colour; what is copied is the plain string.
    static func highlighted(_ text: String) -> AttributedString {
        var out = AttributedString()
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "["), let close = rest[open...].firstIndex(of: "]") {
            out += AttributedString(String(rest[rest.startIndex..<open]))
            var fill = AttributedString(String(rest[open...close]))
            fill.foregroundColor = .accentColor
            out += fill
            rest = rest[rest.index(after: close)...]
        }
        out += AttributedString(String(rest))
        return out
    }
}
