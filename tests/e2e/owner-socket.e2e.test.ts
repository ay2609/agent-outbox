// Socket e2e (replaces the Playwright browser e2e). Spawns the REAL `src/server.ts` exactly as Agent Outbox.app does:
//   - the per-launch app token goes in through a pipe on fd 3 (`--app-auth-fd 3`), never env, argv or disk;
//   - stdin stays open as the lifeline (closing it must stop the server);
//   - OUTBOX_HOME is a temp dir; the owner API is reached ONLY over <state>/run/owner.sock with `fetch(url, { unix })`.
// Software P-256 keys (WebCrypto) stand in for the Secure Enclave. They sign M(tag, digest) built HERE from the contract in
// APP-SECURITY-APPONLY.md §2.1, not by importing the server's own helpers, so a drift in either side fails this test.
//
// Runs under `bun test` (needs the sandbox off for the socket, lsof and spawning bun). Not covered here: the real executor (needs a
// Swift build and the macOS Messages stack); tests/e2e/exec-roundtrip.sh runs this test with E2E_KEEP_DIR and feeds the result to it.
//   E2E_KEEP_DIR=<dir>  use that state dir, leave it behind (the key-1 dry approval stays live for the executor) instead of a temp dir.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const KEEP = process.env.E2E_KEEP_DIR;
const HOME = KEEP ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-e2e-"));
mkdirSync(HOME, { recursive: true, mode: 0o700 });
const OWNER_SOCK = join(HOME, "run", "owner.sock");
const AGENT_SOCK = join(HOME, "run", "agent.sock");

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

// ---------- a software "Secure Enclave" key, signing exactly like the app ----------
function derInt(raw: Uint8Array): Buffer {
  let i = 0;
  while (i < raw.length - 1 && raw[i] === 0) i++;
  let v = Buffer.from(raw.subarray(i));
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return Buffer.concat([Buffer.from([0x02, v.length]), v]);
}
/** WebCrypto returns r||s (IEEE P1363); the contract wants DER. */
function p1363ToDer(sig: Uint8Array): Buffer {
  const body = Buffer.concat([derInt(sig.subarray(0, 32)), derInt(sig.subarray(32, 64))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
const M = (tag: string, digest: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from("agent-outbox/se/v1"), Buffer.from([0]), Buffer.from(tag), Buffer.from([0]), Buffer.from(digest)]);

class SoftKey {
  constructor(private priv: CryptoKey, readonly x963: Buffer) {}
  static async make(): Promise<SoftKey> {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return new SoftKey(kp.privateKey, Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)));   // 65 bytes: 0x04 || x || y
  }
  get id(): string { return b64u(sha(this.x963)); }
  get x963b64(): string { return b64u(this.x963); }
  async sign(tag: "send" | "contacts" | "reauth" | "enroll", digest: Uint8Array): Promise<string> {
    return b64u(p1363ToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, new Uint8Array(M(tag, digest))))));
  }
}

// ---------- the real server ----------
const TOKEN = b64u(randomBytes(32));
let proc: ReturnType<typeof Bun.spawn> | null = null;
let log = "";
const decoder = new TextDecoder();

function spawnServer(home: string, token: string | null, extraEnv: Record<string, string> = {}) {
  const args = [process.execPath, "run", join(ROOT, "src", "server.ts"), ...(token === null ? [] : ["--app-auth-fd", "3"])];
  const p = Bun.spawn(args, { cwd: ROOT, env: { ...process.env, OUTBOX_HOME: home, ...extraEnv }, stdio: ["pipe", "pipe", "pipe", "pipe"] as any });
  if (token !== null) {
    const fd = (p as any).stdio[3] as number;
    writeSync(fd, token + "\n");
    closeSync(fd);                                  // EOF: the server reads to EOF
  } else closeSync((p as any).stdio[3] as number);
  return p;
}
function collect(p: ReturnType<typeof Bun.spawn>, sink: (s: string) => void) {
  for (const s of [p.stdout, p.stderr]) {
    (async () => { for await (const chunk of s as any) sink(decoder.decode(chunk)); })().catch(() => {});
  }
}
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return; await Bun.sleep(50); }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

type Res = { status: number; json: any; headers: Headers };
async function owner(method: string, path: string, body?: unknown, o: { token?: string | null; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const tok = o.token === undefined ? TOKEN : o.token;
  if (tok !== null) headers["x-outbox-app"] = tok;
  const res = await fetch(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), unix: OWNER_SOCK } as any);
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
async function agent(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`http://outbox${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), unix: AGENT_SOCK } as any);
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
/** Enrols `key` (options -> enroll proof signature -> verify) with the given proof fields. */
async function enrol(key: SoftKey, proof: Record<string, unknown>, label = "e2e key"): Promise<{ options: Res; verify: Res }> {
  const options = await owner("POST", "/api/native-keys/enroll/options", { x963: key.x963b64, label });
  expect(options.status).toBe(200);
  const sig = await key.sign("enroll", sha(Buffer.concat([Buffer.from(options.json.challenge, "base64url"), key.x963])));
  const verify = await owner("POST", "/api/native-keys/enroll/verify", { key_id: options.json.key_id, signature: sig, ...proof });
  return { options, verify };
}
async function reauth(key: SoftKey, action: string, target?: string) {
  const o = await owner("POST", "/api/native-keys/reauth/options", { action, ...(target ? { target } : {}) });
  expect(o.status).toBe(200);
  return { challenge_id: o.json.challenge_id, key_id: key.id, signature: await key.sign("reauth", sha(Buffer.from(o.json.challenge, "base64url"))) };
}
/** options -> Touch ID stand-in signature over M("send", sha256(manifest_bytes)) -> se-verify. */
async function approveBatch(key: SoftKey, batchId: string, draftIds: string[]): Promise<{ opt: Res; verify: Res }> {
  const opt = await owner("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds });
  expect(opt.status).toBe(200);
  const signature = await key.sign("send", sha(opt.json.manifest_bytes));
  const verify = await owner("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: key.id, signature });
  return { opt, verify };
}
async function newBatch(n: number, title: string): Promise<{ batchId: string; draftIds: string[] }> {
  const b = await agent("POST", "/v1/batches", { title });
  expect(b.status).toBe(201);
  const batchId = b.json.batch.id as string;
  const items = Array.from({ length: n }, (_, i) => ({ to: `+1202555${String(7000 + i + Math.floor(Math.random() * 900))}`, body: `e2e message ${i + 1}`, name: `E2E ${i + 1}` }));
  const a = await agent("POST", `/v1/batches/${batchId}/items`, { items });
  expect(a.status).toBeLessThan(300);
  const s = await agent("POST", `/v1/batches/${batchId}/submit`, {});
  expect(s.status).toBe(200);
  const d = await agent("GET", `/v1/batches/${batchId}`);
  return { batchId, draftIds: d.json.drafts.map((x: any) => x.id) };
}
const listening = (pid: number): string => {
  const r = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-n", "-P"]);
  return decoder.decode(r.stdout).trim();
};
/** Proof that lsof works here at all (so an empty TCP list means something): it must see the unix sockets of the same process. */
const unixSockets = (pid: number): string => decoder.decode(Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-U", "-n", "-P"]).stdout);

const k1 = { key: null as SoftKey | null }, k2 = { key: null as SoftKey | null };
let setupTokenValue = "";
const recoveryTokens: string[] = [];

beforeAll(async () => {
  proc = spawnServer(HOME, TOKEN);
  collect(proc, (s) => { log += s; });
  await waitFor(() => existsSync(OWNER_SOCK) && existsSync(AGENT_SOCK), 20_000, "the sockets");
  await waitFor(async () => { try { return (await owner("GET", "/api/status")).status === 200; } catch { return false; } }, 20_000, "the owner API");
  k1.key = await SoftKey.make(); k2.key = await SoftKey.make();
});
afterAll(async () => {
  try { proc?.kill(); } catch { /* already gone */ }
  await Bun.sleep(100);
  if (!KEEP) rmSync(HOME, { recursive: true, force: true });
});

describe("the process and its sockets", () => {
  test("no TCP listener exists, the sockets are 0600 in a 0700 run dir, and the server logged no secret", async () => {
    expect(proc!.pid).toBeGreaterThan(0);
    expect(unixSockets(proc!.pid)).toContain("owner.sock");
    expect(listening(proc!.pid)).toBe("");
    expect(statSync(OWNER_SOCK).mode & 0o777).toBe(0o600);
    expect(statSync(OWNER_SOCK).isSocket()).toBe(true);
    expect(statSync(join(HOME, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(HOME).mode & 0o777).toBe(0o700);
    expect(log).toContain("owner API on");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toMatch(/token=|#\/setup|localhost:7/);
  });

  test("the app token only works as X-Outbox-App: missing or wrong is 401 app_auth; browsers are refused; non-/api and deleted routes are 404", async () => {
    for (const token of [null, "wrong", b64u(randomBytes(32))]) {
      const r = await owner("GET", "/api/status", undefined, { token });
      expect([r.status, r.json.error]).toEqual([401, "app_auth"]);
    }
    for (const headers of [{ origin: "http://localhost:7477" }, { "sec-fetch-site": "same-origin" }, { "sec-fetch-mode": "navigate" }] as Record<string, string>[]) {
      const r = await owner("GET", "/api/status", undefined, { headers });
      expect([JSON.stringify(headers), r.status, r.json.error]).toEqual([JSON.stringify(headers), 403, "browser_refused"]);
    }
    for (const [m, p] of [["GET", "/"], ["GET", "/index.html"], ["POST", "/api/auth/login/options"], ["GET", "/api/passkeys"], ["POST", "/api/app/browser-link"], ["POST", "/api/batches/x/approve/verify"]] as const) {
      const r = await owner(m, p, m === "GET" ? undefined : {});
      expect([m, p, r.status, r.json.error]).toEqual([m, p, 404, "not_found"]);
    }
    expect((await owner("GET", "/")).headers.get("set-cookie")).toBeNull();
  });
});

describe("first run: setup token", () => {
  test("fresh install: status says setup is open with a setup token; the token is a private file and is never served", async () => {
    const st = (await owner("GET", "/api/status")).json;
    expect(st.setup).toEqual({ done: false, proof_available: "setup_token", recovery_expires_at: null });
    expect(st.native).toEqual({ keys_active: 0, approve_in_app: false, pin_needs_update: false });
    expect(JSON.stringify(st)).not.toMatch(/setup_token_value/);
    const f = join(HOME, "setup-token");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    setupTokenValue = readFileSync(f, "utf8").trim();
    expect(setupTokenValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(log).not.toContain(setupTokenValue);
    // the pin exists from the first start: v4 with no keys
    expect(JSON.parse(readFileSync(join(HOME, "passkeys.json"), "utf8"))).toEqual({ v: 4, keys: [], policy: { live_allowed: true, contacts_live_allowed: true } });
  });

  test("without a proof the new key is refused (403 proof_required); with a wrong setup token 403; with the right one the key is active", async () => {
    const key = k1.key!;
    const o = await owner("POST", "/api/native-keys/enroll/options", { x963: key.x963b64, label: "MacBook" });
    expect(o.json.proof).toBe("setup_token");
    const sig = await key.sign("enroll", sha(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), key.x963])));
    const none = await owner("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig });
    expect([none.status, none.json.error]).toEqual([403, "proof_required"]);
    const wrong = await owner("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, setup_token: b64u(randomBytes(32)) });
    expect([wrong.status, wrong.json.error]).toEqual([403, "setup_token_invalid"]);
    const bad = await owner("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: await key.sign("send", sha("x")), setup_token: setupTokenValue });
    expect(bad.status).toBe(401);
    const ok = await owner("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, setup_token: setupTokenValue });
    expect([ok.status, ok.json]).toEqual([200, { status: "active" }]);
    expect(existsSync(join(HOME, "setup-token"))).toBe(false);
    const st = (await owner("GET", "/api/status")).json;
    expect(st.setup.done).toBe(true);
    expect(st.native).toEqual({ keys_active: 1, approve_in_app: true, pin_needs_update: false });
    expect(JSON.parse(readFileSync(join(HOME, "passkeys.json"), "utf8")).keys.map((k: any) => k.credential_id)).toEqual([key.id]);
    // the token can't be used again
    const again = await enrol(await SoftKey.make(), { setup_token: setupTokenValue });
    expect([again.verify.status, again.verify.json.error]).toEqual([403, "setup_token_invalid"]);
  });
});

describe("approving with a real P-256 signature", () => {
  test("dry approval: manifest constants, signature verified, approval row, drafts approved; a forged or replayed signature is refused", async () => {
    expect((await owner("POST", "/api/mode", { mode: "dry" })).status).toBe(200);
    const { batchId, draftIds } = await newBatch(2, "e2e approve");
    const opt = await owner("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds });
    expect(opt.status).toBe(200);
    expect(opt.json.se).toEqual({ tag: "send", key_ids: [k1.key!.id] });
    expect(opt.json.manifest).toMatchObject({ v: 2, transport: "dry", rp_id: "agent-outbox", origin: "agent-outbox:app", batch_id: batchId });
    // forged: the other (unenrolled) key signs
    const stranger = await SoftKey.make();
    const forged = await owner("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: k1.key!.id, signature: await stranger.sign("send", sha(opt.json.manifest_bytes)) });
    expect(forged.status).toBe(401);
    const opt2 = await owner("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds });
    // wrong tag
    expect((await owner("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt2.json.challenge_id, key_id: k1.key!.id, signature: await k1.key!.sign("contacts", sha(opt2.json.manifest_bytes)) })).status).toBe(401);
    // the real thing
    const { opt: o3, verify } = await approveBatch(k1.key!, batchId, draftIds);
    expect(verify.status).toBe(200);
    expect(verify.json).toMatchObject({ ok: true, count: 2, credential_id: k1.key!.id, transport: "dry" });
    expect(verify.json.approval_id).toBe(o3.json.manifest.approval_id);
    const b = await owner("GET", `/api/batches/${batchId}`);
    expect(b.json.drafts.map((d: any) => d.status)).toEqual(["approved", "approved"]);
    expect(b.json.approvals).toHaveLength(1);
    // the challenge is single use
    const replay = await owner("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: o3.json.challenge_id, key_id: k1.key!.id, signature: await k1.key!.sign("send", sha(o3.json.manifest_bytes)) });
    expect([replay.status, replay.json.error]).toEqual([400, "challenge_invalid"]);
    // the pin file (what the executor trusts) holds exactly this key
    const pin = JSON.parse(readFileSync(join(HOME, "passkeys.json"), "utf8"));
    expect(pin.keys).toEqual([{ kind: "secure-enclave", credential_id: k1.key!.id, x963: k1.key!.x963b64, label: "MacBook" }]);
  });

  test("going live needs a Touch ID confirmation bound to mode_live; the old `reauth` field is a 400", async () => {
    expect((await owner("POST", "/api/mode", { mode: "live" })).json.error).toBe("reauth_required");
    expect((await owner("POST", "/api/mode", { mode: "live", reauth: { challenge_id: "x", response: {} } })).status).toBe(400);
    expect((await owner("POST", "/api/mode", { mode: "live", se_reauth: await reauth(k1.key!, "policy_live") })).status).toBe(400);
    const ok = await owner("POST", "/api/mode", { mode: "live", se_reauth: await reauth(k1.key!, "mode_live") });
    expect(ok.status).toBe(200);
    expect(ok.json.settings.transport).toBe("live");
    expect((await owner("POST", "/api/mode", { mode: "dry" })).status).toBe(200);
  });
});

describe("another key: se_reauth", () => {
  test("a second key is enrolled with the first key's confirmation bound to that pending key; a mismatched target is refused", async () => {
    const key = k2.key!;
    const o = await owner("POST", "/api/native-keys/enroll/options", { x963: key.x963b64, label: "Mac mini" });
    expect(o.json.proof).toBe("se_reauth");
    const sig = await key.sign("enroll", sha(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), key.x963])));
    const other = await SoftKey.make();
    const oo = await owner("POST", "/api/native-keys/enroll/options", { x963: other.x963b64 });
    const forOther = await reauth(k1.key!, "native_key_add", oo.json.key_id);
    const mismatch = await owner("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: forOther });
    expect([mismatch.status, mismatch.json.error]).toEqual([400, "challenge_invalid"]);
    const noProof = await owner("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig });
    expect(noProof.json.error).toBe("proof_required");
    const good = await reauth(k1.key!, "native_key_add", o.json.key_id);
    const v = await owner("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature: sig, se_reauth: good });
    expect([v.status, v.json]).toEqual([200, { status: "active" }]);
    expect(JSON.parse(readFileSync(join(HOME, "passkeys.json"), "utf8")).keys.map((k: any) => k.credential_id).sort()).toEqual([k1.key!.id, k2.key!.id].sort());
    expect((await owner("GET", "/api/native-keys")).json.keys.filter((k: any) => k.status === "active").map((k: any) => k.key_id).sort()).toEqual([k1.key!.id, k2.key!.id].sort());
  });
});

describe("recover flow (`agent-outbox recover`, run as the owner in Terminal)", () => {
  const runRecover = () => {
    const r = Bun.spawnSync([process.execPath, "run", join(ROOT, "src", "bin.ts"), "recover"], { cwd: ROOT, env: { ...process.env, OUTBOX_HOME: HOME } });
    return { code: r.exitCode, out: decoder.decode(r.stdout) + decoder.decode(r.stderr) };
  };
  const recoveryFile = join(HOME, "recovery-token");
  const readToken = () => readFileSync(recoveryFile, "utf8").trim();

  test("recover writes a 0600 token file, prints no token, audits, and status shows the window", async () => {
    const r = runRecover();
    expect(r.code).toBe(0);
    expect(r.out).toContain("Recovery is open for 30 minutes");
    const tok = readToken();
    recoveryTokens.push(tok);
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.out).not.toContain(tok);
    expect(statSync(recoveryFile).mode & 0o777).toBe(0o600);
    const st = (await owner("GET", "/api/status")).json.setup;
    expect(st.proof_available).toBe("recovery_token");
    expect(Date.parse(st.recovery_expires_at) - Date.now()).toBeGreaterThan(29 * 60_000);
    const act = (await owner("GET", "/api/activity?limit=50")).json.audit as any[];
    expect(act.some((a) => a.action === "recovery.create" && a.actor === "cli")).toBe(true);
  });

  test("the token enrols exactly one key (even though a key already exists), then it is gone; a reused or wrong token is refused", async () => {
    const tok = readToken();
    const wrong = await enrol(await SoftKey.make(), { recovery_token: b64u(randomBytes(32)) });
    expect([wrong.verify.status, wrong.verify.json.error]).toEqual([403, "recovery_token_invalid"]);
    expect(existsSync(recoveryFile)).toBe(true);
    const k3 = await SoftKey.make();
    const ok = await enrol(k3, { recovery_token: tok }, "Recovered");
    expect(ok.options.json.proof).toBe("recovery_token");
    expect([ok.verify.status, ok.verify.json]).toEqual([200, { status: "active" }]);
    expect(existsSync(recoveryFile)).toBe(false);
    const reuse = await enrol(await SoftKey.make(), { recovery_token: tok });
    expect([reuse.verify.status, reuse.verify.json.error]).toEqual([403, "recovery_token_invalid"]);
    expect((await owner("GET", "/api/status")).json.setup.proof_available).toBe("se_reauth");
    // clean up: revoke the recovered key so later steps see two keys again
    expect((await owner("POST", `/api/native-keys/${k3.id}/revoke`, {})).status).toBe(200);
  });

  test("an expired token (> 30 minutes) is dead and deleted on sight", async () => {
    expect(runRecover().code).toBe(0);
    const old = new Date(Date.now() - 31 * 60_000);
    utimesSync(recoveryFile, old, old);
    const tok = readToken();
    const st = (await owner("GET", "/api/status")).json.setup;
    expect(st.proof_available).toBe("se_reauth");
    expect(st.recovery_expires_at).toBeNull();
    expect(existsSync(recoveryFile)).toBe(false);
    const r = await enrol(await SoftKey.make(), { recovery_token: tok });
    expect(r.verify.status).toBe(403);
  });

  test("Cancel recovery removes the file (no proof needed) and audits it", async () => {
    expect(runRecover().code).toBe(0);
    expect(existsSync(recoveryFile)).toBe(true);
    const c = await owner("POST", "/api/recovery/cancel", {});
    expect(c.json).toEqual({ ok: true, cancelled: true });
    expect(existsSync(recoveryFile)).toBe(false);
    expect((await owner("POST", "/api/recovery/cancel", {})).json).toEqual({ ok: true, cancelled: false });
    expect((await owner("GET", "/api/status")).json.setup.proof_available).toBe("se_reauth");
  });

  test("no recovery token ever appears in the server log", () => {
    for (const t of recoveryTokens) expect(log).not.toContain(t);
  });
});

describe("revoke", () => {
  test("revoking key 2 cancels its approvals (drafts back to review), rewrites the pin, and the key can't sign again; key 1's approval stays live", async () => {
    const { batchId, draftIds } = await newBatch(1, "e2e revoke");
    const { verify } = await approveBatch(k2.key!, batchId, draftIds);
    expect(verify.status).toBe(200);
    const r = await owner("POST", `/api/native-keys/${k2.key!.id}/revoke`, {});
    expect([r.status, r.json]).toEqual([200, { revoked_approvals: 1, revoked_contact_approvals: 0 }]);
    const b = await owner("GET", `/api/batches/${batchId}`);
    expect(b.json.drafts.map((d: any) => d.status)).toEqual(["review"]);
    expect(JSON.parse(readFileSync(join(HOME, "passkeys.json"), "utf8")).keys.map((k: any) => k.credential_id)).toEqual([k1.key!.id]);
    const opt = await owner("POST", `/api/batches/${batchId}/approve/options`, { draft_ids: draftIds });
    expect(opt.json.se.key_ids).toEqual([k1.key!.id]);
    const sig = await k2.key!.sign("send", sha(opt.json.manifest_bytes));
    expect((await owner("POST", `/api/batches/${batchId}/approve/se-verify`, { challenge_id: opt.json.challenge_id, key_id: k2.key!.id, signature: sig })).status).toBe(401);
    expect((await owner("POST", `/api/native-keys/${k2.key!.id}/revoke`, {})).json.error).toBe("already_revoked");
    // the key-1 dry approval from the approve test is still unrevoked
    const first = await owner("GET", "/api/batches");
    const approved = first.json.batches.find((x: any) => x.title === "e2e approve");
    expect((await owner("GET", `/api/batches/${approved.id}`)).json.approvals.map((a: any) => a.revoked_at)).toEqual([null]);
  });
});

describe("other launches of the real server", () => {
  test("started WITHOUT --app-auth-fd: agent API only, no owner socket at all, no TCP", async () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-e2e-noapp-"));
    const p = spawnServer(home, null);
    let out = "";
    collect(p, (s) => { out += s; });
    try {
      await waitFor(() => existsSync(join(home, "run", "agent.sock")), 20_000, "the agent socket");
      expect((await fetch("http://outbox/v1/health", { unix: join(home, "run", "agent.sock") } as any)).status).toBe(200);
      expect(existsSync(join(home, "run", "owner.sock"))).toBe(false);
      expect(unixSockets(p.pid)).toContain("agent.sock");
      expect(listening(p.pid)).toBe("");
      expect(out).toContain("no owner channel");
    } finally { p.kill(); rmSync(home, { recursive: true, force: true }); }
  });

  test("a malformed token on the descriptor exits 2 before the database is opened", async () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-e2e-badtok-"));
    const p = spawnServer(home, "not-a-valid-token");
    try {
      expect(await p.exited).toBe(2);
      expect(existsSync(join(home, "outbox.db"))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a non-socket at owner.sock is never unlinked: the server refuses to start (exit 1)", async () => {
    const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-e2e-sock-"));
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "run", "owner.sock"), "precious");
    const p = spawnServer(home, b64u(randomBytes(32)));
    try {
      expect(await p.exited).toBe(1);
      expect(readFileSync(join(home, "run", "owner.sock"), "utf8")).toBe("precious");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("lifeline", () => {
  test("closing the server's stdin (the app died) stops it and removes both sockets", async () => {
    expect(proc!.exitCode).toBeNull();
    try { (proc as any).stdin.end(); } catch { /* ignore */ }
    const code = await Promise.race([proc!.exited, Bun.sleep(10_000).then(() => "timeout")]);
    expect(code).toBe(0);
    expect(existsSync(OWNER_SOCK)).toBe(false);
    expect(existsSync(AGENT_SOCK)).toBe(false);
    expect(log).toContain("stdin closed");
  });
});
