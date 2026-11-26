// Every on-disk location in one place. OUTBOX_HOME overrides the state dir (tests use a temp dir).
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { ROOT_PIN_FILE, configFilePath, resolveStateDir } from "./config";

export const STATE_DIR = resolveStateDir();

export const paths = {
  state: STATE_DIR,
  config: configFilePath(STATE_DIR),
  db: join(STATE_DIR, "outbox.db"),
  runDir: join(STATE_DIR, "run"),
  agentSocket: join(STATE_DIR, "run", "agent.sock"),
  // The owner API (only with `server --app-auth-fd`): 0600 socket in the 0700 run dir. The only way to reach it.
  ownerSocket: join(STATE_DIR, "run", "owner.sock"),
  // Terminal-made owner proof for enrolling a Secure Enclave key (`agent-outbox recover`): 0600, 30 minutes, one use.
  recoveryToken: join(STATE_DIR, "recovery-token"),
  imports: join(STATE_DIR, "imports"),
  logs: join(STATE_DIR, "logs"),
  drySendLog: join(STATE_DIR, "logs", "dry-sends.jsonl"),
  contactsExport: join(STATE_DIR, "contacts-export.json"),
  // First run only: the one-time token that guards enrolling the first Secure Enclave key (0600; deleted once setup is done).
  setupToken: join(STATE_DIR, "setup-token"),
  // Simple mode: the pin the server writes (0600, owned by the user). The sender trusts it only while no root pin exists.
  userPinFile: join(STATE_DIR, "passkeys.json"),
  // Hardened mode: root-owned (0444), installed with one sudo command. Once it exists it is the only pin the sender trusts.
  rootPinFile: ROOT_PIN_FILE,
};

export function ensureStateDirs(): void {
  for (const d of [paths.state, paths.runDir, paths.imports, paths.logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // The sender only trusts <state>/passkeys.json while the state dir is closed to group/other writes, so tighten an older, looser dir.
  chmodSync(paths.state, 0o700);
}
