// /api/status: executor heartbeat, pin mode and pin-file validity, counts.
import type { Database } from "bun:sqlite";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getSettings } from "../core/store";
import { readPaceState } from "../core/pacing-db";
import type { PinFile, PinPolicy } from "../core/types";
import type { OwnerConfig } from "./config";
import { sha256Hex } from "./b64";
import { getPinPolicy, installCommand, listPasskeys, normalizePolicy, pinText, userPinSha256 } from "./auth";

export type PinKind = "root" | "user";
export type PinMode = "simple" | "hardened";

export interface PinStatus {
  /** "root": the hardened-mode file; "user": the simple-mode file the dashboard writes. */
  kind: PinKind;
  path: string;
  present: boolean;
  /** present AND trusted owner (uid 0 for root, this user for the user pin) AND not group/world-writable (file and parent dir) AND parseable AND matching this server's rp/origin and exactly the approve passkeys */
  valid: boolean;
  owner_uid: number | null;
  mode: string | null;
  dir_ok: boolean | null;
  version: number | null;
  keys: number;
  /** Every approve passkey is in the pin file with the same public key. */
  matches_passkeys: boolean;
  /** Pinned keys that aren't among the approve passkeys (credential id not known, or a sign-in key). */
  unexpected_keys: { credential_id: string; label: string }[];
  /** The pin's policy, or null when the file is missing, unreadable or a v1 file (v1 = default policy, never live). */
  policy: PinPolicy | null;
  live_allowed: boolean;
  /** v4: the pin's policy.contacts_live_allowed (missing counts as false). */
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
/** Does the EFFECTIVE pin allow live sending? (The sender additionally verifies root ownership in hardened mode.) */
export function pinLiveAllowed(cfg: OwnerConfig): boolean {
  const e = readEffectivePin(cfg);
  return !!e && e.pin.v === 2 && normalizePolicy(e.pin.policy)?.live_allowed === true;
}
/** v4: does the EFFECTIVE pin allow live contact changes (approved creates, edits and undos)? */
export function pinContactsLiveAllowed(cfg: OwnerConfig): boolean {
  const e = readEffectivePin(cfg);
  return !!e && e.pin.v === 2 && normalizePolicy(e.pin.policy)?.contacts_live_allowed === true;
}

/** The same ownership rules the sender applies to this pin file before it will use it in live mode. */
export function pinStatus(cfg: OwnerConfig, db: Database, kind: PinKind): PinStatus {
  const path = pinPath(cfg, kind);
  const s: PinStatus = { kind, path, present: false, valid: false, owner_uid: null, mode: null, dir_ok: null, version: null, keys: 0, matches_passkeys: false, unexpected_keys: [], policy: null, live_allowed: false, contacts_live_allowed: false, problems: [] };
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
  let pin: PinFile | null = null;
  try { pin = JSON.parse(readFileSync(path, "utf8")) as PinFile; } catch { s.problems.push("The file isn't valid JSON."); }
  if (pin) {
    s.version = typeof pin.v === "number" ? pin.v : null;
    s.keys = pin.keys?.length ?? 0;
    if (pin.v !== 2) s.problems.push(`The pin file is version ${pin.v}, not 2. ${fix}`);
    else {
      s.policy = normalizePolicy(pin.policy);
      if (!s.policy) s.problems.push(`The pin file has no valid policy; the sender will refuse it. ${fix}`);
      s.live_allowed = s.policy?.live_allowed === true;
      s.contacts_live_allowed = s.policy?.contacts_live_allowed === true;
    }
    if (pin.rp_id !== cfg.rpId) s.problems.push(`rp_id is ${pin.rp_id}, this server uses ${cfg.rpId}.`);
    if (pin.origin !== cfg.origin) s.problems.push(`origin is ${pin.origin}, this server uses ${cfg.origin}.`);
    const have = new Map((pin.keys ?? []).map((k) => [k.credential_id, k.x963]));
    const approve = listPasskeys(db, "approve");
    const known = new Map(approve.map((p) => [p.credential_id, p.public_key_x963_b64]));
    s.matches_passkeys = approve.length > 0 && approve.every((p) => have.get(p.credential_id) === p.public_key_x963_b64);
    s.unexpected_keys = (pin.keys ?? []).filter((k) => known.get(k.credential_id) !== k.x963).map((k) => ({ credential_id: k.credential_id, label: k.label ?? "" }));
    if (s.unexpected_keys.length) s.problems.push(`Unexpected key in pinned file: ${s.unexpected_keys.map((k) => `${k.label || "(no label)"} ${k.credential_id.slice(0, 10)}…`).join(", ")}. It isn't one of your approval keys, and the sender would accept approvals signed by it.`);
    if (s.keys !== approve.length) s.problems.push(`Unexpected key in pinned file: it lists ${s.keys} key${s.keys === 1 ? "" : "s"}, but you have ${approve.length} approval key${approve.length === 1 ? "" : "s"}.`);
    if (!s.matches_passkeys) s.problems.push(approve.length === 0 ? "No approval passkey is registered." : `The file doesn't list every approval key. ${fix}`);
  }
  s.valid = s.problems.length === 0;
  return s;
}
export const rootPinStatus = (cfg: OwnerConfig, db: Database): PinStatus => pinStatus(cfg, db, "root");

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
  const approveKeys = listPasskeys(db, "approve");
  const userSha = userPinSha256(cfg);
  // Hardened: is the installed root file byte-identical to the pin the dashboard builds from its keys and policy (what the
  // harden command installs)? Compared with the database, not the user pin file, which anything running as the user can edit.
  const wantSha = approveKeys.length > 0 ? sha256Hex(Buffer.from(pinText(cfg, db), "utf8")) : null;
  let rootCurrent: boolean | null = null;
  if (root.present) { try { rootCurrent = wantSha !== null && wantSha === sha256Hex(readFileSync(cfg.rootPinFile)); } catch { rootCurrent = null; } }
  return {
    server_time: new Date().toISOString(),
    rp_id: cfg.rpId, origin: cfg.origin, port: cfg.port,
    transport: settings.transport, kill_switch: settings.kill_switch, kill_reason: settings.kill_reason,
    contacts_transport: settings.contacts_transport,
    /** "Spread out messages": the settings, plus what the executor reports (when it will send next, or why it is holding approved messages). */
    pacing: { ...settings.pacing, ...readPaceState(db) },
    /** v4: the effective pin's policy.contacts_live_allowed. When contacts_transport is live but this is false, the executor applies contact changes dry. */
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
      /** One sha256-checked command that installs the user pin as the root pin; prints the installed credential ids and labels. Null until the user pin exists. */
      install_command: installCommand(cfg, db),
      /** What the installed pin should show, for comparing with the command's output. */
      expected_keys: approveKeys.map((p) => ({ credential_id: p.credential_id, label: p.label })),
      policy: getPinPolicy(db),
    },
    passkeys: listPasskeys(db).length,
    passkey_purposes: { login: listPasskeys(db, "login").length, approve: approveKeys.length },
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
