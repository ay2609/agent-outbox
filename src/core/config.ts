// Settings the user can change without touching code. Resolved once, at import time, from the state dir
// (OUTBOX_HOME overrides it; tests use temp dirs) and the environment.
//
//   <state>/config.json, every key optional:
//     { "port": 7477, "compose": "auto" | "off", "claude_path": "/absolute/path/to/claude" }
//
// Unknown keys are ignored. A file that isn't valid JSON is reported on stderr and the defaults are used.
// Environment: OUTBOX_HOME (state dir), OUTBOX_PORT (beats config.json).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 7477;
/** Hardened mode's pin file. A compiled-in constant on purpose: not configurable, so a config edit can't move it.
 *  Under /Library because /Library and /Library/Application Support are root-owned on every Mac (a Homebrew-owned /usr/local
 *  on an older Intel Mac is not, and a same-user process could rename the pin away). The path has a space: quote it in shells. */
export const ROOT_PIN_FILE = "/Library/Application Support/agent-outbox/passkeys.json";

export type ComposeMode = "auto" | "off";
export interface Config {
  /** Loopback port of the dashboard. */
  port: number;
  /** "off" hides "Ask Claude"; "auto" shows it when a `claude` binary is found. */
  compose: ComposeMode;
  /** Absolute path to the claude binary; null = look on PATH, then ~/.local/bin/claude. */
  claude_path: string | null;
}

export const defaultStateDir = (): string => join(homedir(), "Library", "Application Support", "agent-outbox");
export const resolveStateDir = (env: Record<string, string | undefined> = process.env): string => env.OUTBOX_HOME || defaultStateDir();
export const configFilePath = (stateDir: string): string => join(stateDir, "config.json");

const validPort = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;

/** Reads <stateDir>/config.json and the environment. Never throws; problems go to `warn` and fall back to the defaults. */
export function loadConfig(stateDir: string, env: Record<string, string | undefined> = process.env,
  warn: (m: string) => void = (m) => console.warn(`[agent-outbox] ${m}`)): Config {
  const cfg: Config = { port: DEFAULT_PORT, compose: "auto", claude_path: null };
  const file = configFilePath(stateDir);
  if (existsSync(file)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { warn(`${file} isn't valid JSON (${(e as Error).message}); using the defaults.`); }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>;
      if (r.port !== undefined) { if (validPort(r.port)) cfg.port = r.port; else warn(`${file}: "port" must be an integer from 1 to 65535; ignoring it.`); }
      if (r.compose !== undefined) { if (r.compose === "auto" || r.compose === "off") cfg.compose = r.compose; else warn(`${file}: "compose" must be "auto" or "off"; ignoring it.`); }
      if (r.claude_path !== undefined) { if (typeof r.claude_path === "string" && r.claude_path.trim()) cfg.claude_path = r.claude_path.trim(); else warn(`${file}: "claude_path" must be a non-empty string; ignoring it.`); }
    } else if (raw !== undefined) warn(`${file} must hold a JSON object; using the defaults.`);
  }
  if (env.OUTBOX_PORT !== undefined && env.OUTBOX_PORT !== "") {
    const p = Number(env.OUTBOX_PORT);
    if (validPort(p)) cfg.port = p; else warn(`OUTBOX_PORT="${env.OUTBOX_PORT}" isn't a valid port; ignoring it.`);
  }
  return cfg;
}

/** Where the `claude` binary is, or null: compose "off" -> null; else config claude_path (must exist), else PATH, else ~/.local/bin/claude. */
export function findClaude(cfg: Pick<Config, "compose" | "claude_path">, o: { which?: (n: string) => string | null; exists?: (p: string) => boolean; home?: string } = {}): string | null {
  if (cfg.compose === "off") return null;
  const exists = o.exists ?? existsSync;
  if (cfg.claude_path) return exists(cfg.claude_path) ? cfg.claude_path : null;
  const onPath = (o.which ?? ((n: string) => Bun.which(n)))("claude");
  if (onPath) return onPath;
  const fallback = join(o.home ?? homedir(), ".local", "bin", "claude");
  return exists(fallback) ? fallback : null;
}

export interface ComposeAvailability { enabled: boolean; reason: "off" | "claude_not_found" | null; path: string | null }
export function composeAvailability(cfg: Pick<Config, "compose" | "claude_path">, o?: Parameters<typeof findClaude>[1]): ComposeAvailability {
  if (cfg.compose === "off") return { enabled: false, reason: "off", path: null };
  const path = findClaude(cfg, o);
  return path ? { enabled: true, reason: null, path } : { enabled: false, reason: "claude_not_found", path: null };
}
