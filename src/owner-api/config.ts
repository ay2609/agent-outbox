// Runtime configuration for the owner API. Everything that reads the environment or paths.ts is resolved here,
// at createOwnerApp() time, so tests can build an app with a temp state dir and an in-memory DB.
import type { Database } from "bun:sqlite";
import { getDb } from "../db";
import { paths } from "../core/paths";
import { SetupToken, defaultSetupToken } from "./setup-token";
import { AppAuth, defaultAppAuth } from "./app-auth";

export interface OwnerConfig {
  db: () => Database;
  stateDir: string;
  /** Simple mode's pin: <state>/passkeys.json, written by the server (0600). */
  userPinFile: string;
  /** Hardened mode's pin: root-owned. If this file exists it is the only pin that counts. */
  rootPinFile: string;
  /** Guards the first-run enrolment. Not started here: server.ts (or a test) calls start(). */
  setupToken: SetupToken;
  /** The per-launch token of the owner socket. Inactive unless server.ts was started with --app-auth-fd. */
  appAuth: AppAuth;
  /** Terminal-made recovery token file (`agent-outbox recover`). */
  recoveryTokenFile: string;
  /** Failed proofs allowed per window and route before that route is locked. */
  loginMaxFailures: number;
  loginWindowMs: number;
  challengeTtlMs: number;
  maxUploadBytes: number;
  /** Where uploaded import files are stored; undefined = the ingest library's default (paths.imports). Tests set a temp dir. */
  importsDir?: string;
}

export function resolveConfig(over: Partial<OwnerConfig> = {}): OwnerConfig {
  return {
    db: () => getDb(),
    stateDir: paths.state,
    userPinFile: paths.userPinFile,
    rootPinFile: paths.rootPinFile,
    setupToken: defaultSetupToken,
    appAuth: defaultAppAuth,
    recoveryTokenFile: paths.recoveryToken,
    loginMaxFailures: 8,
    loginWindowMs: 10 * 60_000,
    challengeTtlMs: 5 * 60_000,
    maxUploadBytes: 25 * 1024 * 1024,
    ...over,
  };
}
