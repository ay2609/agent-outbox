// Test helpers (not imported by the server): a software WebAuthn authenticator with a real P-256 key, so tests and
// the E2E exercise the genuine registration and assertion verification paths.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { openDb } from "../db";
import { addDraft, createBatch, setBatchStatus } from "../core/store";
import { createOwnerApp } from "./index";
import { b64u } from "./b64";
import { SetupToken } from "./setup-token";
import { AppAuth } from "./app-auth";

const sha = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

export class SoftAuthenticator {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly credentialId = randomBytes(32);
  counter = 0;
  constructor(public rpId: string, public origin: string, public opts: { useCounter?: boolean } = { useCounter: true }) {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey; this.publicKey = kp.publicKey;
  }
  get id(): string { return b64u(this.credentialId); }
  /** x963 point as the pin file stores it. */
  get x963(): Buffer {
    const jwk = this.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  }
  private coseKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return isoCBOR.encode(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]]));
  }
  register(options: { challenge: string }, o: { uv?: boolean; origin?: string } = {}): any {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    const flags = 0x01 | ((o.uv ?? true) ? 0x04 : 0) | 0x40; // UP, UV, AT
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([flags]), u32(0), Buffer.alloc(16), Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 255]), this.credentialId, Buffer.from(this.coseKey())]);
    const attestationObject = isoCBOR.encode(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)]]));
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] },
    };
  }
  assert(options: { challenge: string }, o: { uv?: boolean; up?: boolean; origin?: string; rpId?: string; type?: string; signWith?: KeyObject } = {}): any {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }));
    const flags = ((o.up ?? true) ? 0x01 : 0) | ((o.uv ?? true) ? 0x04 : 0);
    if (this.opts.useCounter) this.counter++;
    const authData = Buffer.concat([sha(o.rpId ?? this.rpId), Buffer.from([flags]), u32(this.counter)]);
    const signature = sign("sha256", Buffer.concat([authData, sha(clientDataJSON)]), o.signWith ?? this.privateKey);
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}

export interface Harness {
  app: Hono; db: Database; dir: string; rpId: string; origin: string;
  /** The first-run setup token store (file <dir>/setup-token) and its value; open registration must send the value as `setup_token`. */
  setup: SetupToken; setupToken: string;
  /** The APPROVE key (signs approvals, goes in the pin file). */
  auth: SoftAuthenticator;
  /** The sign-in key (login and reauth only). */
  login: SoftAuthenticator;
  cookie: string;
  /** The app channel's token holder (a fresh one per harness; never the process-wide default) and the token set on it. */
  appAuth: AppAuth; appToken: string;
  /** Terminal recovery token file for this harness (inside its temp dir). */
  recoveryFile: string;
  /** A request over the APP channel (owner.sock): Host `localhost`, X-Outbox, and X-Outbox-App unless `token: null` (or another value). */
  callApp(method: string, path: string, body?: unknown, o?: { token?: string | null; csrf?: boolean; headers?: Record<string, string> }): Promise<{ status: number; json: any; res: Response }>;
  call(method: string, path: string, body?: unknown, o?: { csrf?: boolean; cookie?: string | null; host?: string | null; headers?: Record<string, string> }): Promise<{ status: number; json: any; res: Response }>;
  /** A raw request (multipart uploads, static files): like `call`, but with your own init. Adds the Host header a browser would send. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** First-run setup as the dashboard does it: enrols `login` (no session), then `auth` as the approve key. Keeps the session cookie. */
  signUp(): Promise<void>;
  /** Routes the server's database access through a wrapper (e.g. a Proxy that interleaves a second connection's write). */
  wrapDb(w: (d: Database) => Database): void;
  /** Only step 1 of setup: the sign-in key. */
  signUpLoginOnly(): Promise<void>;
  /** A fresh login-purpose assertion body for reauth-protected calls. */
  reauth(): Promise<{ challenge_id: string; response: any }>;
}

export function makeHarness(over: Parameters<typeof createOwnerApp>[0] = {}, o2: { dbPath?: string } = {}): Harness {
  const rpId = "localhost", port = 7477, origin = `http://localhost:${port}`;
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
    db: () => wrap(db), rpId, origin, port, stateDir: dir, userPinFile: join(dir, "passkeys.json"), setupToken: setup, appAuth, recoveryTokenFile: recoveryFile,
    rootPinFile: join(dir, "root", "passkeys.json"), webDist: join(dir, "dist"),
    ...over,
  });
  const h: Harness = {
    app, db, dir, rpId, origin, setup, setupToken, appAuth, appToken, recoveryFile, auth: new SoftAuthenticator(rpId, origin), login: new SoftAuthenticator(rpId, origin), cookie: "",
    async call(method, path, body, o = {}) {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (o.csrf !== false && method !== "GET") headers["x-outbox"] = "1";
      const ck = o.cookie === undefined ? h.cookie : o.cookie;
      if (ck) headers["cookie"] = ck;
      // A real browser always sends Host; the dashboard refuses requests without an allowed one.
      if (o.host !== null) headers["host"] = o.host ?? `localhost:${port}`;
      Object.assign(headers, o.headers ?? {});
      const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json, res };
    },
    async callApp(method, path, body, o = {}) {
      const headers: Record<string, string> = { host: "localhost" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (o.csrf !== false && method !== "GET") headers["x-outbox"] = "1";
      const tok = o.token === undefined ? appToken : o.token;
      if (tok !== null) headers["x-outbox-app"] = tok;
      Object.assign(headers, o.headers ?? {});
      const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { channel: "app" });
      const text = await res.text();
      let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json, res };
    },
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("host")) headers.set("host", `localhost:${port}`);
      return app.request(path, { ...init, headers });
    },
    wrapDb(w) { wrap = w; },
    async signUpLoginOnly() {
      const o = await h.call("POST", "/api/auth/register/options", { purpose: "login", setup_token: h.setupToken }, { cookie: null });
      if (o.status !== 200) throw new Error(`register options ${o.status} ${JSON.stringify(o.json)}`);
      const v = await h.call("POST", "/api/auth/register/verify", { challenge_id: o.json.challenge_id, response: h.login.register(o.json.options), label: "Test sign-in", setup_token: h.setupToken }, { cookie: null });
      if (v.status !== 200) throw new Error(`register verify ${v.status} ${JSON.stringify(v.json)}`);
      const sc = v.res.headers.get("set-cookie") ?? "";
      h.cookie = sc.split(";")[0] ?? "";
    },
    async signUp() {
      await h.signUpLoginOnly();
      const o = await h.call("POST", "/api/passkeys/options", { purpose: "approve", label: "Test approve" });
      if (o.status !== 200) throw new Error(`approve options ${o.status} ${JSON.stringify(o.json)}`);
      const v = await h.call("POST", "/api/passkeys/verify", { challenge_id: o.json.challenge_id, response: h.auth.register(o.json.options), label: "Test approve" });
      if (v.status !== 200) throw new Error(`approve verify ${v.status} ${JSON.stringify(v.json)}`);
    },
    async reauth() {
      const o = await h.call("POST", "/api/auth/reauth/options", {});
      if (o.status !== 200) throw new Error(`reauth options ${o.status} ${JSON.stringify(o.json)}`);
      return { challenge_id: o.json.challenge_id, response: h.login.assert(o.json.options) };
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
