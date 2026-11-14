// outboxd: the agent API on a unix socket, the dashboard on loopback, and the contacts-export importer.
// Nothing in this process can send a message; sending lives only in outbox-exec.
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { agentApp } from "./agent-api";
import { getDb } from "./db";
import { startContactsWatcher } from "./core/contacts-sync";
import { PORT, ensureStateDirs, paths } from "./core/paths";
import { ownerApp } from "./owner-api/index";
import { passkeyCount, pinText, writePinFiles } from "./owner-api/auth";
import { resolveConfig } from "./owner-api/config";
import { relintOpenBatches } from "./personalize/lint";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

process.umask(0o077); // the database, sockets and every file created from here are owner-only
ensureStateDirs();
const db = getDb();

/** Refuses to start over a live daemon; removes a stale socket file left by a crash. */
async function clearSocket(): Promise<void> {
  if (!existsSync(paths.agentSocket)) return;
  try {
    const r = await fetch("http://outbox/v1/health", { unix: paths.agentSocket, signal: AbortSignal.timeout(1000) });
    if (r.ok) { log(`another outboxd is already serving ${paths.agentSocket}; exiting`); process.exit(1); }
  } catch { /* nobody answered: stale */ }
  unlinkSync(paths.agentSocket);
  log("removed stale agent socket");
}
await clearSocket();

// Keep the user pin in step with the dashboard's keys and policy (e.g. after a port change, which changes the pinned origin).
{
  const ocfg = resolveConfig();
  if (passkeyCount(db, "approve") > 0) {
    let cur: string | null = null;
    try { cur = readFileSync(paths.userPinFile, "utf8"); } catch { /* not written yet */ }
    if (cur !== pinText(ocfg, db)) { writePinFiles(ocfg, db); log(`rewrote ${paths.userPinFile} from the dashboard's keys and policy`); }
  }
}

// Batches still in review were linted by whatever rules were current when they were built; refresh their stored warnings.
log(`re-linted ${relintOpenBatches(db)} open batch(es)`);

const agentServer = Bun.serve({ unix: paths.agentSocket, fetch: agentApp.fetch, idleTimeout: 120 } as any);
chmodSync(paths.agentSocket, 0o600);
log(`agent API on ${paths.agentSocket}`);

const ownerServer = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: ownerApp.fetch, idleTimeout: 60 });
log(`dashboard on 127.0.0.1:${ownerServer.port} (open http://localhost:${ownerServer.port})`);

const watcher = startContactsWatcher({ db, log: (m) => log(m) });
log(`watching ${paths.contactsExport} (polling every 10 s)`);

let stopping = false;
function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log(`${sig}: shutting down`);
  watcher.stop();
  void agentServer.stop(true);
  void ownerServer.stop(true);
  try { unlinkSync(paths.agentSocket); } catch { /* already gone */ }
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
