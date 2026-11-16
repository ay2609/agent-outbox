// Simple vs hardened pin mode, the local-only hardening (Host allowlist, 127.0.0.1 redirect, cookies).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, SoftAuthenticator, type Harness } from "./testkit";
import { installCommand } from "./auth";
import { pinContactsLiveAllowed, pinLiveAllowed, pinMode } from "./status";
import { allowedHosts, cookieSecure, resolveConfig } from "./config";

const ready = async (over: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> => { const h = makeHarness(over); await h.signUp(); return h; };
const rootPin = (h: Harness) => join(h.dir, "root", "passkeys.json");
/** Simulates the harden command: the user pin copied to the root path. (A temp file isn't root-owned, which is fine for these gates.) */
function harden(h: Harness, edit?: (pin: any) => void): void {
  const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
  edit?.(pin);
  mkdirSync(join(h.dir, "root"), { recursive: true });
  writeFileSync(rootPin(h), JSON.stringify(pin, null, 2) + "\n");
}
const status = async (h: Harness) => (await h.call("GET", "/api/status")).json;
const cfgOf = (h: Harness) => resolveConfig({ stateDir: h.dir, userPinFile: join(h.dir, "passkeys.json"), rootPinFile: rootPin(h), rpId: h.rpId, origin: h.origin, port: 7477 });

describe("simple mode (no root pin)", () => {
  test("approving a key writes the user pin (0600, atomic); status says simple, and the effective pin is the user pin", async () => {
    const h = await ready();
    const path = join(h.dir, "passkeys.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const st = (await status(h)).pin;
    expect(st.mode).toBe("simple");
    expect(st.effective).toMatchObject({ kind: "user", path, present: true, valid: true, live_allowed: false, contacts_live_allowed: false, matches_passkeys: true, problems: [] });
    expect(st.root).toMatchObject({ kind: "root", present: false });
    expect(st.user.present).toBe(true);
    expect(st.candidate).toMatchObject({ path, present: true, installed: null });
    expect(pinMode(cfgOf(h))).toBe("simple");
  });

  test("before any approve key there is no pin: simple, effective not present, no harden command", async () => {
    const h = makeHarness();
    await h.signUpLoginOnly();
    const st = (await status(h)).pin;
    expect(st.mode).toBe("simple");
    expect(st.effective.present).toBe(false);
    expect(st.install_command).toBeNull();
  });

  test("turning live_allowed ON needs a fresh sign-in assertion; no assertion, or a replayed one, is refused and nothing is written", async () => {
    const h = await ready();
    const path = join(h.dir, "passkeys.json");
    const before = readFileSync(path, "utf8");
    const no = await h.call("PUT", "/api/pin-policy", { live_allowed: true });
    expect([no.status, no.json.error]).toEqual([403, "reauth_required"]);
    const re = await h.reauth();
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: re })).status).toBe(200);
    // the same challenge can't be used twice
    const again = await h.call("PUT", "/api/pin-policy", { live_allowed: true, contacts_live_allowed: true, reauth: re });
    expect(again.status).toBe(400);
    expect(JSON.parse(readFileSync(path, "utf8")).policy).toEqual({ live_allowed: true });
    expect(before).not.toBe(readFileSync(path, "utf8"));
  });

  test("an APPROVE key's assertion can't stand in for the sign-in confirmation", async () => {
    const h = await ready();
    const o = await h.call("POST", "/api/auth/reauth/options", {});
    const r = await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: { challenge_id: o.json.challenge_id, response: h.auth.assert(o.json.options) } });
    expect(r.status).toBe(401);
    expect(JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8")).policy.live_allowed).toBe(false);
  });

  test("contacts_live_allowed ON needs it too; turning either OFF, or re-saving the same value, doesn't", async () => {
    const h = await ready();
    const c = await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: true });
    expect(c.status).toBe(403);
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: true, reauth: await h.reauth() })).status).toBe(200);
    // same values again: not "turning on"
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: true })).status).toBe(200);
    // turning live_allowed on still does
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true })).status).toBe(403);
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: await h.reauth() })).status).toBe(200);
    // off: no assertion
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: false })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8")).policy).toEqual({ live_allowed: false, contacts_live_allowed: false });
  });

  test("after the policy is on, the live gates read the user pin: status, going live (with its own reauth), approve options", async () => {
    const h = await ready();
    const cfg = cfgOf(h);
    expect(pinLiveAllowed(cfg)).toBe(false);
    const refused = await h.call("PATCH", "/api/settings", { transport: "live", reauth: await h.reauth() });
    expect([refused.status, refused.json.error]).toEqual([409, "pin_not_live_allowed"]);
    expect(refused.json.message).not.toContain("sudo");
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, contacts_live_allowed: true, reauth: await h.reauth() });
    expect(pinLiveAllowed(cfg)).toBe(true);
    expect(pinContactsLiveAllowed(cfg)).toBe(true);
    const st = await status(h);
    expect(st.pin.effective).toMatchObject({ kind: "user", live_allowed: true, contacts_live_allowed: true });
    expect(st.pin_contacts_live_allowed).toBe(true);
    expect((await h.call("PATCH", "/api/settings", { transport: "live" })).status).toBe(403); // still needs its own reauth
    const live = await h.call("PATCH", "/api/settings", { transport: "live", reauth: await h.reauth() });
    expect(live.status).toBe(200);
    expect(live.json.settings.transport).toBe("live");
    const { batchId, draftIds } = (await import("./testkit")).seedBatch(h.db, 1);
    const o = await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds });
    expect(o.json.pin_live_allowed).toBe(true);
  });

  test("a user pin the sender wouldn't trust (group-writable) doesn't count for the gates, and status says why", async () => {
    const h = await ready();
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: await h.reauth() });
    const cfg = cfgOf(h), path = join(h.dir, "passkeys.json");
    expect(pinLiveAllowed(cfg)).toBe(true);
    chmodSync(path, 0o664);
    expect(pinLiveAllowed(cfg)).toBe(false);
    const eff = (await status(h)).pin.effective;
    expect(eff.valid).toBe(false);
    expect(eff.problems.join(" ")).toContain("writable by group or others");
    chmodSync(path, 0o600);
    chmodSync(h.dir, 0o775);
    expect(pinLiveAllowed(cfg)).toBe(false);
    expect((await status(h)).pin.effective.problems.join(" ")).toContain("parent directory");
    chmodSync(h.dir, 0o700);
    expect(pinLiveAllowed(cfg)).toBe(true);
  });

  test("a later approve key is added to the user pin immediately, keeping the policy", async () => {
    const h = await ready();
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: await h.reauth() });
    const second = new SoftAuthenticator(h.rpId, h.origin);
    const o = await h.call("POST", "/api/passkeys/options", { purpose: "approve", label: "Work laptop", reauth: await h.reauth() });
    await h.call("POST", "/api/passkeys/verify", { challenge_id: o.json.challenge_id, response: second.register(o.json.options), label: "Work laptop" });
    const pin = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(pin.keys).toHaveLength(2);
    expect(pin.policy.live_allowed).toBe(true);
    expect((await status(h)).pin.effective.matches_passkeys).toBe(true);
  });
});

describe("hardened mode (root pin exists)", () => {
  test("status says hardened and reports the root file as the effective pin; the candidate is compared with it", async () => {
    const h = await ready();
    harden(h);
    const st = (await status(h)).pin;
    expect(st.mode).toBe("hardened");
    expect(st.effective).toMatchObject({ kind: "root", path: rootPin(h), present: true, live_allowed: false });
    expect(st.candidate.installed).toBe(true);
    // keys or policy change after hardening: the user pin moves on, the root pin doesn't
    await h.call("PUT", "/api/pin-policy", { live_allowed: true });
    const st2 = (await status(h)).pin;
    expect(st2.candidate.installed).toBe(false);
    expect(st2.effective.live_allowed).toBe(false);
    expect(st2.user.live_allowed).toBe(true);
    expect(st2.install_command).toContain("sudo install");
  });

  test("policy changes need no reauth (they only take effect when the command is re-run) and never change the live gates by themselves", async () => {
    const h = await ready();
    harden(h);
    const r = await h.call("PUT", "/api/pin-policy", { live_allowed: true, contacts_live_allowed: true });
    expect(r.status).toBe(200);
    const cfg = cfgOf(h);
    expect(pinLiveAllowed(cfg)).toBe(false);
    expect(pinContactsLiveAllowed(cfg)).toBe(false);
    const refused = await h.call("PATCH", "/api/settings", { transport: "live", reauth: await h.reauth() });
    expect(refused.json.error).toBe("pin_not_live_allowed");
    expect(refused.json.message).toContain("harden command");
    harden(h); // the user re-runs the command
    expect(pinLiveAllowed(cfg)).toBe(true);
    expect((await status(h)).pin.candidate.installed).toBe(true);
  });

  test("an invalid root pin is not a way back to the user pin: no downgrade", async () => {
    const h = await ready();
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: await h.reauth() });
    const cfg = cfgOf(h);
    expect(pinLiveAllowed(cfg)).toBe(true);
    mkdirSync(join(h.dir, "root"), { recursive: true });
    writeFileSync(rootPin(h), "not json");
    expect(pinMode(cfg)).toBe("hardened");
    expect(pinLiveAllowed(cfg)).toBe(false);
    const st = (await status(h)).pin;
    expect(st.mode).toBe("hardened");
    expect(st.effective).toMatchObject({ kind: "root", present: true, valid: false });
    expect(st.effective.problems.join(" ")).toContain("isn't valid JSON");
  });

  test("a root pin that lists an unknown key is reported", async () => {
    const h = await ready();
    harden(h, (p) => p.keys.push({ credential_id: "evil", x963: "AAAA", label: "Evil" }));
    const eff = (await status(h)).pin.effective;
    expect(eff.valid).toBe(false);
    expect(eff.unexpected_keys.map((k: any) => k.credential_id)).toEqual(["evil"]);
  });
});

describe("harden command", () => {
  test("sha-checks the user pin, then sudo-installs it to the root path; quotes a state dir with spaces", async () => {
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-sp-"));
    const state = join(base, "Application Support", "agent-outbox");
    mkdirSync(state, { recursive: true });
    const user = join(state, "passkeys.json");
    writeFileSync(user, '{"v":2}\n');
    const cfg = { userPinFile: user, rootPinFile: "/Library/Application Support/agent-outbox/passkeys.json" } as any;
    const cmd = installCommand(cfg)!;
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(user)).digest("hex");
    expect(cmd).toBe(
      `echo '${sha}  ${user}' | shasum -a 256 -c - && sudo install -d -o root -g wheel -m 755 '/Library/Application Support/agent-outbox' && ` +
      `sudo install -o root -g wheel -m 444 '${user}' '/Library/Application Support/agent-outbox/passkeys.json' && plutil -p '/Library/Application Support/agent-outbox/passkeys.json'`);
    const check = cmd.split(" && ")[0]!;
    expect(Bun.spawnSync(["bash", "-c", check]).exitCode).toBe(0);
    writeFileSync(user, '{"v":2,"tampered":true}\n');
    expect(Bun.spawnSync(["bash", "-c", check]).exitCode).not.toBe(0);
    expect(installCommand({ ...cfg, userPinFile: join(state, "none.json") })).toBeNull();
    expect(existsSync(join(base, "x"))).toBe(false);
  });

  test("the dashboard's command checks the pin built from its own keys and policy: a user pin edited outside it fails the check", async () => {
    const h = await ready();
    const user = join(h.dir, "passkeys.json");
    const cmd: string = (await status(h)).pin.install_command;
    const check = cmd.split(" && ")[0]!;
    expect(Bun.spawnSync(["bash", "-c", check]).exitCode).toBe(0);
    // an agent running as the user adds its own key to the file; the dashboard keeps offering the same checksum
    const pin = JSON.parse(readFileSync(user, "utf8"));
    pin.keys.push({ credential_id: "ZXZpbA", x963: pin.keys[0].x963, label: "This Mac approval" });
    writeFileSync(user, JSON.stringify(pin, null, 2) + "\n");
    const cmd2: string = (await status(h)).pin.install_command;
    expect(cmd2).toBe(cmd);
    expect(Bun.spawnSync(["bash", "-c", cmd2.split(" && ")[0]!]).exitCode).not.toBe(0);
  });
});

describe("local-only hardening", () => {
  test("Host allowlist: localhost:<port> and 127.0.0.1:<port> only; anything else, or no Host, is refused", async () => {
    const h = await ready();
    for (const host of ["localhost:7477", "127.0.0.1:7477", "LOCALHOST:7477"]) {
      expect([host, (await h.call("GET", "/api/status", undefined, { host })).status]).toEqual([host, 200]);
    }
    for (const host of ["evil.example", "evil.example:7477", "localhost", "localhost:9999", "127.0.0.1", "127.0.0.1:80", "localhost.evil.example:7477", "[::1]:7477", "0.0.0.0:7477"]) {
      const r = await h.call("GET", "/api/status", undefined, { host });
      expect([host, r.status, r.json.error]).toEqual([host, 403, "bad_host"]);
    }
    const none = await h.call("GET", "/api/status", undefined, { host: null });
    expect([none.status, none.json.error]).toEqual([403, "bad_host"]);
    // the SPA is behind it too
    expect((await h.request("/", { headers: { host: "rebind.example:7477" } })).status).toBe(403);
    // and a rebinding page can't even reach the sign-in routes
    expect((await h.call("POST", "/api/auth/login/options", {}, { cookie: null, host: "rebind.example:7477" })).status).toBe(403);
  });

  test("the port comes from the config: a different port changes what is allowed", async () => {
    const h = makeHarness({ port: 7600, origin: "http://localhost:7600" });
    expect((await h.call("GET", "/api/auth/state", undefined, { host: "localhost:7600" })).status).toBe(200);
    expect((await h.call("GET", "/api/auth/state", undefined, { host: "localhost:7477" })).status).toBe(403);
    expect([...allowedHosts({ port: 7600, origin: "http://localhost:7600" })].sort()).toEqual(["127.0.0.1:7600", "localhost:7600"]);
  });

  test("page loads on 127.0.0.1 are redirected to http://localhost:<port> (path and query kept); /api and non-GETs are not", async () => {
    const h = await ready();
    const r = await h.request("/some/deep/route?x=1", { headers: { host: "127.0.0.1:7477" }, redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("http://localhost:7477/some/deep/route?x=1");
    expect((await h.request("/", { headers: { host: "127.0.0.1:7477" } })).headers.get("location")).toBe("http://localhost:7477/");
    // on localhost nothing redirects
    expect((await h.request("/")).status).toBe(503); // not built in this temp dir, but not a redirect
    // the API stays reachable on 127.0.0.1 (no redirect, no session loss for a fetch)
    const api = await h.call("GET", "/api/auth/state", undefined, { host: "127.0.0.1:7477", cookie: null });
    expect(api.status).toBe(200);
    expect(api.res.headers.get("location")).toBeNull();
  });

  test("the Origin + X-Outbox CSRF checks are kept", async () => {
    const h = await ready();
    const bad = await h.call("POST", "/api/stop", {}, { headers: { origin: "http://localhost:9999" } });
    expect([bad.status, bad.json.error]).toEqual([403, "bad_origin"]);
    const noHeader = await h.call("POST", "/api/stop", {}, { csrf: false });
    expect([noHeader.status, noHeader.json.error]).toEqual([403, "csrf"]);
    expect((await h.call("POST", "/api/resume", {}, { headers: { origin: "http://localhost:7477" } })).status).toBe(200);
  });

  test("cookie Secure flag only for non-loopback origins", () => {
    expect(cookieSecure("http://localhost:7477")).toBe(false);
    expect(cookieSecure("http://127.0.0.1:7477")).toBe(false);
    expect(cookieSecure("https://outbox.example")).toBe(true);
    expect(cookieSecure("http://outbox.example")).toBe(true);
  });

  test("the auth state and status no longer carry a dev flag or any remote hostname", async () => {
    const h = await ready();
    const a = (await h.call("GET", "/api/auth/state", undefined, { cookie: null })).json;
    expect(a).toMatchObject({ rp_id: "localhost", origin: "http://localhost:7477" });
    expect("dev" in a).toBe(false);
    const s = await status(h);
    expect("dev" in s).toBe(false);
    expect(s).toMatchObject({ rp_id: "localhost", origin: "http://localhost:7477", port: 7477 });
  });
});
