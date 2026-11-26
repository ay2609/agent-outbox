// Development stand-in for `agent-outbox server --app-auth-fd 3` (canned data, no database).
// Speaks the app channel of the owner API with canned data shaped like the real routes (src/owner-api/*.ts), so the SwiftUI
// windows can be run and screenshotted:
//   AGENT_OUTBOX_SERVER_BIN=$PWD/app/dev/server-wrapper.sh OUTBOX_HOME=/tmp/ao-b .build/debug/AgentOutbox
// MOCK_SETUP=first|existing|recovery|keyed picks what status.setup says (default: keyed = a key is active, pretend setup is done).
// Reads the token from fd 3 (one line), listens on <OUTBOX_HOME>/run/owner.sock (0600, folder 0700), requires X-Outbox-App,
// exits when stdin closes (the app's lifeline). Never binds a TCP port, never touches a real state directory.
import { readFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const fdIdx = process.argv.indexOf("--app-auth-fd");
const fd = fdIdx >= 0 ? Number(process.argv[fdIdx + 1]) : 3;
const token = readFileSync(fd, "utf8").trim();
if (token.length !== 43) { console.error("mock-server: bad token length", token.length); process.exit(2); }
const want = createHash("sha256").update(token).digest();

const home = process.env.OUTBOX_HOME;
if (!home) { console.error("mock-server: set OUTBOX_HOME"); process.exit(2); }
const run = `${home}/run`;
mkdirSync(run, { recursive: true, mode: 0o700 }); chmodSync(run, 0o700);
const sock = `${run}/owner.sock`;
rmSync(sock, { force: true });

const now = Date.now(), ago = (m: number) => new Date(now - m * 60_000).toISOString();
const setupMode = process.env.MOCK_SETUP ?? "keyed";
const state = { mapped: false, kill: false, keys: [] as any[], recoveryOpen: setupMode === "recovery", pinNeedsUpdate: process.env.MOCK_PIN_STALE === "1", kill_: 0, transport: "dry", pace: { enabled: false, min_s: 30, max_s: 90, daily_cap: 150, quiet_start: "", quiet_end: "" }, skipped: new Set<string>() };

const draft = (id: string, name: string, handle: string, body: string, extra: any = {}) => ({
  id, batch_id: "b1", position: 0, contact_id: null, proposed_contact: null, create_contact: false, recipient_name: name, handle,
  service: "iMessage", body, version: 1, status: state.skipped.has(id) ? "skipped" : "review", confirmed: false, warnings: [], vars: {}, notes: "",
  created_at: ago(30), updated_at: ago(30), last_send: null, covered_by: null, contact: null, number_in_contact: true, candidates: [], ...extra,
});
const drafts = () => [
  draft("d1", "Maya Chen", "+14155550101", "Hey Maya, the studio is free Saturday afternoon. Want to come by and see the new prints?"),
  draft("d2", "Jordan Lee", "+14155550102", "Hi Jordan, quick reminder about Thursday's dinner at 7. Let me know about allergies!", { create_contact: true, proposed_contact: { given_name: "Jordan", family_name: "Lee", phones: [{ e164: "+14155550102" }], emails: [] }, warnings: [{ code: "new_contact", message: "Jordan Lee isn't in your contacts; a new contact will be created." }] }),
  draft("d3", "Sam", "sam@example.com", "Hi {{name}}, thanks for coming last week.", { warnings: [{ code: "unresolved_var", message: "The message still contains {{name}}." }] }),
];
const batch = (id: string, title: string, status: string, counts: any, total: number, min: number) => ({ id, title, status, created_by: "agent:claude-code", created_at: ago(min), counts, total, warnings: 1, new_contacts: 1 });
const contacts = [
  { id: "c1", display_name: "Maya Chen", given_name: "Maya", family_name: "Chen", org: "Studio North", phones: [{ e164: "+14155550101" }], emails: [] },
  { id: "c2", display_name: "Jordan Lee", given_name: "Jordan", family_name: "Lee", org: "", phones: [{ e164: "+14155550102" }], emails: [{ email: "jordan@example.com" }] },
  { id: "c3", display_name: "Sam Rivera", given_name: "Sam", family_name: "Rivera", org: "Rivera & Co", phones: [], emails: [{ email: "sam@example.com" }] },
];
const setupBlock = () => {
  const done = setupMode !== "first";
  const proof = state.recoveryOpen ? "recovery_token" : setupMode === "first" ? "setup_token" : state.keys.some((k) => k.status === "active") ? "se_reauth" : null;
  return { done, proof_available: proof, recovery_expires_at: state.recoveryOpen ? new Date(now + 25 * 60_000).toISOString() : null };
};
const status = () => ({
  server_time: new Date().toISOString(),
  transport: state.transport, kill_switch: state.kill, kill_reason: state.kill ? "owner" : "", contacts_transport: state.transport,
  pacing: state.pace, exec: { alive: true, heartbeat_age_s: 4, version: "dev", transport: state.transport, pin_file_ok: true, last_error: process.env.MOCK_HOLD ?? null },
  pin: { mode: "simple", effective: { kind: "user", valid: true, problems: [] }, root: { present: false }, user: { present: true, valid: true },
    expected_keys: state.keys.filter((k) => k.status === "active").map((k) => ({ credential_id: k.key_id, label: k.label, kind: "secure-enclave" })),
    install_command: "echo 'abc123  /Users/you/Library/Application Support/agent-outbox/passkeys.json' | shasum -a 256 -c - && sudo install -d -o root -g wheel -m 755 '/Library/Application Support/agent-outbox' && sudo install -o root -g wheel -m 444 '/Users/you/Library/Application Support/agent-outbox/passkeys.json' '/Library/Application Support/agent-outbox/passkeys.json' && plutil -p '/Library/Application Support/agent-outbox/passkeys.json'" },
  counts: { batches_review: 2, drafts_review: 3, drafts_approved: 0, drafts_failed: 0, contact_sets_review: 1, contact_changes_review: 2 },
  native: { keys_active: state.keys.filter((k) => k.status === "active").length, approve_in_app: state.keys.some((k) => k.status === "active"), pin_needs_update: state.pinNeedsUpdate },
  setup: setupBlock(),
});
const importRows = [
  { row_index: 0, match: "matched", normalized: { display_name: "Maya Chen", phone_e164: "+14155550101" }, issues: [] },
  { row_index: 1, match: "new", normalized: { display_name: "Priya Nair", phone_e164: "+14155550103" }, issues: [] },
  { row_index: 2, match: "invalid", normalized: { display_name: "Tom", phone_e164: "" }, issues: [{ message: "No phone number or email." }] },
];
const importSummary = () => ({ import_id: "i1", id: "i1", filename: "dinner-list.csv", kind: "csv", sheet: null, sheets: [], row_count: 3, columns: ["Name", "Phone", "Company"],
  mapping: { confirmed: state.mapped, region: "US", vars: { company: "Company" }, fields: { display_name: { column: "Name", confidence: 0.95 }, phone: { column: "Phone", confidence: 0.9 } } },
  warnings: [], counts: { matched: 1, new: 1, invalid: 1, ambiguous: 0, duplicate: 0 } });
const sets = [{ id: "s1", title: "Add 2 people from the dinner list", created_by: "agent:claude-code", source: "agent", status: "review", created_at: ago(12), counts: { review: 2 } }];
const changes = [
  { id: "ch1", set_id: "s1", kind: "create", status: "review", note: "From the dinner list", error: null, payload: { given_name: "Priya", family_name: "Nair", phones: [{ e164: "+14155550103" }], emails: [], org: "Nair Studio" }, before: null },
  { id: "ch2", set_id: "s1", kind: "edit", status: "review", note: "", error: null, payload: { given_name: "Maya", family_name: "Chen", org: "Studio North Ltd" }, before: { display_name: "Maya Chen" } },
];

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

Bun.serve({
  unix: sock,
  async fetch(req) {
    const given = req.headers.get("x-outbox-app") ?? "";
    const h = createHash("sha256").update(given).digest();
    if (!timingSafeEqual(h, want)) return json({ error: "app_auth", message: "Not the app." }, 401);
    if (req.headers.get("origin") || req.headers.get("sec-fetch-site")) return json({ error: "browser_refused", message: "Not a browser." }, 403);
    const u = new URL(req.url), p = u.pathname, m = req.method;
    console.log(m, p);
    const body = m === "GET" ? null : await req.json().catch(() => ({}));
    if (p === "/api/status") return json(status());
    if (p === "/api/batches") return json({ batches: [
      batch("b1", "Studio open day invitations", "review", { review: 3 }, 3, 30),
      batch("b2", "Dinner Thursday", "approved", { approved: 4, sent: 0 }, 4, 200),
      batch("b3", "Thank-you notes", "done", { sent: 6 }, 6, 3000)] });
    if (p === "/api/batches/b1" && m === "GET") return json({ batch: batch("b1", "Studio open day invitations", "review", { review: 3 }, 3, 30), drafts: drafts(), sends: [], approvals: [], settings: {} });
    if (/^\/api\/batches\/\w+$/.test(p)) return json({ batch: batch("b2", "Dinner Thursday", "approved", { approved: 4 }, 4, 200), drafts: [], approvals: [], settings: {} });
    const dm = p.match(/^\/api\/drafts\/(\w+)\/(skip|include)$/);
    if (dm) { dm[2] === "skip" ? state.skipped.add(dm[1]!) : state.skipped.delete(dm[1]!); return json({ ok: true }); }
    if (p.endsWith("/cancel")) return json({ ok: true });
    if (p === "/api/contact-changes") return json({ sets });
    if (p === "/api/contact-changes/s1") return json({ set: sets[0], counts: { review: 2 }, changes, approvals: [], contacts_transport: state.transport, pin_contacts_live_allowed: true });
    if (p === "/api/contacts") return json({ contacts, total: 3, matched: 3, offset: 0, limit: 100, has_more: false });
    if (p === "/api/groups" && m === "GET") return json({ groups: [{ id: "g1", name: "Studio friends", description: "People from the open day", members: 3 }] });
    if (p === "/api/groups/g1") return json({ group: { id: "g1", name: "Studio friends", members: 2 }, members: [{ handle: "+14155550101", name: "Maya Chen" }, { handle: "sam@example.com", name: "Sam Rivera" }] });
    if (p === "/api/settings") return json({ settings: { transport: state.transport, pacing: state.pace, kill_switch: state.kill } });
    if (p === "/api/native-keys" && m === "GET") return json({ keys: state.keys });
    if (p === "/api/native-keys/enroll/options") {
      const id = createHash("sha256").update(Buffer.from(body.x963, "base64url")).digest("base64url");
      const proof = setupBlock().proof;
      state.keys = state.keys.filter((k) => k.key_id !== id);
      state.keys.push({ key_id: id, label: body.label ?? "Mac", status: "pending", in_effective_pin: false });
      return json({ key_id: id, challenge: Buffer.alloc(32, 7).toString("base64url"), fingerprint: "AAAA-BBBB-CCCC-DDDD-EEEE", expires_at: ago(-10), proof });
    }
    if (p === "/api/native-keys/enroll/verify") {
      if (!setupBlock().proof) return json({ error: "proof_required", message: "Run agent-outbox recover in Terminal first." }, 403);
      for (const k of state.keys) if (k.key_id === body.key_id) { k.status = "active"; k.in_effective_pin = true; }
      state.recoveryOpen = false;
      return json({ ok: true, status: "active" });
    }
    if (p === "/api/native-keys/reauth/options") return json({ challenge_id: "rc1", challenge: Buffer.alloc(32, 3).toString("base64url") });
    const rk = p.match(/^\/api\/native-keys\/([\w-]+)\/revoke$/);
    if (rk) { for (const k of state.keys) if (k.key_id === rk[1]) k.status = "revoked"; return json({ ok: true }); }
    if (p === "/api/recovery/cancel") { const was = state.recoveryOpen; state.recoveryOpen = false; return json({ ok: true, cancelled: was }); }
    if (p === "/api/activity") return json({
      sends: [{ id: "s1", result: "sent", recipient_name: "Maya Chen", handle: "+14155550101", preview: "Hey Maya, the studio is free Saturday", transport: "dry", attempt: 1, started_at: ago(20), error: null }],
      audit: [{ id: 5, at: ago(30), actor: "owner", action: "draft.edit", target: "d1", details: { fields: [], body_changed: true } }, { id: 4, at: ago(90), actor: "server", action: "migration.v7", target: null, details: { revoked_approvals: 2, revoked_contact_approvals: 0 } }],
      next: { sends_before: null, audit_before: null } });
    if (p === "/api/imports" && m === "GET") return json({ imports: [{ id: "i1", filename: "dinner-list.csv", kind: "csv", sheet: null, row_count: 3, created_by: "owner", created_at: ago(60), confirmed: state.mapped }] });
    if (p === "/api/imports" && m === "POST") return json(importSummary());
    if (p === "/api/imports/i1" && m === "GET") return json({ ...importSummary(), rows: importRows, rows_total: 3, rows_offset: 0, rows_limit: 25 });
    if (p === "/api/imports/i1/mapping") { state.mapped = true; return json(importSummary()); }
    if (p === "/api/imports/i1/preview") return json({ previews: [{ name: "Maya Chen", to: "+14155550101", body: String(body.template).replace("{{first_name|there}}", "Maya"), unresolved: [], empty: [] }] });
    if (p === "/api/imports/i1/batch") return json({ batch_id: "b1", drafts: 2, skipped: [2] });
    if (p === "/api/imports/i1/reingest") return json(importSummary());
    const cm = p.match(/^\/api\/contacts\/(c\d)$/);
    if (cm) return json({ contact: { ...contacts.find((c) => c.id === cm[1]), source: "macos", nickname: "", tags: ["studio"], notes: "Met at the open day.", updated_at: ago(500), synced_at: ago(20) } });
    if (m === "PATCH" && /^\/api\/drafts\//.test(p)) return json({ draft: draft("d1", "Maya Chen", "+14155550101", body.body ?? "x") });
    if (p === "/api/groups" && m === "POST") return json({ group: { id: "g1", name: body.name } }, 201);
    if (/^\/api\/groups\/g1\/members$/.test(p)) return json({ added: [1, 2], already: [], invalid: [3] });
    if (p === "/api/mode") { state.transport = body.mode; return json({ ok: true }); }
    if (p === "/api/stop") { state.kill = true; return json({ ok: true, revoked_approvals: 0 }); }
    if (p === "/api/resume") { state.kill = false; return json({ ok: true }); }
    if (p === "/api/settings" && m === "PATCH") { Object.assign(state.pace, body.pacing ?? {}); return json({ ok: true }); }
    if (m === "PATCH" && p === "/api/settings") { Object.assign(state.pace, body.pacing ?? {}); return json({ settings: {} }); }
    return json({ error: "not_found", message: `mock: ${m} ${p}` }, 404);
  },
});

// The lifeline: the app keeps stdin open; when it closes, exit.
process.stdin.resume();
process.stdin.on("end", () => { rmSync(sock, { force: true }); process.exit(0); });
process.stdin.on("close", () => { rmSync(sock, { force: true }); process.exit(0); });
console.log(`mock owner API on ${sock}`);
