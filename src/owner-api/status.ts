// /api/status: executor heartbeat, pin mode and pin-file validity, setup state, counts.
import type { Database } from "bun:sqlite";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getSettings } from "../core/store";
import { readPaceState } from "../core/pacing-db";
import type { PinFile, PinPolicy } from "../core/types";
import type { OwnerConfig } from "./config";
import { sha256Hex } from "./b64";
import { firstRun, getPinPolicy, installCommand, listNativeKeys, nativeKeyCount, pinText, userPinSha256 } from "./auth";
import { RecoveryToken } from "./recovery";
import { fingerprint } from "./keys";

export type PinKind = "root" | "user";
export type PinMode = "simple" | "hardened";

export interface PinStatus {
  /** "root": the hardened-mode file; "user": the simple-mode file the server writes. */
  kind: PinKind;
  path: string;
  present: boolean;
  /** present AND trusted owner (uid 0 for root, this user for the user pin) AND not group/world-writable (file and parent dir) AND a well-formed v4 pin listing exactly the active keys */
  valid: boolean;
  owner_uid: number | null;
  mode: string | null;
  dir_ok: boolean | null;
  version: number | null;
  keys: number;
  /** Every active key is in the pin file with the same public key. (True for an empty pin when there are no active keys.) */
  matches_keys: boolean;
  /** Pinned keys that aren't among the active keys (unknown, or revoked). */
  unexpected_keys: { credential_id: string; label: string }[];
  /** The pin's policy, or null when the file is missing, unreadable or not a v4 pin. */
  policy: PinPolicy | null;
  live_allowed: boolean;
  /** The pin's policy.contacts_live_allowed. */
  contacts_live_allowed: boolean;
  problems: string[];
}

const myUid = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);
export const pinPath = (cfg: OwnerConfig, kind: PinKind): string => (kind === "root" ? cfg.rootPinFile : cfg.userPinFile);

/** Hardened iff the root pin path exists (lstat: even a dangling symlink counts, as for the sender). From then on ONLY that
 *  file counts: if it is invalid the sender holds, it never falls back to the user pin. */
export function pinMode(cfg: OwnerConfig): PinMode {
  try { lstatSync(cfg.rootPinFile); return "hardened"; } catch { return "simple"; }
}

function readPinFile(path: string): PinFile | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as PinFile; } catch { return null; }
}
/** Is the user pin one the sender would trust: owned by this user, no group/world write on the file or its folder? */
function userPinTrusted(cfg: OwnerConfig): boolean {
  try {
    const st = lstatSync(cfg.userPinFile), dst = statSync(dirname(cfg.userPinFile));   // lstat: the sender refuses a symlink
    return st.isFile() && st.uid === myUid() && (st.mode & 0o022) === 0 && dst.uid === myUid() && (dst.mode & 0o022) === 0;
  } catch { return false; }
}
/** The pin the sender would use right now: the root file if it exists, else the user pin (only if its ownership checks out). */
export function readEffectivePin(cfg: OwnerConfig): { kind: PinKind; pin: PinFile } | null {
  if (pinMode(cfg) === "hardened") {
    const pin = readPinFile(cfg.rootPinFile);
    return pin ? { kind: "root", pin } : null;
  }
  if (!userPinTrusted(cfg)) return null;
  const pin = readPinFile(cfg.userPinFile);
  return pin ? { kind: "user", pin } : null;
}
/** A pin's policy when it has both booleans (the v4 shape), else null. */
function strictPolicy(p: unknown): { live_allowed: boolean; contacts_live_allowed: boolean } | null {
  if (!p || typeof p !== "object") return null;
  const r = p as Record<string, unknown>;
  return typeof r.live_allowed === "boolean" && typeof r.contacts_live_allowed === "boolean"
    ? { live_allowed: r.live_allowed, contacts_live_allowed: r.contacts_live_allowed } : null;
}
/** Does the EFFECTIVE pin allow live sending? (The sender additionally verifies root ownership in hardened mode.) */
export function pinLiveAllowed(cfg: OwnerConfig): boolean {
  const e = readEffectivePin(cfg);
  return !!e && e.pin.v === 4 && strictPolicy(e.pin.policy)?.live_allowed === true;
}
/** Does the EFFECTIVE pin allow live contact changes (approved creates, edits and undos)? */
export function pinContactsLiveAllowed(cfg: OwnerConfig): boolean {
  const e = readEffectivePin(cfg);
  return !!e && e.pin.v === 4 && strictPolicy(e.pin.policy)?.contacts_live_allowed === true;
}

const OLD_PIN = (v: unknown) => `The pin file is version ${v}: it holds browser passkeys, which Agent Outbox no longer accepts. Set up Touch ID in the app (hardened: then run the harden command again).`;

/** The same ownership and shape rules the sender applies to this pin file before it will use it. */
export function pinStatus(cfg: OwnerConfig, db: Database, kind: PinKind): PinStatus {
  const path = pinPath(cfg, kind);
  const s: PinStatus = { kind, path, present: false, valid: false, owner_uid: null, mode: null, dir_ok: null, version: null, keys: 0, matches_keys: false, unexpected_keys: [], policy: null, live_allowed: false, contacts_live_allowed: false, problems: [] };
  // lstat, as the sender does: a symlink (even a dangling one) counts as present, and is refused.
  let st;
  try { st = lstatSync(path); } catch { s.problems.push(kind === "root" ? "Not installed." : "Not written yet."); return s; }
  s.present = true;
  const wantUid = kind === "root" ? 0 : myUid();
  const who = kind === "root" ? "root (0)" : `you (${wantUid})`;
  if (st.isSymbolicLink()) { s.problems.push("The file is a symbolic link; the sender refuses it."); return s; }
  s.owner_uid = st.uid;
  s.mode = (st.mode & 0o777).toString(8).padStart(3, "0");
  if (st.uid !== wantUid) s.problems.push(`The file is owned by uid ${st.uid}, not ${who}.`);
  if (st.mode & 0o022) s.problems.push(`The file is writable by group or others (mode ${s.mode}).`);
  try {
    const dst = statSync(dirname(path));
    s.dir_ok = dst.uid === wantUid && (dst.mode & 0o022) === 0;
    if (!s.dir_ok) s.problems.push(`The parent directory isn't owned by ${who} and closed to group/other writes.`);
  } catch { s.dir_ok = false; s.problems.push("The parent directory can't be read."); }
  const fix = kind === "root" ? "Run the harden command again." : "Change a setting or add a key and it is rewritten.";
  let pin: any = null;
  let parsed = false;
  try { pin = JSON.parse(readFileSync(path, "utf8")); parsed = true; } catch { s.problems.push("The file isn't valid JSON."); }
  if (parsed) {
    if (!pin || typeof pin !== "object" || Array.isArray(pin)) { s.problems.push("The pin file isn't a JSON object."); }
    else {
      s.version = typeof pin.v === "number" ? pin.v : null;
      s.keys = Array.isArray(pin.keys) ? pin.keys.length : 0;
      if (pin.v === 1 || pin.v === 2 || pin.v === 3) s.problems.push(OLD_PIN(pin.v));
      else if (pin.v !== 4) s.problems.push(`The pin file is version ${pin.v}, not 4. ${fix}`);
      else {
        const extra = Object.keys(pin).filter((k) => !["v", "keys", "policy"].includes(k));
        if (extra.length) s.problems.push(`The pin file has unexpected top-level keys (${extra.join(", ")}); the sender refuses it. ${fix}`);
        const pol = strictPolicy(pin.policy);
        if (!pol) s.problems.push(`The pin file has no valid policy; the sender will refuse it. ${fix}`);
        s.policy = pol;
        s.live_allowed = pol?.live_allowed === true;
        s.contacts_live_allowed = pol?.contacts_live_allowed === true;
        const keys: any[] = Array.isArray(pin.keys) ? pin.keys : [];
        if (!Array.isArray(pin.keys)) s.problems.push("The pin file has no key list.");
        const active = listNativeKeys(db, "active");
        const have = new Map<string, string>();
        for (const k of keys) {
          const exact = k && typeof k === "object" && Object.keys(k).sort().join(",") === "credential_id,kind,label,x963";
          if (!exact) { s.problems.push("A pinned key has the wrong fields."); continue; }
          if (k.kind === "webauthn") s.problems.push("WebAuthn keys are no longer accepted."); else if (k.kind !== "secure-enclave") s.problems.push(`A pinned key has kind ${String(k.kind)}.`);
          have.set(k.credential_id, k.x963);
        }
        const known = new Map(active.map((k) => [k.key_id, k.public_key_x963_b64]));
        s.matches_keys = active.every((k) => have.get(k.key_id) === k.public_key_x963_b64);
        s.unexpected_keys = keys.filter((k) => known.get(k?.credential_id) !== k?.x963).map((k) => ({ credential_id: String(k?.credential_id ?? ""), label: String(k?.label ?? "") }));
        if (s.unexpected_keys.length) s.problems.push(`Unexpected key in pinned file: ${s.unexpected_keys.map((k) => `${k.label || "(no label)"} ${k.credential_id.slice(0, 10)}…`).join(", ")}. It isn't one of your active approval keys, and the sender would accept approvals signed by it.`);
        if (keys.length !== active.length) s.problems.push(`The pin lists ${keys.length} key${keys.length === 1 ? "" : "s"}, but you have ${active.length} active approval key${active.length === 1 ? "" : "s"}.`);
        if (!s.matches_keys) s.problems.push(`The file doesn't list every active approval key. ${fix}`);
      }
    }
  }
  s.valid = s.problems.length === 0;
  return s;
}
export const rootPinStatus = (cfg: OwnerConfig, db: Database): PinStatus => pinStatus(cfg, db, "root");

/** Key ids (credential_id) of the Secure Enclave keys in the EFFECTIVE pin, or an empty set when there is no usable pin. */
export function effectiveNativeKeyIds(cfg: OwnerConfig): Set<string> {
  const e = readEffectivePin(cfg);
  if (!e || e.pin.v !== 4 || !Array.isArray(e.pin.keys)) return new Set();
  return new Set(e.pin.keys.filter((k) => k && k.kind === "secure-enclave").map((k) => k.credential_id));
}

export function buildStatus(cfg: OwnerConfig, db: Database) {
  const exec = db.query<{ heartbeat_at: string; version: string; transport: string; pin_file_ok: number; last_error: string | null }, []>(
    "SELECT * FROM exec_status WHERE id = 1").get();
  const age = exec ? Math.max(0, Math.round((Date.now() - Date.parse(exec.heartbeat_at)) / 1000)) : null;
  const count = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  const settings = getSettings(db);
  const mode = pinMode(cfg);
  const root = pinStatus(cfg, db, "root");
  const user = pinStatus(cfg, db, "user");
  const effective = mode === "hardened" ? root : user;
  const activeNative = listNativeKeys(db, "active");
  const userSha = userPinSha256(cfg);
  // Hardened: is the installed root file byte-identical to the pin built from the keys and policy (what the harden command installs)?
  // Compared with the database, not the user pin file, which anything running as the user can edit.
  const wantSha = sha256Hex(Buffer.from(pinText(db), "utf8"));
  let rootCurrent: boolean | null = null;
  if (root.present) { try { rootCurrent = wantSha === sha256Hex(readFileSync(cfg.rootPinFile)); } catch { rootCurrent = null; } }
  // Native approval: may the app sign now? Simple mode: the user pin holds the key. Hardened mode: only the root pin counts, so a freshly
  // enrolled key needs the harden command run again. A revoked key still in the root pin needs it too.
  const pinned = effectiveNativeKeyIds(cfg);
  const revokedStillPinned = listNativeKeys(db, "revoked").some((k) => pinned.has(k.key_id));
  const native = {
    keys_active: activeNative.length,
    approve_in_app: activeNative.some((k) => pinned.has(k.key_id)),
    pin_needs_update: mode === "hardened" && (activeNative.some((k) => !pinned.has(k.key_id)) || revokedStillPinned),
  };
  // Which owner proof could enrol a key right now (same order as enroll/options).
  const recoveryExpires = new RecoveryToken(cfg.recoveryTokenFile).expiresAt();
  const proof = recoveryExpires ? "recovery_token" : firstRun(db) && cfg.setupToken.active ? "setup_token" : nativeKeyCount(db) > 0 ? "se_reauth" : null;
  return {
    server_time: new Date().toISOString(),
    native,
    setup: { done: !firstRun(db), proof_available: proof, recovery_expires_at: recoveryExpires },
    transport: settings.transport, kill_switch: settings.kill_switch, kill_reason: settings.kill_reason,
    contacts_transport: settings.contacts_transport,
    /** "Spread out messages": the settings, plus what the executor reports (when it will send next, or why it is holding approved messages). */
    pacing: { ...settings.pacing, ...readPaceState(db) },
    /** The effective pin's policy.contacts_live_allowed. When contacts_transport is live but this is false, the executor applies contact changes dry. */
    pin_contacts_live_allowed: effective.contacts_live_allowed,
    exec: exec ? { ...exec, pin_file_ok: !!exec.pin_file_ok, heartbeat_age_s: age, alive: age !== null && age < 30 } : null,
    pin: {
      /** "hardened" iff the root pin file exists (then only it counts), else "simple". */
      mode,
      /** The pin the sender uses right now (root if present, else the user pin) with its policy and problems. Live gates read this. */
      effective,
      root,
      user,
      /** The user pin is also the candidate for hardening: `installed` = the root file is identical to it (null when there is no root file). */
      candidate: { path: cfg.userPinFile, present: user.present, sha256: userSha, installed: rootCurrent },
      /** One sha256-checked command that installs the user pin as the root pin; prints what is installed. Non-null whenever the user pin file exists. */
      install_command: installCommand(cfg, db),
      /** What the installed pin should show, for comparing with the command's output: active Secure Enclave keys only. */
      expected_keys: activeNative.map((k) => ({ credential_id: k.key_id, label: k.label, kind: "secure-enclave" as const, fingerprint: fingerprint(Buffer.from(k.public_key_x963_b64, "base64url")) })),
      policy: getPinPolicy(db),
    },
    counts: {
      batches_review: count("SELECT COUNT(*) AS n FROM batches WHERE status = 'review'"),
      drafts_review: count("SELECT COUNT(*) AS n FROM drafts WHERE status = 'review'"),
      drafts_approved: count("SELECT COUNT(*) AS n FROM drafts WHERE status IN ('approved','sending')"),
      drafts_failed: count("SELECT COUNT(*) AS n FROM drafts WHERE status = 'failed'"),
      contact_sets_review: count("SELECT COUNT(*) AS n FROM contact_change_sets WHERE status = 'review'"),
      contact_changes_review: count("SELECT COUNT(*) AS n FROM contact_changes WHERE status = 'review'"),
    },
  };
}
