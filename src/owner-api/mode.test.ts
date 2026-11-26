// POST /api/mode: the one Live / Dry run switch. One Touch ID to go live in simple mode; hardened mode never changes the root pin.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSettings } from "../core/store";
import { getPinPolicy } from "./auth";
import { makeHarness, type Harness } from "./testkit";

const ready = async (): Promise<Harness> => { const h = makeHarness(); await h.signUp(); return h; };
const userPin = (h: Harness) => JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
const rootPinPath = (h: Harness) => join(h.dir, "root", "passkeys.json");
/** Simulates the harden command with the given policy: a root pin the executor would trust. */
function hardenWith(h: Harness, policy: Record<string, unknown>): void {
  mkdirSync(join(h.dir, "root"), { recursive: true });
  writeFileSync(rootPinPath(h), JSON.stringify({ ...userPin(h), policy }, null, 2) + "\n");
}
const audits = (h: Harness, action: string) => h.db.query<any, [string]>("SELECT * FROM audit_log WHERE action = ?").all(action);

describe("POST /api/mode: dry", () => {
  test("sets both transports to dry with no reauth, and audits it", async () => {
    const h = await ready();
    h.db.query("UPDATE settings SET value = 'live' WHERE key IN ('transport','contacts_transport')").run();
    const r = await h.call("POST", "/api/mode", { mode: "dry" });
    expect(r.status).toBe(200);
    expect(r.json.settings).toMatchObject({ transport: "dry", contacts_transport: "dry" });
    expect(r.json.contacts).toBe("dry");
    expect(r.json.status.mode).toBe("simple");
    expect(getSettings(h.db)).toMatchObject({ transport: "dry", contacts_transport: "dry" });
    expect(audits(h, "mode.set").length).toBe(1);
  });

  test("dry leaves the stored policy alone", async () => {
    const h = await ready();
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") })).status).toBe(200);
    expect((await h.call("POST", "/api/mode", { mode: "dry" })).status).toBe(200);
    expect(getPinPolicy(h.db)).toEqual({ live_allowed: true, contacts_live_allowed: true });
  });
});

describe("POST /api/mode: live, simple mode", () => {
  test("without a Touch ID confirmation: 403 reauth_required and nothing changes", async () => {
    const h = await ready();
    const before = userPin(h);
    const r = await h.call("POST", "/api/mode", { mode: "live" });
    expect([r.status, r.json.error]).toEqual([403, "reauth_required"]);
    expect(getSettings(h.db)).toMatchObject({ transport: "dry", contacts_transport: "dry" });
    expect(getPinPolicy(h.db)).toEqual({ live_allowed: false, contacts_live_allowed: false });
    expect(userPin(h)).toEqual(before);
  });

  test("with one assertion: policy on, both transports live, the user pin rewritten (live_allowed and contacts_live_allowed true)", async () => {
    const h = await ready();
    const r = await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") });
    expect(r.status).toBe(200);
    expect(r.json.settings).toMatchObject({ transport: "live", contacts_transport: "live" });
    expect(r.json).toMatchObject({ contacts: "live", policy_changed: true });
    expect(r.json.status.effective).toMatchObject({ kind: "user", live_allowed: true, contacts_live_allowed: true });
    expect(getSettings(h.db)).toMatchObject({ transport: "live", contacts_transport: "live" });
    expect(getPinPolicy(h.db)).toEqual({ live_allowed: true, contacts_live_allowed: true });
    expect(userPin(h).policy).toEqual({ live_allowed: true, contacts_live_allowed: true });
    expect(audits(h, "pin_policy.set").length).toBe(1);
    expect(audits(h, "mode.set").length).toBe(1);
  });

  test("a replayed confirmation is refused", async () => {
    const h = await ready();
    const re = await h.reauth("mode_live");
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: re })).status).toBe(200);
    await h.call("POST", "/api/mode", { mode: "dry" });
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: re })).status).toBe(400);
    expect(getSettings(h.db).transport).toBe("dry");
  });

  test("a confirmation signed with the wrong tag, or made for another action, can't stand in", async () => {
    const h = await ready();
    const o = await h.call("POST", "/api/native-keys/reauth/options", { action: "mode_live" });
    const bad = { challenge_id: o.json.challenge_id, key_id: h.auth.id, signature: h.auth.sign("send", Buffer.from(o.json.challenge, "base64url").subarray(0, 32)) };
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: bad })).status).toBe(401);
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("policy_live") })).status).toBe(400);
    expect((await h.call("POST", "/api/mode", { mode: "live", reauth: { challenge_id: "x", response: {} } })).status).toBe(400);
    expect(getSettings(h.db).transport).toBe("dry");
    expect(getPinPolicy(h.db).live_allowed).toBe(false);
  });

  test("a policy that only allows live sending is topped up with contacts; a second Live needs no Touch ID once everything is on", async () => {
    const h = await ready();
    expect((await h.call("PUT", "/api/pin-policy", { live_allowed: true, se_reauth: await h.reauth("policy_live") })).status).toBe(200);
    const r = await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") });
    expect(r.status).toBe(200);
    expect(userPin(h).policy).toEqual({ live_allowed: true, contacts_live_allowed: true });
    const again = await h.call("POST", "/api/mode", { mode: "live" });
    expect(again.status).toBe(200);
    expect(again.json.policy_changed).toBe(false);
  });

  test("when only the transports are dry, going live still needs the assertion (even though the policy is already on)", async () => {
    const h = await ready();
    await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") });
    await h.call("POST", "/api/mode", { mode: "dry" });
    const r = await h.call("POST", "/api/mode", { mode: "live" });
    expect([r.status, r.json.error]).toEqual([403, "reauth_required"]);
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") })).status).toBe(200);
  });

  test("body validation: unknown fields and bad modes are 400; it needs the app token", async () => {
    const h = await ready();
    expect((await h.call("POST", "/api/mode", { mode: "live", extra: 1 })).status).toBe(400);
    expect((await h.call("POST", "/api/mode", { mode: "sideways" })).status).toBe(400);
    expect((await h.call("POST", "/api/mode", {})).status).toBe(400);
    expect((await h.call("POST", "/api/mode", { mode: "dry" }, { token: null })).status).toBe(401);
  });
});

describe("POST /api/mode: live, simple mode, the pin file", () => {
  test("no approval key yet: going live is refused (no confirmation can exist), dry says there's no key and no pin file is written", async () => {
    const h = makeHarness();
    const r = await h.call("POST", "/api/mode", { mode: "live" });
    expect([r.status, r.json.error]).toEqual([403, "reauth_required"]);
    const d = await h.call("POST", "/api/mode", { mode: "dry" });
    expect(d.json.approval_key).toBe(false);
    expect(existsSync(join(h.dir, "passkeys.json"))).toBe(false);
    // with a key, the same response says so
    const k = await ready();
    expect((await k.call("POST", "/api/mode", { mode: "live", se_reauth: await k.reauth("mode_live") })).json.approval_key).toBe(true);
  });

  test("a stale user pin is rebuilt from the database on a Live tap with no Touch ID; the policy is not loosened", async () => {
    const h = await ready();
    expect((await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") })).status).toBe(200);
    const good = readFileSync(join(h.dir, "passkeys.json"), "utf8");
    // a hand edit left the file out of step; nothing else needs changing
    writeFileSync(join(h.dir, "passkeys.json"), good.replace('"label": "Test approve"', '"label": "edited"'), { mode: 0o600 });
    const r = await h.call("POST", "/api/mode", { mode: "live" });
    expect([r.status, r.json.policy_changed, r.json.pin_repaired]).toEqual([200, false, true]);
    expect(readFileSync(join(h.dir, "passkeys.json"), "utf8")).toBe(good);
    expect(audits(h, "pin.repaired").length).toBe(1);
    // a missing file is repaired the same way
    unlinkSync(join(h.dir, "passkeys.json"));
    expect((await h.call("POST", "/api/mode", { mode: "live" })).json.pin_repaired).toBe(true);
    expect(readFileSync(join(h.dir, "passkeys.json"), "utf8")).toBe(good);
    // and an up-to-date file is left alone
    expect((await h.call("POST", "/api/mode", { mode: "live" })).json.pin_repaired).toBe(false);
  });

  test("the repair never turns a policy on: with the policy off and the transport live, Live still needs Touch ID", async () => {
    const h = await ready();
    h.db.query("UPDATE settings SET value = 'live' WHERE key IN ('transport','contacts_transport')").run();
    unlinkSync(join(h.dir, "passkeys.json"));
    const r = await h.call("POST", "/api/mode", { mode: "live" });
    expect([r.status, r.json.error]).toEqual([403, "reauth_required"]);
    expect(getPinPolicy(h.db).live_allowed).toBe(false);
  });
});

describe("POST /api/mode: live, hardened mode", () => {
  test("a pin that doesn't allow live sending: 409 pin_not_live_allowed, with the harden-again guidance; nothing changes", async () => {
    const h = await ready();
    hardenWith(h, { live_allowed: false, contacts_live_allowed: false });
    const r = await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") });
    expect([r.status, r.json.error]).toEqual([409, "pin_not_live_allowed"]);
    expect(r.json.message).toContain("harden command again");
    expect(getSettings(h.db)).toMatchObject({ transport: "dry", contacts_transport: "dry" });
  });

  test("a pin that allows both: one assertion, both transports live, the policy row and BOTH pin files untouched", async () => {
    const h = await ready();
    hardenWith(h, { live_allowed: true, contacts_live_allowed: true });
    const rootBefore = readFileSync(rootPinPath(h), "utf8"), userBefore = readFileSync(join(h.dir, "passkeys.json"), "utf8");
    const no = await h.call("POST", "/api/mode", { mode: "live" });
    expect([no.status, no.json.error]).toEqual([403, "reauth_required"]);
    const r = await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ contacts: "live", policy_changed: false });
    expect(r.json.status.mode).toBe("hardened");
    expect(getSettings(h.db)).toMatchObject({ transport: "live", contacts_transport: "live" });
    expect(readFileSync(rootPinPath(h), "utf8")).toBe(rootBefore);
    expect(readFileSync(join(h.dir, "passkeys.json"), "utf8")).toBe(userBefore);
    expect(getPinPolicy(h.db)).toEqual({ live_allowed: false, contacts_live_allowed: false });
  });

  test("a pin without contacts: messages go live, contacts stay dry, and the response says contacts: dry_pin", async () => {
    const h = await ready();
    hardenWith(h, { live_allowed: true, contacts_live_allowed: false });
    const r = await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") });
    expect(r.status).toBe(200);
    expect(r.json.contacts).toBe("dry_pin");
    expect(getSettings(h.db)).toMatchObject({ transport: "live", contacts_transport: "dry" });
    // nothing left to change: a second Live needs no Touch ID and keeps saying so
    const again = await h.call("POST", "/api/mode", { mode: "live" });
    expect([again.status, again.json.contacts]).toEqual([200, "dry_pin"]);
  });

  test("dry works the same in hardened mode and doesn't touch the pins", async () => {
    const h = await ready();
    hardenWith(h, { live_allowed: true, contacts_live_allowed: true });
    await h.call("POST", "/api/mode", { mode: "live", se_reauth: await h.reauth("mode_live") });
    const rootBefore = readFileSync(rootPinPath(h), "utf8");
    expect((await h.call("POST", "/api/mode", { mode: "dry" })).status).toBe(200);
    expect(getSettings(h.db)).toMatchObject({ transport: "dry", contacts_transport: "dry" });
    expect(readFileSync(rootPinPath(h), "utf8")).toBe(rootBefore);
  });
});
