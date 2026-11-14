import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, challengeBytes } from "./approval";
import { b64u } from "./b64";
import { makeHarness, seedBatch, SoftAuthenticator, type Harness } from "./testkit";
import { getDrafts, updateDraftBody } from "../core/store";
import { getSettings } from "../core/store";
import { DEFAULT_PIN_POLICY } from "../core/types";

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest();

/** Writes the "installed" root pin (the harness's rootPinFile) for the h.auth approve key. */
function installPin(h: Harness, o: { live_allowed?: boolean; v?: number; extraKeys?: any[]; policy?: any } = {}) {
  mkdirSync(join(h.dir, "root"), { recursive: true });
  const pin: any = { v: o.v ?? 2, rp_id: "localhost", origin: "http://localhost:7477",
    keys: [{ credential_id: h.auth.id, x963: h.auth.x963.toString("base64url"), label: "Test approve" }, ...(o.extraKeys ?? [])] };
  if ((o.v ?? 2) === 2) pin.policy = o.policy ?? { ...DEFAULT_PIN_POLICY, live_allowed: o.live_allowed ?? false };
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
async function approve(h: Harness, batchId: string, ids: string[], o: Parameters<SoftAuthenticator["assert"]>[1] = {}) {
  const opt = await options(h, batchId, ids);
  expect(opt.status).toBe(200);
  const verify = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options, o) });
  return { opt, verify };
}

describe("manifest", () => {
  test("buildManifest: shape, key order, hashing of bodies, create_contact payload", async () => {
    const { h, batchId } = await ready();
    const drafts = getDrafts(h.db, batchId);
    const { manifest, bytes } = buildManifest({ rpId: "localhost", origin: "http://localhost:7477" }, batchId, drafts, 24, "dry", "appr-1", new Date("2026-11-10T08:00:00.000Z"));
    expect(Object.keys(manifest)).toEqual(["v", "transport", "approval_id", "batch_id", "created_at", "not_after", "rp_id", "origin", "items"]);
    expect(manifest.v).toBe(2); expect(manifest.transport).toBe("dry");
    expect(manifest.not_after).toBe("2026-11-11T08:00:00.000Z");
    expect(Object.keys(manifest.items[0]!)).toEqual(["draft_id", "to", "service", "body_sha256", "name", "create_contact"]);
    expect(manifest.items[0]!.body_sha256).toBe(sha256(drafts[0]!.body).toString("hex"));
    expect(manifest.items[0]!.create_contact).toBeNull();
    expect(manifest.items[1]!.create_contact).toMatchObject({ given_name: "Person" });
    expect(bytes).toBe(JSON.stringify(manifest)); // compact, no whitespace
    expect(bytes).not.toContain("\n");
    // unicode body hashes the UTF-8 bytes
    expect(manifest.items[0]!.body_sha256).toBe(createHash("sha256").update(Buffer.from(drafts[0]!.body, "utf8")).digest("hex"));
  });

  test("options: challenge is the base64url of sha256(manifest bytes), stored with the exact bytes, 5 min expiry", async () => {
    const { h, batchId, draftIds } = await ready();
    const r = await options(h, batchId, draftIds.slice(0, 2));
    expect(r.status).toBe(200);
    const row = h.db.query<any, [string]>("SELECT * FROM webauthn_challenges WHERE id = ?").get(r.json.challenge_id)!;
    expect(row.purpose).toBe("approve");
    // independent recomputation (Buffer's own base64url, not the library's)
    const expected = sha256(row.manifest).toString("base64url");
    expect(r.json.options.challenge).toBe(expected);
    expect(row.challenge).toBe(expected);
    expect(Buffer.from(r.json.options.challenge, "base64url")).toHaveLength(32);
    expect(Buffer.from(r.json.options.challenge, "base64url").equals(sha256(row.manifest))).toBe(true);
    expect(challengeBytes(row.manifest).length).toBe(32);
    expect(JSON.parse(row.manifest)).toEqual(r.json.manifest);
    expect(r.json.manifest.rp_id).toBe("localhost");
    expect(r.json.manifest.origin).toBe("http://localhost:7477");
    expect(r.json.manifest.items).toHaveLength(2);
    expect(r.json.options.userVerification).toBe("required");
    expect(r.json.drafts.map((d: any) => d.draft_id)).toEqual(draftIds.slice(0, 2));
    const ttl = Date.parse(row.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000); expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });

  test("the real verifyAuthenticationResponse accepts a software-signed assertion; approval row stores raw browser fields", async () => {
    const { h, batchId, draftIds } = await ready();
    const { opt, verify } = await approve(h, batchId, draftIds.slice(0, 2));
    expect(verify.status).toBe(200);
    const ap = h.db.query<any, []>("SELECT * FROM approvals").get()!;
    expect(ap.id).toBe(opt.json.manifest.approval_id);
    expect(ap.manifest).toBe(JSON.stringify(opt.json.manifest)); // exact bytes
    expect(ap.manifest_sha256).toBe(sha256(ap.manifest).toString("hex"));
    expect(ap.credential_id).toBe(h.auth.id);
    expect(ap.batch_id).toBe(batchId);
    expect(ap.revoked_at).toBeNull();
    // clientDataJSON stored verbatim and its challenge equals the manifest hash
    const cd = JSON.parse(Buffer.from(ap.client_data_json_b64, "base64url").toString());
    expect(cd.type).toBe("webauthn.get"); expect(cd.origin).toBe("http://localhost:7477");
    expect(cd.challenge).toBe(sha256(ap.manifest).toString("base64url"));
    expect(ap.authenticator_data_b64).not.toContain("=");
    expect(Buffer.from(ap.authenticator_data_b64, "base64url").subarray(0, 32).equals(sha256("localhost"))).toBe(true);
    // states
    const ds = getDrafts(h.db, batchId);
    expect(ds.map((d) => d.status)).toEqual(["approved", "approved", "review"]);
    expect(h.db.query<any, []>("SELECT status FROM batches").get()!.status).toBe("approved");
    expect(h.db.query<any, []>("SELECT action FROM audit_log WHERE action = 'approval.create'").all()).toHaveLength(1);
    // the stored signature really verifies over authData || sha256(clientDataJSON) with the x963 key (what Swift does)
    const { createPublicKey, verify: cverify } = await import("node:crypto");
    const x963 = h.auth.x963;
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(x963.subarray(1, 33)), y: b64u(x963.subarray(33)) }, format: "jwk" });
    const data = Buffer.concat([Buffer.from(ap.authenticator_data_b64, "base64url"), sha256(Buffer.from(ap.client_data_json_b64, "base64url"))]);
    expect(cverify("sha256", data, key, Buffer.from(ap.signature_b64, "base64url"))).toBe(true);
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
    // an agent / the owner changes a body after the sheet was opened
    updateDraftBody(h.db, draftIds[1]!, "Totally different text", "agent");
    const v = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
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
      const v = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
      expect(v.status).toBe(409);
      expect(v.json.changed[0].reason).toBe(reason);
    }
  });

  test("a challenge can be used once (reuse after success and after failure)", async () => {
    const { h, batchId, draftIds } = await ready();
    const opt = await options(h, batchId, draftIds);
    const resp = h.auth.assert(opt.json.options);
    const first = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: resp });
    expect(first.status).toBe(200);
    const again = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: resp });
    expect(again.status).toBe(400); expect(again.json.error).toBe("challenge_invalid");
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(1);

    // a failed attempt also burns the challenge
    const { h: h2, batchId: b2, draftIds: d2 } = await ready();
    const o2 = await options(h2, b2, d2);
    const bad = await h2.call("POST", `/api/batches/${b2}/approve/verify`, { challenge_id: o2.json.challenge_id, response: h2.auth.assert(o2.json.options, { uv: false }) });
    expect(bad.status).toBe(401);
    const retry = await h2.call("POST", `/api/batches/${b2}/approve/verify`, { challenge_id: o2.json.challenge_id, response: h2.auth.assert(o2.json.options) });
    expect(retry.status).toBe(400);
    expect(h2.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(0);
  });

  test("an expired challenge is refused", async () => {
    const { h, batchId, draftIds } = await ready();
    const opt = await options(h, batchId, draftIds);
    h.db.query("UPDATE webauthn_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const v = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
    expect(v.status).toBe(400); expect(v.json.error).toBe("challenge_expired");
  });

  test("a signature over a different challenge, wrong origin, wrong rpId, wrong key and missing UV are all refused", async () => {
    const cases: [string, (h: Harness, o: any) => any][] = [
      ["other challenge", (h, o) => h.auth.assert({ challenge: b64u(sha256("something else")) })],
      ["wrong origin", (h, o) => h.auth.assert(o, { origin: "https://evil.example" })],
      ["wrong rp id", (h, o) => h.auth.assert(o, { rpId: "evil.example" })],
      ["no UV", (h, o) => h.auth.assert(o, { uv: false })],
      ["wrong type", (h, o) => h.auth.assert(o, { type: "webauthn.create" })],
      ["wrong key", (h, o) => h.auth.assert(o, { signWith: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey })],
      ["unknown credential", (h, o) => new SoftAuthenticator("localhost", "http://localhost:7477").assert(o)],
    ];
    for (const [name, make] of cases) {
      const { h, batchId, draftIds } = await ready();
      const opt = await options(h, batchId, draftIds);
      const v = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: make(h, opt.json.options) });
      expect([name, v.status]).toEqual([name, 401]);
      expect(h.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(0);
      expect(getDrafts(h.db, batchId).some((d) => d.status === "approved")).toBe(false);
    }
  });

  test("a challenge for batch A can't approve batch B", async () => {
    const { h, batchId, draftIds } = await ready();
    const other = seedBatch(h.db, 1, "other");
    const opt = await options(h, batchId, draftIds);
    const v = await h.call("POST", `/api/batches/${other.batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
    expect(v.status).toBe(400);
  });

  test("drafts already in an unconsumed approval are refused; a rejected/sent draft is refused; an edited one is free again", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, [draftIds[0]!]);
    // status is now approved
    const again = await options(h, batchId, [draftIds[0]!]);
    expect(again.status).toBe(409);
    // status drift: row says review but the signed approval still matches -> still refused
    h.db.query("UPDATE drafts SET status = 'review' WHERE id = ?").run(draftIds[0]!);
    const drift = await options(h, batchId, [draftIds[0]!]);
    expect(drift.status).toBe(409); expect(drift.json.error).toBe("already_approved");
    // editing changes the hash, so it no longer matches the old approval: free to approve again
    updateDraftBody(h.db, draftIds[0]!, "edited", "owner");
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(200);
    // consumed approval (sent) -> not covered, but status 'sent' is refused anyway
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

  test("approval endpoints need a session and the CSRF header", async () => {
    const { h, batchId, draftIds } = await ready();
    expect((await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds }, { cookie: null })).status).toBe(401);
    expect((await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds }, { csrf: false })).status).toBe(403);
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
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM webauthn_challenges WHERE purpose='approve'").get()!.n).toBe(0);
    const late = await h.call("POST", `/api/batches/${batchId}/approve/verify`, { challenge_id: pending.json.challenge_id, response: h.auth.assert(pending.json.options) });
    expect(late.status).toBe(400);
    // revoked approvals don't block re-approval
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(200);
    expect((await h.call("POST", "/api/resume", {})).json.kill_switch).toBe(false);
    expect(getSettings(h.db).kill_switch).toBe(false);
  });

  test("stop needs a session but no passkey", async () => {
    const { h } = await ready();
    expect((await h.call("POST", "/api/stop", {}, { cookie: null })).status).toBe(401);
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

  test("cancelling a batch revokes approvals and rejects open drafts", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, [draftIds[0]!]);
    const r = await h.call("POST", `/api/batches/${batchId}/cancel`, {});
    expect(r.status).toBe(200);
    expect(getDrafts(h.db, batchId).every((d) => d.status === "rejected")).toBe(true);
    expect(h.db.query<any, []>("SELECT status FROM batches").get()!.status).toBe("cancelled");
    expect(h.db.query<any, []>("SELECT revoked_at FROM approvals").get()!.revoked_at).toBeTruthy();
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

  test("settings: validation, partial update, live needs a fresh passkey assertion", async () => {
    const { h } = await ready();
    expect((await h.call("GET", "/api/settings")).json.settings.transport).toBe("dry");
    expect((await h.call("PATCH", "/api/settings", { breaker_on_failure: false })).json.settings).toMatchObject({ breaker_on_failure: false });
    // the removed pacing, cap and quiet-hours settings are unknown keys now
    for (const k of [{ daily_cap: 80 }, { pace_min_s: 60 }, { quiet_start: "22:00" }, { timezone: "UTC" }, { burst_size_max: 3 }]) {
      expect((await h.call("PATCH", "/api/settings", k)).status).toBe(400);
    }
    expect(Object.keys((await h.call("GET", "/api/settings")).json.settings).sort()).toEqual(["breaker_on_failure", "contacts_transport", "kill_reason", "kill_switch", "transport"]);
    expect((await h.call("PATCH", "/api/settings", { kill_switch: true })).status).toBe(400); // only via stop/resume
    // going live needs live_allowed in the INSTALLED pin...
    const noPin = await h.call("PATCH", "/api/settings", { transport: "live", reauth: await h.reauth() });
    expect(noPin.status).toBe(409); expect(noPin.json.error).toBe("pin_not_live_allowed");
    installPin(h, { live_allowed: false });
    expect((await h.call("PATCH", "/api/settings", { transport: "live", reauth: await h.reauth() })).json.error).toBe("pin_not_live_allowed");
    installPin(h, { live_allowed: true });
    // ...and then a fresh sign-in assertion
    const noKey = await h.call("PATCH", "/api/settings", { transport: "live" });
    expect(noKey.status).toBe(403); expect(noKey.json.error).toBe("reauth_required");
    expect(getSettings(h.db).transport).toBe("dry");
    const live = await h.call("PATCH", "/api/settings", { transport: "live", reauth: await h.reauth() });
    expect(live.status).toBe(200); expect(live.json.settings.transport).toBe("live");
    expect((await h.call("PATCH", "/api/settings", { transport: "dry" })).json.settings.transport).toBe("dry");
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM audit_log WHERE action = 'setting.set'").get()!.n).toBeGreaterThanOrEqual(3);
  });

  test("a reauth assertion can't be replayed", async () => {
    const { h } = await ready();
    installPin(h, { live_allowed: true });
    const re = await h.reauth();
    expect((await h.call("PATCH", "/api/settings", { transport: "live", reauth: re })).status).toBe(200);
    await h.call("PATCH", "/api/settings", { transport: "dry" });
    expect((await h.call("PATCH", "/api/settings", { transport: "live", reauth: re })).status).toBe(400);
  });

  test("status: pin file presence and validity (uid 0, not group/other writable), exec heartbeat age", async () => {
    const { h } = await ready();
    let s = (await h.call("GET", "/api/status")).json;
    expect(s.pin.root.present).toBe(false);
    expect(s.pin.root.valid).toBe(false);
    expect(s.pin.candidate.present).toBe(true);
    expect(s.exec).toBeNull();
    expect(s.passkey_purposes).toEqual({ login: 1, approve: 1 });
    expect(s.pin.expected_keys).toEqual([{ credential_id: h.auth.id, label: "Test approve" }]);
    // a pin file owned by us (not root) and group-writable is invalid, with reasons
    const path = installPin(h, { live_allowed: true });
    chmodSync(path, 0o664);
    s = (await h.call("GET", "/api/status")).json;
    expect(s.pin.root).toMatchObject({ present: true, valid: false, mode: "664", matches_passkeys: true, version: 2, live_allowed: true, unexpected_keys: [] });
    expect(s.pin.root.policy).toEqual({ live_allowed: true, contacts_live_allowed: false });
    expect(s.pin.root.problems.join(" ")).toContain("not root");
    expect(s.pin.root.problems.join(" ")).toContain("writable by group or others");
    // heartbeat
    h.db.query("INSERT INTO exec_status(id, heartbeat_at, version, transport, pin_file_ok) VALUES (1,?,?,?,?)")
      .run(new Date(Date.now() - 12_000).toISOString(), "0.1", "dry", 0);
    s = (await h.call("GET", "/api/status")).json;
    expect(s.exec.heartbeat_age_s).toBeGreaterThanOrEqual(12);
    expect(s.exec.alive).toBe(true);
    expect(s.counts.sent_today).toBeUndefined();
  });

  test("status flags pinned keys that aren't approve passkeys (the login key, a stranger) and count mismatches; reports the installed policy", async () => {
    const { h } = await ready();
    const stranger = new SoftAuthenticator("localhost", "http://localhost:7477");
    installPin(h, { extraKeys: [{ credential_id: h.login.id, x963: h.login.x963.toString("base64url"), label: "login key" }, { credential_id: stranger.id, x963: stranger.x963.toString("base64url"), label: "stranger" }] });
    const s = (await h.call("GET", "/api/status")).json;
    expect(s.pin.root.unexpected_keys.map((k: any) => k.label)).toEqual(["login key", "stranger"]);
    const probs = s.pin.root.problems.join(" | ");
    expect(probs).toContain("Unexpected key in pinned file");
    expect(probs).toContain("lists 3 keys, but you have 1 approval key");
    expect(s.pin.root.matches_passkeys).toBe(true);
    expect(s.pin.root.valid).toBe(false);
    // a missing approve key
    const path = join(h.dir, "root", "passkeys.json");
    const pin = JSON.parse(readFileSync(path, "utf8")); pin.keys = [pin.keys[1]]; writeFileSync(path, JSON.stringify(pin));
    expect((await h.call("GET", "/api/status")).json.pin.root.matches_passkeys).toBe(false);
    // an old v1 pin has no policy and never allows live
    installPin(h, { v: 1 });
    const v1 = (await h.call("GET", "/api/status")).json.pin.root;
    expect(v1.version).toBe(1); expect(v1.policy).toBeNull(); expect(v1.live_allowed).toBe(false);
    expect(v1.problems.join(" ")).toContain("version 1");
  });

  test("batches list and detail", async () => {
    const { h, batchId, draftIds } = await ready();
    const list = (await h.call("GET", "/api/batches")).json.batches;
    expect(list[0]).toMatchObject({ id: batchId, total: 3, new_contacts: 1, counts: { review: 3 } });
    const d = (await h.call("GET", `/api/batches/${batchId}`)).json;
    expect(d.drafts.map((x: any) => x.id)).toEqual(draftIds);
    expect(Object.keys(d.settings).sort()).toEqual(["breaker_on_failure", "contacts_transport", "kill_reason", "kill_switch", "transport"]);
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

  test("serves the SPA with fallback and refuses path traversal", async () => {
    const { h } = await ready();
    expect((await h.request("/")).status).toBe(503); // not built in this temp dir
    mkdirSync(join(h.dir, "dist", "assets"), { recursive: true });
    writeFileSync(join(h.dir, "dist", "index.html"), "<html>spa</html>");
    writeFileSync(join(h.dir, "dist", "assets", "a.js"), "x");
    writeFileSync(join(h.dir, "secret.txt"), "nope");
    expect(await (await h.request("/")).text()).toContain("spa");
    expect(await (await h.request("/some/deep/route")).text()).toContain("spa");
    expect((await h.request("/assets/a.js")).headers.get("cache-control")).toContain("immutable");
    expect(await (await h.request("/..%2Fsecret.txt")).text()).toContain("spa");
    expect(await (await h.request("/%2e%2e/secret.txt")).text()).not.toContain("nope");
  });
});
