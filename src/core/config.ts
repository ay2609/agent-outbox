// Where things live. Resolved once, at import time, from the state dir (OUTBOX_HOME overrides it; tests use temp dirs).
//
// There is no user-editable configuration any more: the owner API lives only on <state>/run/owner.sock, so there is no port,
// RP ID or origin to set. An old <state>/config.json "port" (and OUTBOX_PORT / OUTBOX_RP_ID / OUTBOX_ORIGIN) is ignored;
// `legacySettings` reports which of them are present so the server can say so once at start. The file is never rewritten.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hardened mode's pin file. A compiled-in constant on purpose: not configurable, so a config edit can't move it.
 *  Under /Library because /Library and /Library/Application Support are root-owned on every Mac (a Homebrew-owned /usr/local
 *  on an older Intel Mac is not, and a same-user process could rename the pin away). The path has a space: quote it in shells. */
export const ROOT_PIN_FILE = "/Library/Application Support/agent-outbox/passkeys.json";

export const defaultStateDir = (): string => join(homedir(), "Library", "Application Support", "agent-outbox");
export const resolveStateDir = (env: Record<string, string | undefined> = process.env): string => env.OUTBOX_HOME || defaultStateDir();
export const configFilePath = (stateDir: string): string => join(stateDir, "config.json");

/** Names of retired settings that are still present: "port" in config.json, and the OUTBOX_PORT / OUTBOX_RP_ID / OUTBOX_ORIGIN variables. */
export function legacySettings(stateDir: string, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  const file = configFilePath(stateDir);
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw) && "port" in raw) out.push("port");
    } catch { /* not JSON: nothing in it is used anyway */ }
  }
  for (const k of ["OUTBOX_PORT", "OUTBOX_RP_ID", "OUTBOX_ORIGIN"]) if (env[k] !== undefined && env[k] !== "") out.push(k);
  return out;
}
