// Test helpers (not imported by the server): software P-256 keys that sign exactly like the app's Secure Enclave key
// (M(tag, digest), DER, base64url), and a harness that calls the owner API in process with the per-launch app token: the same
// code path the unix socket uses (there is no channel parameter any more).
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import { addDraft, createBatch, setBatchStatus } from "../core/store";
import { createOwnerApp } from "./index";
import { b64u } from "./b64";
import { SetupToken } from "./setup-token";
import { AppAuth } from "./app-auth";
import { seMessage, type SeTag } from "./keys";

const sha = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

/** A software stand-in for a Secure Enclave key. */
export class SoftSe {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  constructor() {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey; this.publicKey = kp.publicKey;
  }
  /** x963 point as the pin file stores it. */
  get x963(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  }
  get x963b64(): string { return b64u(this.x963); }
  /** The key id: base64url(sha256(x963)). */
  get id(): string { return b64u(sha(this.x963)); }
  /** DER signature over M(tag, digest), base64url. `signWith` signs with another key (a forgery). */
  sign(tag: SeTag, digest: Uint8Array, signWith?: KeyObject): string {
    return b64u(sign("sha256", seMessage(tag, digest), { key: signWith ?? this.privateKey, dsaEncoding: "der" }));
  }
  /** The body of se-verify for an options response (`manifest_bytes`, `challenge_id`, `se.tag`). */
  signOptions(opt: { challenge_id: string; manifest_bytes: string; se: { tag: "send" | "contacts" } }, o: { signWith?: KeyObject; keyId?: string } = {}) {
    return { challenge_id: opt.challenge_id, key_id: o.keyId ?? this.id, signature: this.sign(opt.se.tag, sha(opt.manifest_bytes), o.signWith) };
  }
}

export interface Harness {
  app: Hono; db: Database; dir: string;
  /** The first-run setup token store (file <dir>/setup-token) and its value. */
  setup: SetupToken; setupToken: string;
  /** The approval key (software Secure Enclave key). */
  auth: SoftSe;
  /** The app token holder (a fresh one per harness) and the token set on it. */
  appAuth: AppAuth; appToken: string;
  /** Terminal recovery token file for this harness (inside its temp dir). */
  recoveryFile: string;
  /** A request over the owner API with the app token (`token: null` omits it, or pass another value). */
  call(method: string, path: string, body?: unknown, o?: { token?: string | null; headers?: Record<string, string> }): Promise<{ status: number; json: any; res: Response }>;
  /** Same as `call` (kept so older call sites read the same). */
  callApp: Harness["call"];
  /** A raw request with the token: like `call`, but with your own init. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** First-run setup as the app does it: enrols `key` (default `auth`) with the setup token. */
  signUp(key?: SoftSe, label?: string): Promise<void>;
  /** Enrol `key` with the proof you pass in the verify body (e.g. { recovery_token } or { se_reauth }); returns the verify response. */
  enrol(key: SoftSe, proof: Record<string, unknown>, label?: string): Promise<{ status: number; json: any }>;
  /** Routes the server's database access through a wrapper (e.g. a Proxy that interleaves a second connection's write). */
  wrapDb(w: (d: Database) => Database): void;
  /** A fresh `se_reauth` body (challenge_id, key_id, signature) for `action` signed by `key` (default `auth`). */
  reauth(action?: "mode_live" | "policy_live" | "native_key_add", target?: string, key?: SoftSe): Promise<{ challenge_id: string; key_id: string; signature: string }>;
}

export function makeHarness(over: Parameters<typeof createOwnerApp>[0] = {}, o2: { dbPath?: string } = {}): Harness {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-test-"));
  const db = openDb(o2.dbPath ? join(dir, o2.dbPath) : ":memory:");
  let wrap: (d: Database) => Database = (d) => d;
  const setup = new SetupToken(join(dir, "setup-token"));
  const setupToken = setup.start(db)!;
  const appAuth = new AppAuth();
  const appToken = b64u(randomBytes(32));
  appAuth.set(appToken);
  const recoveryFile = join(dir, "recovery-token");
  const app = createOwnerApp({
    db: () => wrap(db), stateDir: dir, userPinFile: join(dir, "passkeys.json"), setupToken: setup, appAuth, recoveryTokenFile: recoveryFile,
    rootPinFile: join(dir, "root", "passkeys.json"),
    ...over,
  });
  const h: Harness = {
    app, db, dir, setup, setupToken, appAuth, appToken, recoveryFile, auth: new SoftSe(),
    async call(method, path, body, o = {}) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      const tok = o.token === undefined ? appToken : o.token;
      if (tok !== null) headers["x-outbox-app"] = tok;
      Object.assign(headers, o.headers ?? {});
      const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json, res };
    },
    callApp: (...a) => h.call(...a),
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("x-outbox-app")) headers.set("x-outbox-app", appToken);
      return app.request(path, { ...init, headers });
    },
    wrapDb(w) { wrap = w; },
    async enrol(key, proof, label = "Test approve") {
      const o = await h.call("POST", "/api/native-keys/enroll/options", { x963: key.x963b64, label });
      if (o.status !== 200) return { status: o.status, json: o.json };
      const signature = key.sign("enroll", sha(Buffer.concat([Buffer.from(o.json.challenge, "base64url"), key.x963])));
      return h.call("POST", "/api/native-keys/enroll/verify", { key_id: o.json.key_id, signature, ...proof });
    },
    async signUp(key = h.auth, label = "Test approve") {
      const v = await h.enrol(key, { setup_token: h.setupToken }, label);
      if (v.status !== 200) throw new Error(`enrol ${v.status} ${JSON.stringify(v.json)}`);
    },
    async reauth(action = "mode_live", target, key = h.auth) {
      const o = await h.call("POST", "/api/native-keys/reauth/options", { action, ...(target ? { target } : {}) });
      if (o.status !== 200) throw new Error(`reauth options ${o.status} ${JSON.stringify(o.json)}`);
      return { challenge_id: o.json.challenge_id, key_id: key.id, signature: key.sign("reauth", sha(Buffer.from(o.json.challenge, "base64url"))) };
    },
  };
  return h;
}

/** A review-state batch with `n` drafts: +1202555010i, bodies "Hello <name> i". */
export function seedBatch(db: Database, n = 3, title = "Test batch"): { batchId: string; draftIds: string[] } {
  const batchId = createBatch(db, { title, created_by: "agent:test", source: "mcp", status: "review" });
  const draftIds: string[] = [];
  for (let i = 0; i < n; i++) {
    draftIds.push(addDraft(db, batchId, {
      handle: `+1202555010${i}`, recipient_name: `Person ${i + 1}`, body: `Hello Person ${i + 1}, quick note. “Unicode” ✓`, actor: "agent",
      ...(i === 1 ? { proposed_contact: { given_name: "Person", family_name: "2", phones: [{ e164: "+12025550101", label: "mobile" }], emails: [] }, create_contact: true } : {}),
    }));
  }
  setBatchStatus(db, batchId, "review", "test");
  return { batchId, draftIds };
}
