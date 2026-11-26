// Simple vs hardened pin mode (pin v4: Secure Enclave keys only), the harden command, and key revocation's effect on the pin.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness, seedBatch, SoftSe, type Harness } from "./testkit";
import { installCommand, writePinFiles } from "./auth";
import { pinContactsLiveAllowed, pinLiveAllowed, pinMode } from "./status";
import { resolveConfig } from "./config";

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
const cfgOf = (h: Harness) => resolveConfig({ stateDir: h.dir, userPinFile: join(h.dir, "passkeys.json"), rootPinFile: rootPin(h) });
const readUser = (h: Harness) => JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));

describe("simple mode (no root pin)", () => {
  test("enrolling a key writes the user pin (v4, 0600, exact shape); status says simple, and the effective pin is the user pin", async () => {
    const h = await ready();
    const path = join(h.dir, "passkeys.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const pin = readUser(h);
    expect(Object.keys(pin)).toEqual(["v", "keys", "policy"]);
    expect(pin).toEqual({
      v: 4, keys: [{ kind: "secure-enclave", credential_id: h.auth.id, x963: h.auth.x963b64, label: "Test approve" }],
      policy: { live_allowed: false, contacts_live_allowed: false },
    });
    expect(Object.keys(pin.keys[0])).toEqual(["kind", "credential_id", "x963", "label"]);
    const st = (await status(h)).pin;
    expect(st.mode).toBe("simple");
    expect(st.effective).toMatchObject({ kind: "user", path, present: true, valid: true, version: 4, live_allowed: false, contacts_live_allowed: false, matches_keys: true, problems: [] });
    expect(st.root).toMatchObject({ kind: "root", present: false });
    expect(st.candidate).toMatchObject({ path, present: true, installed: null });
    expect(st.expected_keys).toEqual([{ credential_id: h.auth.id, label: "Test approve", kind: "secure-enclave", fingerprint: expect.stringMatching(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/) }]);
    expect(pinMode(cfgOf(h))).toBe("simple");
  });

  test("the writer always writes, even with no keys (never deletes); an empty pin is valid and approvals are impossible", async () => {
    const h = makeHarness();
    expect((await status(h)).pin.install_command).toBeNull(); // nothing written yet (the server writes it at start)
    writePinFiles(cfgOf(h), h.db);
    expect(readUser(h)).toEqual({ v: 4, keys: [], policy: { live_allowed: false, contacts_live_allowed: false } });
    const st = (await status(h)).pin;
    expect(st.effective).toMatchObject({ present: true, valid: true, keys: 0, problems: [] });
    expect(st.install_command).toContain("sudo install");
  });

  test("turning live_allowed ON needs a fresh Touch ID confirmation; none, or a replayed one, is refused and nothing is written", async () => {
    const h = await ready();
    const path = join(h.dir, "passkeys.json");
    const before = readFileSync(path, "utf8");
    const no = await h.call("PUT", "/api/pin-policy", { live_allowed: true });
    expect([no.status, no.json.error]).toEqual([403, "reauth_required"]);
    const re = await h.reauth("policy_live");
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true, se_reauth: re })).status).toBe(200);
    // the same challenge can't be used twice
    const again = await h.call("PUT", "/api/pin-policy", { live_allowed: true, contacts_live_allowed: true, se_reauth: re });
    expect(again.status).toBe(400);
    expect(readUser(h).policy).toEqual({ live_allowed: true, contacts_live_allowed: false });
    expect(before).not.toBe(readFileSync(path, "utf8"));
  });

  test("a reauth made for another action doesn't count, and the old `reauth` field is refused", async () => {
    const h = await ready();
    const r = await h.call("PUT", "/api/pin-policy", { live_allowed: true, se_reauth: await h.reauth("mode_live") });
    expect(r.status).toBe(400);
    expect(readUser(h).policy.live_allowed).toBe(false);
    const old = await h.call("PUT", "/api/pin-policy", { live_allowed: true, reauth: { challenge_id: "x", response: {} } });
    expect(old.status).toBe(400);
    expect(old.json.error).toBe("bad_request");
  });

  test("contacts_live_allowed ON needs it too; turning either OFF, or re-saving the same value, doesn't", async () => {
    const h = await ready();
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: true })).status).toBe(403);
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: true, se_reauth: await h.reauth("policy_live") })).status).toBe(200);
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: true })).status).toBe(200);
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true })).status).toBe(403);
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true, se_reauth: await h.reauth("policy_live") })).status).toBe(200);
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: false, contacts_live_allowed: false })).status).toBe(200);
    expect(readUser(h).policy).toEqual({ live_allowed: false, contacts_live_allowed: false });
  });

  test("after the policy is on, the live gates read the user pin: status, going live (with its own reauth), approve options", async () => {
    const h = await ready();
    const cfg = cfgOf(h);
    expect(pinLiveAllowed(cfg)).toBe(false);
    const refused = await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: await h.reauth("mode_live") });
    expect([refused.status, refused.json.error]).toEqual([409, "pin_not_live_allowed"]);
    expect(refused.json.message).not.toContain("sudo");
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, contacts_live_allowed: true, se_reauth: await h.reauth("policy_live") });
    expect(pinLiveAllowed(cfg)).toBe(true);
    expect(pinContactsLiveAllowed(cfg)).toBe(true);
    const st = await status(h);
    expect(st.pin.effective).toMatchObject({ kind: "user", live_allowed: true, contacts_live_allowed: true });
    expect(st.pin_contacts_live_allowed).toBe(true);
    expect((await h.call("PATCH", "/api/settings", { transport: "live" })).status).toBe(403); // still needs its own reauth
    const live = await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: await h.reauth("mode_live") });
    expect(live.status).toBe(200);
    expect(live.json.settings.transport).toBe("live");
    const { batchId, draftIds } = seedBatch(h.db, 1);
    const o = await h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds });
    expect(o.json.pin_live_allowed).toBe(true);
  });

  test("a user pin the sender wouldn't trust (group-writable) doesn't count for the gates, and status says why", async () => {
    const h = await ready();
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, se_reauth: await h.reauth("policy_live") });
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

  test("a later key (added with the first key's confirmation) is in the user pin immediately, keeping the policy", async () => {
    const h = await ready();
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, se_reauth: await h.reauth("policy_live") });
    const second = new SoftSe();
    const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: second.x963b64, label: "Work laptop" });
    expect(o.json.proof).toBe("se_reauth");
    const re = await h.reauth("native_key_add", o.json.key_id);
    const sig = second.sign("enroll", createHash("sha256").update(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), second.x963])).digest());
    expect((await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: re })).status).toBe(200);
    const pin = readUser(h);
    expect(pin.keys).toHaveLength(2);
    expect(pin.policy.live_allowed).toBe(true);
    expect((await status(h)).pin.effective.matches_keys).toBe(true);
  });

  test("old pin versions on disk are reported with the re-pin message; extra top-level keys and webauthn keys are reported", async () => {
    const h = await ready();
    const path = join(h.dir, "passkeys.json");
    const pin = readUser(h);
    for (const v of [2, 3]) {
      writeFileSync(path, JSON.stringify({ ...pin, v }), { mode: 0o600 });
      expect((await status(h)).pin.effective.problems.join(" ")).toContain("holds browser passkeys");
    }
    writeFileSync(path, JSON.stringify({ ...pin, rp_id: "localhost" }), { mode: 0o600 });
    expect((await status(h)).pin.effective.problems.join(" ")).toContain("unexpected top-level keys");
    writeFileSync(path, JSON.stringify({ ...pin, keys: [{ ...pin.keys[0], kind: "webauthn" }] }), { mode: 0o600 });
    expect((await status(h)).pin.effective.problems.join(" ")).toContain("WebAuthn keys are no longer accepted");
    expect(pinLiveAllowed(cfgOf(h))).toBe(false);
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
    const refused = await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: await h.reauth("mode_live") });
    expect(refused.json.error).toBe("pin_not_live_allowed");
    expect(refused.json.message).toContain("harden command");
    harden(h); // the user re-runs the command
    expect(pinLiveAllowed(cfg)).toBe(true);
    expect((await status(h)).pin.candidate.installed).toBe(true);
  });

  test("an invalid root pin is not a way back to the user pin: no downgrade", async () => {
    const h = await ready();
    await h.call("PUT", "/api/pin-policy", { live_allowed: true, se_reauth: await h.reauth("policy_live") });
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
    harden(h, (p) => p.keys.push({ kind: "secure-enclave", credential_id: "evil", x963: "AAAA", label: "Evil" }));
    const eff = (await status(h)).pin.effective;
    expect(eff.valid).toBe(false);
    expect(eff.unexpected_keys.map((k: any) => k.credential_id)).toEqual(["evil"]);
  });

  test("an old v2 root pin (browser passkeys) is reported, native.approve_in_app is false and pin_needs_update is true", async () => {
    const h = await ready();
    harden(h, (p) => { p.v = 2; p.rp_id = "localhost"; p.origin = "http://localhost:7477"; p.keys = [{ credential_id: "x", x963: "y", label: "z" }]; });
    const s = await status(h);
    expect(s.pin.effective.problems.join(" ")).toContain("holds browser passkeys");
    expect(s.native).toEqual({ keys_active: 1, approve_in_app: false, pin_needs_update: true });
  });

  test("a revoked key still in the root pin: pin_needs_update stays true until the command is re-run; the last key may be revoked and the pin lists none", async () => {
    const h = await ready();
    harden(h);
    expect((await status(h)).native).toEqual({ keys_active: 1, approve_in_app: true, pin_needs_update: false });
    const r = await h.call("POST", `/api/native-keys/${h.auth.id}/revoke`, {});
    expect(r.status).toBe(200);
    expect(readUser(h)).toEqual({ v: 4, keys: [], policy: { live_allowed: false, contacts_live_allowed: false } });
    const s = await status(h);
    expect(s.native).toEqual({ keys_active: 0, approve_in_app: false, pin_needs_update: true });
    expect(s.pin.install_command).toContain("sudo install");
    expect(s.pin.expected_keys).toEqual([]);
    harden(h); // the owner runs the command
    expect((await status(h)).native.pin_needs_update).toBe(false);
  });
});

describe("harden command", () => {
  test("sha-checks the user pin, then sudo-installs it to the root path; quotes a state dir with spaces", async () => {
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-sp-"));
    const state = join(base, "Application Support", "agent-outbox");
    mkdirSync(state, { recursive: true });
    const user = join(state, "passkeys.json");
    writeFileSync(user, '{"v":4}\n');
    const cfg = { userPinFile: user, rootPinFile: "/Library/Application Support/agent-outbox/passkeys.json" } as any;
    const cmd = installCommand(cfg)!;
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(user)).digest("hex");
    expect(cmd).toBe(
      `echo '${sha}  ${user}' | shasum -a 256 -c - && sudo install -d -o root -g wheel -m 755 '/Library/Application Support/agent-outbox' && ` +
      `sudo install -o root -g wheel -m 444 '${user}' '/Library/Application Support/agent-outbox/passkeys.json' && plutil -p '/Library/Application Support/agent-outbox/passkeys.json'`);
    const check = cmd.split(" && ")[0]!;
    expect(Bun.spawnSync(["bash", "-c", check]).exitCode).toBe(0);
    writeFileSync(user, '{"v":4,"tampered":true}\n');
    expect(Bun.spawnSync(["bash", "-c", check]).exitCode).not.toBe(0);
    expect(installCommand({ ...cfg, userPinFile: join(state, "none.json") })).toBeNull();
    expect(existsSync(join(base, "x"))).toBe(false);
  });

  test("the app's command checks the pin built from its own keys and policy: a user pin edited outside it fails the check", async () => {
    const h = await ready();
    const user = join(h.dir, "passkeys.json");
    const cmd: string = (await status(h)).pin.install_command;
    const check = cmd.split(" && ")[0]!;
    expect(Bun.spawnSync(["bash", "-c", check]).exitCode).toBe(0);
    // an agent running as the user adds its own key to the file; the app keeps offering the same checksum
    const pin = JSON.parse(readFileSync(user, "utf8"));
    pin.keys.push({ kind: "secure-enclave", credential_id: "ZXZpbA", x963: pin.keys[0].x963, label: "This Mac approval" });
    writeFileSync(user, JSON.stringify(pin, null, 2) + "\n");
    const cmd2: string = (await status(h)).pin.install_command;
    expect(cmd2).toBe(cmd);
    expect(Bun.spawnSync(["bash", "-c", cmd2.split(" && ")[0]!]).exitCode).not.toBe(0);
  });
});
