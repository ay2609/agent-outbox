// Fix-round tests: transactions, approvability, expiry, stop/undo, PATCH guards, warnings, contacts,
// pin policy, imports paging. Enrolment tests live in native.test.ts.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../db";
import { addDraft, createBatch, getDrafts, getSettings, setBatchStatus } from "../core/store";
import { DEFAULT_PIN_POLICY, type Warning, type WarningCode } from "../core/types";
import { buildManifest } from "./approval";
import { makeHarness, seedBatch, SoftSe, type Harness } from "./testkit";

async function ready(n = 3, over: Parameters<typeof makeHarness>[0] = {}, o2: Parameters<typeof makeHarness>[1] = {}) {
  const h = makeHarness(over, o2);
  await h.signUp();
  return { h, ...seedBatch(h.db, n) };
}
const options = (h: Harness, batchId: string, ids: string[], extra: Record<string, unknown> = {}) =>
  h.call("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: ids, ...extra });
/** A second key, enrolled with the first key's confirmation. */
async function enrolSecond(h: Harness) {
  const se2 = new SoftSe();
  const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: se2.x963b64, label: "iPad" });
  const signature = se2.sign("enroll", createHash("sha256").update(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), se2.x963])).digest());
  const v = await h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature, se_reauth: await h.reauth("native_key_add", o.json.key_id) });
  expect(v.status).toBe(200);
  return se2;
}
async function approve(h: Harness, batchId: string, ids: string[], extra: Record<string, unknown> = {}) {
  const opt = await options(h, batchId, ids, extra);
  expect(opt.status).toBe(200);
  const verify = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, h.auth.signOptions(opt.json));
  expect(verify.status).toBe(200);
  return { opt, verify };
}
const statuses = (h: Harness, batchId: string) => getDrafts(h.db, batchId).map((d) => d.status);
const batchJson = async (h: Harness, batchId: string) => (await h.call("GET", `/api/batches/${batchId}`)).json;
function installPin(h: Harness, policy: Record<string, unknown> = { ...DEFAULT_PIN_POLICY, live_allowed: true }) {
  mkdirSync(join(h.dir, "root"), { recursive: true });
  const path = join(h.dir, "root", "passkeys.json");
  writeFileSync(path, JSON.stringify({ v: 4, keys: [{ kind: "secure-enclave", credential_id: h.auth.id, x963: h.auth.x963b64, label: "Test approve" }], policy: { live_allowed: false, contacts_live_allowed: false, ...policy } }));
  return path;
}

describe("manifest v2 and transport", () => {
  test("the manifest carries v:2 and the settings' transport; live is shown with the installed pin's state", async () => {
    const { h, batchId, draftIds } = await ready();
    const dry = await options(h, batchId, [draftIds[0]!]);
    expect(dry.json.manifest).toMatchObject({ v: 2, transport: "dry" });
    expect(dry.json.pin_live_allowed).toBe(false);
    installPin(h);
    await h.call("PATCH", "/api/settings", { transport: "live", se_reauth: await h.reauth("mode_live") });
    expect(getSettings(h.db).transport).toBe("live");
    const live = await options(h, batchId, [draftIds[0]!]);
    expect(live.json.manifest.transport).toBe("live");
    expect(live.json.pin_live_allowed).toBe(true);
    // the signed bytes contain it
    const row = h.db.query<any, [string]>("SELECT manifest FROM owner_challenges WHERE id = ?").get(live.json.challenge_id)!;
    expect(JSON.parse(row.manifest).transport).toBe("live");
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, h.auth.signOptions(live.json));
    expect(v.json.transport).toBe("live");
    expect(JSON.parse(h.db.query<any, []>("SELECT manifest FROM approvals").get()!.manifest).transport).toBe("live");
  });

  test("buildManifest refuses a proposed contact whose handles aren't exactly the draft handle", async () => {
    const { h, batchId } = await ready();
    const [, d2] = getDrafts(h.db, batchId);
    const bad = [
      { ...d2!, proposed_contact: { ...d2!.proposed_contact!, phones: [...d2!.proposed_contact!.phones, { e164: "+12025559999", label: "home" }] } },
      { ...d2!, proposed_contact: { ...d2!.proposed_contact!, phones: [{ e164: "+12025559999", label: "mobile" }] } },
      { ...d2!, proposed_contact: { ...d2!.proposed_contact!, emails: [{ email: "x@y.com", label: "work" }] } },
      { ...d2!, proposed_contact: { ...d2!.proposed_contact!, phones: [] } },
    ];
    for (const d of bad) expect(() => buildManifest(batchId, [d], 24)).toThrow();
    expect(() => buildManifest(batchId, [d2!], 24)).not.toThrow();
    // with create_contact off the proposal is irrelevant
    expect(() => buildManifest(batchId, [{ ...bad[0]!, create_contact: false }], 24)).not.toThrow();
  });
});

describe("pin policy and install command", () => {
  test("the user pin carries the policy the user chose; mode 0600; the install command is sha256-checked and prints what it installed", async () => {
    const { h } = await ready();
    const policy = { live_allowed: true };
    // simple mode (no root pin): turning live on takes effect at once, so it needs a fresh Touch ID confirmation
    expect((await h.call("PUT", "/api/pin-policy", policy)).status).toBe(403);
    const put = await h.call("PUT", "/api/pin-policy", { ...policy, se_reauth: await h.reauth("policy_live") });
    expect(put.status).toBe(200);
    const candPath = join(h.dir, "passkeys.json");
    const cand = JSON.parse(readFileSync(candPath, "utf8"));
    expect(cand.v).toBe(4); expect(cand.policy).toEqual({ live_allowed: true, contacts_live_allowed: false });
    expect(cand.keys.map((k: any) => k.credential_id)).toEqual([h.auth.id]);
    expect(statSync(candPath).mode & 0o777).toBe(0o600);
    const st = (await h.call("GET", "/api/status")).json.pin;
    const sha = createHash("sha256").update(readFileSync(candPath)).digest("hex");
    expect(st.candidate.sha256).toBe(sha);
    expect(st.install_command).toBe(
      `echo '${sha}  ${candPath}' | shasum -a 256 -c - && sudo install -d -o root -g wheel -m 755 ${join(h.dir, "root")} && ` +
      `sudo install -o root -g wheel -m 444 ${candPath} ${join(h.dir, "root", "passkeys.json")} && plutil -p ${join(h.dir, "root", "passkeys.json")}`);
    expect(st.expected_keys).toMatchObject([{ credential_id: h.auth.id, label: "Test approve", kind: "secure-enclave" }]);
    expect(st.policy).toEqual(policy);
    // a later key keeps the user's policy
    await enrolSecond(h);
    expect(JSON.parse(readFileSync(candPath, "utf8")).policy).toEqual({ live_allowed: true, contacts_live_allowed: false });
    expect(JSON.parse(readFileSync(candPath, "utf8")).keys).toHaveLength(2);
  });

  test("the install command really verifies: shasum accepts the file and rejects a tampered one", async () => {
    const { h } = await ready();
    const st = (await h.call("GET", "/api/status")).json.pin;
    const check = st.install_command.split(" && ")[0] as string;
    const run = (cmd: string) => Bun.spawnSync(["bash", "-c", cmd]).exitCode;
    expect(run(check)).toBe(0);
    writeFileSync(join(h.dir, "passkeys.json"), '{"tampered":true}');
    expect(run(check)).not.toBe(0);
  });

  test("defaults: live not allowed, and bad policies are refused", async () => {
    const { h } = await ready();
    const cand = JSON.parse(readFileSync(join(h.dir, "passkeys.json"), "utf8"));
    expect(cand.policy).toEqual(DEFAULT_PIN_POLICY);
    expect(cand.policy.live_allowed).toBe(false);
    expect((await h.call("GET", "/api/pin-policy")).json.policy).toEqual(DEFAULT_PIN_POLICY);
    for (const bad of [{ live_allowed: "yes" }, { live_allowed: true, extra: 1 }, { live_allowed: true, min_pace_s: 60 }, {}]) {
      expect([JSON.stringify(bad), (await h.call("PUT", "/api/pin-policy", bad)).status]).toEqual([JSON.stringify(bad), 400]);
    }
  });

  test("an installed pin with the old pacing fields still works: only live_allowed is read and reported", async () => {
    const { h } = await ready();
    installPin(h, { live_allowed: true, min_pace_s: 90, min_burst_pause_s: 200, max_burst_size: 8, max_daily_cap: 20, require_quiet_hours: true } as any);
    const st = (await h.call("GET", "/api/status")).json.pin;
    expect(st.root.policy).toEqual({ live_allowed: true, contacts_live_allowed: false });
    expect(st.root.live_allowed).toBe(true);
    expect(st.clamped).toBeUndefined();
    expect(st.root.problems.join(" ")).not.toMatch(/policy/);
  });
});

describe("transactions are IMMEDIATE (no SQLITE_BUSY_SNAPSHOT)", () => {
  /** A Proxy that, the first time the server runs a write statement through it, tries a write from a SECOND connection to
   *  the same file (busy_timeout 0). With a deferred transaction that write succeeds and the server's own write then fails
   *  with SQLITE_BUSY_SNAPSHOT; with IMMEDIATE the server already holds the write lock, so the second write can't interleave. */
  function interleaver(h: Harness, dbPath: string, sqlMatch: RegExp) {
    const second = openDb(dbPath);
    second.exec("PRAGMA busy_timeout = 0");
    const seen = { interleaved: false, blocked: false, fired: 0 };
    h.wrapDb((real: Database) => new Proxy(real, {
      get(target, prop) {
        if (prop === "query") {
          return (sql: string) => {
            if (seen.fired === 0 && sqlMatch.test(sql)) {
              seen.fired++;
              try { second.query("INSERT INTO audit_log(at, actor, action, target, details_json) VALUES ('t','other','interleave',NULL,'{}')").run(); seen.interleaved = true; }
              catch (e) { seen.blocked = /locked|busy/i.test(String(e)); }
            }
            return target.query(sql);
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }));
    return seen;
  }

  test("PATCH draft: a second connection can't write between the read and the write", async () => {
    const dbPath = "interleave-patch.db";
    const { h, draftIds } = await ready(3, {}, { dbPath });
    const seen = interleaver(h, join(h.dir, dbPath), /^UPDATE drafts SET service/);
    const r = await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { body: "Edited text" });
    expect(r.status).toBe(200);
    expect(seen.fired).toBe(1);
    expect(seen.interleaved).toBe(false); expect(seen.blocked).toBe(true);
  });

  test("approve verify, stop, settings and key enrolment all hold the write lock from their first read", async () => {
    const dbPath = "interleave-all.db";
    const { h, batchId, draftIds } = await ready(3, {}, { dbPath });
    // approve verify
    const opt = await options(h, batchId, [draftIds[0]!]);
    let seen = interleaver(h, join(h.dir, dbPath), /^INSERT INTO approvals/);
    const v = await h.call("POST", `/api/batches/${batchId}/approve/se-verify`, h.auth.signOptions(opt.json));
    expect(v.status).toBe(200);
    expect([seen.fired, seen.interleaved, seen.blocked]).toEqual([1, false, true]);
    // stop (revokeApprovals)
    seen = interleaver(h, join(h.dir, dbPath), /^UPDATE approvals SET revoked_at/);
    expect((await h.call("POST", "/api/stop", {})).status).toBe(200);
    expect([seen.fired, seen.interleaved, seen.blocked]).toEqual([1, false, true]);
    // settings
    seen = interleaver(h, join(h.dir, dbPath), /^INSERT INTO settings/);
    expect((await h.call("PATCH", "/api/settings", { breaker_on_failure: false })).status).toBe(200);
    expect([seen.fired, seen.interleaved, seen.blocked]).toEqual([1, false, true]);
    // skip + include
    seen = interleaver(h, join(h.dir, dbPath), /^UPDATE drafts SET status = 'skipped'/);
    expect((await h.call("POST", `/api/drafts/${draftIds[2]}/skip`, {})).status).toBe(200);
    expect([seen.fired, seen.interleaved, seen.blocked]).toEqual([1, false, true]);
    // key activation
    seen = interleaver(h, join(h.dir, dbPath), /^UPDATE native_keys SET status = 'active'/);
    await enrolSecond(h);
    expect([seen.fired, seen.interleaved, seen.blocked]).toEqual([1, false, true]);
  });

  test("a deferred transaction WOULD fail here (control): the second connection's write lands and ours errors", () => {
    const dir = process.env.TMPDIR ?? "/tmp";
    const path = join(dir, `busy-control-${process.pid}.db`);
    const a = openDb(path), b = openDb(path);
    b.exec("PRAGMA busy_timeout = 0");
    a.query("INSERT INTO settings(key, value) VALUES ('x','1') ON CONFLICT DO NOTHING").run();
    let err = "";
    try {
      a.transaction(() => {
        a.query("SELECT * FROM settings").all(); // read
        b.query("INSERT INTO settings(key, value) VALUES ('y','1')").run(); // second connection writes in between
        a.query("INSERT INTO settings(key, value) VALUES ('z','1')").run(); // our write
      })();
    } catch (e) { err = String(e); }
    expect(err).toMatch(/SQLITE_BUSY_SNAPSHOT|database is locked|busy/i);
    for (const p of [path, path + "-wal", path + "-shm"]) { try { Bun.spawnSync(["rm", "-f", p]); } catch { /* temp */ } }
  });
});

describe("approvability and covered_by", () => {
  test("failed and skipped drafts are approvable; one with a LIVE covering approval is not and says which", async () => {
    const { h, batchId, draftIds } = await ready();
    const { verify } = await approve(h, batchId, [draftIds[0]!]);
    h.db.query("UPDATE drafts SET status = 'failed' WHERE id = ?").run(draftIds[0]!);
    h.db.query("UPDATE drafts SET status = 'skipped' WHERE id = ?").run(draftIds[2]!);
    const b = await batchJson(h, batchId);
    const by = Object.fromEntries(b.drafts.map((d: any) => [d.id, d]));
    expect(by[draftIds[0]!].covered_by).toBe(verify.json.approval_id); // failed but still inside the live approval: the executor will retry
    expect(by[draftIds[1]!].covered_by).toBeNull();
    expect(by[draftIds[2]!].covered_by).toBeNull();
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(409); // "Approve 2" used to hit this
    const two = await approve(h, batchId, [draftIds[1]!, draftIds[2]!]);
    expect(two.verify.json.count).toBe(2);
    expect(statuses(h, batchId)).toEqual(["failed", "approved", "approved"]); // skipped switched to included by approving it
  });

  test("an approved draft whose approval expired is approvable again (re-approval after expiry)", async () => {
    const { h, batchId, draftIds } = await ready();
    const first = await approve(h, batchId, draftIds.slice(0, 2));
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(409);
    h.db.query("UPDATE approvals SET not_after = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), first.verify.json.approval_id);
    expect(statuses(h, batchId)).toEqual(["approved", "approved", "review"]); // the executor hasn't reverted them yet
    const b = await batchJson(h, batchId);
    expect(b.drafts.map((d: any) => d.covered_by)).toEqual([null, null, null]);
    const again = await approve(h, batchId, draftIds.slice(0, 2));
    expect(again.verify.json.approval_id).not.toBe(first.verify.json.approval_id);
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM approvals").get()!.n).toBe(2);
    // a revoked approval likewise
    h.db.query("UPDATE approvals SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), again.verify.json.approval_id);
    expect((await batchJson(h, batchId)).drafts[0].covered_by).toBeNull();
  });

  test("a CONSUMED item no longer covers the draft", async () => {
    const { h, batchId, draftIds } = await ready();
    const { verify } = await approve(h, batchId, [draftIds[0]!]);
    h.db.query("INSERT INTO sends(id, draft_id, approval_id, attempt, transport, started_at, result) VALUES ('s1',?,?,1,'dry',?,'sent')").run(draftIds[0]!, verify.json.approval_id, new Date().toISOString());
    expect((await batchJson(h, batchId)).drafts[0].covered_by).toBeNull();
  });

  test("a draft with no covering approval but status 'approved' (stale) and 'draft'/'sent' statuses", async () => {
    const { h, batchId, draftIds } = await ready();
    h.db.query("UPDATE drafts SET status = 'approved' WHERE id = ?").run(draftIds[0]!); // approved with NO approval at all
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(200);
    h.db.query("UPDATE drafts SET status = 'unknown' WHERE id = ?").run(draftIds[1]!);
    expect((await options(h, batchId, [draftIds[1]!])).json.error).toBe("draft_not_approvable");
  });
});

describe("stop, undo and resume", () => {
  test("stop records why; undo restores exactly that stop's approvals, their drafts and the kill switch", async () => {
    const { h, batchId, draftIds } = await ready();
    const keep = await approve(h, batchId, draftIds.slice(0, 2));
    const old = seedBatch(h.db, 1, "revoked earlier");
    const earlier = await approve(h, old.batchId, old.draftIds);
    await h.call("POST", `/api/batches/${old.batchId}/cancel`, {}); // revoked by something else, before the stop
    const r = await h.call("POST", "/api/stop", {});
    expect(r.json).toMatchObject({ kill_switch: true, kill_reason: "owner", revoked_approvals: 1, reverted_drafts: 2 });
    expect(r.json.stop_id).toBeGreaterThan(0);
    expect(getSettings(h.db)).toMatchObject({ kill_switch: true, kill_reason: "owner" });
    expect((await h.call("GET", "/api/status")).json).toMatchObject({ kill_switch: true, kill_reason: "owner" });
    expect(statuses(h, batchId)).toEqual(["review", "review", "review"]);
    const undo = await h.call("POST", "/api/stop/undo", { stop_id: r.json.stop_id });
    expect(undo.status).toBe(200);
    expect(undo.json).toMatchObject({ restored_approvals: 1, restored_drafts: 2, kill_switch: false });
    expect(statuses(h, batchId)).toEqual(["approved", "approved", "review"]);
    expect(h.db.query<any, [string]>("SELECT revoked_at FROM approvals WHERE id = ?").get(keep.verify.json.approval_id)!.revoked_at).toBeNull();
    // the approval revoked by the batch cancel before the stop stays revoked
    expect(h.db.query<any, [string]>("SELECT revoked_at FROM approvals WHERE id = ?").get(earlier.verify.json.approval_id)!.revoked_at).toBeTruthy();
    expect(getSettings(h.db)).toMatchObject({ kill_switch: false, kill_reason: "" });
    expect(h.db.query<any, []>("SELECT status FROM batches WHERE title = 'Test batch'").get()!.status).toBe("approved");
    // covered again, and once only
    expect((await options(h, batchId, [draftIds[0]!])).status).toBe(409);
    expect((await h.call("POST", "/api/stop/undo", { stop_id: r.json.stop_id })).json.error).toBe("already_undone");
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM audit_log WHERE action = 'stop.undo'").get()!.n).toBe(1);
  });

  test("undo skips drafts edited since the stop, expired approvals, unknown ids and late undos", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, draftIds.slice(0, 2));
    const r = await h.call("POST", "/api/stop", {});
    await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { body: "Changed my mind" }); // edited after the stop
    const undo = await h.call("POST", "/api/stop/undo", { stop_id: r.json.stop_id });
    expect(undo.json).toMatchObject({ restored_approvals: 1, restored_drafts: 1 });
    expect(statuses(h, batchId)).toEqual(["review", "approved", "review"]);
    expect((await h.call("POST", "/api/stop/undo", { stop_id: 999999 })).status).toBe(404);
    // too late
    const { h: h2, batchId: b2, draftIds: d2 } = await ready();
    await approve(h2, b2, d2);
    const s2 = await h2.call("POST", "/api/stop", {});
    h2.db.query("UPDATE audit_log SET at = ? WHERE id = ?").run(new Date(Date.now() - 3 * 60_000).toISOString(), s2.json.stop_id);
    expect((await h2.call("POST", "/api/stop/undo", { stop_id: s2.json.stop_id })).json.error).toBe("undo_expired");
    expect(getSettings(h2.db).kill_switch).toBe(true);
    // an approval that expired in the meantime isn't revived
    const { h: h3, batchId: b3, draftIds: d3 } = await ready();
    const a3 = await approve(h3, b3, d3);
    const s3 = await h3.call("POST", "/api/stop", {});
    h3.db.query("UPDATE approvals SET not_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), a3.verify.json.approval_id);
    expect((await h3.call("POST", "/api/stop/undo", { stop_id: s3.json.stop_id })).json).toMatchObject({ restored_approvals: 0, restored_drafts: 0, kill_switch: false });
  });

  test("undo puts the kill switch back to what it was before the stop (a tripped breaker stays tripped)", async () => {
    const { h } = await ready();
    h.db.query("UPDATE settings SET value = '1' WHERE key = 'kill_switch'").run();
    h.db.query("UPDATE settings SET value = 'breaker' WHERE key = 'kill_reason'").run();
    const r = await h.call("POST", "/api/stop", {});
    expect(getSettings(h.db).kill_reason).toBe("owner");
    await h.call("POST", "/api/stop/undo", { stop_id: r.json.stop_id });
    expect(getSettings(h.db)).toMatchObject({ kill_switch: true, kill_reason: "breaker" });
  });

  test("resume clears the reason and reports what was stopped it; undo after a resume leaves the switch alone", async () => {
    const { h } = await ready();
    h.db.query("UPDATE settings SET value = '1' WHERE key = 'kill_switch'").run();
    h.db.query("UPDATE settings SET value = 'breaker' WHERE key = 'kill_reason'").run();
    expect((await h.call("GET", "/api/status")).json.kill_reason).toBe("breaker");
    const r = await h.call("POST", "/api/resume", {});
    expect(r.json).toMatchObject({ kill_switch: false, was: "breaker" });
    expect(getSettings(h.db)).toMatchObject({ kill_switch: false, kill_reason: "" });
    const s = await h.call("POST", "/api/stop", {});
    await h.call("POST", "/api/resume", {});
    const u = await h.call("POST", "/api/stop/undo", { stop_id: s.json.stop_id });
    expect(u.status).toBe(200);
    expect(getSettings(h.db).kill_switch).toBe(false);
  });
});

describe("PATCH guards", () => {
  test("locked statuses, including unknown, can't be edited by any field", async () => {
    const { h, draftIds } = await ready();
    for (const st of ["sending", "sent", "unknown", "rejected"]) {
      h.db.query("UPDATE drafts SET status = ? WHERE id = ?").run(st, draftIds[0]!);
      for (const body of [{ body: "x" }, { service: "SMS" }, { handle: "+12025550199" }, { create_contact: false }]) {
        const r = await h.call("PATCH", `/api/drafts/${draftIds[0]}`, body);
        expect([st, Object.keys(body)[0], r.status, r.json.error]).toEqual([st, Object.keys(body)[0], 409, "draft_locked"]);
      }
      expect((await h.call("POST", `/api/drafts/${draftIds[0]}/skip`, {})).status).toBe(409);
    }
    expect(getDrafts(h.db, h.db.query<any, []>("SELECT id FROM batches").get()!.id)[0]!.body).toContain("Hello Person 1");
  });

  test("every UPDATE carries the status guard: a draft that starts sending between our read and write is refused, nothing changes", async () => {
    const { h, draftIds } = await ready();
    h.wrapDb((real: Database) => new Proxy(real, {
      get(target, prop) {
        if (prop === "query") {
          return (sql: string) => {
            // the executor flips the draft to 'sending' after our status check, before our UPDATE
            if (/^UPDATE drafts SET service/.test(sql)) target.query("UPDATE drafts SET status = 'sending' WHERE id = ?").run(draftIds[0]!);
            return target.query(sql);
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    }));
    const before = h.db.query<any, [string]>("SELECT body, version FROM drafts WHERE id = ?").get(draftIds[0]!)!;
    const r = await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { body: "too late" });
    expect(r.status).toBe(409); expect(r.json.error).toBe("draft_locked");
    const after = h.db.query<any, [string]>("SELECT body, version, status FROM drafts WHERE id = ?").get(draftIds[0]!)!;
    expect(after).toMatchObject({ body: before.body, version: before.version }); // the whole transaction rolled back
    expect(h.db.query<any, [string]>("SELECT COUNT(*) n FROM draft_revisions WHERE draft_id = ? AND version = 2").get(draftIds[0]!)!.n).toBe(0); // rolled back
  });

  test("editing an approved draft drops it to review; fields and body change together in one revision", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, [draftIds[0]!]);
    const r = await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { body: "Newer", service: "SMS" });
    expect(r.json.draft).toMatchObject({ status: "review", body: "Newer", service: "SMS", version: 2 });
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM draft_revisions WHERE draft_id = '" + draftIds[0] + "'").get()!.n).toBe(2);
    // a no-op edit changes nothing
    const same = await h.call("PATCH", `/api/drafts/${draftIds[0]}`, { body: "Newer" });
    expect(same.json.draft.version).toBe(2);
  });
});

describe("warnings gate the approval", () => {
  function flagged(h: Harness, batchId: string) {
    const w = (code: WarningCode): Warning[] => [{ code, message: code }];
    const ids = {
      unresolved: addDraft(h.db, batchId, { handle: "+12025550111", recipient_name: "A", body: "Hi {{first_name}}", actor: "agent", warnings: w("unresolved_var") }),
      empty: addDraft(h.db, batchId, { handle: "+12025550112", recipient_name: "B", body: "x", actor: "agent", warnings: w("empty_body") }),
      invalid: addDraft(h.db, batchId, { handle: "+12025550113", recipient_name: "C", body: "x", actor: "agent", warnings: w("invalid_handle") }),
      dup: addDraft(h.db, batchId, { handle: "+12025550114", recipient_name: "D", body: "x", actor: "agent", warnings: w("duplicate_recipient") }),
      soft: addDraft(h.db, batchId, { handle: "+12025550115", recipient_name: "E", body: "x", actor: "agent", warnings: w("recently_messaged") }),
    };
    return ids;
  }
  test("only unresolved_var / duplicate_recipient are held behind include_anyway", async () => {
    const { h, batchId } = await ready(1);
    const ids = flagged(h, batchId);
    for (const key of ["unresolved", "dup"] as const) {
      const r = await options(h, batchId, [ids[key]]);
      expect([key, r.status, r.json.error, r.json.draft_ids]).toEqual([key, 409, "warnings_unacknowledged", [ids[key]]]);
      const ok = await options(h, batchId, [ids[key]], { include_anyway: [ids[key]] });
      expect([key, ok.status]).toEqual([key, 200]);
      expect(ok.json.drafts[0].warnings[0].code).toBeTruthy();
    }
    expect((await options(h, batchId, [ids.soft])).status).toBe(200);
    // the flag for one draft doesn't excuse another
    expect((await options(h, batchId, [ids.unresolved, ids.dup], { include_anyway: [ids.unresolved] })).json.draft_ids).toEqual([ids.dup]);
    // one include_anyway list can cover many (the batch-level switch)
    expect((await options(h, batchId, [ids.unresolved, ids.dup, ids.soft], { include_anyway: [ids.unresolved, ids.dup] })).status).toBe(200);
  });

  test("empty_body / invalid_handle can never be approved, include_anyway or not", async () => {
    const { h, batchId } = await ready(1);
    const ids = flagged(h, batchId);
    for (const key of ["empty", "invalid"] as const) {
      for (const extra of [{}, { include_anyway: [ids[key]] }]) {
        const r = await options(h, batchId, [ids[key]], extra);
        expect([key, r.status, r.json.error, r.json.draft_ids]).toEqual([key, 409, "draft_unsendable", [ids[key]]]);
      }
    }
    // mixed with sendable ones the whole request is refused, naming only the unsendable draft
    const mixed = await options(h, batchId, [ids.soft, ids.invalid], { include_anyway: [ids.invalid] });
    expect([mixed.status, mixed.json.draft_ids]).toEqual([409, [ids.invalid]]);
  });

  test("advisory warnings never hold a draft back", async () => {
    const { h, batchId } = await ready(1);
    const codes: WarningCode[] = ["recently_messaged", "link_in_first_message", "non_mobile", "too_long", "pending_elsewhere", "ambiguous_contact", "empty_var", "identical_to_template", "new_contact"];
    const ids = codes.map((code, i) => addDraft(h.db, batchId, { handle: `+1202555020${i}`, recipient_name: code, body: "x", actor: "agent", warnings: [{ code, message: code }] }));
    const r = await options(h, batchId, ids);
    expect(r.status).toBe(200);
    expect(r.json.manifest.items.length).toBe(codes.length);
  });

  test("a chain to one person: both messages approve together under one include_anyway", async () => {
    const { h, batchId } = await ready(1);
    const w = (code: WarningCode): Warning[] => [{ code, message: code }];
    const a = addDraft(h.db, batchId, { handle: "+12025550301", recipient_name: "Chain", body: "invite {{x}}", actor: "agent", warnings: w("unresolved_var") });
    const b = addDraft(h.db, batchId, { handle: "+12025550301", recipient_name: "Chain", body: "link", actor: "agent", warnings: w("link_in_first_message") });
    expect((await options(h, batchId, [a, b])).json.draft_ids).toEqual([a]);
    const ok = await options(h, batchId, [a, b], { include_anyway: [a, b] });
    expect(ok.status).toBe(200);
    expect(ok.json.manifest.items.map((i: any) => i.draft_id)).toEqual([a, b]);
  });

  test("one bulk request skips or includes a whole chain, and leaves other people alone", async () => {
    const { h, batchId, draftIds } = await ready(1);
    const chain = [0, 1].map((i) => addDraft(h.db, batchId, { handle: "+12025550401", recipient_name: "Chain", body: `m${i}`, actor: "agent" }));
    expect((await h.call("POST", `/api/batches/${batchId}/skip`, { draft_ids: chain, skipped: true })).json.changed).toBe(2);
    expect(statuses(h, batchId)).toEqual(["review", "skipped", "skipped"]);
    expect((await h.call("POST", `/api/batches/${batchId}/skip`, { draft_ids: chain, skipped: false })).json.changed).toBe(2);
    expect(statuses(h, batchId)).toEqual(["review", "review", "review"]);
    expect(draftIds.length).toBe(1);
  });

  test("bulk skip excludes the chosen drafts (never approved or locked ones) and include brings them back", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, [draftIds[0]!]);
    h.db.query("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draftIds[2]!);
    const r = await h.call("POST", `/api/batches/${batchId}/skip`, { draft_ids: draftIds });
    expect(r.json.changed).toBe(1); // only the plain review one
    expect(statuses(h, batchId)).toEqual(["approved", "skipped", "sent"]);
    expect((await h.call("POST", `/api/batches/${batchId}/skip`, { draft_ids: draftIds, skipped: false })).json.changed).toBe(1);
    expect(statuses(h, batchId)).toEqual(["approved", "review", "sent"]);
    expect((await h.call("POST", "/api/batches/nope/skip", { draft_ids: ["x"] })).status).toBe(404);
  });
});

describe("proposed contacts keep exactly the draft's handle", () => {
  test("a mismatched proposal is refused at options; toggling create_contact strips the extras", async () => {
    const { h, batchId, draftIds } = await ready();
    const withExtras = { given_name: "Per", family_name: "Son", org: "Acme", tags: ["friend"], phones: [{ e164: "+12025550101", label: "mobile" }, { e164: "+12025559999", label: "home" }], emails: [{ email: "p@x.com", label: "work" }] };
    h.db.query("UPDATE drafts SET proposed_contact_json = ?, create_contact = 1 WHERE id = ?").run(JSON.stringify(withExtras), draftIds[1]!);
    const refused = await options(h, batchId, [draftIds[1]!]);
    expect(refused.status).toBe(409); expect(refused.json.error).toBe("proposed_contact_mismatch");
    // owner toggles it off and on again: only the draft's own handle survives, other fields are kept
    expect((await h.call("PATCH", `/api/drafts/${draftIds[1]}`, { create_contact: false })).status).toBe(200);
    const on = await h.call("PATCH", `/api/drafts/${draftIds[1]}`, { create_contact: true });
    expect(on.json.draft.proposed_contact).toEqual({ given_name: "Per", family_name: "Son", org: "Acme", tags: ["friend"], phones: [{ e164: "+12025550101", label: "mobile" }], emails: [] });
    const ok = await options(h, batchId, [draftIds[1]!]);
    expect(ok.status).toBe(200);
    expect(ok.json.manifest.items[0].create_contact.phones).toHaveLength(1);
    expect(ok.json.manifest.items[0].create_contact.emails).toEqual([]);
  });

  test("changing the number rewrites the proposal to the new number; email handles work too", async () => {
    const { h, draftIds } = await ready();
    const r = await h.call("PATCH", `/api/drafts/${draftIds[1]}`, { handle: "(202) 555-0177" });
    expect(r.json.draft.handle).toBe("+12025550177");
    expect(r.json.draft.proposed_contact.phones).toEqual([{ e164: "+12025550177", label: "mobile" }]);
    const e = await h.call("PATCH", `/api/drafts/${draftIds[1]}`, { handle: "Sam@Example.com" });
    expect(e.json.draft.proposed_contact).toMatchObject({ phones: [], emails: [{ email: "sam@example.com", label: "other" }] });
  });
});

describe("recipient display and the ambiguous-contact picker", () => {
  function contact(h: Harness, id: string, name: string, handles: string[], org = "") {
    h.db.query("INSERT INTO contacts(id, source, display_name, given_name, family_name, org, phones_json, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, "manual", name, name.split(" ")[0]!, name.split(" ")[1] ?? "", org, JSON.stringify(handles.map((e164) => ({ e164, label: "mobile" }))), new Date().toISOString());
    for (const hd of handles) h.db.query("INSERT INTO contact_handles(handle, contact_id) VALUES (?,?)").run(hd, id);
  }
  test("number_in_contact is false when the draft's handle isn't among its contact's, with the contact's handles listed", async () => {
    const { h, batchId, draftIds } = await ready();
    contact(h, "c1", "Sam Lee", ["+12025550100"]);
    h.db.query("UPDATE drafts SET contact_id = 'c1' WHERE id = ?").run(draftIds[0]!); // handle +12025550100: in contact
    h.db.query("UPDATE drafts SET contact_id = 'c1' WHERE id = ?").run(draftIds[2]!); // handle +12025550102: not in contact
    const b = await batchJson(h, batchId);
    expect(b.drafts[0]).toMatchObject({ number_in_contact: true, contact: { id: "c1", display_name: "Sam Lee", handles: ["+12025550100"] } });
    expect(b.drafts[1]).toMatchObject({ number_in_contact: null, contact: null });
    expect(b.drafts[2].number_in_contact).toBe(false);
    const opt = await options(h, batchId, [draftIds[2]!]);
    expect(opt.json.drafts[0].number_in_contact).toBe(false);
  });

  test("candidates come with the draft; 'use existing' links it and moves it to the contact's number; 'keep + create new' builds a proposal", async () => {
    const { h, batchId } = await ready(1);
    contact(h, "c1", "Dana Cole", ["+12025550130", "+12025550131"], "Acme");
    contact(h, "c2", "Dana Cole", ["+12025550140"]);
    const ambig = addDraft(h.db, batchId, {
      handle: "+12025550199", recipient_name: "Dana Cole", body: "Hi Dana", actor: "template", import_id: undefined,
      warnings: [{ code: "ambiguous_contact", message: "May match an existing contact: Dana Cole" }],
    });
    let b = await batchJson(h, batchId);
    const d = b.drafts.find((x: any) => x.id === ambig);
    expect(d.candidates.map((c: any) => c.contact_id).sort()).toEqual(["c1", "c2"]);
    expect(d.candidates.find((c: any) => c.contact_id === "c1")).toMatchObject({ display_name: "Dana Cole", org: "Acme", handles: expect.arrayContaining(["+12025550130", "+12025550131"]) });
    // a number that isn't the contact's is refused
    expect((await h.call("PATCH", `/api/drafts/${ambig}`, { contact_id: "c1", handle: "+12025550199" })).status).toBe(400);
    expect((await h.call("PATCH", `/api/drafts/${ambig}`, { contact_id: "nope" })).status).toBe(400);
    const use = await h.call("PATCH", `/api/drafts/${ambig}`, { contact_id: "c1", handle: "+12025550131" });
    expect(use.status).toBe(200);
    expect(use.json.draft).toMatchObject({ contact_id: "c1", handle: "+12025550131", recipient_name: "Dana Cole", create_contact: false, proposed_contact: null });
    expect(use.json.draft.warnings.some((w: any) => w.code === "ambiguous_contact")).toBe(false);
    // second draft: keep the number and create a new contact
    const ambig2 = addDraft(h.db, batchId, {
      handle: "+12025550198", recipient_name: "Dana Cole", body: "Hi again", actor: "template",
      warnings: [{ code: "ambiguous_contact", message: "May match" }],
    });
    const keep = await h.call("PATCH", `/api/drafts/${ambig2}`, { create_contact: true });
    expect(keep.status).toBe(200);
    expect(keep.json.draft).toMatchObject({ contact_id: null, handle: "+12025550198", create_contact: true });
    expect(keep.json.draft.proposed_contact).toMatchObject({ given_name: "Dana", family_name: "Cole", phones: [{ e164: "+12025550198", label: "mobile" }], emails: [] });
    expect(keep.json.draft.warnings.some((w: any) => w.code === "ambiguous_contact")).toBe(false);
    // without an ambiguity warning there is nothing to synthesise a contact from
    const plain = (await ready(1));
    expect((await plain.h.call("PATCH", `/api/drafts/${plain.draftIds[0]}`, { create_contact: true })).status).toBe(400);
    b = await batchJson(h, batchId);
    expect(b.drafts.find((x: any) => x.id === ambig2).candidates).toEqual([]); // resolved: no picker
  });
});

describe("imports: filtered pages, re-ingest with a sheet or region", () => {
  const rowsCsv = ["name,phone"].concat(Array.from({ length: 12 }, (_, i) => `Person ${i},(202) 555-01${String(i).padStart(2, "0")}`), ["Bad,not a number", "Bad2,"]).join("\n") + "\n";
  async function upload(h: Harness, content: string, name = "people.csv", extra: Record<string, string> = {}) {
    const r = await h.call("POST", "/api/imports", { filename: name, data_b64: Buffer.from(content, "utf8").toString("base64"), ...extra });
    return { status: r.status, json: r.json as any };
  }
  const tmp = () => join(process.env.TMPDIR ?? "/tmp", `outbox-imp-${Math.random().toString(36).slice(2)}`);

  test("GET /api/imports/:id pages and filters the rows with issue messages", async () => {
    const h = makeHarness({ importsDir: tmp() });
    await h.signUp();
    const up = await upload(h, rowsCsv);
    const id = up.json.import_id;
    const all = (await h.call("GET", `/api/imports/${id}?limit=5`)).json;
    expect(all.rows).toHaveLength(5); expect(all.rows_total).toBe(14); expect(all.counts.invalid).toBe(2);
    expect(all.rows[0]).toMatchObject({ row_index: 0 });
    const page2 = (await h.call("GET", `/api/imports/${id}?limit=5&offset=10`)).json;
    expect(page2.rows.map((r: any) => r.row_index)).toEqual([10, 11, 12, 13]);
    const invalid = (await h.call("GET", `/api/imports/${id}?match=invalid`)).json;
    expect(invalid.rows_total).toBe(2); expect(invalid.rows.every((r: any) => r.match === "invalid")).toBe(true);
    expect(invalid.rows.some((r: any) => r.issues.length > 0 && typeof r.issues[0].message === "string")).toBe(true);
    expect((await h.call("GET", `/api/imports/${id}?match=new&limit=100`)).json.rows_total).toBe(12);
  });

  test("reingest re-reads the stored file with a sheet and region and creates a new import", async () => {
    const h = makeHarness({ importsDir: tmp() });
    await h.signUp();
    const up = await upload(h, "name,phone\nAda,020 7946 0958\n", "uk.csv");
    expect(up.json.counts.invalid + up.json.counts.new).toBe(1);
    const re = await h.call("POST", `/api/imports/${up.json.import_id}/reingest`, { region: "GB", sheet: "Sheet1" });
    expect(re.status).toBe(200);
    expect(re.json.import_id).not.toBe(up.json.import_id);
    expect(re.json.filename).toBe("uk.csv");
    expect(h.db.query<any, []>("SELECT COUNT(*) n FROM imports").get()!.n).toBe(2);
    expect(h.db.query<any, []>("SELECT details_json FROM audit_log WHERE action = 'import.reingest'").get()!.details_json).toContain('"region":"GB"');
    expect((await h.call("POST", "/api/imports/nope/reingest", {})).status).toBe(404);
    expect((await h.call("POST", `/api/imports/${up.json.import_id}/reingest`, { region: "United States" })).status).toBe(400);
    // an import row pointing outside the import store is never read
    h.db.query("UPDATE imports SET stored_path = '/etc/hosts' WHERE id = ?").run(up.json.import_id);
    expect((await h.call("POST", `/api/imports/${up.json.import_id}/reingest`, {})).status).toBe(400);
  });

  test("a region is accepted on upload and mapping, and validated", async () => {
    const h = makeHarness({ importsDir: tmp() });
    await h.signUp();
    const up = await upload(h, "name,phone\nAda,020 7946 0958\n", "uk.csv", { region: "gb" });
    expect(up.status).toBe(200);
    expect((await upload(h, "name,phone\nAda,1\n", "x.csv", { region: "USA" })).status).toBe(400);
    const m = await h.call("PUT", `/api/imports/${up.json.import_id}/mapping`, { fields: up.json.mapping.fields, confirmed: true, region: "GB" });
    expect(m.status).toBe(200);
    expect((await h.call("POST", "/api/imports", { text: "name,phone\nAda,1", region: "zz1" })).status).toBe(400);
    expect((await h.call("POST", "/api/imports", { text: "name,phone\nAda,202 555 0101", region: "us" })).status).toBe(200);
  });
});

describe("misc", () => {
  test("approvals in the batch API show their transport; the approvals list keeps working with v1 rows", async () => {
    const { h, batchId, draftIds } = await ready();
    await approve(h, batchId, [draftIds[0]!]);
    const b = await batchJson(h, batchId);
    expect(b.approvals[0]).toMatchObject({ items: 1, transport: "dry" });
  });
  test("the user pin is replaced atomically and never world-readable", async () => {
    const { h } = await ready();
    const p = join(h.dir, "passkeys.json");
    chmodSync(p, 0o644);
    await h.call("PUT", "/api/pin-policy", { ...DEFAULT_PIN_POLICY, live_allowed: true, se_reauth: await h.reauth("policy_live") });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(existsSync(p + `.${process.pid}.tmp`)).toBe(false);
  });
});
