import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, challengeBytes } from "./approval";
import { makeHarness, seedBatch, SoftSe, type Harness } from "./testkit";
import { getDrafts, updateDraftBody } from "../core/store";
import { getSettings } from "../core/store";

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest();

/** Writes the "installed" root pin (the harness's rootPinFile) for the h.auth key. */
function installPin(h: Harness, o: { live_allowed?: boolean; v?: number; extraKeys?: any[]; keys?: any[]; policy?: any } = {}) {
  mkdirSync(join(h.dir, "root"), { recursive: true });
  const pin: any = { v: o.v ?? 4,
    keys: o.keys ?? [{ kind: "secure-enclave", credential_id: h.auth.id, x963: h.auth.x963b64, label: "Test approve" }, ...(o.extraKeys ?? [])],
    policy: o.policy ?? { live_allowed: o.live_allowed ?? false, contacts_live_allowed: false } };
  const path = join(h.dir, "root", "passkeys.json");
  writeFileSync(path, JSON.stringify(pin));
  return path;
}

async function ready(n = 3) {
  const h = makeHarness();
  await h.signUp();
  const seed = seedBatch(h.db, n);
  return { h, ...seed };
}
async function options(h: Harness, batchId: string, ids: string[], hours?: number) {
  return h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: ids, ...(hours ? { not_after_hours: hours } : {}) });
}
const seBody = (h: Harness, opt: any, o: Parameters<SoftSe["signOptions"]>[1] = {}) => h.auth.signOptions(opt.json, o);
async function approve(h: Harness, batchId: string, ids: string[]) {
  const opt = await options(h, batchId, ids);
  expect(opt.status).toBe(200);
  const verify = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, seBody(h, opt));
  return { opt, verify };
}

describe("manifest", () => {
  test("buildManifest: shape, key order, hashing of bodies, create_contact payload, fixed rp_id/origin", async () => {
    const { h, batchId } = await ready();
    const drafts = getDrafts(h.db, batchId);
    const { manifest, bytes } = buildManifest(batchId, drafts, 24, "dry", "appr-1", new Date("2026-11-10T08:00:00.000Z"));
    expect(Object.keys(manifest)).toEqual(["v", "transport", "approval_id", "batch_id", "created_at", "not_after", "rp_id", "origin", "items"]);
    expect(manifest.v).toBe(2); expect(manifest.transport).toBe("dry");
    expect(manifest.rp_id).toBe("agent-outbox"); expect(manifest.origin).toBe("agent-outbox:app");
    expect(manifest.not_after).toBe("2026-11-11T08:00:00.000Z");
    expect(Object.keys(manifest.items[0]!)).toEqual(["draft_id", "to", "service", "body_sha256", "name", "create_contact"]);
    expect(manifest.items[0]!.body_sha256).toBe(sha256(drafts[0]!.body).toString("hex"));
    expect(manifest.items[0]!.create_contact).toBeNull();
    expect(manifest.items[1]!.create_contact).toMatchObject({ given_name: "Person" });
    expect(bytes).toBe(JSON.stringify(manifest)); // compact, no whitespace
    expect(bytes).not.toContain("\n");
    expect(manifest.items[0]!.body_sha256).toBe(createHash("sha256").update(Buffer.from(drafts[0]!.body, "utf8")).digest("hex"));
  });

  test("options: the stored challenge is the base64url of sha256(manifest bytes), kept with the exact bytes, 5 min expiry; no WebAuthn options", async () => {
    const { h, batchId, draftIds } = await ready();
    const r = await options(h, batchId, draftIds.slice(0, 2));
    expect(r.status).toBe(200);
    const row = h.db.query<any, [string]>("SELECT * FROM owner_challenges WHERE id = ?").get(r.json.challenge_id)!;
    expect(row).toMatchObject({ kind: "send", target: batchId, approval_id: r.json.manifest.approval_id, action: null });
    const expected = sha256(row.manifest).toString("base64url");   // Buffer's own base64url
    expect(row.challenge).toBe(expected);
    expect(challengeBytes(row.manifest).length).toBe(32);
    expect(JSON.parse(row.manifest)).toEqual(r.json.manifest);
    expect(r.json.manifest_bytes).toBe(row.manifest);
    expect(r.json.options).toBeUndefined();
    expect(r.json.se).toMatchObject({ tag: "send", key_ids: [h.auth.id] });
    expect(r.json.manifest.items).toHaveLength(2);
    expect(r.json.drafts.map((d: any) => d.draft_id)).toEqual(draftIds.slice(0, 2));
    const ttl = Date.parse(row.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000); expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });

  test("a software-signed approval is accepted; the approval row stores the signature and empty WebAuthn fields", async () => {
    const { h, batchId, draftIds } = await ready();
    const { opt, verify } = await approve(h, batchId, draftIds.slice(0, 2));
    expect(verify.status).toBe(200);
    const ap = h.db.query<any, []>("SELECT * FROM approvals").get()!;
    expect(ap.id).toBe(opt.json.manifest.approval_id);
    expect(ap.manifest).toBe(JSON.stringify(opt.json.manifest)); // exact bytes
    expect(ap.manifest_sha256).toBe(sha256(ap.manifest).toString("hex"));
    expect(ap.credential_id).toBe(h.auth.id);
    expect(ap.authenticator_data_b64).toBe(""); expect(ap.client_data_json_b64).toBe("");
    expect(ap.batch_id).toBe(batchId);
    expect(ap.revoked_at).toBeNull();
    const ds = getDrafts(h.db, batchId);
    expect(ds.map((d) => d.status)).toEqual(["approved", "approved", "review"]);
    expect(h.db.query<any, []>("SELECT status FROM batches").get()!.status).toBe("approved");
    expect(h.db.query<any, []>("SELECT action FROM audit_log WHERE action = 'approval.create'").all()).toHaveLength(1);
  });

  test("not_after is a fixed 24 h; a client-sent not_after_hours is ignored", async () => {
    const { h, batchId, draftIds } = await ready();
    for (const hours of [undefined, 72, 1, 500]) {
      const d = await options(h, batchId, [draftIds[0]!], hours);
      expect(d.status).toBe(200);
      expect((Date.parse(d.json.manifest.not_after) - Date.parse(d.json.manifest.created_at)) / 3600_000).toBe(24);
      expect(d.json.queue).toBeUndefined(); expect(d.json.sent_today).toBeUndefined();
    }
  });
});

describe("approval refusals", () => {
  test("verify rejects when a draft was edited after options (tampered draft), and nothing is recorded", async () => {
    const { h, batchId, draftIds } = await ready();
    const opt = await options(h, batchId, draftIds);
    updateDraftBody(h.db, draftIds[1]!, "Totally different text", "agent");
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, seBody(h, opt));
    expect(v.status).toBe(409); expect(v.json.error).toBe("draft_changed");
    expect(v.json.changed).toEqual([{ draft_id: draftIds[1], reason: "body_changed" }]);
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(0);
    expect(getDrafts(h.db, batchId).every((d) => d.status === "review")).toBe(true);
  });

  test("verify rejects changed handle, service and create_contact", async () => {
    for (const [sql, reason] of [
      ["UPDATE drafts SET handle = '+19998887777' WHERE id = ?", "handle_changed"],
      ["UPDATE drafts SET service = 'SMS' WHERE id = ?", "service_changed"],
      ["UPDATE drafts SET create_contact = 0 WHERE id = ?", "contact_changed"],
    ] as const) {
      const { h, batchId, draftIds } = await ready();
      const opt = await options(h, batchId, draftIds);
      h.db.query(sql).run(draftIds[1]!);
      const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, seBody(h, opt));
      expect(v.status).toBe(409);
      expect(v.json.changed[0].reason).toBe(reason);
    }
  });

  test("a challenge can be used once (reuse after success and after failure)", async () => {
    const { h, batchId, draftIds } = await ready();
    const opt = await options(h, batchId, draftIds);
    const body = seBody(h, opt);
    const first = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, body);
    expect(first.status).toBe(200);
    const again = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, body);
    expect(again.status).toBe(400); expect(again.json.error).toBe("challenge_invalid");
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(1);

    // a failed attempt also burns the challenge
    const { h: h2, batchId: b2, draftIds: d2 } = await ready();
    const o2 = await options(h2, b2, d2);
    const bad = await h2.call("POST", `/api/batches/${b2}/approve/se-verify`, { ...seBody(h2, o2), signature: h2.auth.sign("send", sha256("other")) });
    expect(bad.status).toBe(401);
    const retry = await h2.call("POST", `/api/batches/${b2}/approve/se-verify`, seBody(h2, o2));
    expect(retry.status).toBe(400);
    expect(h2.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(0);
  });

  test("an expired challenge is refused", async () => {
    const { h, batchId, draftIds } = await ready();
    const opt = await options(h, batchId, draftIds);
    h.db.query("UPDATE owner_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, seBody(h, opt));
    expect(v.status).toBe(400); expect(v.json.error).toBe("challenge_expired");
  });

  test("a signature over a different digest or tag, the wrong key, an unknown key and extra fields are all refused", async () => {
    const stranger = new SoftSe();
    const cases: [string, (h: Harness, o: any) => any, number][] = [
      ["other digest", (h, o) => ({ ...seBody(h, o), signature: h.auth.sign("send", sha256("something else")) }), 401],
      ["wrong tag", (h, o) => ({ ...seBody(h, o), signature: h.auth.sign("contacts", sha256(o.json.manifest_bytes)) }), 401],
      ["wrong key signs", (h, o) => seBody(h, o, { signWith: stranger.privateKey }), 401],
      ["unknown credential", (h, o) => stranger.signOptions(o.json), 401],
      ["legacy webauthn fields", (h, o) => ({ challenge_id: o.json.challenge_id, response: {} }), 400],
    ];
    for (const [name, make, status] of cases) {
      const { h, batchId, draftIds } = await ready();
      const opt = await options(h, batchId, draftIds);
      const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, make(h, opt));
      expect([name, v.status]).toEqual([name, status]);
      expect(h.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(0);
      expect(getDrafts(h.db, batchId).some((d) => d.status === "approved")).toBe(false);
    }
  });

  test("a challenge for batch A can't approve batch B", async () => {
    const { h, batchId, draftIds } = await ready();
    const other = seedBatch(h.db, 1, "other");
    const opt = await options(h, batchId, draftIds);
    const v = await h.call("POST", `/api/batches/${other.batchId}/approve/se-verify`, seBody(h, opt));
    expect(v.status).toBe(400);
  });

  test("drafts already in an unconsumed approval are refused; a rejected/sent draft is refused; an edited one is free again", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, [draftIds[0]!]);
    const again = await options(h, batchId, [draftIds[0]!]);
    expect(again.status).toBe(409);
    h.db.query("UPDATE drafts SET status = 'review' WHERE id = ?").run(draftIds[0]!);
    const drift = await options(h, batchId, [draftIds[0]!]);
    expect(drift.status).toBe(409); expect(drift.json.error).toBe("already_approved");
    updateDraftBody(h.db, draftIds[0]!, "edited", "owner");
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(200);
    h.db.query("UPDATE drafts SET status = 'rejected' WHERE id = ?").run(draftIds[2]!);
    expect((await options(h, batchId, [draftIds[2]!])).status).toBe(409);
    h.db.query("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draftIds[2]!);
    expect((await options(h, batchId, [draftIds[2]!])).status).toBe(409);
  });

  test("failed and skipped drafts can be approved again; failed drafts under a live approval can't until it's consumed", async () => {
    const { h, batchId, draftIds } = await ready();
    h.db.query("UPDATE drafts SET status = 'skipped' WHERE id = ?").run(draftIds[2]!);
    expect((await options(h, batchId, [draftIds[2]!])).status).toBe(200);
    const { verify } = await approve(h, batchId, [draftIds[0]!]);
    expect(verify.status).toBe(200);
    const apId = verify.json.approval_id as string;
    h.db.query("UPDATE drafts SET status = 'failed' WHERE id = ?").run(draftIds[0]!);
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(409); // exec will retry inside the same approval
    for (let i = 1; i <= 3; i++) h.db.query("INSERT INTO sends(id, draft_id, approval_id, attempt, transport, started_at, result) VALUES (?,?,?,?,?,?,?)").run(`s${i}`, draftIds[0]!, apId, i, "dry", new Date().toISOString(), "failed");
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(200); // 3 failures: consumed
  });

  test("validation: unknown draft id, empty selection, drafting and cancelled batches, empty body", async () => {
    const { h, batchId, draftIds } = await ready();
    expect((await options(h, batchId, ["nope"])).status).toBe(400);
    expect((await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: [] })).status).toBe(400);
    h.db.query("UPDATE drafts SET body = '   ' WHERE id = ?").run(draftIds[0]!);
    expect((await options(h, batchId, [draftIds[0]!])).json.error).toBe("draft_empty");
    h.db.query("UPDATE batches SET status = 'drafting'").run();
    expect((await options(h, batchId, [draftIds[1]!])).json.error).toBe("batch_drafting");
    h.db.query("UPDATE batches SET status = 'cancelled'").run();
    expect((await options(h, batchId, [draftIds[1]!])).json.error).toBe("batch_cancelled");
    expect((await options(h, "missing", [draftIds[1]!])).status).toBe(404);
  });

  test("approval endpoints need the app token", async () => {
    const { h, batchId, draftIds } = await ready();
    expect((await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds }, { token: null })).status).toBe(401);
  });
});

describe("stop, skip, cancel", () => {
  test("stop sets the kill switch, revokes unconsumed approvals, returns approved drafts to review and kills pending challenges", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, draftIds.slice(0, 2));
    const pending = await options(h, batchId, [draftIds[2]!]);
    expect(pending.status).toBe(200);
    const r = await h.call("POST", "/api/stop", {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kill_switch: true, revoked_approvals: 1, reverted_drafts: 2 });
    expect(getSettings(h.db).kill_switch).toBe(true);
    expect(h.db.query<any, []>("SELECT revoked_at FROM approvals").get()!.revoked_at).toBeTruthy();
    expect(getDrafts(h.db, batchId).map((d) => d.status)).toEqual(["review", "review", "review"]);
    expect(h.db.query<any, []>("SELECT status FROM batches").get()!.status).toBe("review");
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM owner_challenges WHERE kind IN ('send','contacts')").get()!.n).toBe(0);
    const late = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, seBody(h, pending));
    expect(late.status).toBe(400);
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(200);
    expect((await h.call("POST", "/api/resume", {})).json.kill_switch).toBe(false);
    expect(getSettings(h.db).kill_switch).toBe(false);
  });

  test("stop needs the app token but no Touch ID", async () => {
    const { h } = await ready();
    expect((await h.call("POST", "/api/stop", {}, { token: null })).status).toBe(401);
    expect((await h.call("POST", "/api/stop", {})).status).toBe(200);
  });

  test("skipping an approved draft revokes its approval and reverts the others", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, draftIds);
    const r = await h.call("POST", `/api/drafts/${draftIds[1]}/skip`, {});
    expect(r.status).toBe(200); expect(r.json.revoked_approvals).toBe(1);
    expect(getDrafts(h.db, batchId).map((d) => d.status)).toEqual(["review", "skipped", "review"]);
    expect(h.db.query<any, []>("SELECT revoked_at FROM approvals").get()!.revoked_at).toBeTruthy();
    expect((await h.call("POST", `/api/drafts/${draftIds[1]}/include`, {})).status).toBe(200);
  });

  test("cancelling a batch revokes approvals, rejects open drafts and drops its pending challenges", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, [draftIds[0]!]);
    await options(h, batchId, [draftIds[1]!]);
    const r = await h.call("POST", `/api/batches/${batchId}/cancel`, {});
    expect(r.status).toBe(200);
    expect(getDrafts(h.db, batchId).every((d) => d.status === "rejected")).toBe(true);
    expect(h.db.query<any, []>("SELECT status FROM batches").get()!.status).toBe("cancelled");
    expect(h.db.query<any, []>("SELECT revoked_at FROM approvals").get()!.revoked_at).toBeTruthy();
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM owner_challenges").get()!.n).toBe(0);
    expect((await h.call("POST", `/api/batches/${batchId}/cancel`, {})).status).toBe(409);
  });
});

describe("drafts, settings, status", () => {
  test("PATCH draft: body edit makes a revision and bumps the version; an approved draft drops back to review", async () => {
    const { h, batchId, draftIds } = await ready();
    const r = await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { body: "New text" });
    expect(r.status).toBe(200);
    expect(r.json.draft).toMatchObject({ body: "New text", version: 2, status: "review" });
    expect(h.db.query<any, []>("SELECT actor FROM draft_revisions WHERE version = 2").get()!.actor).toBe("owner");
    await approve(h, batchId, [draftIds[0]!]);
    const e = await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { body: "Newer text" });
    expect(e.json.draft.status).toBe("review");
    expect((await h.call("PATCH", `/api/drafts/${draftIds[0]}`, {})).status).toBe(400);
    expect((await h.call("PATCH", `/api/drafts/${draftIds[1]}`, { service: "SMS", create_contact: false })).json.draft).toMatchObject({ service: "SMS", create_contact: false });
    expect((await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { create_contact: true })).status).toBe(400); // no proposed contact
    h.db.query("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draftIds[2]!);
    expect((await h.call("PATCH", `/api/drafts/${draftIds[2]}`, { body: "x" })).status).toBe(409);
  });

  test("settings: validation, partial update, live needs a fresh Touch ID confirmation", async () => {
    const { h } = await ready();
    expect((await h.call("GET", "/api/settings")).json.settings.transport).toBe("dry");
    expect((await h.call("PATCH", "/api/settings", { breaker_on_failure: false })).json.settings).toMatchObject({ breaker_on_failure: false });
    for (const k of [{ daily_cap: 80 }, { pace_min_s: 60 }, { quiet_start: "22:00" }, { timezone: "UTC" }, { burst_size_max: 3 }]) {
      expect((await h.call("PATCH", "/api/settings", k)).status).toBe(400);
    }
    expect(Object.keys((await h.call("GET", "/api/settings")).json.settings).sort()).toEqual(["breaker_on_failure", "contacts_transport", "kill_reason", "kill_switch", "pacing", "transport"]);
    expect((await h.call("PATCH", "/api/settings", { kill_switch: true })).status).toBe(400); // only via stop/resume
    // going live needs live_allowed in the INSTALLED pin...
    const noPin = await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: await h.reauth("mode_live") });
    expect(noPin.status).toBe(409); expect(noPin.json.error).toBe("pin_not_live_allowed");
    installPin(h, { live_allowed: false });
    expect((await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: await h.reauth("mode_live") })).json.error).toBe("pin_not_live_allowed");
    installPin(h, { live_allowed: true });
    // ...and then a fresh confirmation
    const noKey = await h.call("PATCH", "/api/settings", { transport: "live" });
    expect(noKey.status).toBe(403); expect(noKey.json.error).toBe("reauth_required");
    expect(getSettings(h.db).transport).toBe("dry");
    const live = await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: await h.reauth("mode_live") });
    expect(live.status).toBe(200); expect(live.json.settings.transport).toBe("live");
    expect((await h.call("PATCH", "/api/settings", { transport: "dry" })).json.settings.transport).toBe("dry");
    expect((await h.call("PATCH", "/api/settings", { transport: "live", reauth: { challenge_id: "x", response: {} } })).status).toBe(400);
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM audit_log WHERE action = 'setting.set'").get()!.n).toBeGreaterThanOrEqual(3);
  });

  test("a reauth confirmation can't be replayed", async () => {
    const { h } = await ready();
    installPin(h, { live_allowed: true });
    const re = await h.reauth("mode_live");
    expect((await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: re })).status).toBe(200);
    await h.call("PATCH", "/api/settings", { transport: "dry" });
    expect((await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: re })).status).toBe(400);
  });

  test("status: no removed fields; pin file presence and validity (uid 0, not group/other writable), exec heartbeat age", async () => {
    const { h } = await ready();
    let s = (await h.call("GET", "/api/status")).json;
    for (const gone of ["rp_id", "origin", "port", "passkeys", "passkey_purposes"]) expect(s[gone]).toBeUndefined();
    expect(s.pin.root.present).toBe(false);
    expect(s.pin.root.valid).toBe(false);
    expect(s.pin.candidate.present).toBe(true);
    expect(s.exec).toBeNull();
    expect(s.pin.expected_keys.map((k: any) => ({ credential_id: k.credential_id, label: k.label, kind: k.kind }))).toEqual([{ credential_id: h.auth.id, label: "Test approve", kind: "secure-enclave" }]);
    const path = installPin(h, { live_allowed: true });
    chmodSync(path, 0o664);
    s = (await h.call("GET", "/api/status")).json;
    expect(s.pin.root).toMatchObject({ present: true, valid: false, mode: "664", matches_keys: true, version: 4, live_allowed: true, unexpected_keys: [] });
    expect(s.pin.root.policy).toEqual({ live_allowed: true, contacts_live_allowed: false });
    expect(s.pin.root.problems.join(" ")).toContain("not root");
    expect(s.pin.root.problems.join(" ")).toContain("writable by group or others");
    h.db.query("INSERT INTO exec_status(id, heartbeat_at, version, transport, pin_file_ok) VALUES (1,?,?,?,?)")
      .run(new Date(Date.now() - 12_000).toISOString(), "0.1", "dry", 0);
    s = (await h.call("GET", "/api/status")).json;
    expect(s.exec.heartbeat_age_s).toBeGreaterThanOrEqual(12);
    expect(s.exec.alive).toBe(true);
    expect(s.counts.sent_today).toBeUndefined();
  });

  test("status flags pinned keys that aren't active keys (a stranger, a revoked key) and count mismatches; reports the installed policy", async () => {
    const { h } = await ready();
    const stranger = new SoftSe();
    installPin(h, { extraKeys: [{ kind: "secure-enclave", credential_id: stranger.id, x963: stranger.x963b64, label: "stranger" }] });
    const s = (await h.call("GET", "/api/status")).json;
    expect(s.pin.root.unexpected_keys.map((k: any) => k.label)).toEqual(["stranger"]);
    const probs = s.pin.root.problems.join(" | ");
    expect(probs).toContain("Unexpected key in pinned file");
    expect(probs).toContain("lists 2 keys, but you have 1 active approval key");
    expect(s.pin.root.matches_keys).toBe(true);
    expect(s.pin.root.valid).toBe(false);
    // a missing key
    installPin(h, { keys: [] });
    expect((await h.call("GET", "/api/status")).json.pin.root.matches_keys).toBe(false);
    // an old v1 pin: version message, no policy, never live
    installPin(h, { v: 1 });
    const v1 = (await h.call("GET", "/api/status")).json.pin.root;
    expect(v1.version).toBe(1); expect(v1.live_allowed).toBe(false);
    expect(v1.problems.join(" ")).toContain("holds browser passkeys");
  });

  test("batches list and detail", async () => {
    const { h, batchId, draftIds } = await ready();
    const list = (await h.call("GET", "/api/batches")).json.batches;
    expect(list[0]).toMatchObject({ id: batchId, total: 3, new_contacts: 1, counts: { review: 3 } });
    const d = (await h.call("GET", `/api/batches/${batchId}`)).json;
    expect(d.drafts.map((x: any) => x.id)).toEqual(draftIds);
    expect(Object.keys(d.settings).sort()).toEqual(["breaker_on_failure", "contacts_transport", "kill_reason", "kill_switch", "pacing", "transport"]);
    expect(d.queue).toBeUndefined(); expect(d.sent_today).toBeUndefined();
    expect((await h.call("GET", "/api/batches?status=done")).json.batches).toHaveLength(0);
  });

  test("contacts search and activity paging", async () => {
    const { h } = await ready();
    h.db.query("INSERT INTO contacts(id, source, display_name, given_name, family_name, phones_json, updated_at) VALUES ('c1','manual','Sam Lee','Sam','Lee','[]','2026-01-01T00:00:00Z')").run();
    h.db.query("INSERT INTO contact_handles(handle, contact_id) VALUES ('+15551234567','c1')").run();
    expect((await h.call("GET", "/api/contacts?q=sam")).json.contacts.map((c: any) => c.id)).toEqual(["c1"]);
    expect((await h.call("GET", "/api/contacts?q=555-123")).json.contacts.map((c: any) => c.id)).toEqual(["c1"]);
    expect((await h.call("GET", "/api/contacts?q=zzz")).json.contacts).toEqual([]);
    const a = (await h.call("GET", "/api/activity?limit=2")).json;
    expect(a.audit.length).toBe(2); expect(a.next.audit_before).toBeTruthy();
  });

  test("no SPA and no static files: non-/api paths are 404 not_found, even with the token", async () => {
    const { h } = await ready();
    for (const p of ["/", "/some/deep/route", "/assets/a.js", "/..%2Fsecret.txt", "/index.html"]) {
      const r = await h.request(p);
      expect([p, r.status]).toEqual([p, 404]);
      expect((await r.json()).error).toBe("not_found");
    }
    writeFileSync(join(h.dir, "secret.txt"), "nope");
    expect(readFileSync(join(h.dir, "secret.txt"), "utf8")).toBe("nope");
  });
});
