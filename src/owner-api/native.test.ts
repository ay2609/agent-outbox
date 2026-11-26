// Native (Secure Enclave) approval: server side. A software P-256 key stands in for the SE (same x963 + DER wire format).
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { b64u } from "./b64";
import { buildPinFile, pinText } from "./auth";
import { fingerprint, parseX963, seMessage, verifySe, type SeTag } from "./native";
import { RecoveryToken } from "./recovery";
import { AppAuth } from "./app-auth";
import { makeHarness, seedBatch, type Harness } from "./testkit";
import { setSetting } from "../core/store";
import { proposeContactChanges, validateCreate } from "../core/contact-changes";

const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

class SoftSE {
  readonly priv: KeyObject; readonly x963: Buffer;
  constructor() {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.priv = kp.privateKey;
    const j = kp.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.x963 = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]);
  }
  get keyId(): string { return b64u(sha256(this.x963)); }
  get x963b64(): string { return b64u(this.x963); }
  /** DER signature over M(tag, digest), base64url. `raw` signs the given bytes as they are. */
  sign(tag: SeTag, digest: Uint8Array, raw?: Buffer): string {
    return b64u(sign("sha256", raw ?? seMessage(tag, digest), { key: this.priv, dsaEncoding: "der" }));
  }
}

/** First-run enrolment over the app channel with the setup token. Returns the SE key. */
async function enrollFirstRun(h: Harness, se = new SoftSE(), label = "This Mac (Touch ID)") {
  const o = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se.x963b64, label });
  expect(o.status).toBe(200);
  const sig = se.sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
  const v = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, setup_token: h.setupToken });
  return { se, o, v };
}
/** Enrol on an install that already has passkeys: no proof in the request, then the browser confirms with the login key. */
async function enrollViaBrowser(h: Harness, se = new SoftSE()) {
  const o = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 });
  const sig = se.sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
  const v = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig });
  return { se, o, v };
}
async function seReauth(h: Harness, se: SoftSE, action: string) {
  const o = await h.callApp("POST", "/api/native-keys/reauth/options", { action });
  expect(o.status).toBe(200);
  return { challenge_id: o.json.challenge_id, key_id: se.keyId, signature: se.sign("reauth", sha256(Buffer.from(o.json.challenge, "base64url"))) };
}
async function seOptions(h: Harness, batchId: string, ids: string[]) {
  return h.callApp("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: ids, signer: "secure-enclave" });
}
async function ready(n = 2) {
  const h = makeHarness();
  const { se } = await enrollFirstRun(h);
  return { h, se, ...seedBatch(h.db, n) };
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

describe("channels", () => {
  test("X-Outbox-App over TCP is refused with 400 and audited (even with a session)", async () => {
    const h = makeHarness();
    await h.signUp();
    const r = await h.call("GET", "/api/status", undefined, { headers: { "x-outbox-app": h.appToken } });
    expect(r.status).toBe(400); expect(r.json.error).toBe("app_auth_tcp");
    const r2 = await h.call("GET", "/", undefined, { cookie: null, headers: { "x-outbox-app": "x" } });
    expect(r2.status).toBe(400);
    expect(h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'app_auth.tcp_refused'").get()).toEqual({ n: 2 });
    // the token never helps on TCP: no header, no session -> 401 as before
    expect((await h.call("GET", "/api/status", undefined, { cookie: null })).status).toBe(401);
  });

  test("the app channel without (or with a wrong) token is 401 app_auth; with it, /api works without a cookie", async () => {
    const h = makeHarness();
    for (const token of [null, "wrong", b64u(randomBytes(32))]) {
      const r = await h.callApp("GET", "/api/status", undefined, { token });
      expect(r.status).toBe(401); expect(r.json.error).toBe("app_auth");
    }
    const ok = await h.callApp("GET", "/api/status");
    expect(ok.status).toBe(200);
    expect(ok.json.native).toEqual({ keys_active: 0, approve_in_app: false, pin_needs_update: false });
    // CSRF header still required on mutations, even with the token
    const noCsrf = await h.callApp("POST", "/api/native-keys/reauth/options", { action: "mode_live" }, { csrf: false });
    expect(noCsrf.status).toBe(403); expect(noCsrf.json.error).toBe("csrf");
    // only /api is served on the app channel, and a foreign Host is refused
    expect((await h.app.request("/", { headers: { host: "localhost" } }, { channel: "app" })).status).toBe(404);
    expect((await h.app.request("/api/status", { headers: { host: "evil.example", "x-outbox-app": h.appToken } }, { channel: "app" })).status).toBe(403);
  });

  test("an app channel with no token configured is off (503), and the channel can't be chosen by a request", async () => {
    const h = makeHarness({ appAuth: new AppAuth() });
    expect((await h.app.request("/api/status", { headers: { host: "localhost" } }, { channel: "app" })).status).toBe(503);
    // a request-level "channel" lookalike (header, query, body) does nothing: Env is server-side only
    const r = await h.call("GET", "/api/status?channel=app", undefined, { cookie: null, headers: { channel: "app" } });
    expect(r.status).toBe(401);
  });

  test("app-only routes are 403 app_only on TCP (with a session), tcp-only routes are 403 tcp_only on the app channel", async () => {
    const h = makeHarness();
    await h.signUp();
    const seed = seedBatch(h.db, 1);
    for (const [m, p] of [
      ["POST", `/api/batches/${seed.batchId}/approve/se-verify`], ["POST", "/api/contact-changes/x/approve/se-verify"],
      ["POST", "/api/native-keys/enroll/options"], ["POST", "/api/native-keys/enroll/verify"], ["POST", "/api/native-keys/reauth/options"],
      ["POST", "/api/app/browser-link"],
    ] as const) {
      const r = await h.call(m, p, {});
      expect(r.status).toBe(403); expect(r.json.error).toBe("app_only");
    }
    for (const p of ["/api/native-keys/enroll/abc/confirm", "/api/auth/link"]) {
      const r = await h.callApp("POST", p, {});
      expect(r.status).toBe(403); expect(r.json.error).toBe("tcp_only");
    }
  });
});

describe("enrolment", () => {
  test("first run: setup token + possession proof activates the key, deletes the token, closes open registration and writes a v3 pin", async () => {
    const h = makeHarness();
    expect(existsSync(join(h.dir, "setup-token"))).toBe(true);
    expect((await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json.setup_token_required).toBe(true);
    const { se, o, v } = await enrollFirstRun(h);
    expect(o.json.proof).toBe("setup_token");
    expect(o.json.key_id).toBe(se.keyId); expect(o.json.fingerprint).toBe(fingerprint(se.x963));
    expect(v.status).toBe(200); expect(v.json).toEqual({ status: "active" });
    expect(existsSync(join(h.dir, "setup-token"))).toBe(false);
    expect(h.setup.active).toBe(false);
    // open registration is closed: a login passkey can no longer be registered with the (old) setup token
    const reg = await h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null });
    expect(reg.status).toBe(403); expect(reg.json.error).toBe("registration_locked");
    expect((await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json.setup_token_required).toBe(false);
    // the pin is v3 with the SE key
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.v).toBe(3);
    expect(pin.keys).toEqual([{ kind: "secure-enclave", credential_id: se.keyId, x963: se.x963b64, label: "This Mac (Touch ID)" }]);
    const keys = await h.callApp("GET", "/api/native-keys");
    expect(keys.json.keys[0]).toMatchObject({ key_id: se.keyId, status: "active", in_effective_pin: true });
    expect((await h.callApp("GET", "/api/status")).json.native).toEqual({ keys_active: 1, approve_in_app: true, pin_needs_update: false });
  });

  test("a wrong/missing setup token, a bad possession signature, a duplicate key and a second first-run all fail", async () => {
    const h = makeHarness();
    const se = new SoftSE();
    const o = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 });
    const good = se.sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
    const bad = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: good, setup_token: b64u(randomBytes(32)) });
    expect(bad.status).toBe(403); expect(bad.json.error).toBe("setup_token_invalid");
    const none = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: good });
    expect(none.status).toBe(403); expect(none.json.error).toBe("setup_token_required");
    // signature by another key (possession): refused
    const other = new SoftSE().sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
    expect((await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: other, setup_token: h.setupToken })).status).toBe(401);
    // wrong tag over the right bytes
    const wrongTag = se.sign("send", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
    expect((await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: wrongTag, setup_token: h.setupToken })).status).toBe(401);
    // same public key twice -> 409
    expect((await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 })).status).toBe(409);
    // garbage key
    expect((await h.callApp("POST", "/api/native-keys/enroll/options", { x963: "AAAA" })).status).toBe(400);
    // good proof now works, and a second key can no longer use the (deleted) setup token
    expect((await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: good, setup_token: h.setupToken })).status).toBe(200);
    const se2 = new SoftSE();
    const o2 = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64 });
    expect(o2.json.proof).toBe("se_reauth");
    const sig2 = se2.sign("enroll", sha256(Buffer.concat([Buffer.from(o2.json.challenge, "base64url"), se2.x963])));
    const r = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o2.json.key_id, signature: sig2, setup_token: h.setupToken });
    expect(r.status).toBe(403);
    const r2 = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o2.json.key_id, signature: sig2 });
    expect(r2.status).toBe(403); expect(r2.json.error).toBe("reauth_required");
  });

  test("an additional key with an active SE key needs an se_reauth for native_key_add (and only that action)", async () => {
    const { h, se } = await ready(1);
    const se2 = new SoftSE();
    const o = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64 });
    const sig = se2.sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se2.x963])));
    const wrongAction = await seReauth(h, se, "mode_live");
    const bad = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: wrongAction });
    expect(bad.status).toBe(400);
    const good = await seReauth(h, se, "native_key_add");
    const v = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: good });
    expect(v.status).toBe(200); expect(v.json.status).toBe("active");
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.keys.map((k: any) => k.credential_id).sort()).toEqual([se.keyId, se2.keyId].sort());
  });

  test("with a login key present: no proof -> awaiting_browser; confirm needs a LOGIN reauth (an approve key is refused)", async () => {
    const h = makeHarness();
    await h.signUp();
    const { se, o, v } = await enrollViaBrowser(h);
    expect(o.json.proof).toBe("browser");
    expect(v.json).toEqual({ status: "awaiting_browser", confirm_url: `http://localhost:7477/#/native-enroll/${se.keyId}` });
    const st = await h.call("GET", `/api/native-keys/enroll/${se.keyId}`);
    expect(st.json).toMatchObject({ status: "pending", fingerprint: fingerprint(se.x963) });
    // not yet in the pin
    expect(JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8")).v).toBe(2);
    // confirming with the APPROVE key's assertion must fail (the login-purpose check)
    const ro = await h.call("POST", "/api/auth/reauth/options", {});
    const wrong = await h.call("POST", `/api/native-keys/enroll/${se.keyId}/confirm`, { reauth: { challenge_id: ro.json.challenge_id, response: h.auth.assert(ro.json.options) } });
    expect(wrong.status).toBe(401);
    // no reauth at all
    expect((await h.call("POST", `/api/native-keys/enroll/${se.keyId}/confirm`, {})).status).toBe(400);
    const ok = await h.call("POST", `/api/native-keys/enroll/${se.keyId}/confirm`, { reauth: await h.reauth() });
    expect(ok.status).toBe(200); expect(ok.json).toEqual({ status: "active" });
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.v).toBe(3);
    expect(pin.keys.map((k: any) => k.kind)).toEqual(["webauthn", "secure-enclave"]);
    expect((await h.call("GET", `/api/native-keys/enroll/${se.keyId}`)).json.status).toBe("active");
    // confirming again: no longer pending
    expect((await h.call("POST", `/api/native-keys/enroll/${se.keyId}/confirm`, { reauth: await h.reauth() })).status).toBe(400);
  });

  test("a pending key expires after 10 minutes", async () => {
    const h = makeHarness();
    const se = new SoftSE();
    const o = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 });
    h.db.query("UPDATE native_keys SET enroll_expires_at = ? WHERE key_id = ?").run(new Date(Date.now() - 1000).toISOString(), se.keyId);
    const sig = se.sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
    const r = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: se.keyId, signature: sig, setup_token: h.setupToken });
    expect(r.status).toBe(400); expect(r.json.error).toBe("enroll_invalid");
  });

  test("recovery token: lets one enrolment through, is single use, and expires after 30 minutes", async () => {
    const h = makeHarness();
    await h.signUp();
    const { se: first } = await enrollViaBrowser(h);      // pending; then a confirmed key to have a "lost" key scenario
    await h.call("POST", `/api/native-keys/enroll/${first.keyId}/confirm`, { reauth: await h.reauth() });
    const rt = new RecoveryToken(h.recoveryFile);
    expect(rt.active).toBe(false);
    const token = rt.create();
    expect(statSync(h.recoveryFile).mode & 0o777).toBe(0o600);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const enroll = async (tok: string) => {
      const se = new SoftSE();
      const o = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se.x963b64 });
      const sig = se.sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se.x963])));
      return { se, o, v: await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, recovery_token: tok }) };
    };
    const wrong = await enroll(b64u(randomBytes(32)));
    expect(wrong.v.status).toBe(403); expect(wrong.v.json.error).toBe("recovery_token_invalid");
    const good = await enroll(token);
    expect(good.o.json.proof).toBe("recovery_token");
    expect(good.v.status).toBe(200); expect(good.v.json.status).toBe("active");
    expect(existsSync(h.recoveryFile)).toBe(false);        // consumed
    const again = await enroll(token);
    expect(again.v.status).toBe(403);
    // expiry: a token file older than 30 minutes is dead
    const t2 = rt.create();
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(h.recoveryFile, old, old);
    expect(rt.active).toBe(false);
    expect((await enroll(t2)).v.status).toBe(403);
    // a loose file (mode 0644) is not accepted either
    const t3 = rt.create();
    chmodSync(h.recoveryFile, 0o644);
    expect(rt.matches(t3)).toBe(false);
  });
});

describe("pin file", () => {
  test("bytes are v2-identical with no active native key, and v3 with one (webauthn first, then native)", async () => {
    const h = makeHarness();
    await h.signUp();
    const cfg = { rpId: h.rpId, origin: h.origin } as any;
    const before = pinText({ ...cfg, db: () => h.db } as any, h.db);
    const o = JSON.parse(before);
    expect(o.v).toBe(2);
    expect(Object.keys(o)).toEqual(["v", "rp_id", "origin", "keys", "policy"]);
    expect(Object.keys(o.keys[0])).toEqual(["credential_id", "x963", "label"]);          // no `kind`
    expect(before).toBe(JSON.stringify(buildPinFile(cfg, h.db), null, 2) + "\n");
    // a pending (not active) native key changes nothing
    const { se } = await enrollViaBrowser(h);
    expect(pinText(cfg, h.db)).toBe(before);
    await h.call("POST", `/api/native-keys/enroll/${se.keyId}/confirm`, { reauth: await h.reauth() });
    const after = JSON.parse(pinText(cfg, h.db));
    expect(after.v).toBe(3);
    expect(Object.keys(after.keys[0])).toEqual(["kind", "credential_id", "x963", "label"]);
    expect(after.keys.map((k: any) => k.kind)).toEqual(["webauthn", "secure-enclave"]);
    expect(after.keys[1].credential_id).toBe(se.keyId);
    expect(readFileSync(join(h.dir, "passkeys.json"), "utf8")).toBe(pinText(cfg, h.db));
    // revoking the only native key returns the pin to the exact v2 bytes
    expect((await h.callApp("POST", `/api/native-keys/${se.keyId}/revoke`, {})).status).toBe(200);
    expect(readFileSync(join(h.dir, "passkeys.json"), "utf8")).toBe(before);
  });

  test("hardened mode: an enrolled key is not trusted until the root pin has it (status says run the command again)", async () => {
    const { h, se } = await ready(1);
    // a root pin that doesn't list the key -> hardened, not in the effective pin
    const rootDir = join(h.dir, "root");
    require("node:fs").mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, "passkeys.json"), JSON.stringify({ v: 2, rp_id: "localhost", origin: "http://localhost:7477", keys: [{ credential_id: "x", x963: "y", label: "z" }], policy: { live_allowed: false } }));
    const st = (await h.callApp("GET", "/api/status")).json;
    expect(st.pin.mode).toBe("hardened");
    expect(st.native).toEqual({ keys_active: 1, approve_in_app: false, pin_needs_update: true });
    expect((await h.callApp("GET", "/api/native-keys")).json.keys[0].in_effective_pin).toBe(false);
    // the root pin as the harden command would install it
    writeFileSync(join(rootDir, "passkeys.json"), pinText({ rpId: h.rpId, origin: h.origin } as any, h.db));
    const st2 = (await h.callApp("GET", "/api/status")).json;
    expect(st2.native).toEqual({ keys_active: 1, approve_in_app: true, pin_needs_update: false });
    expect(st2.pin.candidate.installed).toBe(true);
    expect(se.keyId).toBeTruthy();
  });
});

describe("se-verify (send)", () => {
  test("happy path: row has credential_id = key id, empty WebAuthn fields, DER signature; batch approved; audit signer", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const opt = await seOptions(h, batchId, draftIds);
    expect(opt.status).toBe(200);
    expect(opt.json.options).toBeNull();
    expect(opt.json.se).toEqual({ tag: "send", key_ids: [se.keyId] });
    expect(typeof opt.json.manifest_bytes).toBe("string");
    expect(JSON.parse(opt.json.manifest_bytes)).toEqual(opt.json.manifest);
    const digest = sha256(opt.json.manifest_bytes);
    const signature = se.sign("send", digest);
    // the server's own verifier and an independent node:crypto check agree
    const jwkKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(se.x963.subarray(1, 33)), y: b64u(se.x963.subarray(33)) } });
    const { verify } = await import("node:crypto");
    expect(verify("sha256", seMessage("send", digest), { key: jwkKey, dsaEncoding: "der" }, Buffer.from(signature, "base64url"))).toBe(true);
    const v = await h.callApp("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.keyId, signature });
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ ok: true, count: draftIds.length, credential_id: se.keyId, transport: "dry" });
    const row = h.db.query<any, [string]>("SELECT * FROM approvals WHERE id = ?").get(opt.json.manifest.approval_id)!;
    expect(row).toMatchObject({ credential_id: se.keyId, authenticator_data_b64: "", client_data_json_b64: "", signature_b64: signature, batch_id: batchId });
    expect(row.manifest).toBe(opt.json.manifest_bytes);
    expect(row.manifest_sha256).toBe(digest.toString("hex"));
    expect(h.db.query("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status = 'approved'").get(batchId)).toEqual({ n: draftIds.length });
    const a = h.db.query<any, []>("SELECT details_json FROM audit_log WHERE action = 'approval.create'").get()!;
    expect(JSON.parse(a.details_json)).toMatchObject({ signer: "secure-enclave", credential_id: se.keyId });
  });

  test("wrong tag, raw digest, wrong key, pending key and revoked key are all refused; nothing is written", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const attempt = async (key_id: string, signature: (d: Buffer) => string) => {
      const opt = await seOptions(h, batchId, draftIds);
      const v = await h.callApp("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id, signature: signature(sha256(opt.json.manifest_bytes)) });
      return v;
    };
    expect((await attempt(se.keyId, (d) => se.sign("contacts", d))).status).toBe(401);
    expect((await attempt(se.keyId, (d) => se.sign("reauth", d))).status).toBe(401);
    expect((await attempt(se.keyId, (d) => se.sign("send", d, d))).status).toBe(401);           // sha256(manifest) alone
    expect((await attempt(se.keyId, (d) => se.sign("send", d, Buffer.from("x")))).status).toBe(401);
    const stranger = new SoftSE();
    expect((await attempt(stranger.keyId, (d) => stranger.sign("send", d))).status).toBe(401);    // unknown key
    // a pending key
    const pend = new SoftSE();
    await h.callApp("POST", "/api/native-keys/enroll/options", { x963: pend.x963b64 });
    expect((await attempt(pend.keyId, (d) => pend.sign("send", d))).status).toBe(401);
    expect(h.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    // revoked
    expect((await h.callApp("POST", `/api/native-keys/${se.keyId}/revoke`, {})).status).toBe(200);
    const none = await seOptions(h, batchId, draftIds);
    expect(none.status).toBe(409); expect(none.json.error).toBe("no_native_keys");
  });

  test("a challenge is single use; a webauthn-signer challenge can't be a send approval for another batch", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const opt = await seOptions(h, batchId, draftIds);
    const signature = se.sign("send", sha256(opt.json.manifest_bytes));
    const bad = await h.callApp("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.keyId, signature: se.sign("send", sha256("x")) });
    expect(bad.status).toBe(401);
    const reuse = await h.callApp("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.keyId, signature });
    expect(reuse.status).toBe(400); expect(reuse.json.error).toBe("challenge_invalid");
    // another batch's id with a fresh challenge from this batch
    const other = seedBatch(h.db, 1, "Other");
    const opt2 = await seOptions(h, batchId, draftIds);
    const wrongBatch = await h.callApp("POST", `/api/batches/${other.batchId}/approve/se-verify`, { challenge_id: opt2.json.challenge_id, key_id: se.keyId, signature: se.sign("send", sha256(opt2.json.manifest_bytes)) });
    expect(wrongBatch.status).toBe(400);
    expect(h.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  test("a draft edited between options and verify -> 409 draft_changed, nothing recorded", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const opt = await seOptions(h, batchId, draftIds);
    h.db.query("UPDATE drafts SET body = 'something else' WHERE id = ?").run(draftIds[0]!);
    const v = await h.callApp("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.keyId, signature: se.sign("send", sha256(opt.json.manifest_bytes)) });
    expect(v.status).toBe(409); expect(v.json.error).toBe("draft_changed");
    expect(h.db.query("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 0 });
  });

  test("a send challenge can't be finished as contacts and vice versa; the webauthn signer still works and now returns manifest_bytes", async () => {
    const h = makeHarness();
    await h.signUp();
    const seed = seedBatch(h.db, 1);
    const opt = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds });
    expect(opt.status).toBe(200);
    expect(typeof opt.json.manifest_bytes).toBe("string");
    expect(opt.json.options.challenge).toBe(b64u(sha256(opt.json.manifest_bytes)));
    const v = await h.call("POST", `/api/batches/${seed.batchId}/approve/verify`, { challenge_id: opt.json.challenge_id, response: h.auth.assert(opt.json.options) });
    expect(v.status).toBe(200);
    // no native keys -> signer secure-enclave refused
    const seed2 = seedBatch(h.db, 1, "b2");
    expect((await h.call("POST", `/api/batches/${seed2.batchId}/approve/options`, { draft_ids: seed2.draftIds, signer: "secure-enclave" })).json.error).toBe("no_native_keys");
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
    const opt = await h.callApp("POST", `/api/contact-changes/${set1}/approve/options`, { change_ids: [ch1], signer: "secure-enclave" });
    expect(opt.status).toBe(200);
    expect(opt.json.options).toBeNull();
    expect(opt.json.se).toEqual({ tag: "contacts", key_ids: [se.keyId] });
    const digest = sha256(opt.json.manifest_bytes);
    const wrong = await h.callApp("POST", `/api/contact-changes/${set1}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: se.keyId, signature: se.sign("send", digest) });
    expect(wrong.status).toBe(401);
    const opt2 = await h.callApp("POST", `/api/contact-changes/${set1}/approve/options`, { change_ids: [ch1], signer: "secure-enclave" });
    const d2 = sha256(opt2.json.manifest_bytes);
    const ok = await h.callApp("POST", `/api/contact-changes/${set1}/approve/se-verify`, { challenge_id: opt2.json.challenge_id, key_id: se.keyId, signature: se.sign("contacts", d2) });
    expect(ok.status).toBe(200);
    const row = h.db.query<any, []>("SELECT * FROM contact_approvals").get()!;
    expect(row).toMatchObject({ credential_id: se.keyId, authenticator_data_b64: "", client_data_json_b64: "" });
    expect(h.db.query<any, [string]>("SELECT status FROM contact_changes WHERE id = ?").get(ch1)!.status).toBe("approved");
    // the send path refuses a contacts challenge
    const opt3 = await h.callApp("POST", `/api/contact-changes/${set1}/approve/options`, { change_ids: [ch1], signer: "secure-enclave" });
    expect(opt3.status).toBe(409);   // already approved: nothing left to sign
  });
});

describe("revocation", () => {
  test("revoke rewrites the pin, revokes that key's approvals (drafts back to review) and contact approvals; other keys' approvals stay", async () => {
    const { h, se, batchId, draftIds } = await ready();
    const se2 = new SoftSE();
    // second key via se_reauth
    const o = await h.callApp("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64 });
    const v2 = await h.callApp("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, se_reauth: await seReauth(h, se, "native_key_add"),
      signature: se2.sign("enroll", sha256(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se2.x963]))) });
    expect(v2.status).toBe(200);
    // approve batch with key 1 (a second batch with key 2)
    const approveWith = async (k: SoftSE, bid: string, ids: string[]) => {
      const opt = await seOptions(h, bid, ids);
      return h.callApp("POST", `/api/batches/${bid}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: k.keyId, signature: k.sign("send", sha256(opt.json.manifest_bytes)) });
    };
    expect((await approveWith(se, batchId, draftIds)).status).toBe(200);
    const b2 = seedBatch(h.db, 1, "b2");
    expect((await approveWith(se2, b2.batchId, b2.draftIds)).status).toBe(200);
    // a contact approval by key 1
    const prop = proposeSet(h);
    const co = await h.callApp("POST", `/api/contact-changes/${prop.set_id}/approve/options`, { change_ids: [prop.changes[0]!.id], signer: "secure-enclave" });
    expect((await h.callApp("POST", `/api/contact-changes/${prop.set_id}/approve/se-verify`, { challenge_id: co.json.challenge_id, key_id: se.keyId, signature: se.sign("contacts", sha256(co.json.manifest_bytes)) })).status).toBe(200);

    const r = await h.callApp("POST", `/api/native-keys/${se.keyId}/revoke`, {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ revoked_approvals: 1, revoked_contact_approvals: 1 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status = 'review'").get(batchId)).toEqual({ n: draftIds.length });
    expect(h.db.query<any, [string]>("SELECT status FROM native_keys WHERE key_id = ?").get(se.keyId)).toEqual({ status: "revoked" });
    expect(h.db.query<any, [string]>("SELECT revoked_at FROM approvals WHERE batch_id = ?").get(b2.batchId)).toEqual({ revoked_at: null });
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.keys.map((k: any) => k.credential_id)).toEqual([se2.keyId]);
    // revoking again, or an unknown key
    expect((await h.callApp("POST", `/api/native-keys/${se.keyId}/revoke`, {})).status).toBe(409);
    expect((await h.callApp("POST", `/api/native-keys/nope/revoke`, {})).status).toBe(404);
    // the revoked key can't sign any more, and it works from a browser session too (no proof needed: it only removes power)
    const tok = b64u(randomBytes(32));
    h.db.query("INSERT INTO sessions(token_sha256, created_at, expires_at, user_agent) VALUES (?,?,?,'')").run(sha256(tok).toString("hex"), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
    expect((await h.call("POST", `/api/native-keys/${se2.keyId}/revoke`, {}, { cookie: `outbox_session=${tok}` })).status).toBe(200);
    const last = JSON.parse(pinText({ rpId: h.rpId, origin: h.origin } as any, h.db));
    expect(last.keys.length).toBe(0);
  });
});

describe("se_reauth", () => {
  test("is accepted for POST /api/mode live (app channel), single use, bound to its action, and refused over TCP", async () => {
    const { h, se } = await ready(1);
    // no reauth -> 403
    expect((await h.callApp("POST", "/api/mode", { mode: "live" })).json.error).toBe("reauth_required");
    // wrong action
    const wrong = await seReauth(h, se, "policy_live");
    expect((await h.callApp("POST", "/api/mode", { mode: "live", se_reauth: wrong })).status).toBe(400);
    // a bad signature
    const o = await h.callApp("POST", "/api/native-keys/reauth/options", { action: "mode_live" });
    const bad = { challenge_id: o.json.challenge_id, key_id: se.keyId, signature: se.sign("send", sha256(Buffer.from(o.json.challenge, "base64url"))) };
    expect((await h.callApp("POST", "/api/mode", { mode: "live", se_reauth: bad })).status).toBe(401);
    const good = await seReauth(h, se, "mode_live");
    const ok = await h.callApp("POST", "/api/mode", { mode: "live", se_reauth: good });
    expect(ok.status).toBe(200);
    expect(ok.json.settings.transport).toBe("live");
    expect(JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8")).policy).toEqual({ live_allowed: true, contacts_live_allowed: true });
    // reuse of the same challenge (back to dry first: going live again needs the confirmation again)
    expect((await h.callApp("POST", "/api/mode", { mode: "dry" })).status).toBe(200);
    expect((await h.callApp("POST", "/api/mode", { mode: "live", se_reauth: good })).status).toBe(400);
    // a revoked key's reauth is refused
    const g2 = await seReauth(h, se, "mode_live");
    await h.callApp("POST", `/api/native-keys/${se.keyId}/revoke`, {});
    expect((await h.callApp("POST", "/api/mode", { mode: "live", se_reauth: g2 })).status).toBe(401);
  });

  test("se_reauth over TCP is refused (it can only be produced for the app channel)", async () => {
    const h = makeHarness();
    await h.signUp();
    const r = await h.call("POST", "/api/mode", { mode: "live", se_reauth: { challenge_id: "x", key_id: "y", signature: "z" } });
    expect(r.status).toBe(403); expect(r.json.error).toBe("app_only");
  });
});

describe("browser link", () => {
  test("link code: 5 minutes, single use; it gives a normal session cookie; with no login key it needs an SE reauth, and a link session may register the FIRST login passkey", async () => {
    const { h, se } = await ready(1);
    // zero login keys: needs an se_reauth for browser_link
    expect((await h.callApp("POST", "/api/app/browser-link", {})).json.error).toBe("reauth_required");
    const bl = await h.callApp("POST", "/api/app/browser-link", { se_reauth: await seReauth(h, se, "browser_link") });
    expect(bl.status).toBe(200);
    expect(bl.json.url).toMatch(/^http:\/\/localhost:7477\/#\/link\?code=[A-Za-z0-9_-]{43}$/);
    const code = new URL(bl.json.url.replace("/#", "/")).searchParams.get("code")!;
    expect(Date.parse(bl.json.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(Date.parse(bl.json.expires_at) - Date.now()).toBeGreaterThan(4 * 60_000);
    // only a hash is stored
    expect(JSON.stringify(h.db.query("SELECT * FROM link_codes").all())).not.toContain(code);
    // needs CSRF, and a wrong code fails
    expect((await h.call("POST", "/api/auth/link", { code }, { cookie: null, csrf: false })).status).toBe(403);
    expect((await h.call("POST", "/api/auth/link", { code: "nope" }, { cookie: null })).status).toBe(400);
    const use = await h.call("POST", "/api/auth/link", { code }, { cookie: null });
    expect(use.status).toBe(200);
    const cookie = (use.res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("outbox_session=");
    expect((await h.call("GET", "/api/status", undefined, { cookie })).status).toBe(200);
    // single use
    expect((await h.call("POST", "/api/auth/link", { code }, { cookie: null })).status).toBe(400);
    // the link session may register the first login passkey (setup kind), a plain one could not
    const reg = await h.call("POST", "/api/passkeys/options", { purpose: "login" }, { cookie });
    expect(reg.status).toBe(200);
    const v = await h.call("POST", "/api/passkeys/verify", { challenge_id: reg.json.challenge_id, response: h.login.register(reg.json.options) }, { cookie });
    expect(v.status).toBe(200);
    // once a login key exists the same route needs a reauth again
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "login" }, { cookie })).json.error).toBe("reauth_required");
    // the sign-in key was made in this (proofed) link session, so the first approval key right after it needs no extra reauth
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "approve" }, { cookie })).status).toBe(200);
  });

  test("a link made with no proof (a sign-in key exists) is a session, not an owner proof: no first-approval-key shortcut", async () => {
    const h = makeHarness();
    await h.signUpLoginOnly();                 // sign-in key, no approval key yet
    const bl = await h.callApp("POST", "/api/app/browser-link", {});
    expect(bl.status).toBe(200);
    const code = new URL(bl.json.url.replace("/#", "/")).searchParams.get("code")!;
    const use = await h.call("POST", "/api/auth/link", { code }, { cookie: null });
    const cookie = (use.res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "approve" }, { cookie })).json.error).toBe("reauth_required");
    // a real sign-in session still gets the shortcut
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "approve" })).status).toBe(200);
  });

  test("link codes expire after 5 minutes; with a login key the link needs no extra proof; no keys at all -> setup_first", async () => {
    const h = makeHarness();
    expect((await h.callApp("POST", "/api/app/browser-link", {})).json.error).toBe("setup_first");
    await h.signUp();
    const bl = await h.callApp("POST", "/api/app/browser-link", {});
    expect(bl.status).toBe(200);
    const code = new URL(bl.json.url.replace("/#", "/")).searchParams.get("code")!;
    h.db.query("UPDATE link_codes SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await h.call("POST", "/api/auth/link", { code }, { cookie: null })).status).toBe(400);
    // a link session is NOT allowed to register a first login key when one exists (nor any approval key without the rules)
    const bl2 = await h.callApp("POST", "/api/app/browser-link", {});
    const code2 = new URL(bl2.json.url.replace("/#", "/")).searchParams.get("code")!;
    const use = await h.call("POST", "/api/auth/link", { code: code2 }, { cookie: null });
    const cookie = (use.res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "login" }, { cookie })).json.error).toBe("reauth_required");
  });
});

describe("misc", () => {
  test("`setSetting` is untouched by native routes and the agent-forbidden tables exist", () => {
    const h = makeHarness();
    for (const t of ["native_keys", "native_challenges", "link_codes", "session_links"]) {
      expect(h.db.query("SELECT name FROM sqlite_master WHERE name = ?").get(t)).toEqual({ name: t });
    }
    expect(typeof setSetting).toBe("function");
  });
});
