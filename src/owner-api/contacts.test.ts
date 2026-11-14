// v4 contact changes, the owner's side: list/detail, reject/cancel, the contacts manifest and its Touch ID approval (tamper
// refusals, nothing recorded on failure), Stop, undo sets, the contacts transport and the pin's contacts_live_allowed.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedContact } from "../../tests/helpers";
import { proposeContactChanges, validateCreate, validateUpdate } from "../core/contact-changes";
import { newId, nowIso } from "../db";
import { getSettings } from "../core/store";
import type { ContactManifest } from "../core/types";
import { b64u } from "./b64";
import { buildContactManifest } from "./contact-approval";
import { challengeBytes } from "./approval";
import { makeHarness, seedBatch, type Harness } from "./testkit";

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest();
const hex = (s: string) => sha256(s).toString("hex");

/** A signed-up owner plus a set with one automatic create and two edits (Ann, Ben) in review. */
async function ready() {
  const h = makeHarness();
  await h.signUp();
  const ann = seedContact(h.db, { name: "Ann Lee", given: "Ann", family: "Lee", phones: [{ e164: "+14155550101", label: "mobile" }], tags: ["Friends"] });
  const ben = seedContact(h.db, { name: "Ben Roe", given: "Ben", family: "Roe", phones: [{ e164: "+14155550102", label: "mobile" }] });
  const r = proposeContactChanges(h.db, {
    title: "Book club members", created_by: "agent:test", source: "mcp",
    creates: [validateCreate({ given_name: "New", family_name: "Person", phones: ["+14155550199"] })],
    updates: [
      { contact: seedGet(h, ann), payload: validateUpdate({ set: { given_name: "Ann 📚" }, add_groups: ["Book club"] }) },
      { contact: seedGet(h, ben), payload: validateUpdate({ set: { given_name: "Ben 📚" } }) },
    ],
  });
  const [create, annEdit, benEdit] = r.changes.map((c) => c.id) as [string, string, string];
  return { h, setId: r.set_id, ann, ben, create, annEdit, benEdit };
}
import { getContact } from "../core/store";
const seedGet = (h: Harness, id: string) => getContact(h.db, id)!;

const approveOptions = (h: Harness, setId: string, ids: string[]) => h.call("POST", `/api/contact-changes/${setId}/approve/options`, { change_ids: ids });
async function approve(h: Harness, setId: string, ids: string[]) {
  const opt = await approveOptions(h, setId, ids);
  expect(opt.status).toBe(200);
  const verify = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
  return { opt, verify };
}
const status = (h: Harness, id: string) => (h.db.query("SELECT status FROM contact_changes WHERE id = ?").get(id) as any).status;
const setStatus = (h: Harness, id: string) => (h.db.query("SELECT status FROM contact_change_sets WHERE id = ?").get(id) as any).status;
const count = (h: Harness, table: string) => (h.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;

/** What the executor writes when it applies a change (the tests stand in for it). */
function markApplied(h: Harness, changeId: string, o: { transport?: "dry" | "live"; fingerprint?: string | null; vcard?: string | null; result_macos_id?: string | null } = {}) {
  const t = nowIso();
  const transport = o.transport ?? "live";
  h.db.query(`UPDATE contact_changes SET status = 'applied', transport = ?, after_fingerprint = ?, before_vcard = ?, result_macos_id = COALESCE(?, result_macos_id), applied_at = ? WHERE id = ?`)
    .run(transport, o.fingerprint === undefined ? "f".repeat(64) : o.fingerprint, o.vcard === undefined ? null : o.vcard, o.result_macos_id ?? null, t, changeId);
  h.db.query("INSERT INTO contact_applies(id, change_id, approval_id, transport, started_at, finished_at, result, macos_id) VALUES (?,?,NULL,?,?,?,'applied',?)")
    .run(newId(), changeId, transport, t, t, o.result_macos_id ?? null);
}

function installPin(h: Harness, policy: Record<string, unknown>) {
  mkdirSync(join(h.dir, "root"), { recursive: true });
  const path = join(h.dir, "root", "passkeys.json");
  writeFileSync(path, JSON.stringify({ v: 2, rp_id: "localhost", origin: "http://localhost:7477", keys: [{ credential_id: h.auth.id, x963: h.auth.x963.toString("base64url"), label: "Test approve" }], policy }));
}

describe("list, detail, reject, cancel", () => {
  test("list shows sets with change counts and filters by set status; detail has payloads, before, undo state and the settings the sheet needs", async () => {
    const { h, setId, ann, annEdit } = await ready();
    const l = await h.call("GET", "/api/contact-changes");
    expect(l.status).toBe(200);
    expect(l.json.sets).toHaveLength(1);
    expect(l.json.sets[0]).toMatchObject({ id: setId, title: "Book club members", status: "review", source: "mcp", counts: { auto_queued: 1, review: 2 } });
    expect((await h.call("GET", "/api/contact-changes?status=review")).json.sets).toHaveLength(1);
    expect((await h.call("GET", "/api/contact-changes?status=done")).json.sets).toHaveLength(0);
    expect((await h.call("GET", "/api/contact-changes?status=bogus")).status).toBe(400);
    const d = await h.call("GET", `/api/contact-changes/${setId}`);
    expect(d.json.changes.map((c: any) => [c.kind, c.status])).toEqual([["create", "auto_queued"], ["update", "review"], ["update", "review"]]);
    const edit = d.json.changes.find((c: any) => c.id === annEdit);
    expect(edit).toMatchObject({ payload: { set: { given_name: "Ann 📚" }, add_groups: ["Book club"] }, covered_by: null, undo_blocked: "not applied" });
    expect(edit.payload_json).toBeUndefined(); // the signed bytes only come with the approval options
    expect(edit.before_vcard).toBeUndefined(); // and the vCard snapshot never leaves the server
    expect(edit.before).toMatchObject({ contact_id: ann, display_name: "Ann Lee", groups: ["Friends"] });
    expect(d.json).toMatchObject({ contacts_transport: "dry", pin_contacts_live_allowed: false, approvals: [] });
    expect((await h.call("GET", "/api/contact-changes/nope")).status).toBe(404);
    // the owner API needs a session
    expect((await h.call("GET", "/api/contact-changes", undefined, { cookie: null })).status).toBe(401);
    expect((await h.call("POST", `/api/contact-changes/${setId}/cancel`, {}, { csrf: false })).status).toBe(403);
  });

  test("reject sets review -> rejected (audited); the set follows; an auto-queued or applied change can't be rejected; cancel stops everything unapplied", async () => {
    const { h, setId, create, annEdit, benEdit } = await ready();
    const r = await h.call("POST", `/api/contact-changes/${setId}/reject`, { change_ids: [annEdit] });
    expect(r.json).toMatchObject({ ok: true, rejected: 1 });
    expect(status(h, annEdit)).toBe("rejected");
    expect(setStatus(h, setId)).toBe("review"); // Ben's edit is still waiting
    expect((await h.call("POST", `/api/contact-changes/${setId}/reject`, { change_ids: [annEdit] })).json.error).toBe("change_not_rejectable");
    expect((await h.call("POST", `/api/contact-changes/${setId}/reject`, { change_ids: [create] })).json.error).toBe("change_not_rejectable");
    expect((await h.call("POST", `/api/contact-changes/${setId}/reject`, { change_ids: ["nope"] })).status).toBe(400);
    expect((await h.call("POST", `/api/contact-changes/${setId}/reject`, { change_ids: [] })).status).toBe(400);
    await h.call("POST", `/api/contact-changes/${setId}/reject`, { change_ids: [benEdit] });
    expect(setStatus(h, setId)).toBe("drafting"); // only the automatic create is left
    expect(h.db.query("SELECT actor, target FROM audit_log WHERE action = 'contact_changes.reject'").all()).toEqual([{ actor: "owner", target: setId }, { actor: "owner", target: setId }]);

    const x = await ready();
    const c = await x.h.call("POST", `/api/contact-changes/${x.setId}/cancel`);
    expect(c.json).toMatchObject({ ok: true, rejected: 3, revoked_approvals: 0 });
    expect(setStatus(x.h, x.setId)).toBe("cancelled");
    expect(x.h.db.query("SELECT status FROM contact_changes WHERE set_id = ?").all(x.setId)).toEqual([{ status: "rejected" }, { status: "rejected" }, { status: "rejected" }]);
    expect((await x.h.call("POST", `/api/contact-changes/${x.setId}/cancel`)).json.error).toBe("set_closed");
    expect((await approveOptions(x.h, x.setId, [x.annEdit])).json.error).toBe("set_cancelled");
  });

  test("cancel also revokes the set's live approval and holds back its approved changes", async () => {
    const { h, setId, annEdit } = await ready();
    expect((await approve(h, setId, [annEdit])).verify.status).toBe(200);
    const c = await h.call("POST", `/api/contact-changes/${setId}/cancel`);
    expect(c.json).toMatchObject({ rejected: 3, revoked_approvals: 1 });
    expect(status(h, annEdit)).toBe("rejected");
    expect((h.db.query("SELECT revoked_at FROM contact_approvals").get() as any).revoked_at).toBeTruthy();
  });
});

describe("contacts manifest and approval", () => {
  test("buildContactManifest: shape, key order, sha256 of the exact payload bytes, 24 h, compact serialisation", async () => {
    const { h, setId } = await ready();
    const changes = h.db.query("SELECT * FROM contact_changes WHERE set_id = ? AND kind = 'update' ORDER BY position").all(setId) as any[];
    const { manifest, bytes } = buildContactManifest({ rpId: "localhost", origin: "http://localhost:7477" }, setId,
      changes.map((r) => ({ id: r.id, kind: r.kind, target_macos_id: r.target_macos_id, payload_json: r.payload_json })) as any, 24, "dry", "appr-1", new Date("2026-11-10T08:00:00.000Z"));
    expect(Object.keys(manifest)).toEqual(["v", "kind", "transport", "approval_id", "set_id", "created_at", "not_after", "rp_id", "origin", "contact_items"]);
    expect(manifest).toMatchObject({ v: 1, kind: "contacts", transport: "dry", approval_id: "appr-1", set_id: setId, not_after: "2026-11-11T08:00:00.000Z" });
    expect(Object.keys(manifest.contact_items[0]!)).toEqual(["change_id", "kind", "target_macos_id", "payload_sha256"]);
    expect(manifest.contact_items[0]!.payload_sha256).toBe(sha256(Buffer.from(changes[0].payload_json, "utf8")).toString("hex"));
    expect(bytes).toBe(JSON.stringify(manifest));
    expect(bytes).not.toContain("\n");
  });

  test("options: challenge = b64u(sha256(manifest bytes)) stored with the exact bytes and the set id; payloads and display data; transport from the setting", async () => {
    const { h, setId, annEdit, benEdit, ann } = await ready();
    const r = await approveOptions(h, setId, [benEdit, annEdit]);
    expect(r.status).toBe(200);
    const row = h.db.query("SELECT * FROM webauthn_challenges WHERE id = ?").get(r.json.challenge_id) as any;
    expect(row).toMatchObject({ purpose: "approve", batch_id: setId });
    expect(row.challenge).toBe(sha256(row.manifest).toString("base64url"));
    expect(r.json.options.challenge).toBe(row.challenge);
    expect(challengeBytes(row.manifest).length).toBe(32);
    expect(JSON.parse(row.manifest)).toEqual(r.json.manifest);
    const m = r.json.manifest as ContactManifest;
    expect(m).toMatchObject({ v: 1, kind: "contacts", transport: "dry", set_id: setId, rp_id: "localhost", origin: "http://localhost:7477" });
    expect(m.contact_items.map((i) => i.change_id)).toEqual([annEdit, benEdit]); // in position order, whatever the request order
    expect(Date.parse(m.not_after) - Date.parse(m.created_at)).toBe(24 * 3600_000);
    for (const item of m.contact_items) expect(item.payload_sha256).toBe(hex(r.json.payloads[item.change_id]));
    expect(r.json.display[annEdit].before).toMatchObject({ contact_id: ann, display_name: "Ann Lee" });
    expect(r.json.pin_contacts_live_allowed).toBe(false);
    expect(h.db.query("SELECT action FROM audit_log WHERE action = 'contact_approval.options'").all()).toHaveLength(1);
    // transport comes from the setting
    h.db.query("UPDATE settings SET value = 'live' WHERE key = 'contacts_transport'").run();
    expect((await approveOptions(h, setId, [annEdit])).json.manifest.transport).toBe("live");
  });

  test("options refuse: nothing picked, a change from another set, an auto-queued create, an unknown set, no approval passkey", async () => {
    const { h, setId, create, annEdit } = await ready();
    expect((await approveOptions(h, setId, [])).status).toBe(400);
    expect((await approveOptions(h, setId, ["nope"])).status).toBe(400);
    const auto = await approveOptions(h, setId, [create]);
    expect(auto.status).toBe(409); expect(auto.json.error).toBe("change_not_approvable");
    expect(auto.json.message).toMatch(/added automatically/);
    expect((await approveOptions(h, "nope", [annEdit])).status).toBe(404);
    const other = await ready();
    expect((await approveOptions(h, other.setId, [annEdit])).status).toBe(404); // different harness DB: set unknown there
    const bare = makeHarness(); await bare.signUpLoginOnly();
    const s = proposeContactChanges(bare.db, { title: "t", created_by: "agent:x", source: "mcp", creates: [], updates: [{ contact: getContact(bare.db, seedContact(bare.db, { name: "Z Z" }))!, payload: validateUpdate({ set: { org: "Q" } }) }] });
    expect((await approveOptions(bare, s.set_id, [s.changes[0]!.id])).json.error).toBe("no_passkeys");
  });

  test("approve: the signed manifest is stored verbatim, items become approved, the set follows, the passkey counter and audit are written", async () => {
    const { h, setId, create, annEdit, benEdit } = await ready();
    const { opt, verify } = await approve(h, setId, [annEdit, benEdit]);
    expect(verify.status).toBe(200);
    expect(verify.json).toMatchObject({ ok: true, count: 2, transport: "dry", credential_id: h.auth.id, set: { id: setId, status: "approved" } });
    const row = h.db.query("SELECT * FROM contact_approvals").get() as any;
    expect(row).toMatchObject({ id: opt.json.manifest.approval_id, set_id: setId, credential_id: h.auth.id, not_after: opt.json.manifest.not_after, revoked_at: null });
    expect(row.manifest).toBe(JSON.stringify(opt.json.manifest));
    expect(row.manifest_sha256).toBe(hex(row.manifest));
    expect(JSON.parse(row.manifest).kind).toBe("contacts");
    for (const f of ["authenticator_data_b64", "client_data_json_b64", "signature_b64"]) expect(row[f]).toMatch(/^[A-Za-z0-9_-]+$/);
    // the client data's challenge is exactly sha256 of the stored manifest
    expect(JSON.parse(Buffer.from(row.client_data_json_b64, "base64url").toString()).challenge).toBe(sha256(row.manifest).toString("base64url"));
    expect([status(h, annEdit), status(h, benEdit), status(h, create)]).toEqual(["approved", "approved", "auto_queued"]);
    expect(setStatus(h, setId)).toBe("approved");
    expect((h.db.query("SELECT counter FROM passkeys WHERE credential_id = ?").get(h.auth.id) as any).counter).toBe(h.auth.counter);
    expect(h.db.query("SELECT actor, target FROM audit_log WHERE action = 'contact_approval.create'").all()).toEqual([{ actor: "owner", target: opt.json.manifest.approval_id }]);
    // approving the same changes again while the approval is live and unused is refused
    expect((await approveOptions(h, setId, [annEdit])).json.error).toBe("already_approved");
    // the detail names the covering approval
    const d = await h.call("GET", `/api/contact-changes/${setId}`);
    expect(d.json.changes.find((c: any) => c.id === annEdit).covered_by).toBe(opt.json.manifest.approval_id);
    expect(d.json.approvals).toMatchObject([{ id: opt.json.manifest.approval_id, items: 2, transport: "dry", revoked_at: null }]);
    // the send-approval table is untouched
    expect(count(h, "approvals")).toBe(0);
  });

  test("a partial approval leaves the rest in review (and the set in review); the challenge is single use", async () => {
    const { h, setId, annEdit, benEdit } = await ready();
    const { opt, verify } = await approve(h, setId, [annEdit]);
    expect(verify.status).toBe(200);
    expect([status(h, annEdit), status(h, benEdit), setStatus(h, setId)]).toEqual(["approved", "review", "review"]);
    const again = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
    expect(again.status).toBe(400); expect(again.json.error).toBe("challenge_invalid");
    expect(count(h, "contact_approvals")).toBe(1);
  });

  test("TAMPER: a payload edited after the options were built is refused, nothing is recorded, the challenge is burned", async () => {
    const { h, setId, annEdit, benEdit } = await ready();
    const opt = await approveOptions(h, setId, [annEdit, benEdit]);
    h.db.query("UPDATE contact_changes SET payload_json = ? WHERE id = ?").run(JSON.stringify({ set: { given_name: "Ann 📚" }, add_phones: [{ e164: "+15550001111", label: "mobile" }] }), annEdit);
    const v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
    expect(v.status).toBe(409);
    expect(v.json.error).toBe("contact_changed");
    expect(v.json.changed).toEqual([{ change_id: annEdit, reason: "payload_changed" }]);
    expect(count(h, "contact_approvals")).toBe(0);
    expect([status(h, annEdit), status(h, benEdit), setStatus(h, setId)]).toEqual(["review", "review", "review"]);
    expect(count(h, "webauthn_challenges")).toBe(0);
  });

  test("TAMPER: a changed kind or target, a status moved on, a deleted change or a cancelled set are all refused", async () => {
    for (const [name, tweak, code] of [
      ["target", (h: Harness, id: string) => h.db.query("UPDATE contact_changes SET target_macos_id = 'someone-else' WHERE id = ?").run(id), "contact_changed"],
      ["kind", (h: Harness, id: string) => h.db.query("UPDATE contact_changes SET kind = 'create' WHERE id = ?").run(id), "contact_changed"],
      ["rejected", (h: Harness, id: string) => h.db.query("UPDATE contact_changes SET status = 'rejected' WHERE id = ?").run(id), "change_not_approvable"],
      ["consumed", (h: Harness, id: string) => h.db.query("INSERT INTO contact_applies(id, change_id, transport, started_at) VALUES (?,?,'dry',?)").run(newId(), id, nowIso()), "change_consumed"],
    ] as const) {
      const { h, setId, annEdit } = await ready();
      const opt = await approveOptions(h, setId, [annEdit]);
      tweak(h, annEdit);
      const v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
      expect([name, v.status, v.json.error]).toEqual([name, 409, code]);
      expect([name, count(h, "contact_approvals")]).toEqual([name, 0]);
    }
    const { h, setId, annEdit } = await ready();
    const opt = await approveOptions(h, setId, [annEdit]);
    h.db.query("PRAGMA foreign_keys = OFF").run();
    h.db.query("DELETE FROM contact_changes WHERE id = ?").run(annEdit);
    const v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
    expect(v.json.error).toBe("contact_changed");
    expect(count(h, "contact_approvals")).toBe(0);
  });

  test("a stored payload that no longer validates (unknown key, bad character) can't be signed", async () => {
    const { h, setId, annEdit } = await ready();
    h.db.query("UPDATE contact_changes SET payload_json = ? WHERE id = ?").run('{"set":{"given_name":"A"},"evil":1}', annEdit);
    const r = await approveOptions(h, setId, [annEdit]);
    expect(r.status).toBe(409); expect(r.json.error).toBe("payload_invalid");
    h.db.query("UPDATE contact_changes SET payload_json = ? WHERE id = ?").run('{"set":{"given_name":"A\\u202E"}}', annEdit);
    expect((await approveOptions(h, setId, [annEdit])).json.error).toBe("payload_invalid");
  });

  test("only an approval passkey can approve: the sign-in key, a wrong challenge, a different set, and a tampered signature all fail and record nothing", async () => {
    const { h, setId, annEdit } = await ready();
    // sign-in key
    let opt = await approveOptions(h, setId, [annEdit]);
    let v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.login.assert(opt.json.options) });
    expect(v.status).toBe(401);
    // another set's id
    opt = await approveOptions(h, setId, [annEdit]);
    v = await h.call("POST", `/api/contact-changes/other-set/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
    expect(v.json.error).toBe("challenge_invalid");
    // signature over a different challenge
    opt = await approveOptions(h, setId, [annEdit]);
    v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert({ challenge: b64u(sha256("something else")) }) });
    expect(v.status).toBe(401);
    // user presence/verification missing
    opt = await approveOptions(h, setId, [annEdit]);
    v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options, { uv: false }) });
    expect(v.status).toBe(401);
    expect(count(h, "contact_approvals")).toBe(0);
    expect(status(h, annEdit)).toBe("review");
  });

  test("a contacts challenge can't finish a send approval, and a send challenge can't finish a contacts approval", async () => {
    const { h, setId, annEdit } = await ready();
    const copt = await approveOptions(h, setId, [annEdit]);
    // the same set id offered as a batch id
    const asSend = await h.call("POST", `/api/batches/${setId}/approve/verify`, { challenge_id: copt.json.challenge_id, response: h.auth.assert(copt.json.options) });
    expect(asSend.status).toBe(400); expect(asSend.json.error).toBe("challenge_invalid");
    expect(count(h, "approvals")).toBe(0); expect(count(h, "contact_approvals")).toBe(0);
    // and the other way round
    const { batchId, draftIds } = seedBatch(h.db, 1);
    const sopt = await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds });
    expect(sopt.status).toBe(200);
    const asContacts = await h.call("POST", `/api/contact-changes/${batchId}/approve/verify`, { challenge_id: sopt.json.challenge_id, response: h.auth.assert(sopt.json.options) });
    expect(asContacts.status).toBe(400);
    expect(count(h, "approvals")).toBe(0); expect(count(h, "contact_approvals")).toBe(0);
    // a real send approval still works, and a real contacts approval too
    expect((await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds })).status).toBe(200);
    expect((await approve(h, setId, [annEdit])).verify.status).toBe(200);
  });

  test("an expired approval window is refused", async () => {
    const { h, setId, annEdit } = await ready();
    const opt = await approveOptions(h, setId, [annEdit]);
    const m = JSON.parse((h.db.query("SELECT manifest FROM webauthn_challenges").get() as any).manifest);
    // a manifest already past its not_after: build one, store it as the challenge, sign it
    const past = buildContactManifest({ rpId: "localhost", origin: "http://localhost:7477" }, setId,
      [{ id: annEdit, kind: "update", target_macos_id: m.contact_items[0].target_macos_id, payload_json: opt.json.payloads[annEdit] }] as any, 24, "dry", newId(), new Date(Date.now() - 25 * 3600_000));
    const ch = b64u(challengeBytes(past.bytes));
    h.db.query("UPDATE webauthn_challenges SET manifest = ?, challenge = ?, approval_id = ? WHERE id = ?").run(past.bytes, ch, past.manifest.approval_id, opt.json.challenge_id);
    const v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert({ challenge: ch }) });
    expect(v.status).toBe(400); expect(v.json.error).toBe("approval_expired");
    expect(count(h, "contact_approvals")).toBe(0);
  });
});

describe("Stop revokes contact approvals", () => {
  test("Stop revokes the live contacts approval, returns its changes to review, and Undo-stop restores them", async () => {
    const { h, setId, annEdit, benEdit } = await ready();
    await approve(h, setId, [annEdit, benEdit]);
    expect(setStatus(h, setId)).toBe("approved");
    const s = await h.call("POST", "/api/stop");
    expect(s.json).toMatchObject({ ok: true, revoked_contact_approvals: 1, reverted_contact_changes: 2 });
    expect((h.db.query("SELECT revoked_at FROM contact_approvals").get() as any).revoked_at).toBeTruthy();
    expect([status(h, annEdit), status(h, benEdit), setStatus(h, setId)]).toEqual(["review", "review", "review"]);
    expect(h.db.query("SELECT action FROM audit_log WHERE action = 'contact_approval.revoke'").all()).toHaveLength(1);
    // the revoked approval no longer covers anything: the changes can be approved again
    expect((await approve(h, setId, [annEdit])).verify.status).toBe(200);
    expect(count(h, "contact_approvals")).toBe(2);
  });

  test("Stop undo within the window restores the contacts approval and its changes", async () => {
    const { h, setId, annEdit, benEdit } = await ready();
    await approve(h, setId, [annEdit, benEdit]);
    const s = await h.call("POST", "/api/stop");
    const u = await h.call("POST", "/api/stop/undo", { stop_id: s.json.stop_id });
    expect(u.json).toMatchObject({ ok: true, restored_contact_approvals: 1, restored_contact_changes: 2 });
    expect((h.db.query("SELECT revoked_at FROM contact_approvals").get() as any).revoked_at).toBeNull();
    // the queued auto create was held by Stop and Undo-stop does not bring it back, so the set still has one change in review
    expect([status(h, annEdit), status(h, benEdit), setStatus(h, setId)]).toEqual(["approved", "approved", "review"]);
  });

  test("Stop also holds every queued auto create: review, requires approval, note 'held by Stop', audited; an applied or started create is untouched; Resume does not put it back", async () => {
    const { h, setId, create, annEdit } = await ready();
    const other = proposeContactChanges(h.db, { title: "Other", created_by: "agent:t", source: "mcp",
      creates: [validateCreate({ given_name: "Zed", family_name: "Zimmer", phones: ["+14155550188"] }), validateCreate({ given_name: "Yan", family_name: "Young", phones: ["+14155550187"] })], updates: [] });
    expect(other.status).toBe("drafting");
    const [started, queued] = other.changes.map((c) => c.id) as [string, string];
    markApplied(h, started); // the executor already has a record for this one
    h.db.query("UPDATE contact_changes SET status = 'auto_queued' WHERE id = ?").run(started); // (still queued by status, but consumed)
    const s = await h.call("POST", "/api/stop");
    expect(s.json).toMatchObject({ ok: true, held_contact_creates: 2 });
    for (const id of [create, queued]) {
      expect(h.db.query("SELECT status, requires_approval, note, kind FROM contact_changes WHERE id = ?").get(id)).toEqual({ status: "review", requires_approval: 1, note: "held by Stop", kind: "create" });
    }
    expect(status(h, started)).toBe("auto_queued"); // consumed rows are the executor's
    expect(setStatus(h, setId)).toBe("review");
    expect(setStatus(h, other.set_id)).toBe("review"); // was 'drafting'
    const a = h.db.query("SELECT details_json FROM audit_log WHERE action = 'contact_changes.hold'").all() as any[];
    expect(a).toHaveLength(1);
    expect(JSON.parse(a[0].details_json)).toMatchObject({ count: 2 });
    // Resume leaves them in review; the owner approves them from Changes if wanted
    await h.call("POST", "/api/resume");
    expect(status(h, create)).toBe("review");
    expect(status(h, queued)).toBe("review");
    const ok = await approve(h, setId, [create, annEdit]);
    expect(ok.verify.status).toBe(200);
    expect(status(h, create)).toBe("approved");
    // Stop with nothing queued reports 0
    expect((await h.call("POST", "/api/stop")).json.held_contact_creates).toBe(0);
  });

  test("a change the executor already consumed is not dragged back to review by Stop", async () => {
    const { h, setId, annEdit, benEdit } = await ready();
    await approve(h, setId, [annEdit, benEdit]);
    markApplied(h, annEdit);
    const s = await h.call("POST", "/api/stop");
    expect(s.json.reverted_contact_changes).toBe(1);
    expect([status(h, annEdit), status(h, benEdit)]).toEqual(["applied", "review"]);
  });
});

describe("undo", () => {
  test("undo of an applied create and an applied edit makes ONE new set, source 'undo', with kind='undo' rows in review and ContactUndoPayloads", async () => {
    const { h, setId, create, annEdit, ann } = await ready();
    markApplied(h, create, { result_macos_id: "mac-created-1", fingerprint: "a".repeat(64) });
    markApplied(h, annEdit, { fingerprint: "b".repeat(64), vcard: "BEGIN:VCARD\nFN:Ann Lee\nEND:VCARD" });
    const u = await h.call("POST", "/api/contact-changes/undo", { change_ids: [create, annEdit] });
    expect(u.status).toBe(200);
    expect(u.json.sets).toHaveLength(1);
    const undoSet = h.db.query("SELECT * FROM contact_change_sets WHERE id = ?").get(u.json.set_id) as any;
    expect(undoSet).toMatchObject({ title: "Undo: Book club members", source: "undo", status: "review", created_by: "owner" });
    const rows = h.db.query("SELECT * FROM contact_changes WHERE set_id = ? ORDER BY position").all(u.json.set_id) as any[];
    expect(rows.map((r) => [r.kind, r.status, r.requires_approval, r.undo_of])).toEqual([["undo", "review", 1, create], ["undo", "review", 1, annEdit]]);
    expect(rows[0]).toMatchObject({ target_macos_id: "mac-created-1" }); // a create: the contact that was made
    expect(JSON.parse(rows[0].payload_json)).toEqual({ undo_of: create, undo_kind: "create", before_vcard_sha256: null, after_fingerprint: "a".repeat(64) });
    expect(rows[1]).toMatchObject({ target_contact_id: ann });
    expect(rows[1].target_macos_id).toBe((h.db.query("SELECT macos_id FROM contacts WHERE id = ?").get(ann) as any).macos_id); // an edit: the card that was edited
    expect(JSON.parse(rows[1].payload_json)).toEqual({ undo_of: annEdit, undo_kind: "update", before_vcard_sha256: hex("BEGIN:VCARD\nFN:Ann Lee\nEND:VCARD"), after_fingerprint: "b".repeat(64) });
    // nothing was applied or approved by asking for an undo
    expect(count(h, "contact_approvals")).toBe(0);
    expect(status(h, annEdit)).toBe("applied");
    expect(h.db.query("SELECT action, actor FROM audit_log WHERE action = 'contact_changes.undo_request'").all()).toEqual([{ action: "contact_changes.undo_request", actor: "owner" }]);
    // the detail of the original set says an undo is waiting
    const d = await h.call("GET", `/api/contact-changes/${setId}`);
    expect(d.json.changes.find((c: any) => c.id === annEdit).undo_blocked).toMatch(/already waiting/);
    // and the undo set shows what it reverses
    const ud = await h.call("GET", `/api/contact-changes/${u.json.set_id}`);
    expect(ud.json.changes[1].original).toMatchObject({ kind: "update", status: "applied", payload: { set: { given_name: "Ann 📚" } } });
  });

  test("undo is only for applied creates and edits the executor has a record for, once; all or nothing", async () => {
    const { h, create, annEdit, benEdit } = await ready();
    const asked = async (ids: string[]) => h.call("POST", "/api/contact-changes/undo", { change_ids: ids });
    // not applied
    const r1 = await asked([annEdit]);
    expect(r1.status).toBe(409); expect(r1.json.error).toBe("not_undoable"); expect(r1.json.problems[0].reason).toMatch(/review, not applied/);
    // 'applied' but no contact_applies row (the status alone proves nothing)
    h.db.query("UPDATE contact_changes SET status = 'applied', transport = 'live', after_fingerprint = ?, before_vcard = 'v' WHERE id = ?").run("c".repeat(64), annEdit);
    expect((await asked([annEdit])).json.problems[0].reason).toMatch(/no record of applying/);
    // an applied edit without its pre-change snapshot (live) can't be restored
    markApplied(h, benEdit, { vcard: null });
    expect((await asked([benEdit])).json.problems[0].reason).toMatch(/snapshot/);
    // an applied live create without a fingerprint
    markApplied(h, create, { result_macos_id: "mac-1", fingerprint: null });
    expect((await asked([create])).json.problems[0].reason).toMatch(/fingerprint/);
    // all or nothing: one good + one bad makes nothing
    h.db.query("UPDATE contact_changes SET after_fingerprint = ? WHERE id = ?").run("d".repeat(64), create);
    const mixed = await asked([create, benEdit]);
    expect(mixed.status).toBe(409);
    expect(count(h, "contact_change_sets")).toBe(1);
    // a good one works once, then an undo is already waiting
    expect((await asked([create])).status).toBe(200);
    expect((await asked([create])).json.problems[0].reason).toMatch(/already waiting/);
    // nonsense
    expect((await asked(["nope"])).status).toBe(404);
    expect((await asked([])).status).toBe(400);
    // an undone change can't be undone again
    h.db.query("UPDATE contact_changes SET status = 'undone' WHERE id = ?").run(create);
    expect((await asked([create])).json.problems[0].reason).toMatch(/already undone/);
  });

  test("a dry change can be undone (log only) when the executor recorded a fingerprint, with or without a snapshot; without a fingerprint the undo is refused", async () => {
    const { h, annEdit, benEdit } = await ready();
    markApplied(h, annEdit, { transport: "dry", fingerprint: "a".repeat(64), vcard: null });
    const u = await h.call("POST", "/api/contact-changes/undo", { change_ids: [annEdit] });
    expect(u.status).toBe(200);
    expect(JSON.parse((h.db.query("SELECT payload_json FROM contact_changes WHERE kind = 'undo'").get() as any).payload_json)).toEqual({ undo_of: annEdit, undo_kind: "update", before_vcard_sha256: null, after_fingerprint: "a".repeat(64) });
    markApplied(h, benEdit, { transport: "dry", fingerprint: null, vcard: null }); // a record from before the executor always wrote one
    const no = await h.call("POST", "/api/contact-changes/undo", { change_ids: [benEdit] });
    expect(no.status).toBe(409); expect(no.json.error).toBe("not_undoable");
    expect(no.json.message).toMatch(/no fingerprint/);
    expect(count(h, "contact_change_sets")).toBe(2); // no new set was made for it
  });

  test("an undo of a change that went in LIVE is signed live even while the setting is dry (and shows why); it needs the pin's contacts_live_allowed, else 409", async () => {
    const { h, setId, annEdit, benEdit } = await ready();
    markApplied(h, annEdit, { transport: "live", fingerprint: "b".repeat(64), vcard: "s1" });
    markApplied(h, benEdit, { transport: "dry", fingerprint: "c".repeat(64), vcard: "s2" });
    expect(getSettings(h.db).contacts_transport).toBe("dry");
    const dryUndo = await h.call("POST", "/api/contact-changes/undo", { change_ids: [benEdit] });
    const liveUndo = await h.call("POST", "/api/contact-changes/undo", { change_ids: [annEdit] });
    const idOf = (setId: string) => (h.db.query("SELECT id FROM contact_changes WHERE set_id = ?").get(setId) as any).id;
    // an undo of a dry change stays dry
    const d = await approveOptions(h, dryUndo.json.set_id, [idOf(dryUndo.json.set_id)]);
    expect(d.status).toBe(200);
    expect(d.json.manifest.transport).toBe("dry"); expect(d.json.live_reason).toBeNull();
    // an undo of a live change: refused until the installed pin allows live contact changes
    const noPin = await approveOptions(h, liveUndo.json.set_id, [idOf(liveUndo.json.set_id)]);
    expect(noPin.status).toBe(409); expect(noPin.json.error).toBe("pin_not_contacts_live_allowed");
    expect(noPin.json.message).toMatch(/undoes changes that were made live/); expect(noPin.json.message).toMatch(/Allow live contact changes/);
    installPin(h, { live_allowed: true }); // sending allowed, contacts not
    expect((await approveOptions(h, liveUndo.json.set_id, [idOf(liveUndo.json.set_id)])).status).toBe(409);
    installPin(h, { live_allowed: false, contacts_live_allowed: true });
    const l = await approve(h, liveUndo.json.set_id, [idOf(liveUndo.json.set_id)]);
    expect(l.opt.json.manifest.transport).toBe("live");
    expect(l.opt.json.live_reason).toBe("undo_of_live");
    expect(l.opt.json.pin_contacts_live_allowed).toBe(true);
    expect(l.verify.json.transport).toBe("live");
    expect(JSON.parse((h.db.query("SELECT manifest FROM contact_approvals").get() as any).manifest).transport).toBe("live");
    // with the setting itself live, an undo of a dry change is live because of the setting: no special reason
    h.db.query("UPDATE settings SET value = 'live' WHERE key = 'contacts_transport'").run();
    const viaSetting = await approveOptions(h, dryUndo.json.set_id, [idOf(dryUndo.json.set_id)]);
    expect(viaSetting.json.manifest.transport).toBe("live"); expect(viaSetting.json.live_reason).toBeNull();
  });

  test("undo changes from two sets make two undo sets", async () => {
    const a = await ready();
    const second = proposeContactChanges(a.h.db, { title: "Second", created_by: "agent:t", source: "mcp", creates: [], updates: [{ contact: getContact(a.h.db, a.ann)!, payload: validateUpdate({ add_groups: ["X"] }) }] });
    markApplied(a.h, a.annEdit, { vcard: "v1" });
    markApplied(a.h, second.changes[0]!.id, { vcard: "v2" });
    const u = await a.h.call("POST", "/api/contact-changes/undo", { change_ids: [a.annEdit, second.changes[0]!.id] });
    expect(u.json.sets).toHaveLength(2);
    expect(count(a.h, "contact_change_sets")).toBe(4);
  });

  test("an undo set is approved like any other (Touch ID, contacts manifest); the signature binds the snapshot: if the original's fingerprint moves, signing is refused", async () => {
    const { h, annEdit } = await ready();
    markApplied(h, annEdit, { transport: "dry", fingerprint: "b".repeat(64), vcard: "snapshot-1" });
    const u = await h.call("POST", "/api/contact-changes/undo", { change_ids: [annEdit] });
    const undoId = (h.db.query("SELECT id FROM contact_changes WHERE kind = 'undo'").get() as any).id;
    const { opt, verify } = await approve(h, u.json.set_id, [undoId]);
    expect(verify.status).toBe(200);
    expect(opt.json.manifest.contact_items[0]).toMatchObject({ change_id: undoId, kind: "undo" });
    expect(opt.json.display[undoId].original).toMatchObject({ kind: "update" });
    expect(status(h, undoId)).toBe("approved");

    const y = await ready();
    markApplied(y.h, y.annEdit, { transport: "dry", fingerprint: "b".repeat(64), vcard: "snapshot-1" });
    const u2 = await y.h.call("POST", "/api/contact-changes/undo", { change_ids: [y.annEdit] });
    const undo2 = (y.h.db.query("SELECT id FROM contact_changes WHERE kind = 'undo'").get() as any).id;
    const o2 = await approveOptions(y.h, u2.json.set_id, [undo2]);
    y.h.db.query("UPDATE contact_changes SET after_fingerprint = ? WHERE id = ?").run("e".repeat(64), y.annEdit);
    const v2 = await y.h.call("POST", `/api/contact-changes/${u2.json.set_id}/approve/verify`, { challenge_id: o2.json.challenge_id, response: y.h.auth.assert(o2.json.options) });
    expect(v2.status).toBe(409); expect(v2.json.error).toBe("undo_mismatch");
    expect(count(y.h, "contact_approvals")).toBe(0);
    // an undo whose original is no longer applied is refused at options time
    y.h.db.query("UPDATE contact_changes SET status = 'undone' WHERE id = ?").run(y.annEdit);
    expect((await approveOptions(y.h, u2.json.set_id, [undo2])).json.error).toBe("undo_target_gone");
  });
});

describe("contacts transport and the pin's contacts_live_allowed", () => {
  test("pin policy: the candidate carries contacts_live_allowed (saved on tick); leaving it out keeps it; old payloads and old pins keep working", async () => {
    const { h } = await ready();
    expect((await h.call("GET", "/api/pin-policy")).json.policy).toEqual({ live_allowed: false, contacts_live_allowed: false });
    const put = await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: true, reauth: await h.reauth() });
    expect(put.status).toBe(200);
    expect(put.json.policy).toEqual({ live_allowed: false, contacts_live_allowed: true });
    const cand = JSON.parse((await Bun.file(join(h.dir, "passkeys.json")).text()));
    expect(cand.policy).toEqual({ live_allowed: false, contacts_live_allowed: true });
    // a PUT without the field keeps it
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: await h.reauth() })).json.policy).toEqual({ live_allowed: true, contacts_live_allowed: true });
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true, contacts_live_allowed: false })).json.policy).toEqual({ live_allowed: true, contacts_live_allowed: false });
    for (const bad of [{ live_allowed: true, contacts_live_allowed: "yes" }, { live_allowed: true, contacts_live: true }, { contacts_live_allowed: true }]) {
      expect((await h.call("PUT", "/api/pin-policy", bad)).status).toBe(400);
    }
    // the audit trail has the setting
    expect(h.db.query("SELECT details_json FROM audit_log WHERE action = 'pin_policy.set' ORDER BY id").all().map((r: any) => JSON.parse(r.details_json))).toContainEqual({ live_allowed: false, contacts_live_allowed: true });
  });

  test("status reports pin_contacts_live_allowed from the INSTALLED pin; an old pin without the field is fine and means false", async () => {
    const { h } = await ready();
    let s = (await h.call("GET", "/api/status")).json;
    expect(s).toMatchObject({ contacts_transport: "dry", pin_contacts_live_allowed: false });
    expect(s.counts).toMatchObject({ contact_sets_review: 1, contact_changes_review: 2 });
    installPin(h, { live_allowed: true }); // a pin from before v4
    s = (await h.call("GET", "/api/status")).json;
    expect(s.pin.root).toMatchObject({ live_allowed: true, contacts_live_allowed: false });
    expect(s.pin.root.policy).toEqual({ live_allowed: true });
    expect(s.pin_contacts_live_allowed).toBe(false);
    installPin(h, { live_allowed: false, contacts_live_allowed: true });
    s = (await h.call("GET", "/api/status")).json;
    expect(s.pin_contacts_live_allowed).toBe(true);
    expect(s.pin.root).toMatchObject({ live_allowed: false, contacts_live_allowed: true });
    // a non-boolean value never counts
    installPin(h, { live_allowed: false, contacts_live_allowed: "true" });
    expect((await h.call("GET", "/api/status")).json.pin_contacts_live_allowed).toBe(false);
  });

  test("going live: needs the installed pin's contacts_live_allowed (409 with the way forward), then a fresh sign-in assertion; back to dry needs nothing", async () => {
    const { h, setId, annEdit } = await ready();
    const noPin = await h.call("PATCH", "/api/settings", { contacts_transport: "live", reauth: await h.reauth() });
    expect(noPin.status).toBe(409); expect(noPin.json.error).toBe("pin_not_contacts_live_allowed");
    expect(noPin.json.message).toMatch(/Allow live contact changes/);
    installPin(h, { live_allowed: true }); // sending allowed, contacts not
    expect((await h.call("PATCH", "/api/settings", { contacts_transport: "live", reauth: await h.reauth() })).json.error).toBe("pin_not_contacts_live_allowed");
    installPin(h, { live_allowed: false, contacts_live_allowed: true });
    const noAuth = await h.call("PATCH", "/api/settings", { contacts_transport: "live" });
    expect(noAuth.status).toBe(403); expect(noAuth.json.error).toBe("reauth_required");
    expect(getSettings(h.db).contacts_transport).toBe("dry");
    const ok = await h.call("PATCH", "/api/settings", { contacts_transport: "live", reauth: await h.reauth() });
    expect(ok.status).toBe(200);
    expect(ok.json.settings).toMatchObject({ contacts_transport: "live", transport: "dry" });
    expect(h.db.query("SELECT action, details_json FROM audit_log WHERE action = 'setting.set' AND target = 'contacts_transport'").all()).toEqual([{ action: "setting.set", details_json: '{"value":"live"}' }]);
    // the manifest now asks for live, and the options say whether the pin allows it
    const o = await approveOptions(h, setId, [annEdit]);
    expect(o.json.manifest.transport).toBe("live");
    expect(o.json.pin_contacts_live_allowed).toBe(true);
    // a sign-in assertion can't be replayed, and an approve key can't do it
    const re = await h.reauth();
    expect((await h.call("PATCH", "/api/settings", { contacts_transport: "dry" })).json.settings.contacts_transport).toBe("dry");
    expect((await h.call("PATCH", "/api/settings", { contacts_transport: "live", reauth: { challenge_id: re.challenge_id, response: h.auth.assert({ challenge: "x" }) } })).status).toBe(401);
    expect((await h.call("PATCH", "/api/settings", { contacts_transport: "sideways" })).status).toBe(400);
  });

  test("going live for sending and for contacts in one request needs only one assertion", async () => {
    const { h } = await ready();
    installPin(h, { live_allowed: true, contacts_live_allowed: true });
    const r = await h.call("PATCH", "/api/settings", { transport: "live", contacts_transport: "live", reauth: await h.reauth() });
    expect(r.status).toBe(200);
    expect(r.json.settings).toMatchObject({ transport: "live", contacts_transport: "live" });
  });

  test("the manifest transport is whatever the setting was WHEN THE OPTIONS WERE BUILT, and the executor ignores the setting for a signed manifest", async () => {
    const { h, setId, annEdit } = await ready();
    const o = await approveOptions(h, setId, [annEdit]);
    h.db.query("UPDATE settings SET value = 'live' WHERE key = 'contacts_transport'").run(); // flipped after options
    const v = await h.call("POST", `/api/contact-changes/${setId}/approve/verify`, { challenge_id: o.json.challenge_id, response: h.auth.assert(o.json.options) });
    expect(v.json.transport).toBe("dry");
    expect(JSON.parse((h.db.query("SELECT manifest FROM contact_approvals").get() as any).manifest).transport).toBe("dry");
  });
});
