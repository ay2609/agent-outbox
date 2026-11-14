import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, seedBatch, SoftAuthenticator } from "./testkit";
import { DEFAULT_PIN_POLICY } from "../core/types";
import { coseToX963 } from "./auth";
import { fromB64u } from "./b64";
import { SetupToken } from "./setup-token";
import { openDb } from "../db";

const RP = "localhost", ORIGIN = "http://localhost:7477";

describe("passkey registration (two purposes)", () => {
  test("setup enrols a sign-in key, then an approve key, with distinct user ids and names; pin files hold the approve key only", async () => {
    const h = makeHarness();
    const o1 = await h.call("POST", "/api/auth/register/options", { purpose: "login", label: "Phone sign-in", setup_token: h.setupToken }, { cookie: null });
    expect(o1.json.options.user.name).toBe("Sign in to Outbox");
    expect(h.cookie).toBe("");
    const v1 = await h.call("POST", "/api/auth/register/verify", { challenge_id: o1.json.challenge_id, response: h.login.register(o1.json.options), label: "Phone sign-in", setup_token: h.setupToken }, { cookie: null });
    expect(v1.status).toBe(200);
    expect(v1.json.purpose).toBe("login");
    h.cookie = (v1.res.headers.get("set-cookie") ?? "").split(";")[0]!;
    // no user pin yet: there is no approve key
    expect(existsSync(join(h.dir, "passkeys.json"))).toBe(false);
    expect((await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json.setup).toEqual({ login: true, approve: false });

    const o2 = await h.call("POST", "/api/passkeys/options", { purpose: "approve", label: "Phone approve" });
    expect(o2.status).toBe(200);
    expect(o2.json.options.user.name).toBe("APPROVE SENDING (Outbox)");
    expect(o2.json.options.user.id).not.toBe(o1.json.options.user.id);
    // the login key must not be excluded, or one phone couldn't hold both
    expect(o2.json.options.excludeCredentials ?? []).toEqual([]);
    const v2 = await h.call("POST", "/api/passkeys/verify", { challenge_id: o2.json.challenge_id, response: h.auth.register(o2.json.options), label: "Phone approve" });
    expect(v2.status).toBe(200);

    const rows = h.db.query<any, []>("SELECT * FROM passkeys ORDER BY created_at").all();
    expect(rows.map((r) => r.purpose)).toEqual(["login", "approve"]);
    expect(rows[0].user_handle).toBe(o1.json.options.user.id);
    expect(rows[1].user_handle).toBe(o2.json.options.user.id);
    expect(rows[0].user_handle).not.toBe(rows[1].user_handle);
    expect(Buffer.from(coseToX963(fromB64u(rows[1].public_key_cose_b64))).equals(h.auth.x963)).toBe(true);
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin).toEqual({ v: 2, rp_id: RP, origin: ORIGIN, keys: [{ credential_id: h.auth.id, x963: h.auth.x963.toString("base64url"), label: "Phone approve" }], policy: DEFAULT_PIN_POLICY });
    expect(JSON.stringify(pin)).not.toContain(h.login.id);
    // the user pin is owner-only, and the old candidate / dev files are gone for good
    expect(statSync(join(h.dir, "passkeys.json")).mode & 0o777).toBe(0o600);
    for (const f of ["pin-candidate.json", "dev-passkeys.json"]) expect(existsSync(join(h.dir, f))).toBe(false);
    expect((await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json.setup).toEqual({ login: true, approve: true });
  });

  test("the user pin is written (0600, atomically) on registration, and again on every policy change, with no temp files left", async () => {
    const h = makeHarness();
    await h.signUp();
    const path = join(h.dir, "passkeys.json");
    expect(JSON.parse(readFileSync(path, "utf8")).policy).toEqual(DEFAULT_PIN_POLICY);
    const r = await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: false });
    expect(r.status).toBe(200);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(h.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("session cookie: HttpOnly + SameSite=Strict always; Secure only for a non-loopback (https) origin", async () => {
    const remote = makeHarness({ origin: "https://outbox.example" });
    remote.login.origin = "https://outbox.example";
    const o = await remote.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: remote.setupToken }, { cookie: null });
    const v = await remote.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: remote.login.register(o.json.options), setup_token: remote.setupToken }, { cookie: null });
    const sc = v.res.headers.get("set-cookie")!;
    expect(sc).toContain("HttpOnly"); expect(sc).toContain("Secure"); expect(sc).toContain("SameSite=Strict");
    // http://localhost: a Secure cookie would be dropped by Safari, so it is not set
    const local = makeHarness();
    await local.signUp();
    const o2 = await local.call("POST", "/api/auth/login/options", {}, { cookie: null });
    const v2 = await local.call("POST", "/api/auth/login/verify", { challenge_id: o2.json.challenge_id, response: local.login.assert(o2.json.options) }, { cookie: null });
    const sc2 = v2.res.headers.get("set-cookie")!;
    expect(sc2).toContain("HttpOnly"); expect(sc2).toContain("SameSite=Strict"); expect(sc2).not.toContain("Secure");
  });

  test("registration options request P-256 only, resident key and UV required", async () => {
    const h = makeHarness();
    const o = await h.call("POST", "/api/auth/register/options", { setup_token: h.setupToken }, { cookie: null });
    expect(o.json.options.pubKeyCredParams).toEqual([{ alg: -7, type: "public-key" }]);
    expect(o.json.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(o.json.options.rp.id).toBe("localhost");
    expect(o.json.options.user.name).toBe("Sign in to Outbox"); // default purpose
  });

  test("unauthenticated registration is open only while zero keys of that purpose exist (and, for approve, no login key)", async () => {
    const h = makeHarness();
    // approve first, with nothing else registered: allowed by the rule...
    const ap = await h.call("POST", "/api/auth/register/options", { purpose: "approve", setup_token: h.setupToken }, { cookie: null });
    expect(ap.status).toBe(200);
    // two challenges issued while empty
    const o1 = await h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null });
    const o2 = await h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null });
    await h.signUp();
    // ...and locked once the login key exists, for both purposes
    for (const purpose of ["login", "approve"]) {
      const locked = await h.call("POST", "/api/auth/register/options", { purpose }, { cookie: null });
      expect([purpose, locked.status, locked.json.error]).toEqual([purpose, 403, "registration_locked"]);
    }
    // stale challenges can't plant an attacker's key
    const attacker = new SoftAuthenticator(RP, ORIGIN);
    for (const o of [o1, o2, ap]) {
      const stale = await h.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: attacker.register(o.json.options) }, { cookie: null });
      expect(stale.status).toBe(403); expect(stale.json.error).toBe("registration_locked");
    }
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM passkeys").get()!.n).toBe(2);
  });

  test("two simultaneous first registrations: exactly one wins (count check + insert in one immediate transaction)", async () => {
    const h = makeHarness();
    const a = new SoftAuthenticator(RP, ORIGIN), b = new SoftAuthenticator(RP, ORIGIN);
    const [oa, ob] = await Promise.all([
      h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null }),
      h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null }),
    ]);
    const [va, vb] = await Promise.all([
      h.call("POST", "/api/auth/register/verify", { challenge_id: oa.json.challenge_id, response: a.register(oa.json.options), setup_token: h.setupToken }, { cookie: null }),
      h.call("POST", "/api/auth/register/verify", { challenge_id: ob.json.challenge_id, response: b.register(ob.json.options), setup_token: h.setupToken }, { cookie: null }),
    ]);
    expect([va.status, vb.status].sort()).toEqual([200, 403]);
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM passkeys WHERE purpose = 'login'").get()!.n).toBe(1);
  });

  test("a key registered after the options were issued blocks that challenge", async () => {
    const h = makeHarness();
    const o = await h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null });
    const resp = h.login.register(o.json.options);
    // another registration sneaks in (as a second connection would) before our insert
    const other = new SoftAuthenticator(RP, ORIGIN);
    h.db.query("INSERT INTO passkeys(credential_id, public_key_cose_b64, public_key_x963_b64, counter, label, purpose, user_handle, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(other.id, "x", other.x963.toString("base64url"), 0, "sneaky", "login", "u", new Date().toISOString());
    const v = await h.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: resp, setup_token: h.setupToken }, { cookie: null });
    expect(v.status).toBe(403);
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM passkeys").get()!.n).toBe(1);
  });

  test("adding a later key (either purpose) needs a session AND a fresh sign-in assertion", async () => {
    const h = makeHarness();
    await h.signUp();
    const second = new SoftAuthenticator(RP, ORIGIN);
    // no session
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "approve" }, { cookie: null })).status).toBe(401);
    // session but no reauth: the setup exemption is gone once an approve key exists
    const noRe = await h.call("POST", "/api/passkeys/options", { label: "iPad", purpose: "approve" });
    expect(noRe.status).toBe(403); expect(noRe.json.error).toBe("reauth_required");
    const noRe2 = await h.call("POST", "/api/passkeys/options", { label: "iPad", purpose: "login" });
    expect(noRe2.status).toBe(403);
    const opts = await h.call("POST", "/api/passkeys/options", { label: "iPad", purpose: "approve", reauth: await h.reauth() });
    expect(opts.status).toBe(200);
    // same purpose shares the user id; excludeCredentials only lists same-purpose keys
    expect(opts.json.options.excludeCredentials.map((c: any) => c.id)).toEqual([h.auth.id]);
    expect(opts.json.options.user.name).toBe("APPROVE SENDING (Outbox)");
    const ok = await h.call("POST", "/api/passkeys/verify", { challenge_id: opts.json.challenge_id, response: second.register(opts.json.options), label: "iPad" });
    expect(ok.status).toBe(200);
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.keys.map((k: any) => k.label).sort()).toEqual(["Test approve", "iPad"]);
    expect(h.db.query<any, []>("SELECT DISTINCT user_handle FROM passkeys WHERE purpose = 'approve'").all()).toHaveLength(1);
  });

  test("the setup exemption (no reauth for the first approve key) needs a fresh session and is only for the approve purpose", async () => {
    const h = makeHarness();
    await h.signUpLoginOnly();
    // a login-purpose addition always needs a reauth
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "login" })).status).toBe(403);
    // an old session loses the exemption
    h.db.query("UPDATE sessions SET created_at = ?").run(new Date(Date.now() - 31 * 60_000).toISOString());
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "approve" })).json.error).toBe("reauth_required");
    h.db.query("UPDATE sessions SET created_at = ?").run(new Date().toISOString());
    expect((await h.call("POST", "/api/passkeys/options", { purpose: "approve" })).status).toBe(200);
  });

  test("a setup challenge can't be replayed after the approve key exists", async () => {
    const h = makeHarness();
    await h.signUpLoginOnly();
    const o = await h.call("POST", "/api/passkeys/options", { purpose: "approve" });
    const o2 = await h.call("POST", "/api/passkeys/options", { purpose: "approve" });
    const a = new SoftAuthenticator(RP, ORIGIN), b = new SoftAuthenticator(RP, ORIGIN);
    expect((await h.call("POST", "/api/passkeys/verify", { challenge_id: o.json.challenge_id, response: a.register(o.json.options) })).status).toBe(200);
    expect((await h.call("POST", "/api/passkeys/verify", { challenge_id: o2.json.challenge_id, response: b.register(o2.json.options) })).status).toBe(403);
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM passkeys WHERE purpose='approve'").get()!.n).toBe(1);
  });

  test("a non-UV or wrong-origin registration is refused", async () => {
    const h = makeHarness();
    const o = await h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null });
    const bad = await h.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: h.login.register(o.json.options, { uv: false }), setup_token: h.setupToken }, { cookie: null });
    expect(bad.status).toBe(400);
    const o2 = await h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null });
    const bad2 = await h.call("POST", "/api/auth/register/verify", { challenge_id: o2.json.challenge_id, response: h.login.register(o2.json.options, { origin: "https://evil.example" }), setup_token: h.setupToken }, { cookie: null });
    expect(bad2.status).toBe(400);
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM passkeys").get()!.n).toBe(0);
  });
});

describe("passkey purposes in assertions", () => {
  test("login and reauth offer login keys only; approve options offer approve keys only", async () => {
    const h = makeHarness();
    await h.signUp();
    const lo = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    expect(lo.json.options.allowCredentials.map((c: any) => c.id)).toEqual([h.login.id]);
    const ro = await h.call("POST", "/api/auth/reauth/options", {});
    expect(ro.json.options.allowCredentials.map((c: any) => c.id)).toEqual([h.login.id]);
    const seed = seedBatch(h.db, 1);
    const ao = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds });
    expect(ao.json.options.allowCredentials.map((c: any) => c.id)).toEqual([h.auth.id]);
  });

  test("an approve key can't sign in or reauth, and a login key can't approve", async () => {
    const h = makeHarness();
    await h.signUp();
    const lo = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    const harvested = await h.call("POST", "/api/auth/login/verify", { challenge_id: lo.json.challenge_id, response: h.auth.assert(lo.json.options) }, { cookie: null });
    expect(harvested.status).toBe(401);
    const ro = await h.call("POST", "/api/auth/reauth/options", {});
    const re = await h.call("PATCH", "/api/settings", { transport: "live", reauth: { challenge_id: ro.json.challenge_id, response: h.auth.assert(ro.json.options) } });
    expect([401, 409]).toContain(re.status); // 409 when the pin isn't live-allowed, which is checked first; 401 here once it is
    const seed = seedBatch(h.db, 1);
    const ao = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds });
    const stolen = await h.call("POST", `/api/batches/${seed.batchId}/approve/verify`, { challenge_id: ao.json.challenge_id, response: h.login.assert(ao.json.options) });
    expect(stolen.status).toBe(401); expect(stolen.json.error).toBe("approval_failed");
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(0);
  });

  test("approve options refuse when there is no approve key yet", async () => {
    const h = makeHarness();
    await h.signUpLoginOnly();
    const seed = seedBatch(h.db, 1);
    const ao = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds });
    expect(ao.status).toBe(409); expect(ao.json.error).toBe("no_passkeys");
  });
});

describe("sessions, CSRF and errors", () => {
  test("every /api route except /api/auth needs a session", async () => {
    const h = makeHarness();
    await h.signUp();
    for (const [m, p] of [["GET", "/api/status"], ["GET", "/api/batches"], ["GET", "/api/settings"], ["GET", "/api/contacts"], ["POST", "/api/stop"], ["GET", "/api/activity"]] as const) {
      const r = await h.call(m, p, m === "POST" ? {} : undefined, { cookie: null });
      expect(r.status).toBe(401);
    }
    expect((await h.call("GET", "/api/status")).status).toBe(200);
    expect((await h.call("GET", "/api/nope")).status).toBe(404);
  });

  test("a bogus or expired session is rejected; logout kills the session", async () => {
    const h = makeHarness();
    await h.signUp();
    expect((await h.call("GET", "/api/status", undefined, { cookie: "outbox_session=nope" })).status).toBe(401);
    h.db.query("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await h.call("GET", "/api/status")).status).toBe(401);
    const h2 = makeHarness(); await h2.signUp();
    expect((await h2.call("POST", "/api/auth/logout", {})).status).toBe(200);
    expect((await h2.call("GET", "/api/status")).status).toBe(401);
  });

  test("sessions store only a hash and last 30 days", async () => {
    const h = makeHarness();
    await h.signUp();
    const token = h.cookie.split("=")[1]!;
    const row = h.db.query<any, []>("SELECT * FROM sessions").get()!;
    expect(row.token_sha256).not.toBe(token);
    expect(row.token_sha256).toHaveLength(64);
    const days = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 86400_000;
    expect(Math.round(days)).toBe(30);
  });

  test("a mutation without the X-Outbox header is refused (even with a valid session)", async () => {
    const h = makeHarness();
    await h.signUp();
    const r = await h.call("POST", "/api/stop", {}, { csrf: false });
    expect(r.status).toBe(403); expect(r.json.error).toBe("csrf");
    expect(h.db.query<any, []>("SELECT value FROM settings WHERE key='kill_switch'").get()!.value).toBe("0");
    // login endpoints need it too
    expect((await h.call("POST", "/api/auth/login/options", {}, { csrf: false, cookie: null })).status).toBe(403);
  });

  test("a mutation with a foreign Origin is refused", async () => {
    const h = makeHarness();
    await h.signUp();
    const res = await h.request("/api/stop", { method: "POST", headers: { cookie: h.cookie, "x-outbox": "1", origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(403);
  });

  test("errors are JSON with no stack trace", async () => {
    const h = makeHarness();
    await h.signUp();
    const bad = await h.call("POST", "/api/batches/x/approve/options", { draft_ids: "nope" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).not.toContain("at ");
    const nf = await h.call("GET", "/api/batches/does-not-exist");
    expect(nf.status).toBe(404);
    expect(nf.json.error).toBe("not_found");
  });

  test("unexpected exceptions return a generic 500, not a stack", async () => {
    const h = makeHarness({ db: () => { throw new Error("boom at /secret/path.ts:12"); } });
    const r = await h.call("GET", "/api/auth/state");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain("secret");
    expect(r.json.error).toBe("internal");
  });
});

describe("login", () => {
  test("login with the sign-in passkey; single-use challenge; unknown key refused", async () => {
    const h = makeHarness();
    await h.signUp();
    const o = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    expect(o.json.options.userVerification).toBe("required");
    const resp = h.login.assert(o.json.options);
    const ok = await h.call("POST", "/api/auth/login/verify", { challenge_id: o.json.challenge_id, response: resp }, { cookie: null });
    expect(ok.status).toBe(200);
    const replay = await h.call("POST", "/api/auth/login/verify", { challenge_id: o.json.challenge_id, response: resp }, { cookie: null });
    expect(replay.status).toBe(400); expect(replay.json.error).toBe("challenge_invalid");
    const o2 = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    const stranger = new SoftAuthenticator("localhost", "http://localhost:7477");
    expect((await h.call("POST", "/api/auth/login/verify", { challenge_id: o2.json.challenge_id, response: stranger.assert(o2.json.options) }, { cookie: null })).status).toBe(401);
  });

  test("login refused without user verification", async () => {
    const h = makeHarness();
    await h.signUp();
    const o = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    const r = await h.call("POST", "/api/auth/login/verify", { challenge_id: o.json.challenge_id, response: h.login.assert(o.json.options, { uv: false }) }, { cookie: null });
    expect(r.status).toBe(401);
  });

  test("an expired challenge is refused", async () => {
    const h = makeHarness();
    await h.signUp();
    const o = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    h.db.query("UPDATE webauthn_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const r = await h.call("POST", "/api/auth/login/verify", { challenge_id: o.json.challenge_id, response: h.login.assert(o.json.options) }, { cookie: null });
    expect(r.status).toBe(400); expect(r.json.error).toBe("challenge_expired");
  });

  test("failed logins are rate limited (429 + Retry-After), and a good login is locked out too until the window passes", async () => {
    const h = makeHarness({ loginMaxFailures: 3, loginWindowMs: 60_000 });
    await h.signUp();
    const stranger = new SoftAuthenticator("localhost", "http://localhost:7477");
    for (let i = 0; i < 3; i++) {
      const o = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
      const r = await h.call("POST", "/api/auth/login/verify", { challenge_id: o.json.challenge_id, response: stranger.assert(o.json.options) }, { cookie: null });
      expect(r.status).toBe(401);
    }
    const locked = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    expect(locked.status).toBe(429);
    expect(locked.res.headers.get("retry-after")).toBeTruthy();
  });

  test("the limiter is per route and session: a local agent spamming bad logins can't lock the owner out of reauth or approve", async () => {
    const h = makeHarness({ loginMaxFailures: 3, loginWindowMs: 60_000 });
    await h.signUp();
    const stranger = new SoftAuthenticator("localhost", "http://localhost:7477");
    for (let i = 0; i < 3; i++) {
      const o = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
      await h.call("POST", "/api/auth/login/verify", { challenge_id: o.json.challenge_id, response: stranger.assert(o.json.options) }, { cookie: null });
    }
    expect((await h.call("POST", "/api/auth/login/options", {}, { cookie: null })).status).toBe(429); // anonymous login: locked
    // ...but the signed-in owner still reauths and approves
    expect((await h.call("POST", "/api/auth/reauth/options", {})).status).toBe(200);
    const seed = seedBatch(h.db, 1);
    const ao = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds });
    const v = await h.call("POST", `/api/batches/${seed.batchId}/approve/verify`, { challenge_id: ao.json.challenge_id, response: h.auth.assert(ao.json.options) });
    expect(v.status).toBe(200);
  });

  test("bad approvals lock only approving for that session, not login", async () => {
    const h = makeHarness({ loginMaxFailures: 2, loginWindowMs: 60_000 });
    await h.signUp();
    const seed = seedBatch(h.db, 1);
    for (let i = 0; i < 2; i++) {
      const ao = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds });
      const bad = await h.call("POST", `/api/batches/${seed.batchId}/approve/verify`, { challenge_id: ao.json.challenge_id, response: h.auth.assert(ao.json.options, { uv: false }) });
      expect(bad.status).toBe(401);
    }
    const ao = await h.call("POST", `/api/batches/${seed.batchId}/approve/options`, { draft_ids: seed.draftIds });
    const locked = await h.call("POST", `/api/batches/${seed.batchId}/approve/verify`, { challenge_id: ao.json.challenge_id, response: h.auth.assert(ao.json.options) });
    expect(locked.status).toBe(429);
    const lo = await h.call("POST", "/api/auth/login/options", {}, { cookie: null });
    expect(lo.status).toBe(200);
  });
});

describe("audit and security headers", () => {
  test("mutations write audit rows", async () => {
    const h = makeHarness();
    await h.signUp();
    await h.call("POST", "/api/stop", {});
    await h.call("POST", "/api/resume", {});
    const actions = h.db.query<any, []>("SELECT action FROM audit_log").all().map((r) => r.action);
    expect(actions).toContain("passkey.register");
    expect(actions).toContain("stop");
    expect(actions).toContain("resume");
  });
  test("responses carry CSP and no-store on the API", async () => {
    const h = makeHarness();
    const r = await h.call("GET", "/api/auth/state");
    expect(r.res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("first-run setup token", () => {
  const open = (h: { call: Function }, body: object) => h.call("POST", "/api/auth/register/options", body, { cookie: null });
  const keys = (h: { db: any }) => h.db.query("SELECT COUNT(*) n FROM passkeys").get().n as number;

  test("open registration without a token is refused (options and verify, either purpose), and creates nothing", async () => {
    const h = makeHarness();
    expect((await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json.setup_token_required).toBe(true);
    for (const purpose of ["login", "approve"]) {
      const o = await open(h, { purpose });
      expect([purpose, o.status, o.json.error]).toEqual([purpose, 403, "setup_token_required"]);
    }
    // an empty string counts as missing
    expect((await open(h, { purpose: "login", setup_token: "" })).json.error).toBe("setup_token_required");
    // a challenge obtained with the token, then verified without it
    const o = await open(h, { purpose: "login", setup_token: h.setupToken });
    const v = await h.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: h.login.register(o.json.options) }, { cookie: null });
    expect([v.status, v.json.error]).toEqual([403, "setup_token_required"]);
    expect(keys(h)).toBe(0);
  });

  test("a wrong token is refused on options and on verify, and nothing is enrolled", async () => {
    const h = makeHarness();
    const wrong = h.setupToken.slice(0, -1) + (h.setupToken.endsWith("A") ? "B" : "A");
    for (const purpose of ["login", "approve"]) {
      const o = await open(h, { purpose, setup_token: wrong });
      expect([purpose, o.status, o.json.error]).toEqual([purpose, 403, "setup_token_invalid"]);
    }
    expect((await open(h, { purpose: "login", setup_token: "short" })).json.error).toBe("setup_token_invalid");
    expect((await open(h, { purpose: "login", setup_token: h.setupToken + "x" })).json.error).toBe("setup_token_invalid");
    const o = await open(h, { purpose: "login", setup_token: h.setupToken });
    const v = await h.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: h.login.register(o.json.options), setup_token: wrong }, { cookie: null });
    expect([v.status, v.json.error]).toEqual([403, "setup_token_invalid"]);
    expect(keys(h)).toBe(0);
    expect(existsSync(h.setup.path)).toBe(true);
  });

  test("missing and wrong tokens count toward the register limiter; once it trips, even the right token is refused for a while", async () => {
    const h = makeHarness();
    for (let i = 0; i < 4; i++) expect((await open(h, { purpose: "login" })).json.error).toBe("setup_token_required");
    for (let i = 0; i < 4; i++) expect((await open(h, { purpose: "login", setup_token: "nope" })).json.error).toBe("setup_token_invalid");
    const locked = await open(h, { purpose: "login", setup_token: h.setupToken });
    expect([locked.status, locked.json.error]).toEqual([429, "rate_limited"]);
    expect(locked.res.headers.get("retry-after")).toBeTruthy();
    expect(keys(h)).toBe(0);
  });

  test("the right token enrols the first sign-in key; then the file is deleted, the state flag is false and the token is dead", async () => {
    const h = makeHarness();
    expect(existsSync(h.setup.path)).toBe(true);
    expect((await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json.setup_token_required).toBe(true);
    await h.signUpLoginOnly();
    expect(keys(h)).toBe(1);
    expect(existsSync(h.setup.path)).toBe(false);
    expect(h.setup.active).toBe(false);
    expect(h.setup.matches(h.setupToken)).toBe(false);
    const st = (await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json;
    expect(st.setup_token_required).toBe(false);
    expect(JSON.stringify(st)).not.toContain(h.setupToken);
    // the approval key afterwards is session-based and needs no token
    const o = await h.call("POST", "/api/passkeys/options", { purpose: "approve" });
    expect(o.status).toBe(200);
    expect(JSON.stringify(o.json)).not.toContain(h.setupToken);
  });

  test("an approve-purpose open registration with the token also works (and is the only way in without a session)", async () => {
    const h = makeHarness();
    const o = await open(h, { purpose: "approve", setup_token: h.setupToken });
    expect(o.status).toBe(200);
    const v = await h.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: h.auth.register(o.json.options), setup_token: h.setupToken }, { cookie: null });
    expect(v.status).toBe(200);
    // an approve key is not a sign-in key: the token stays until a sign-in key exists
    expect(existsSync(h.setup.path)).toBe(true);
    expect(h.setup.active).toBe(true);
  });

  test("session-based enrolment is unchanged: no token needed for the approval key or later keys", async () => {
    const h = makeHarness();
    await h.signUp();
    const more = await h.call("POST", "/api/passkeys/options", { purpose: "approve", reauth: await h.reauth() });
    expect(more.status).toBe(200);
  });

  test("the token is persisted while unused: generate, reload, same token; the file is 0600 and 43 base64url characters", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-st-"));
    const path = join(dir, "state", "setup-token");
    const db = openDb(":memory:");
    const t1 = new SetupToken(path);
    const tok = t1.start(db)!;
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(tok);
    expect(readdirSync(join(dir, "state")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const t2 = new SetupToken(path);
    expect(t2.start(db)).toBe(tok);
    expect(t2.matches(tok)).toBe(true);
    expect(t2.matches(tok.slice(1))).toBe(false);
    expect(t2.matches(undefined)).toBe(false);
    // a second token store over the same path never matches before start()
    expect(new SetupToken(path).matches(tok)).toBe(false);
  });

  test("a malformed, world-readable or symlinked token file is replaced, never trusted or followed", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-st-"));
    const db = openDb(":memory:");
    const path = join(dir, "setup-token");
    writeFileSync(path, "not-a-token\n", { mode: 0o600 });
    const a = new SetupToken(path).start(db)!;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(path, "utf8").trim()).toBe(a);
    // readable by others: regenerated
    const loose = "A".repeat(43);
    writeFileSync(path, loose + "\n");
    chmodSync(path, 0o644);
    const b = new SetupToken(path).start(db)!;
    expect(b).not.toBe(loose);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // a symlink at the path: its target is not read, and not written through
    const target = join(dir, "elsewhere");
    writeFileSync(target, "B".repeat(43) + "\n", { mode: 0o600 });
    mkdirSync(join(dir, "x"));
    const link = join(dir, "x", "setup-token");
    symlinkSync(target, link);
    const c = new SetupToken(link).start(db)!;
    expect(c).not.toBe("B".repeat(43));
    expect(readFileSync(target, "utf8").trim()).toBe("B".repeat(43));
    expect(statSync(link).isFile()).toBe(true);
  });

  test("at server start with a sign-in key already registered: no token, and a leftover file is deleted", async () => {
    const h = makeHarness();
    await h.signUpLoginOnly();
    writeFileSync(h.setup.path, "A".repeat(43) + "\n", { mode: 0o600 });
    const again = new SetupToken(h.setup.path);
    expect(again.start(h.db)).toBeNull();
    expect(again.active).toBe(false);
    expect(existsSync(h.setup.path)).toBe(false);
  });

  test("if every sign-in key is gone, the next start issues a fresh token", async () => {
    const h = makeHarness();
    await h.signUpLoginOnly();
    const old = h.setupToken;
    h.db.query("DELETE FROM passkeys").run();
    const next = new SetupToken(h.setup.path).start(h.db)!;
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(next).not.toBe(old);
  });

  test("a server that never started its token store refuses open registration (fails closed)", async () => {
    const h = makeHarness({ setupToken: new SetupToken(join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-st-")), "setup-token")) });
    const o = await open(h, { purpose: "login", setup_token: h.setupToken });
    expect([o.status, o.json.error]).toEqual([403, "setup_token_invalid"]);
  });
});
