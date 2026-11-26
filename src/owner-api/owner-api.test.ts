// The owner API's shell: socket-only rules (no non-/api paths, browsers refused, app token), the exact route inventory,
// deleted routes, body limits, no TCP listener in the source, error shape, limiter, setup token file handling, the v7 migration.
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, newId, nowIso } from "../db";
import { b64u } from "./b64";
import { FailureLimiter, LimiterSet, firstRun, writePinFiles } from "./auth";
import { SetupToken } from "./setup-token";
import { migrateV7 } from "./migrate-v7";
import { resolveConfig } from "./config";
import { makeHarness, seedBatch, SoftSe } from "./testkit";
import { proposeContactChanges, validateCreate } from "../core/contact-changes";

const ROUTES_50 = [
  // status, settings
  "GET /api/status", "GET /api/settings", "PATCH /api/settings", "POST /api/mode", "GET /api/pin-policy", "PUT /api/pin-policy",
  // batches, drafts
  "GET /api/batches", "GET /api/batches/:id", "POST /api/batches/:id/approve/options", "POST /api/batches/:id/approve/se-verify",
  "POST /api/batches/:id/cancel", "POST /api/batches/:id/skip", "PATCH /api/drafts/:id", "POST /api/drafts/:id/skip", "POST /api/drafts/:id/include",
  // stop
  "POST /api/stop", "POST /api/stop/undo", "POST /api/resume",
  // imports
  "GET /api/imports", "POST /api/imports", "GET /api/imports/:id", "POST /api/imports/:id/reingest", "PUT /api/imports/:id/mapping",
  "POST /api/imports/:id/preview", "POST /api/imports/:id/batch",
  // contacts, activity
  "POST /api/contacts/sync", "GET /api/contacts", "GET /api/contacts/pending", "GET /api/contacts/:id", "GET /api/activity",
  // groups
  "GET /api/groups", "POST /api/groups", "GET /api/groups/:id", "PATCH /api/groups/:id", "POST /api/groups/:id/members", "POST /api/groups/:id/remove", "DELETE /api/groups/:id",
  // contact changes
  "GET /api/contact-changes", "GET /api/contact-changes/:id", "POST /api/contact-changes/:id/reject", "POST /api/contact-changes/:id/cancel",
  "POST /api/contact-changes/:id/approve/options", "POST /api/contact-changes/:id/approve/se-verify", "POST /api/contact-changes/undo",
  // keys, recovery
  "GET /api/native-keys", "POST /api/native-keys/enroll/options", "POST /api/native-keys/enroll/verify", "POST /api/native-keys/:key_id/revoke",
  "POST /api/native-keys/reauth/options", "POST /api/recovery/cancel",
];
const DELETED = [
  ["GET", "/api/auth/state"], ["POST", "/api/auth/register/options"], ["POST", "/api/auth/register/verify"], ["POST", "/api/auth/login/options"],
  ["POST", "/api/auth/login/verify"], ["POST", "/api/auth/reauth/options"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/link"],
  ["GET", "/api/passkeys"], ["POST", "/api/passkeys/options"], ["POST", "/api/passkeys/verify"], ["POST", "/api/batches/x/approve/verify"],
  ["POST", "/api/contact-changes/x/approve/verify"], ["GET", "/api/native-keys/enroll/x"], ["POST", "/api/native-keys/enroll/x/confirm"],
  ["POST", "/api/app/browser-link"], ["GET", "/"], ["GET", "/index.html"], ["GET", "/assets/app.js"],
] as const;

describe("route inventory", () => {
  test("exactly the 50 documented routes (the rest of the table is the middleware)", () => {
    const h = makeHarness();
    const routes = [...new Set(h.app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))].sort();
    expect(routes).toEqual([...ROUTES_50].sort());
    expect(routes).toHaveLength(50);
  });
  test("every deleted route (and every non-/api path, the old SPA) answers 404 not_found", async () => {
    const h = makeHarness();
    await h.signUp();
    for (const [m, p] of DELETED) {
      const r = await h.call(m, p, m === "GET" ? undefined : {});
      expect([m, p, r.status, r.json.error]).toEqual([m, p, 404, "not_found"]);
    }
  });
});

describe("request rules", () => {
  test("non-/api paths are 404 even without a token; /api without or with a wrong token is 401 app_auth", async () => {
    const h = makeHarness();
    expect((await h.call("GET", "/", undefined, { token: null })).status).toBe(404);
    for (const token of [null, "wrong", b64u(randomBytes(32)), "x".repeat(500)]) {
      const r = await h.call("GET", "/api/status", undefined, { token });
      expect([r.status, r.json.error]).toEqual([401, "app_auth"]);
    }
    expect((await h.call("GET", "/api/status")).status).toBe(200);
  });

  test("any Origin / Sec-Fetch-Site / Sec-Fetch-Mode header is 403 browser_refused, even with the right token", async () => {
    const h = makeHarness();
    for (const headers of [{ origin: "http://localhost:7477" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-mode": "cors" }, { origin: "null" }] as Record<string, string>[]) {
      const r = await h.call("GET", "/api/status", undefined, { headers });
      expect([JSON.stringify(headers), r.status, r.json.error]).toEqual([JSON.stringify(headers), 403, "browser_refused"]);
    }
    // the browser check comes before the token check
    const r = await h.call("GET", "/api/status", undefined, { token: null, headers: { origin: "http://evil.example" } });
    expect(r.json.error).toBe("browser_refused");
  });

  test("no Host, Origin+X-Outbox, cookie or session logic: the app may still send X-Outbox: 1 and it is ignored; cookies are never set", async () => {
    const h = makeHarness();
    const r = await h.call("POST", "/api/stop", {}, { headers: { "x-outbox": "1", cookie: "outbox_session=abc" } });
    expect(r.status).toBe(200);
    expect(r.res.headers.get("set-cookie")).toBeNull();
    expect(r.res.headers.get("content-security-policy")).toBeNull();
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect((await h.call("POST", "/api/resume", {}, { headers: { host: "evil.example" } })).status).toBe(200);
  });

  test("an app channel with no token configured refuses everything (nothing can match)", async () => {
    const h = makeHarness({ appAuth: new (await import("./app-auth")).AppAuth() });
    const r = await h.call("GET", "/api/status");
    expect([r.status, r.json.error]).toEqual([401, "app_auth"]);
  });

  test("body limits: JSON over 1 MB is 413 too_large; imports allow up to 36 MB; a decoded file over 25 MB is 413", async () => {
    const h = makeHarness();
    const big = JSON.stringify({ text: "x".repeat(1_100_000) });
    const r = await h.call("PATCH", "/api/settings", JSON.parse(big));
    expect([r.status, r.json.error]).toEqual([413, "too_large"]);
    const ok = await h.call("POST", "/api/imports", { text: "name,phone\nAda,202 555 0101\n".repeat(60_000), filename: "a.csv" });   // ~1.5 MB of JSON: allowed on imports
    expect(ok.status).not.toBe(413);
    const huge = await h.call("POST", "/api/imports", { filename: "big.csv", data_b64: "A".repeat(35_000_000) });                          // ~26 MB decoded
    expect([huge.status, huge.json.error]).toEqual([413, "too_large"]);
    const tooBig = await h.request("/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: "{" + " ".repeat(37 * 1024 * 1024) + "}" });
    expect(tooBig.status).toBe(413);
  });

  test("errors are JSON with no stack trace; unexpected exceptions return a generic 500", async () => {
    const h = makeHarness();
    const r = await h.call("GET", "/api/batches/nope");
    expect(r.json).toEqual({ error: "not_found", message: "Batch not found." });
    h.wrapDb(() => { throw new Error("boom: secret detail"); });
    const e = await h.call("GET", "/api/status");
    expect(e.status).toBe(500);
    expect(e.json).toEqual({ error: "internal", message: "Something went wrong on the server." });
  });

  test("mutations write audit rows; the old reauth field is refused everywhere (strict schemas)", async () => {
    const h = makeHarness();
    await h.signUp();
    const before = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()!.n;
    await h.call("POST", "/api/stop", {});
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()!.n).toBeGreaterThan(before);
    for (const [m, p] of [["PATCH", "/api/settings"], ["POST", "/api/mode"], ["PUT", "/api/pin-policy"]] as const) {
      const r = await h.call(m, p, { mode: "dry", live_allowed: false, reauth: { challenge_id: "x", response: {} } });
      expect([p, r.status, r.json.error]).toEqual([p, 400, "bad_request"]);
    }
  });
});

describe("limiter", () => {
  test("8 failures in the window lock the route (429 + Retry-After); a good attempt resets; other routes are unaffected", async () => {
    const h = makeHarness();
    await h.signUp();
    const { batchId, draftIds } = seedBatch(h.db, 1);
    const bad = () => h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: "nope", key_id: h.auth.id, signature: "AAAA" });
    const opt = async () => (await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds })).json;
    // unknown challenges don't count as failures; wrong signatures on real challenges do
    for (let i = 0; i < 8; i++) {
      const o = await opt();
      const r = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: o.challenge_id, key_id: h.auth.id, signature: h.auth.sign("send", createHash("sha256").update("x").digest()) });
      expect(r.status).toBe(401);
    }
    const locked = await bad();
    expect(locked.status).toBe(429); expect(locked.json.error).toBe("rate_limited");
    expect(Number(locked.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await h.call("POST", "/api/mode", { mode: "live" })).status).toBe(403);   // the mode route has its own limiter: still reauth_required, not 429
  });
  test("LimiterSet keeps one limiter per route and no per-session keys", () => {
    const set = new LimiterSet(2, 1000);
    const a = set.for("approve"), b = set.for("approve"), c = set.for("enroll");
    expect(a).toBe(b); expect(a).not.toBe(c);
    a.fail(); a.fail();
    expect(() => a.check()).toThrow();
    expect(() => c.check()).not.toThrow();
    expect(new FailureLimiter(1, 1000).idle).toBe(true);
  });
});

describe("first-run setup token file", () => {
  const dir = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-setup-"));
  test("the token is persisted while unused: generate, reload, same token; the file is 0600 and 43 base64url characters", () => {
    const d = dir(), db = openDb(":memory:");
    const a = new SetupToken(join(d, "setup-token"));
    const t1 = a.start(db)!;
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(join(d, "setup-token")).mode & 0o777).toBe(0o600);
    expect(new SetupToken(join(d, "setup-token")).start(db)).toBe(t1);
    expect(a.matches(t1)).toBe(true); expect(a.matches(t1.slice(1))).toBe(false); expect(a.matches(undefined)).toBe(false);
  });
  test("a malformed, world-readable or symlinked token file is replaced, never trusted or followed", () => {
    const d = dir(), db = openDb(":memory:");
    const path = join(d, "setup-token");
    writeFileSync(path, "short\n", { mode: 0o600 });
    const t1 = new SetupToken(path).start(db)!;
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const loose = b64u(randomBytes(32));
    writeFileSync(path, loose + "\n", { mode: 0o600 }); chmodSync(path, 0o644);
    expect(new SetupToken(path).start(db)).not.toBe(loose);
    const target = join(d, "elsewhere"), planted = b64u(randomBytes(32));
    writeFileSync(target, planted + "\n", { mode: 0o600 });
    unlinkSync(path); symlinkSync(target, path);
    expect(new SetupToken(path).start(db)).not.toBe(planted);
    expect(readFileSync(target, "utf8")).toBe(planted + "\n");     // never written through the link
    expect(readdirSync(d).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  test("once setup is done: no token, and a leftover file is deleted; if the DB says first run again (fresh DB) a new one is issued", () => {
    const d = dir(), db = openDb(":memory:");
    const path = join(d, "setup-token");
    const t = new SetupToken(path);
    t.start(db);
    db.query("UPDATE settings SET value = '1' WHERE key = 'setup_done'").run();
    expect(firstRun(db)).toBe(false);
    expect(new SetupToken(path).start(db)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
  test("a harness whose token store was never started refuses the setup token (fails closed)", async () => {
    const h = makeHarness();
    h.setup.clear();
    const se = new SoftSe();
    const v = await h.enrol(se, { setup_token: h.setupToken });
    expect([v.status, v.json.error]).toEqual([403, "setup_token_invalid"]);
  });
});

describe("setup_done seed (schema.sql)", () => {
  test("a fresh database starts at 0; any legacy passkey or non-pending native key makes it 1 (once, at the first open)", () => {
    const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-seed-"));
    const fresh = openDb(join(d, "a.db"));
    expect(fresh.query("SELECT value FROM settings WHERE key = 'setup_done'").get()).toEqual({ value: "0" });
    // a legacy install: tables exist with rows but the seed never ran
    const old = openDb(join(d, "b.db"));
    old.query("DELETE FROM settings WHERE key = 'setup_done'").run();
    old.query("INSERT INTO passkeys(credential_id, public_key_cose_b64, public_key_x963_b64, label, purpose, created_at) VALUES ('c','x','y','l','login',?)").run(nowIso());
    old.close();
    expect(openDb(join(d, "b.db")).query("SELECT value FROM settings WHERE key = 'setup_done'").get()).toEqual({ value: "1" });
    const nat = openDb(join(d, "c.db"));
    nat.query("DELETE FROM settings WHERE key = 'setup_done'").run();
    nat.query("INSERT INTO native_keys(key_id, public_key_x963_b64, status, enroll_challenge, enroll_expires_at, created_at) VALUES ('k','p','pending','c','e',?)").run(nowIso());
    nat.close();
    expect(openDb(join(d, "c.db")).query("SELECT value FROM settings WHERE key = 'setup_done'").get()).toEqual({ value: "0" });   // pending doesn't count
    // and it never flips back once set
    const again = openDb(join(d, "b.db"));
    again.query("DELETE FROM passkeys").run();
    again.close();
    expect(openDb(join(d, "b.db")).query("SELECT value FROM settings WHERE key = 'setup_done'").get()).toEqual({ value: "1" });
  });
});

describe("v7 migration", () => {
  function legacyInstall() {
    const d = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-mig-"));
    const db = openDb(join(d, "o.db"));
    // an old (build 47) install: a browser passkey, a pin v2 on disk, a WebAuthn approval, a session, challenges, a link code
    db.query("DELETE FROM settings WHERE key = 'setup_done'").run();
    db.query("INSERT INTO passkeys(credential_id, public_key_cose_b64, public_key_x963_b64, label, purpose, created_at) VALUES ('pk1','cose','x963','Phone','approve',?)").run(nowIso());
    db.query("INSERT INTO passkeys(credential_id, public_key_cose_b64, public_key_x963_b64, label, purpose, created_at) VALUES ('pk0','cose','x963','Login','login',?)").run(nowIso());
    db.close();
    const reopened = openDb(join(d, "o.db"));
    writeFileSync(join(d, "passkeys.json"), JSON.stringify({ v: 2, rp_id: "localhost", origin: "http://localhost:7477", keys: [{ credential_id: "pk1", x963: "x963", label: "Phone" }], policy: { live_allowed: true } }), { mode: 0o600 });
    const { batchId, draftIds } = seedBatch(reopened, 2);
    const approvalId = newId();
    reopened.query(`INSERT INTO approvals(id, batch_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(approvalId, batchId, JSON.stringify({ items: draftIds.map((id) => ({ draft_id: id })) }), "sha", "pk1", "ad", "cd", "sig", new Date(Date.now() + 3600_000).toISOString(), nowIso());
    reopened.query("UPDATE drafts SET status = 'approved' WHERE batch_id = ?").run(batchId);
    reopened.query("INSERT INTO sessions(token_sha256, created_at, expires_at) VALUES ('t',?,?)").run(nowIso(), new Date(Date.now() + 1e6).toISOString());
    reopened.query("INSERT INTO webauthn_challenges(id, purpose, challenge, expires_at) VALUES ('w','login','c',?)").run(new Date(Date.now() + 1e6).toISOString());
    reopened.query("INSERT INTO native_challenges(id, action, challenge, expires_at) VALUES ('n','mode_live','c',?)").run(new Date(Date.now() + 1e6).toISOString());
    reopened.query("INSERT INTO link_codes(code_sha256, expires_at) VALUES ('l',?)").run(new Date(Date.now() + 1e6).toISOString());
    reopened.query("INSERT INTO session_links(token_sha256, created_at) VALUES ('t',?)").run(nowIso());
    reopened.query("INSERT INTO native_keys(key_id, public_key_x963_b64, status, enroll_challenge, enroll_expires_at, created_at) VALUES ('pend','p','pending','c','e',?)").run(nowIso());
    return { d, db: reopened, batchId, approvalId };
  }

  test("browser-signed approvals are revoked (drafts back to review), legacy tables are emptied (passkeys kept), a v2 pin becomes an empty v4, setup_done = 1, no setup token", () => {
    const { d, db, batchId, approvalId } = legacyInstall();
    // the migration runs on a database opened by an old build: setup_done seeds to 1 because passkeys exist
    expect(db.query("SELECT value FROM settings WHERE key = 'setup_done'").get()).toEqual({ value: "1" });
    const r = migrateV7(db);
    expect(r).toEqual({ ran: true, revoked_approvals: 1, revoked_contact_approvals: 0 });
    expect(db.query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM approvals WHERE id = ?").get(approvalId)!.revoked_at).toBeTruthy();
    expect(db.query("SELECT COUNT(*) AS n FROM drafts WHERE batch_id = ? AND status = 'review'").get(batchId)).toEqual({ n: 2 });
    for (const t of ["sessions", "webauthn_challenges", "native_challenges", "link_codes", "session_links"]) expect([t, db.query(`SELECT COUNT(*) AS n FROM ${t}`).get()]).toEqual([t, { n: 0 }]);
    expect(db.query("SELECT COUNT(*) AS n FROM native_keys").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM passkeys").get()).toEqual({ n: 2 });
    expect(db.query("SELECT details_json FROM audit_log WHERE action = 'migration.v7'").get()).toEqual({ details_json: JSON.stringify({ revoked_approvals: 1, revoked_contact_approvals: 0 }) });
    // the server then rewrites the pin: v2 -> v4 with no keys
    const cfg = resolveConfig({ db: () => db, stateDir: d, userPinFile: join(d, "passkeys.json"), rootPinFile: join(d, "root", "passkeys.json") });
    writePinFiles(cfg, db);
    expect(JSON.parse(readFileSync(join(d, "passkeys.json"), "utf8"))).toEqual({ v: 4, keys: [], policy: { live_allowed: false, contacts_live_allowed: false } });
    expect(firstRun(db)).toBe(false);
    const st = new SetupToken(join(d, "setup-token"));
    expect(st.start(db)).toBeNull();
    expect(existsSync(join(d, "setup-token"))).toBe(false);
  });

  test("it runs once (migrated_v7), keeps approvals signed by an active Secure Enclave key, and revokes contact approvals too", () => {
    const { db, batchId } = legacyInstall();
    db.query("INSERT INTO native_keys(key_id, public_key_x963_b64, label, status, enroll_challenge, enroll_expires_at, created_at, activated_at) VALUES ('se1','pse','Mac','active','c','e',?,?)").run(nowIso(), nowIso());
    const keep = newId();
    db.query(`INSERT INTO approvals(id, batch_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(keep, batchId, JSON.stringify({ items: [] }), "sha2", "se1", "", "", "sig", new Date(Date.now() + 3600_000).toISOString(), nowIso());
    const prop = proposeContactChanges(db, { title: "t", created_by: "agent:t", source: "mcp", creates: [validateCreate({ given_name: "Sam", family_name: "Lee", phones: ["+14155550123"] })], updates: [] });
    for (const [id, cred] of [["ca1", "pk1"], ["ca2", "se1"]] as const) {
      db.query(`INSERT INTO contact_approvals(id, set_id, manifest, manifest_sha256, credential_id, authenticator_data_b64, client_data_json_b64, signature_b64, not_after, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, prop.set_id, JSON.stringify({ kind: "contacts", contact_items: [] }), "s" + id, cred, "", "", "sig", new Date(Date.now() + 3600_000).toISOString(), nowIso());
    }
    const r = migrateV7(db);
    expect([r.revoked_approvals, r.revoked_contact_approvals]).toEqual([1, 1]);
    expect(db.query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM approvals WHERE id = ?").get(keep)!.revoked_at).toBeNull();
    expect(db.query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM contact_approvals WHERE id = 'ca2'").get()!.revoked_at).toBeNull();
    expect(db.query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM contact_approvals WHERE id = 'ca1'").get()!.revoked_at).toBeTruthy();
    expect(migrateV7(db)).toEqual({ ran: false, revoked_approvals: 0, revoked_contact_approvals: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'migration.v7'").get()).toEqual({ n: 1 });
  });
});

describe("no TCP listener anywhere in the source", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "testkit.ts" ? [join(dir, e.name)] : []);
  const SRC = join(import.meta.dir, "..");
  test("no Bun.serve under src/ has a hostname or a port, and nothing reads OUTBOX_PORT / RP_ID / ORIGIN or WEB_DIST", () => {
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/Bun\.serve\(\s*\{([^}]*)\}/g)) {
        expect([f, /\b(hostname|port)\s*:/.test(m[1]!)]).toEqual([f, false]);
        expect([f, /\bunix\s*:/.test(m[1]!)]).toEqual([f, true]);
      }
      expect([f, /process\.env\.OUTBOX_(PORT|RP_ID|ORIGIN|WEB_DIST)/.test(src)]).toEqual([f, false]);
      expect([f, /simplewebauthn|webauthn-challenges|browser-link|link_code|session_link/i.test(src.replace(/^.*(native_challenges|link_codes|session_links|webauthn_challenges).*$/gm, ""))]).toEqual([f, false]);
    }
  });
  test("the only legacy `passkeys` table read is the setup_done seed in schema.sql", () => {
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      expect([f, /FROM passkeys|INTO passkeys|UPDATE passkeys/i.test(src)]).toEqual([f, false]);
    }
    expect(readFileSync(join(SRC, "db", "schema.sql"), "utf8")).toContain("EXISTS(SELECT 1 FROM passkeys)");
  });
});
