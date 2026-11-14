// Every on-disk location in one place. OUTBOX_HOME overrides the state dir (tests use a temp dir).
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { ROOT_PIN_FILE, configFilePath, loadConfig, resolveStateDir } from "./config";

export const STATE_DIR = resolveStateDir();
export const config = loadConfig(STATE_DIR);

export const paths = {
  state: STATE_DIR,
  config: configFilePath(STATE_DIR),
  db: join(STATE_DIR, "outbox.db"),
  runDir: join(STATE_DIR, "run"),
  agentSocket: join(STATE_DIR, "run", "agent.sock"),
  imports: join(STATE_DIR, "imports"),
  logs: join(STATE_DIR, "logs"),
  drySendLog: join(STATE_DIR, "logs", "dry-sends.jsonl"),
  contactsExport: join(STATE_DIR, "contacts-export.json"),
  // Simple mode: the pin the dashboard writes (0600, owned by the user). The sender trusts it only while no root pin exists.
  userPinFile: join(STATE_DIR, "passkeys.json"),
  // Hardened mode: root-owned (0444), installed with one sudo command. Once it exists it is the only pin the sender trusts.
  rootPinFile: ROOT_PIN_FILE,
};

export function ensureStateDirs(): void {
  for (const d of [paths.state, paths.runDir, paths.imports, paths.logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // The sender only trusts <state>/passkeys.json while the state dir is closed to group/other writes, so tighten an older, looser dir.
  chmodSync(paths.state, 0o700);
}

/** The dashboard's loopback port: config.json "port", or OUTBOX_PORT. */
export const PORT = config.port;
// Passkeys are bound to the RP ID "localhost", so the dashboard is always opened at http://localhost:<port>.
// OUTBOX_RP_ID / OUTBOX_ORIGIN are test-only overrides.
export const RP_ID = process.env.OUTBOX_RP_ID ?? "localhost";
export const ORIGIN = process.env.OUTBOX_ORIGIN ?? `http://localhost:${PORT}`;
