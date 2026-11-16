// The gate test: the agent API must have no way to approve or send.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentApp } from "../src/agent-api/app";
import { call, fakeDeps, memDb, seedContact } from "./helpers";

const ROOT = join(import.meta.dir, "..");
// v4: contact_approvals (the user's signed contacts approvals) and contact_applies (the executor's consumption record) are gated too.
const GATED_TABLES = ["approvals", "sends", "contact_writes", "passkeys", "sessions", "webauthn_challenges", "settings", "contact_approvals", "contact_applies"];

// The complete route table. Adding a route means adding it here on purpose, after checking it can't approve or send.
const ALLOWED_ROUTES = [
  "GET /v1/health", "GET /v1/status",
  "POST /v1/drafts", "POST /v1/batches", "POST /v1/batches/:id/items", "POST /v1/batches/:id/submit",
  "GET /v1/batches", "GET /v1/batches/:id", "PATCH /v1/drafts/:id", "PATCH /v1/drafts", "POST /v1/batches/:id/cancel",
  "GET /v1/contacts", "POST /v1/contacts/sync", "GET /v1/contacts/:id",
  "POST /v1/imports", "GET /v1/imports/:id", "PUT /v1/imports/:id/mapping", "POST /v1/imports/:id/batch",
  // v4 contact changes: propose and read only. Approval, apply and undo are not here and never will be.
  "POST /v1/contact-changes", "POST /v1/imports/:id/contact-changes", "GET /v1/contact-changes", "GET /v1/contact-changes/:id",
  // v5 saved groups: agents may make and change groups and address a draft batch to one. No delete, nothing that approves or sends.
  "GET /v1/groups", "POST /v1/groups", "GET /v1/groups/:ref", "PATCH /v1/groups/:ref", "POST /v1/groups/:ref/members",
  "POST /v1/groups/:ref/remove", "POST /v1/groups/:ref/batch",
].sort();

function makeApp() {
  const db = memDb();
  const { deps } = fakeDeps(db);
  return { db, app: createAgentApp({ db: () => db, deps: async () => deps }) };
}

describe("route table", () => {
  const { app } = makeApp();
  const routes = app.routes.map((r) => `${r.method} ${r.path}`);

  test("is exactly the allowlist, with no catch-all middleware", () => {
    expect(routes.some((r) => r.startsWith("ALL "))).toBe(false);
    expect([...new Set(routes)].sort()).toEqual(ALLOWED_ROUTES);
  });

  test("no route name can approve, send, sign, schedule, stop or touch settings, sessions or keys", () => {
    const bad = /approv|send|sign|passkey|webauthn|session|setting|kill|stop|resume|schedul|execut|login|auth|manifest|contact_write|dry|live|transport/i;
    for (const r of routes) expect(bad.test(r.split(" ")[1]!)).toBe(false);
  });

  test("the only writes are POST/PUT/PATCH on drafts, batches, items, submit, cancel, sync, imports, contact-change proposals and groups", () => {
    const writes = routes.filter((r) => !r.startsWith("GET "));
    for (const w of writes) {
      expect(w).toMatch(/^(POST|PUT|PATCH) \/v1\/(drafts|batches|batches\/:id\/(items|submit|cancel)|drafts\/:id|contacts\/sync|imports|imports\/:id\/(mapping|batch|contact-changes)|contact-changes|groups|groups\/:ref(\/(members|remove|batch))?)$/);
    }
    // contact changes have no per-change or per-set write route at all (no approve, apply, undo, cancel, reject)
    expect(routes.filter((r) => /contact-changes\/:id(\/|$)/.test(r) && !r.startsWith("GET ") && !r.startsWith("POST /v1/imports/:id"))).toEqual([]);
    expect(routes.some((r) => r.startsWith("DELETE "))).toBe(false);
  });
});

describe("source scan: agent API, MCP and CLI never write gated tables or set a sent-ish status", () => {
  const dirs = ["src/agent-api", "src/mcp", "src/cli"];
  // src/core/contact-changes.ts is what the agent routes call to propose contact changes: it is held to the same rules.
  // src/core/groups.ts is what the group routes call (v5): held to the same rules.
  const files = [...dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => f.endsWith(".ts")).map((f) => join(d, f))), "src/core/contact-changes.ts", "src/core/groups.ts"];
  test("scanned files exist", () => expect(files.length).toBeGreaterThanOrEqual(8));
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    test(f, () => {
      for (const t of GATED_TABLES) {
        expect(src).not.toMatch(new RegExp(`(INSERT\\s+(OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+${t}\\b`, "i"));
      }
      expect(src).not.toMatch(/\bsetSetting\b/);
      expect(src).not.toMatch(/setBatchStatus\([^)]*["'](approved|sending|sent|done)["']/);
      expect(src).not.toMatch(/status\s*=\s*['"]?(approved|sending|sent|done|applied|undone|applying)\b/i);
      // v4: no undo rows from here, and no contact-change status or set status other than the proposing ones
      expect(src).not.toMatch(/INSERT\s+INTO\s+contact_changes[^;]*['"]undo['"]/is);
      expect(src).not.toMatch(/UPDATE\s+contact_(changes|change_sets)\s+SET\s+status/i);
      // contacts are never added automatically: nothing the agent side can write is queued for apply without approval
      expect(src).not.toMatch(/auto_queued/);
      expect(src).not.toMatch(/requires_approval\s*[:=]\s*(0|false)\b/);
      expect(src).not.toMatch(/osascript|NSAppleScript|child_process|Bun\.spawn|\bspawn\(/);
      expect(src).not.toMatch(/owner-api/);
    });
  }
});

describe("behaviour: exercise every route, then nothing is approved or sent", () => {
  test("after every route (plus forbidden attempts) no draft is approved/sending/sent and gated tables are untouched", async () => {
    const { db, app } = makeApp();
    const settingsBefore = db.query("SELECT key, value FROM settings ORDER BY key").all();
    const hits = new Set<string>();
    const hit = async (method: string, pattern: string, path: string, body?: unknown) => {
      hits.add(`${method} ${pattern}`);
      return call(app, method, path, body);
    };

    const cid = seedContact(db, { name: "Sam Lee", phones: [{ e164: "+12025550009", label: "mobile" }] });
    await hit("GET", "/v1/health", "/v1/health");
    const d1 = await hit("POST", "/v1/drafts", "/v1/drafts", { contact_id: cid, body: "hey" });
    const b1 = await hit("POST", "/v1/batches", "/v1/batches", { title: "T", items: [{ to: "4151230001", body: "a" }] });
    const id = b1.json.batch.id as string;
    await hit("POST", "/v1/batches/:id/items", `/v1/batches/${id}/items`, { items: [{ to: "4151230002", body: "b" }] });
    await hit("POST", "/v1/batches/:id/submit", `/v1/batches/${id}/submit`);
    await hit("GET", "/v1/batches", "/v1/batches");
    await hit("GET", "/v1/batches/:id", `/v1/batches/${id}`);
    await hit("PATCH", "/v1/drafts/:id", `/v1/drafts/${d1.json.draft.id}`, { body: "hey there" });
    await hit("GET", "/v1/contacts", "/v1/contacts?q=sam");
    await hit("GET", "/v1/contacts/:id", `/v1/contacts/${cid}`);
    await hit("POST", "/v1/contacts/sync", "/v1/contacts/sync");
    const imp = await hit("POST", "/v1/imports", "/v1/imports", { text: "Name,Phone\nAnn,4151230001\n", kind: "csv" });
    const iid = imp.json.import_id as string;
    await hit("GET", "/v1/imports/:id", `/v1/imports/${iid}`);
    await hit("PUT", "/v1/imports/:id/mapping", `/v1/imports/${iid}/mapping`, { fields: { given_name: { column: "Name" } } });
    await hit("POST", "/v1/imports/:id/batch", `/v1/imports/${iid}/batch`, { title: "I", template: "Hi {{first_name}}", submit: true });
    await hit("GET", "/v1/status", "/v1/status");
    await hit("PATCH", "/v1/drafts", "/v1/drafts", { updates: [{ draft_id: d1.json.draft.id, body: "hey there, bulk" }] });
    const b3 = await call(app, "POST", "/v1/batches", { title: "to cancel", items: [{ to: "4151230009", body: "never" }] });
    await hit("POST", "/v1/batches/:id/cancel", `/v1/batches/${b3.json.batch.id}/cancel`);

    // v4: contact changes. A new person (auto), an edit (review) and a read of each.
    const cc = await hit("POST", "/v1/contact-changes", "/v1/contact-changes", {
      title: "People", creates: [{ given_name: "New", family_name: "Person", phones: ["4155550123"] }],
      updates: [{ contact_id: cid, set: { given_name: "Sam 📚" } }],
    });
    expect(cc.status).toBe(201);
    await hit("GET", "/v1/contact-changes", "/v1/contact-changes");
    await hit("GET", "/v1/contact-changes/:id", `/v1/contact-changes/${cc.json.set_id}`);
    await hit("POST", "/v1/imports/:id/contact-changes", `/v1/imports/${iid}/contact-changes`, { first_name_suffix: "📚" });

    // v5: groups. Make one, add, read, rename, remove, then a batch addressed to it (still just a review batch).
    const grp = await hit("POST", "/v1/groups", "/v1/groups", { name: "Crew", members: [{ to: "4151230021", name: "Ann" }, { to: "4151230022", name: "Bo" }] });
    expect(grp.status).toBe(201);
    await hit("GET", "/v1/groups", "/v1/groups");
    await hit("GET", "/v1/groups/:ref", `/v1/groups/${grp.json.group.id}`);
    await hit("POST", "/v1/groups/:ref/members", `/v1/groups/${grp.json.group.id}/members`, { members: [{ to: "4151230023" }] });
    await hit("PATCH", "/v1/groups/:ref", `/v1/groups/${grp.json.group.id}`, { name: "Crew 2" });
    await hit("POST", "/v1/groups/:ref/remove", `/v1/groups/${grp.json.group.id}/remove`, { handles: ["4151230023"] });
    const gb = await hit("POST", "/v1/groups/:ref/batch", "/v1/groups/Crew%202/batch", { title: "Crew note", template: "hi" });
    expect(gb.json.batch.status).toBe("review");

    // every route in the table was exercised
    expect([...hits].sort()).toEqual(ALLOWED_ROUTES);

    // contacts are never added automatically: everything the routes queued (a clean create, an edit, import rows) waits in review
    const queued = db.query("SELECT kind, status, requires_approval FROM contact_changes").all() as any[];
    expect(queued.length).toBeGreaterThanOrEqual(2);
    expect(queued.some((c) => c.kind === "create")).toBe(true);
    for (const c of queued) expect(c).toMatchObject({ status: "review", requires_approval: 1 });
    expect((db.query("SELECT COUNT(*) AS n FROM contact_changes WHERE status = 'auto_queued' OR requires_approval = 0").get() as any).n).toBe(0);

    // attempts to smuggle approval through the routes that exist, and routes that must not exist
    const batchId = b1.json.batch.id, draftId = d1.json.draft.id;
    await call(app, "PATCH", `/v1/drafts/${draftId}`, { body: "x", status: "approved", version: 99 });
    await call(app, "POST", "/v1/batches", { title: "sneaky", status: "approved", items: [{ to: "4151230003", body: "c", status: "sent" }], submit: true });
    await call(app, "POST", `/v1/batches/${batchId}/submit`, { status: "approved" });
    const forbidden: [string, string][] = [
      ["POST", `/v1/batches/${batchId}/approve`], ["POST", `/v1/batches/${batchId}/send`], ["POST", `/v1/drafts/${draftId}/send`],
      ["POST", `/v1/drafts/${draftId}/approve`], ["POST", "/v1/approvals"], ["POST", "/v1/sends"], ["PUT", "/v1/settings/kill_switch"],
      ["PATCH", "/v1/settings"], ["POST", "/v1/passkeys"], ["POST", "/v1/stop"], ["POST", "/v1/resume"], ["DELETE", `/v1/batches/${batchId}`],
      ["PUT", `/v1/batches/${batchId}/status`], ["POST", "/api/batches/x/approve/verify"],
      // v4: nothing to approve, apply, undo, cancel or edit a contact change set or one change
      ["POST", `/v1/contact-changes/${cc.json.set_id}/approve`], ["POST", `/v1/contact-changes/${cc.json.set_id}/approve/options`],
      ["POST", `/v1/contact-changes/${cc.json.set_id}/approve/verify`], ["POST", `/v1/contact-changes/${cc.json.set_id}/apply`],
      ["POST", `/v1/contact-changes/${cc.json.set_id}/undo`], ["POST", "/v1/contact-changes/undo"], ["POST", `/v1/contact-changes/${cc.json.set_id}/cancel`],
      ["POST", `/v1/contact-changes/${cc.json.set_id}/reject`], ["PATCH", `/v1/contact-changes/${cc.json.set_id}`], ["PUT", `/v1/contact-changes/${cc.json.set_id}/status`],
      ["DELETE", `/v1/contact-changes/${cc.json.set_id}`], ["POST", "/v1/contact-approvals"], ["POST", "/v1/contact-applies"],
      // v5: a group can't be deleted, approved or sent to from here
      ["DELETE", `/v1/groups/${grp.json.group.id}`], ["PUT", `/v1/groups/${grp.json.group.id}`], ["POST", `/v1/groups/${grp.json.group.id}/approve`],
      ["POST", `/v1/groups/${grp.json.group.id}/send`], ["POST", `/v1/groups/${grp.json.group.id}/delete`],
    ];
    for (const [m, p] of forbidden) {
      const r = await call(app, m, p, { status: "approved", transport: "live" });
      expect([404, 405]).toContain(r.status);
    }

    // smuggling a status, a kind or a signature into a proposal is refused (unknown keys), and creates nothing
    const setsBefore = (db.query("SELECT COUNT(*) AS n FROM contact_change_sets").get() as any).n;
    for (const body of [
      { title: "x", creates: [{ given_name: "A", phones: ["4155550124"], status: "applied" }] },
      { title: "x", creates: [{ given_name: "A", phones: ["4155550124"], kind: "undo" }] },
      { title: "x", updates: [{ contact_id: cid, set: { given_name: "Z" }, status: "approved" }] },
      { title: "x", updates: [{ contact_id: cid, add_groups: ["g"], from_create: true }] },
      { title: "x", status: "approved", creates: [{ given_name: "A", phones: ["4155550124"] }] },
    ]) {
      const r = await call(app, "POST", "/v1/contact-changes", body);
      expect(r.status).toBe(400);
    }
    expect((db.query("SELECT COUNT(*) AS n FROM contact_change_sets").get() as any).n).toBe(setsBefore);

    // cancelling can only stop: it never reaches approved/sending/sent/done, and it refuses a batch that is already approved
    expect(db.query("SELECT status FROM batches WHERE id = ?").get(b3.json.batch.id)).toEqual({ status: "cancelled" });
    expect(db.query("SELECT status FROM drafts WHERE batch_id = ?").all(b3.json.batch.id)).toEqual([{ status: "rejected" }]);

    // nothing is approved, sending or sent
    expect(db.query("SELECT COUNT(*) AS n FROM drafts WHERE status IN ('approved','sending','sent','failed','unknown')").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM batches WHERE status IN ('approved','sending','done')").get()).toEqual({ n: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM drafts").get() as any).n).toBeGreaterThan(3);
    // gated tables untouched
    for (const t of ["approvals", "sends", "contact_writes", "passkeys", "sessions", "webauthn_challenges"]) {
      expect(db.query(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
    // v4: the agent routes left the gated contact tables alone and only created sets and changes in proposing states
    for (const t of ["contact_approvals", "contact_applies"]) expect(db.query(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM contact_changes WHERE kind = 'undo' OR undo_of IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM contact_changes WHERE status IN ('approved','applied','undone','failed') OR transport IS NOT NULL OR before_vcard IS NOT NULL OR after_fingerprint IS NOT NULL OR result_macos_id IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM contact_change_sets WHERE status IN ('approved','applying','done')").get()).toEqual({ n: 0 });
    expect((db.query("SELECT COUNT(*) AS n FROM contact_changes").get() as any).n).toBe(2);
    // v5: the group is still there with its two people; the group routes touched nothing gated
    expect(db.query("SELECT COUNT(*) AS n FROM contact_group_members").get()).toEqual({ n: 2 });
    expect(db.query("SELECT key, value FROM settings ORDER BY key").all()).toEqual(settingsBefore);
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'setting.%' OR actor NOT LIKE 'agent:%' AND actor <> 'system'").get()).toEqual({ n: 0 });
  });
});

describe("cancel is stop-only", () => {
  const H = { "X-Outbox-Client": "owner-of-batch" };
  test("an agent can cancel only its own drafting/review batch, and never an approved, sending, sent or done one", async () => {
    const { db, app } = makeApp();
    const mk = async (label = "owner-of-batch") => (await call(app, "POST", "/v1/batches", { title: "B", items: [{ to: "4151230001", body: "a" }], submit: true }, { "X-Outbox-Client": label })).json.batch.id as string;
    const mine = await mk();
    expect((await call(app, "POST", `/v1/batches/${mine}/cancel`, undefined, { "X-Outbox-Client": "someone-else" })).status).toBe(403);
    expect((await call(app, "POST", `/v1/batches/${mine}/cancel`, undefined, H)).status).toBe(200);
    expect((await call(app, "POST", `/v1/batches/${mine}/cancel`, undefined, H)).status).toBe(409); // already cancelled
    for (const status of ["approved", "sending", "done"]) {
      const id = await mk();
      db.query("UPDATE batches SET status = ? WHERE id = ?").run(status, id); // what the user's approval would have done
      const r = await call(app, "POST", `/v1/batches/${id}/cancel`, undefined, H);
      expect(r.status).toBe(409);
      expect(db.query("SELECT status FROM batches WHERE id = ?").get(id)).toEqual({ status });
    }
    // a review batch holding an approved draft is refused too
    const id = await mk();
    db.query("UPDATE drafts SET status = 'approved' WHERE batch_id = ?").run(id);
    expect((await call(app, "POST", `/v1/batches/${id}/cancel`, undefined, H)).status).toBe(409);
    expect((await call(app, "POST", "/v1/batches/nope/cancel", undefined, H)).status).toBe(404);
  });
});
