// Settings the user can change without touching code. Resolved once, at import time, from the state dir
// (OUTBOX_HOME overrides it; tests use temp dirs) and the environment.
//
//   <state>/config.json, every key optional:
//     { "port": 7477 }
//
// Unknown keys are ignored (older installs may still have "compose" and "claude_path"). A file that isn't valid JSON is reported on stderr and the defaults are used.
// Environment: OUTBOX_HOME (state dir), OUTBOX_PORT (beats config.json).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 7477;
/** Hardened mode's pin file. A compiled-in constant on purpose: not configurable, so a config edit can't move it.
 *  Under /Library because /Library and /Library/Application Support are root-owned on every Mac (a Homebrew-owned /usr/local
 *  on an older Intel Mac is not, and a same-user process could rename the pin away). The path has a space: quote it in shells. */
export const ROOT_PIN_FILE = "/Library/Application Support/agent-outbox/passkeys.json";

export interface Config {
  /** Loopback port of the dashboard. */
  port: number;
}

export const defaultStateDir = (): string => join(homedir(), "Library", "Application Support", "agent-outbox");
export const resolveStateDir = (env: Record<string, string | undefined> = process.env): string => env.OUTBOX_HOME || defaultStateDir();
export const configFilePath = (stateDir: string): string => join(stateDir, "config.json");

const validPort = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;

/** Reads <stateDir>/config.json and the environment. Never throws; problems go to `warn` and fall back to the defaults. */
export function loadConfig(stateDir: string, env: Record<string, string | undefined> = process.env,
  warn: (m: string) => void = (m) => console.warn(`[agent-outbox] ${m}`)): Config {
  const cfg: Config = { port: DEFAULT_PORT };
  const file = configFilePath(stateDir);
  if (existsSync(file)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { warn(`${file} isn't valid JSON (${(e as Error).message}); using the defaults.`); }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      if (r.port !== undefined) { if (validPort(r.port)) cfg.port = r.port; else warn(`${file}: "port" must be an integer from 1 to 65535; ignoring it.`); }
    } else if (raw !== undefined) warn(`${file} must hold a JSON object; using the defaults.`);
  }
  if (env.OUTBOX_PORT !== undefined && env.OUTBOX_PORT !== "") {
    const p = Number(env.OUTBOX_PORT);
    if (validPort(p)) cfg.port = p; else warn(`OUTBOX_PORT="${env.OUTBOX_PORT}" isn't a valid port; ignoring it.`);
  }
  return cfg;
}
