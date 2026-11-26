// Native (Secure Enclave) approval and enrolment: server side. A software P-256 key stands in for the SE (same x963 + DER wire format).
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync, readFileSync, statSync, utimesSync, chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { b64u } from "./b64";
import { fingerprint, parseX963, seMessage, verifySe } from "./native";
import { RecoveryToken } from "./recovery";
import { SetupToken } from "./setup-token";
import { makeHarness, seedBatch, SoftSe, type Harness } from "./testkit";
import { setSetting } from "../core/store";
import { proposeContactChanges, validateCreate } from "../core/contact-changes";

const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();
const enrollSig = (se: SoftSe, challenge: string): string => se.sign("enroll", sha256(Buffer.concat([Buffer.from(challenge, "base64url"), se.x963])));

async function seOptions(h: Harness, batchId: string, ids: string[]) {
  return h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: ids });
}
async function ready(n = 2) {
  const h = makeHarness();
  await h.signUp();
  return { h, se: h.auth, ...seedBatch(h.db, n) };
}
/** Adds a second key to a harness that already has one (se_reauth proof). */
async function addSecond(h: Harness): Promise<SoftSe> {
  const se2 = new SoftSe();
  const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64 });
  const v = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: enrollSig(se2, o.json.challenge), se_reauth: await h.reauth("native_key_add", o.json.key_id) });
  expect(v.status).toBe(200);
  return se2;
}

describe("signature format (shared test vector with the Swift app)", () => {
  // The same vector is in app/Tests/NativeApprovalTests (SigVectors): message bytes and a DER signature that both sides must accept.
  const V = {
    x963: "BFHlp5qxwVq3HzGnr6jrgUNQICOdJ8fmdfJXhiW64Kc4WQmYWYXTj9nhlEL7SZu0HenfZz1lwc1ysetD4oDKrhg",
    manifest: '{"v":2,"transport":"dry","approval_id":"appr-vector","batch_id":"batch-vector","items":[]}',
    send: { msg: "6167656e742d6f7574626f782f73652f76310073656e6400a80a78d142246407219263b202c371b810d02515693fd0a10c8dbe9a252180b3", sig: "MEUCIB1dt6LwbsdKFdV1Qnykwn86us8hojw1TEICZjWGLkhrAiEAlcvT0QUZdg8HShBx9UU352FOlMMzxENbYdx3471nXqY" },
    contacts: { msg: "6167656e742d6f7574626f782f73652f763100636f6e746163747300a80a78d142246407219263b202c371b810d02515693fd0a10c8dbe9a252180b3", sig: "MEYCIQCy4HRIYB5jt8gLh-bXaO0suCjB-w8WxrRuMfdG-4rKJQIhALaUhosPGCd-KbVi81W59zIJXsCegFeLkI-jEKC0KIVp" },
  };
  test("seMessage layout and the vector's signatures verify; wrong tag/message does not", () => {
    const digest = sha256(V.manifest);
    const x = parseX963(V.x963)!;
    expect(x).not.toBeNull();
    for (const tag of ["send", "contacts"] as const) {
      expect(seMessage(tag, digest).toString("hex")).toBe(V[tag].msg);
      expect(verifySe(x, seMessage(tag, digest), Buffer.from(V[tag].sig, "base64url"))).toBe(true);
    }
    expect(verifySe(x, seMessage("contacts", digest), Buffer.from(V.send.sig, "base64url"))).toBe(false);
    expect(verifySe(x, Buffer.from(V.manifest), Buffer.from(V.send.sig, "base64url"))).toBe(false);
    expect(verifySe(x, digest, Buffer.from(V.send.sig, "base64url"))).toBe(false);
    expect(() => seMessage("send", Buffer.alloc(31))).toThrow();
  });
  test("fingerprint is 5 groups of 4 upper-case hex of sha256(x963)[0..10]; parseX963 rejects bad points", () => {
    const x = parseX963(V.x963)!;
    expect(fingerprint(x)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    expect(fingerprint(x).replaceAll("-", "").toLowerCase()).toBe(sha256(x).subarray(0, 10).toString("hex"));
    expect(parseX963("AAAA")).toBeNull();
    const bad = Buffer.from(x); bad[10] = bad[10]! ^ 0xff;                // off the curve
    expect(parseX963(b64u(bad))).toBeNull();
    const comp = Buffer.from(x); comp[0] = 0x02;
    expect(parseX963(b64u(comp))).toBeNull();
  });
});

describe("enrolment", () => {
  test("first run: setup token + possession proof activates the key, deletes the token, sets setup_done and writes a v4 pin", async () => {
    const h = makeHarness();
    expect(existsSync(join(h.dir, "setup-token"))).toBe(true);
    const st0 = (await h.call("GET", "/api/status")).json;
    expect(st0.setup).toEqual({ done: false, proof_available: "setup_token", recovery_expires_at: null });
    const se = h.auth;
    const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se.x963b64, label: "This Mac (Touch ID)" });
    expect(o.json.proof).toBe("setup_token");
    expect(o.json.key_id).toBe(se.id); expect(o.json.fingerprint).toBe(fingerprint(se.x963));
    const v = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: enrollSig(se, o.json.challenge), setup_token: h.setupToken });
    expect(v.status).toBe(200); expect(v.json).toEqual({ status: "active" });
    expect(existsSync(join(h.dir, "setup-token"))).toBe(false);
    expect(h.setup.active).toBe(false);
    expect(h.db.query("SELECT value FROM settings WHERE key = 'setup_done'").get()).toEqual({ value: "1" });
    expect((await h.call("GET", "/api/status")).json.setup).toEqual({ done: true, proof_available: "se_reauth", recovery_expires_at: null });
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.v).toBe(4);
    expect(pin.keys).toEqual([{ kind: "secure-enclave", credential_id: se.id, x963: se.x963b64, label: "This Mac (Touch ID)" }]);
    const keys = await h.call("GET", "/api/native-keys");
    expect(keys.json.keys[0]).toMatchObject({ key_id: se.id, status: "active", in_effective_pin: true });
    expect((await h.call("GET", "/api/status")).json.native).toEqual({ keys_active: 1, approve_in_app: true, pin_needs_update: false });
  });

  test("a wrong/missing setup token, a bad possession signature, a duplicate key and a second first-run all fail", async () => {
    const h = makeHarness();
    const se = new SoftSe();
    const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 });
    const good = enrollSig(se, o.json.challenge);
    const bad = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: good, setup_token: b64u(randomBytes(32)) });
    expect(bad.status).toBe(403); expect(bad.json.error).toBe("setup_token_invalid");
    const none = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: good });
    expect(none.status).toBe(403); expect(none.json.error).toBe("proof_required");
    expect(none.json.message).toContain("agent-outbox recover");
    // signature by another key (possession): refused
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: enrollSig(new SoftSe(), o.json.challenge).replace(/.$/, "A"), setup_token: h.setupToken })).status).toBe(401);
    const forged = new SoftSe().sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: forged, setup_token: h.setupToken })).status).toBe(401);
    // wrong tag over the right bytes
    const wrongTag = se.sign("send", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: wrongTag, setup_token: h.setupToken })).status).toBe(401);
    // same public key twice -> 409
    expect((await h.call("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 })).status).toBe(409);
    // garbage key
    expect((await h.call("POST", "/api/native-keys/enroll/options", { x963: "AAAA" })).status).toBe(400);
    // good proof now works, and a second key can no longer use the (deleted) setup token
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: good, setup_token: h.setupToken })).status).toBe(200);
    const se2 = new SoftSe();
    const o2 = await h.call("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64 });
    expect(o2.json.proof).toBe("se_reauth");
    const sig2 = enrollSig(se2, o2.json.challenge);
    const r = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o2.json.key_id, signature: sig2, setup_token: h.setupToken });
    expect(r.status).toBe(403); expect(r.json.error).toBe("setup_token_invalid");
    const r2 = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o2.json.key_id, signature: sig2 });
    expect(r2.status).toBe(403); expect(r2.json.error).toBe("proof_required");
  });

  test("a stray setup token after setup is done can't enrol (setup_done is stored, revoking every key doesn't reopen first run)", async () => {
    const { h, se } = await ready(1);
    expect((await h.call("POST", `/api/native-keys/${se.id}/revoke`, {})).status).toBe(200);
    expect((await h.call("GET", "/api/status")).json.setup).toEqual({ done: true, proof_available: null, recovery_expires_at: null });
    const se2 = new SoftSe();
    const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64 });
    expect(o.json.proof).toBeNull();
    const v = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: enrollSig(se2, o.json.challenge), setup_token: h.setupToken });
    expect(v.status).toBe(403); expect(v.json.error).toBe("setup_token_invalid");
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: enrollSig(se2, o.json.challenge) })).json.error).toBe("proof_required");
  });

  test("an additional key with an active SE key needs an se_reauth bound to native_key_add AND that exact pending key", async () => {
    const { h, se } = await ready(1);
    const se2 = new SoftSe();
    const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64 });
    const sig = enrollSig(se2, o.json.challenge);
    // wrong action
    const wrongAction = await h.reauth("mode_live");
    const bad = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: wrongAction });
    expect(bad.status).toBe(400);
    // right action, but for another pending key (target mismatch): refused, and the challenge is burnt
    const se3 = new SoftSe();
    const o3 = await h.call("POST", "/api/native-keys/enroll/options", { x963: se3.x963b64 });
    const forOther = await h.reauth("native_key_add", o3.json.key_id);
    const mismatch = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: forOther });
    expect(mismatch.status).toBe(400); expect(mismatch.json.error).toBe("challenge_invalid");
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o3.json.key_id, signature: enrollSig(se3, o3.json.challenge), se_reauth: forOther })).status).toBe(400);
    // a native_key_add challenge made without a target is refused at options time; a target on another action too
    expect((await h.call("POST", "/api/native-keys/reauth/options", { action: "native_key_add" })).status).toBe(400);
    expect((await h.call("POST", "/api/native-keys/reauth/options", { action: "mode_live", target: o.json.key_id })).status).toBe(400);
    expect((await h.call("POST", "/api/native-keys/reauth/options", { action: "passkey_add" })).status).toBe(400);
    expect((await h.call("POST", "/api/native-keys/reauth/options", { action: "browser_link" })).status).toBe(400);
    expect((await h.call("POST", "/api/native-keys/reauth/options", { action: "native_key_add", target: "nope" })).json.error).toBe("enroll_invalid");
    // the pending key itself can't vouch for itself (it is not active)
    const self = await h.call("POST", "/api/native-keys/reauth/options", { action: "native_key_add", target: o.json.key_id });
    const selfSig = { challenge_id: self.json.challenge_id, key_id: se2.id, signature: se2.sign("reauth", sha256(Buffer.from(self.json.challenge, "base64url"))) };
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: selfSig })).status).toBe(401);
    // right action and target
    const good = await h.reauth("native_key_add", o.json.key_id);
    const v = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: good });
    expect(v.status).toBe(200); expect(v.json.status).toBe("active");
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.keys.map((k: any) => k.credential_id).sort()).toEqual([se.id, se2.id].sort());
  });

  test("a pending key expires after 10 minutes", async () => {
    const h = makeHarness();
    const se = new SoftSe();
    const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 });
    h.db.query("UPDATE native_keys SET enroll_expires_at = ? WHERE key_id = ?").run(new Date(Date.now() - 1000).toISOString(), se.id);
    const r = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: se.id, signature: enrollSig(se, o.json.challenge), setup_token: h.setupToken });
    expect(r.status).toBe(400); expect(r.json.error).toBe("enroll_invalid");
  });

  test("the removed browser enrolment routes are gone (404)", async () => {
    const h = makeHarness();
    expect((await h.call("GET", "/api/native-keys/enroll/abc")).status).toBe(404);
    expect((await h.call("POST", "/api/native-keys/enroll/abc/confirm", {})).status).toBe(404);
    expect((await h.call("POST", "/api/app/browser-link", {})).status).toBe(404);
  });
});

describe("recovery", () => {
  async function recoverEnrol(h: Harness, tok: string) {
    const se = new SoftSe();
    const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 });
    return { se, o, v: await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: enrollSig(se, o.json.challenge), recovery_token: tok }) };
  }

  test("a recovery token lets one enrolment through even on an existing install (no keys), is single use, and shows in status", async () => {
    const h = makeHarness();
    await h.signUp();
    await h.call("POST", `/api/native-keys/${h.auth.id}/revoke`, {});
    const rt = new RecoveryToken(h.recoveryFile);
    expect(rt.active).toBe(false);
    const token = rt.create();
    expect(statSync(h.recoveryFile).mode & 0o777).toBe(0o600);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const st = (await h.call("GET", "/api/status")).json.setup;
    expect(st.proof_available).toBe("recovery_token");
    expect(Date.parse(st.recovery_expires_at) - Date.now()).toBeGreaterThan(29 * 60_000);
    const wrong = await recoverEnrol(h, b64u(randomBytes(32)));
    expect(wrong.v.status).toBe(403); expect(wrong.v.json.error).toBe("recovery_token_invalid");
    expect(existsSync(h.recoveryFile)).toBe(true);
    const good = await recoverEnrol(h, token);
    expect(good.o.json.proof).toBe("recovery_token");
    expect(good.v.status).toBe(200); expect(good.v.json.status).toBe("active");
    expect(existsSync(h.recoveryFile)).toBe(false);        // consumed
    const again = await recoverEnrol(h, token);
    expect(again.v.status).toBe(403);
    expect(JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8")).keys.map((k: any) => k.credential_id)).toEqual([good.se.id]);
    expect(h.db.query("SELECT details_json FROM audit_log WHERE action = 'native_key.activate' ORDER BY id DESC").get()).toEqual({ details_json: JSON.stringify({ how: "recovery_token" }) });
  });

  test("a token older than 30 minutes is dead and deleted on sight; a loose file (0644) is not accepted", async () => {
    const h = makeHarness();
    await h.signUp();
    const rt = new RecoveryToken(h.recoveryFile);
    const t2 = rt.create();
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(h.recoveryFile, old, old);
    expect(rt.active).toBe(false);
    expect(existsSync(h.recoveryFile)).toBe(false);
    expect((await recoverEnrol(h, t2)).v.status).toBe(403);
    const t3 = rt.create();
    chmodSync(h.recoveryFile, 0o644);
    expect(rt.matches(t3)).toBe(false);
    // a symlink at the name is not followed
    writeFileSync(join(h.dir, "elsewhere"), t3 + "\n", { mode: 0o600 });
    require("node:fs").unlinkSync(h.recoveryFile);
    require("node:fs").symlinkSync(join(h.dir, "elsewhere"), h.recoveryFile);
    expect(rt.active).toBe(false);
  });

  test("POST /api/recovery/cancel deletes the file (needs no proof), audits it, and reports whether one was there", async () => {
    const h = makeHarness();
    expect((await h.call("POST", "/api/recovery/cancel", {})).json).toEqual({ ok: true, cancelled: false });
    new RecoveryToken(h.recoveryFile).create();
    const r = await h.call("POST", "/api/recovery/cancel", {});
    expect(r.json).toEqual({ ok: true, cancelled: true });
    expect(existsSync(h.recoveryFile)).toBe(false);
    expect(h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'recovery.cancel'").get()).toEqual({ n: 2 });
    expect((await h.call("POST", "/api/recovery/cancel", { x: 1 })).status).toBe(400);
  });

  test("proof order: recovery beats setup token beats se_reauth beats none", async () => {
    const h = makeHarness();
    const proof = async () => (await h.call("GET", "/api/status")).json.setup.proof_available;
    expect(await proof()).toBe("setup_token");
    new RecoveryToken(h.recoveryFile).create();
    expect(await proof()).toBe("recovery_token");
    const fresh = new SoftSe();
    expect((await h.call("POST", "/api/native-keys/enroll/options", { x963: fresh.x963b64 })).json.proof).toBe("recovery_token");
  });

  test("a leftover setup token file is deleted when setup is already done", async () => {
    const { h } = await ready(1);
    const t = new SetupToken(join(h.dir, "setup-token"));
    writeFileSync(join(h.dir, "setup-token"), b64u(randomBytes(32)) + "\n", { mode: 0o600 });
    expect(t.start(h.db)).toBeNull();
    expect(existsSync(join(h.dir, "setup-token"))).toBe(false);
  });
});

describe("se-verify (send)", () => {
  test("happy path: row has credential_id = key id, empty WebAuthn fields, DER signature; batch approved; audit signer; manifest constants", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const opt = await seOptions(h, batchId, draftIds);
    expect(opt.status).toBe(200);
    expect(opt.json.options).toBeUndefined();
    expect(opt.json.se).toEqual({ tag: "send", key_ids: [se.id] });
    expect(typeof opt.json.manifest_bytes).toBe("string");
    expect(JSON.parse(opt.json.manifest_bytes)).toEqual(opt.json.manifest);
    expect(opt.json.manifest).toMatchObject({ v: 2, rp_id: "agent-outbox", origin: "agent-outbox:app", transport: "dry" });
    const digest = sha256(opt.json.manifest_bytes);
    const signature = se.sign("send", digest);
    // an independent node:crypto check agrees with the app's signing format
    const jwkKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(se.x963.subarray(1, 33)), y: b64u(se.x963.subarray(33)) } });
    expect(verify("sha256", seMessage("send", digest), { key: jwkKey, dsaEncoding: "der" }, Buffer.from(signature, "base64url"))).toBe(true);
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.id, signature });
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ ok: true, count: draftIds.length, credential_id: se.id, transport: "dry" });
    const row = h.db.query<any, [string]>("SELECT * FROM approvals WHERE id = ?").get(opt.json.manifest.approval_id)!;
    expect(row).toMatchObject({ credential_id: se.id, authenticator_data_b64: "", client_data_json_b64: "", signature_b64: signature, batch_id: batchId });
    expect(row.manifest).toBe(opt.json.manifest_bytes);
    expect(row.manifest_sha256).toBe(digest.toString("hex"));
    expect(h.db.query("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status = 'approved'").get(batchId)).toEqual({ n: draftIds.length });
    const a = h.db.query<any, []>("SELECT details_json FROM audit_log WHERE action = 'approval.create'").get()!;
    expect(JSON.parse(a.details_json)).toMatchObject({ signer: "secure-enclave", credential_id: se.id });
  });

  test("signer webauthn is refused (400); the old verify route is 404; with no key: 409 no_native_keys", async () => {
    const h = makeHarness();
    const seed = seedBatch(h.db, 1);
    expect((await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds })).json.error).toBe("no_native_keys");
    await h.signUp();
    const w = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds, signer: "webauthn" });
    expect([w.status, w.json.error]).toEqual([400, "bad_request"]);
    expect((await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds, signer: "secure-enclave" })).status).toBe(200);
    expect((await h.call("POST", `/api/batches/${seed.batchId}/approve/verify`, {})).status).toBe(404);
  });

  test("wrong tag, raw digest, wrong key, pending key and revoked key are all refused; nothing is written", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const attempt = async (key_id: string, signature: (d: Buffer) => string) => {
      const opt = await seOptions(h, batchId, draftIds);
      return h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id, signature: signature(sha256(opt.json.manifest_bytes)) });
    };
    expect((await attempt(se.id, (d) => se.sign("contacts", d))).status).toBe(401);
    expect((await attempt(se.id, (d) => se.sign("reauth", d))).status).toBe(401);
    expect((await attempt(se.id, (d) => b64u(require("node:crypto").sign("sha256", d, { key: se.privateKey, dsaEncoding: "der" })))).status).toBe(401);  // sha256(manifest) alone
    const stranger = new SoftSe();
    expect((await attempt(stranger.id, (d) => stranger.sign("send", d))).status).toBe(401);    // unknown key
    expect((await attempt(se.id, (d) => stranger.sign("send", d))).status).toBe(401);          // right id, someone else's signature
    const pend = new SoftSe();
    await h.call("POST", "/api/native-keys/enroll/options", { x963: pend.x963b64 });
    expect((await attempt(pend.id, (d) => pend.sign("send", d))).status).toBe(401);
    expect(h.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect((await h.call("POST", `/api/native-keys/${se.id}/revoke`, {})).status).toBe(200);
    const none = await seOptions(h, batchId, draftIds);
    expect(none.status).toBe(409); expect(none.json.error).toBe("no_native_keys");
  });

  test("a challenge is single use, and belongs to its batch", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const opt = await seOptions(h, batchId, draftIds);
    const signature = se.sign("send", sha256(opt.json.manifest_bytes));
    const bad = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.id, signature: se.sign("send", sha256("x")) });
    expect(bad.status).toBe(401);
    const reuse = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.id, signature });
    expect(reuse.status).toBe(400); expect(reuse.json.error).toBe("challenge_invalid");
    const other = seedBatch(h.db, 1, "Other");
    const opt2 = await seOptions(h, batchId, draftIds);
    const wrongBatch = await h.call("POST", `/api/batches/${other.batchId}/approve/se-verify`, { challenge_id: opt2.json.challenge_id, key_id: se.id, signature: se.sign("send", sha256(opt2.json.manifest_bytes)) });
    expect(wrongBatch.status).toBe(400);
    expect(h.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  test("an expired challenge is refused (challenge_expired)", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const opt = await seOptions(h, batchId, draftIds);
    h.db.query("UPDATE owner_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.id, signature: se.sign("send", sha256(opt.json.manifest_bytes)) });
    expect([v.status, v.json.error]).toEqual([400, "challenge_expired"]);
  });

  test("a draft edited between options and verify -> 409 draft_changed, nothing recorded", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const opt = await seOptions(h, batchId, draftIds);
    h.db.query("UPDATE drafts SET body = 'something else' WHERE id = ?").run(draftIds[0]!);
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.id, signature: se.sign("send", sha256(opt.json.manifest_bytes)) });
    expect(v.status).toBe(409); expect(v.json.error).toBe("draft_changed");
    expect(h.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  test("a send challenge can't be finished as contacts and vice versa", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const prop = proposeSet(h);
    const sopt = await seOptions(h, batchId, draftIds);
    const copt = await h.call("POST", `/api/contact-changes/${prop.set_id}/approve/options`, { change_ids: [prop.changes[0]!.id] });
    const asContacts = await h.call("POST", `/api/contact-changes/${batchId}/approve/se-verify`, { challenge_id: sopt.json.challenge_id, key_id: se.id, signature: se.sign("send", sha256(sopt.json.manifest_bytes)) });
    expect(asContacts.status).toBe(400);
    const asSend = await h.call("POST", `/api/batches/${prop.set_id}/approve/se-verify`, { challenge_id: copt.json.challenge_id, key_id: se.id, signature: se.sign("contacts", sha256(copt.json.manifest_bytes)) });
    expect(asSend.status).toBe(400);
    expect(h.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM contact_approvals").get()).toEqual({ n: 0 });
  });
});

function proposeSet(h: Harness) {
  return proposeContactChanges(h.db, { title: "t", created_by: "agent:test", source: "mcp", creates: [validateCreate({ given_name: "Sam", family_name: "Lee", phones: ["+14155550123"] })], updates: [] });
}

describe("se-verify (contacts)", () => {
  test("contacts options/se-verify with tag contacts; a send-tag signature is refused", async () => {
    const { h, se } = await ready(1);
    const prop = proposeSet(h);
    const set1 = prop.set_id, ch1 = prop.changes[0]!.id;
    const opt = await h.call("POST", `/api/contact-changes/${set1}/approve/options`, { change_ids: [ch1], signer: "secure-enclave" });
    expect(opt.status).toBe(200);
    expect(opt.json.options).toBeUndefined();
    expect(opt.json.se).toEqual({ tag: "contacts", key_ids: [se.id] });
    expect(opt.json.manifest).toMatchObject({ rp_id: "agent-outbox", origin: "agent-outbox:app" });
    const digest = sha256(opt.json.manifest_bytes);
    const wrong = await h.call("POST", `/api/contact-changes/${set1}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.id, signature: se.sign("send", digest) });
    expect(wrong.status).toBe(401);
    const opt2 = await h.call("POST", `/api/contact-changes/${set1}/approve/options`, { change_ids: [ch1] });
    const ok = await h.call("POST", `/api/contact-changes/${set1}/approve/se-verify`, { challenge_id: opt2.json.challenge_id, key_id: se.id, signature: se.sign("contacts", sha256(opt2.json.manifest_bytes)) });
    expect(ok.status).toBe(200);
    const row = h.db.query<any, []>("SELECT * FROM contact_approvals").get()!;
    expect(row).toMatchObject({ credential_id: se.id, authenticator_data_b64: "", client_data_json_b64: "" });
    expect(h.db.query<any, [string]>("SELECT status FROM contact_changes WHERE id = ?").get(ch1)!.status).toBe("approved");
    expect((await h.call("POST", `/api/contact-changes/${set1}/approve/options`, { change_ids: [ch1] })).status).toBe(409);   // already approved
    expect((await h.call("POST", `/api/contact-changes/${set1}/approve/verify`, {})).status).toBe(404);
  });
});

describe("revocation", () => {
  test("revoke rewrites the pin, revokes that key's approvals (drafts back to review) and contact approvals; other keys' approvals stay", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const se2 = await addSecond(h);
    const approveWith = async (k: SoftSe, bid: string, ids: string[]) => {
      const opt = await seOptions(h, bid, ids);
      return h.call("POST", `/api/batches/${bid}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: k.id, signature: k.sign("send", sha256(opt.json.manifest_bytes)) });
    };
    expect((await approveWith(se, batchId, draftIds)).status).toBe(200);
    const b2 = seedBatch(h.db, 1, "b2");
    expect((await approveWith(se2, b2.batchId, b2.draftIds)).status).toBe(200);
    const prop = proposeSet(h);
    const co = await h.call("POST", `/api/contact-changes/${prop.set_id}/approve/options`, { change_ids: [prop.changes[0]!.id] });
    expect((await h.call("POST", `/api/contact-changes/${prop.set_id}/approve/se-verify`, { challenge_id: co.json.challenge_id, key_id: se.id, signature: se.sign("contacts", sha256(co.json.manifest_bytes)) })).status).toBe(200);

    const r = await h.call("POST", `/api/native-keys/${se.id}/revoke`, {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ revoked_approvals: 1, revoked_contact_approvals: 1 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status = 'review'").get(batchId)).toEqual({ n: draftIds.length });
    expect(h.db.query<any, [string]>("SELECT status FROM native_keys WHERE key_id = ?").get(se.id)).toEqual({ status: "revoked" });
    expect(h.db.query<any, [string]>("SELECT revoked_at FROM approvals WHERE batch_id = ?").get(b2.batchId)).toEqual({ revoked_at: null });
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.keys.map((k: any) => k.credential_id)).toEqual([se2.id]);
    expect((await h.call("POST", `/api/native-keys/${se.id}/revoke`, {})).status).toBe(409);
    expect((await h.call("POST", `/api/native-keys/nope/revoke`, {})).status).toBe(404);
    // the last key can be revoked too: the pin then lists none (and is not deleted)
    expect((await h.call("POST", `/api/native-keys/${se2.id}/revoke`, {})).status).toBe(200);
    expect(JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"))).toEqual({ v: 4, keys: [], policy: { live_allowed: false, contacts_live_allowed: false } });
  });
});

describe("se_reauth", () => {
  test("is accepted for POST /api/mode live, single use, bound to its action", async () => {
    const { h, se } = await ready(1);
    expect((await h.call("POST", "/api/mode", { mode: "live" })).json.error).toBe("reauth_required");
    const wrong = await h.reauth("policy_live");
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: wrong })).status).toBe(400);
    const o = await h.call("POST", "/api/native-keys/reauth/options", { action: "mode_live" });
    const bad = { challenge_id: o.json.challenge_id, key_id: se.id, signature: se.sign("send", sha256(Buffer.from(o.json.challenge, "base64url"))) };
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: bad })).status).toBe(401);
    const good = await h.reauth("mode_live");
    const ok = await h.call("POST", "/api/mode", { mode: "live", se_reauth: good });
    expect(ok.status).toBe(200);
    expect(ok.json.settings.transport).toBe("live");
    expect(ok.json.approval_key).toBe(true);
    expect(JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8")).policy).toEqual({ live_allowed: true, contacts_live_allowed: true });
    expect((await h.call("POST", "/api/mode", { mode: "dry" })).status).toBe(200);
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: good })).status).toBe(400);   // reuse
    const g2 = await h.reauth("mode_live");
    await h.call("POST", `/api/native-keys/${se.id}/revoke`, {});
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: g2 })).status).toBe(401);       // a revoked key's reauth
  });

  test("reauth/options needs an active key", async () => {
    const h = makeHarness();
    const r = await h.call("POST", "/api/native-keys/reauth/options", { action: "mode_live" });
    expect([r.status, r.json.error]).toEqual([409, "no_native_keys"]);
  });
});

describe("misc", () => {
  test("`setSetting` is untouched by native routes and the agent-forbidden tables exist", () => {
    const h = makeHarness();
    for (const t of ["native_keys", "native_challenges", "link_codes", "session_links", "owner_challenges"]) {
      expect(h.db.query("SELECT name FROM sqlite_master WHERE name = ?").get(t)).toEqual({ name: t });
    }
    expect(typeof setSetting).toBe("function");
  });
});
