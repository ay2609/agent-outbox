// Runtime configuration for the dashboard app. Everything that reads the environment or paths.ts is resolved here,
// at createOwnerApp() time, so tests can build an app with a temp state dir and an in-memory DB.
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db";
import { ORIGIN, PORT, RP_ID, paths } from "../core/paths";
import { SetupToken, defaultSetupToken } from "./setup-token";
import { AppAuth, defaultAppAuth } from "./app-auth";

export interface OwnerConfig {
  db: () => Database;
  rpId: string;
  origin: string;
  /** Loopback port; with `origin` it decides which Host headers are accepted. */
  port: number;
  stateDir: string;
  /** Simple mode's pin: <state>/passkeys.json, written by the dashboard (0600). */
  userPinFile: string;
  /** Hardened mode's pin: root-owned. If this file exists it is the only pin that counts. */
  rootPinFile: string;
  webDist: string;
  /** Guards open (no-session) registration while no sign-in key exists. Not started here: server.ts (or a test) calls start(). */
  setupToken: SetupToken;
  /** The per-launch token of the app channel (owner.sock). Inactive (no app channel) unless server.ts was started with --app-auth-fd. */
  appAuth: AppAuth;
  /** Terminal-made recovery token file (`agent-outbox recover`). */
  recoveryTokenFile: string;
  /** Failed passkey verifications allowed per window before login is locked (global: every request is from 127.0.0.1). */
  loginMaxFailures: number;
  loginWindowMs: number;
  challengeTtlMs: number;
  sessionTtlMs: number;
  maxUploadBytes: number;
  /** Where uploaded import files are stored; undefined = the ingest library's default (paths.imports). Tests set a temp dir. */
  importsDir?: string;
}

export const SESSION_COOKIE = "outbox_session";

/** Host header values the dashboard answers to: localhost:<port> and 127.0.0.1:<port> (plus the origin's own host, for overrides). */
export function allowedHosts(cfg: Pick<OwnerConfig, "port" | "origin">): Set<string> {
  const hosts = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`]);
  try { hosts.add(new URL(cfg.origin).host); } catch { /* a malformed override fails origin checks anyway */ }
  return hosts;
}
/** Plain-http loopback origins can't carry Secure cookies (Safari drops them); anything else (an https override) keeps Secure. */
export const cookieSecure = (origin: string): boolean => !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

export function resolveConfig(over: Partial<OwnerConfig> = {}): OwnerConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    db: () => getDb(),
    rpId: RP_ID,
    origin: ORIGIN,
    port: PORT,
    stateDir: paths.state,
    userPinFile: paths.userPinFile,
    rootPinFile: paths.rootPinFile,
    webDist: join(here, "..", "..", "web", "dist"),
    setupToken: defaultSetupToken,
    appAuth: defaultAppAuth,
    recoveryTokenFile: paths.recoveryToken,
    loginMaxFailures: 8,
    loginWindowMs: 10 * 60_000,
    challengeTtlMs: 5 * 60_000,
    sessionTtlMs: 30 * 24 * 3600_000,
    maxUploadBytes: 25 * 1024 * 1024,
    ...over,
  };
}
