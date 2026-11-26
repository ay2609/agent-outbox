// outboxd: the agent API on a unix socket, the dashboard on loopback, and the contacts-export importer.
// Nothing in this process can send a message; sending lives only in outbox-exec.
//
// `main(argv)` is the entry point (src/bin.ts calls it for `agent-outbox server …`; `bun run src/server.ts` runs it directly).
// `--app-auth-fd N` (Agent Outbox.app only): reads the per-launch app token from inherited descriptor N, serves the owner API a second
// time on <state>/run/owner.sock for the app, and exits when stdin closes (the app died). Without it there is no app channel.
import { chmodSync, closeSync, existsSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { agentApp } from "./agent-api";
import { getDb } from "./db";
import { startContactsWatcher } from "./core/contacts-sync";
import { PORT, ensureStateDirs, paths } from "./core/paths";
import { ownerApp } from "./owner-api/index";
import { nativeKeyCount, passkeyCount, pinText, writePinFiles } from "./owner-api/auth";
import { resolveConfig } from "./owner-api/config";
import { APP_TOKEN_RE, defaultAppAuth } from "./owner-api/app-auth";
import { defaultSetupToken } from "./owner-api/setup-token";
import { relintOpenBatches } from "./personalize/lint";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/** Parses `--app-auth-fd N` / `--app-auth-fd=N`. Returns null when absent; exits 2 on a malformed value. */
export function parseAppAuthFd(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let v: string | undefined;
    if (a === "--app-auth-fd") v = argv[i + 1];
    else if (a.startsWith("--app-auth-fd=")) v = a.slice("--app-auth-fd=".length);
    else continue;
    if (v === undefined || !/^\d+$/.test(v) || Number(v) < 3) {
      console.error("--app-auth-fd needs a file descriptor number of 3 or more");
      process.exit(2);
    }
    return Number(v);
  }
  return null;
}

/** Reads the app token from `fd` to EOF (at most 128 bytes, one line of 43 base64url characters), closes the descriptor and returns
 *  the token. Anything else exits 2. The token is never logged or put anywhere but the in-memory hash. */
export function readAppToken(fd: number): string {
  const buf = Buffer.alloc(129);
  let n = 0;
  try {
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > 128) { console.error("app auth: too much data on the descriptor"); process.exit(2); }
    }
  } catch (e) {
    console.error(`app auth: cannot read descriptor ${fd}: ${(e as Error).message}`);
    process.exit(2);
  }
  try { closeSync(fd); } catch { /* already closed */ }
  const token = buf.subarray(0, n).toString("utf8").replace(/\r?\n$/, "");
  if (!APP_TOKEN_RE.test(token)) { console.error("app auth: the token must be 43 base64url characters"); process.exit(2); }
  return token;
}

export async function main(argvIn: string[] = process.argv.slice(2)): Promise<void> {
  const argv = argvIn[0] === "server" ? argvIn.slice(1) : argvIn;
  const appFd = parseAppAuthFd(argv);
  // Before anything else: a bad descriptor or token must not leave a half-started daemon.
  if (appFd !== null) defaultAppAuth.set(readAppToken(appFd));

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
    if (passkeyCount(db, "approve") > 0 || nativeKeyCount(db) > 0) {
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

  // First run: no sign-in key and no native key yet, so registering one needs the one-time setup token (kept in <state>/setup-token until then).
  const setupToken = defaultSetupToken.start(db);

  // The TCP listener always says it is "tcp"; the app channel is only ever the socket below. The channel is a server-side value, never a header.
  const ownerServer = Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: (req: Request) => ownerApp.fetch(req, { channel: "tcp" }), idleTimeout: 60 });
  log(`dashboard on 127.0.0.1:${ownerServer.port} (open http://localhost:${ownerServer.port})`);
  if (setupToken) log(`first-run setup: open http://localhost:${ownerServer.port}/#/setup?token=${setupToken}`);

  let appServer: ReturnType<typeof Bun.serve> | null = null;
  if (appFd !== null) {
    try { unlinkSync(paths.ownerSocket); } catch { /* none (a stale file from a crash is replaced) */ }
    appServer = Bun.serve({ unix: paths.ownerSocket, fetch: (req: Request) => ownerApp.fetch(req, { channel: "app" }), idleTimeout: 60 } as any);
    chmodSync(paths.ownerSocket, 0o600);
    log(`app channel on ${paths.ownerSocket}`);
  }

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
    if (appServer) void appServer.stop(true);
    try { unlinkSync(paths.agentSocket); } catch { /* already gone */ }
    if (appServer) { try { unlinkSync(paths.ownerSocket); } catch { /* already gone */ } }
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Lifeline: the app keeps our stdin open for as long as it lives; EOF means it died, so we stop (no orphaned daemon holding the socket).
  if (appFd !== null) {
    process.stdin.on("end", () => shutdown("stdin closed (the app exited)"));
    process.stdin.on("error", () => shutdown("stdin error"));
    process.stdin.resume();
  }
}

if (import.meta.main) await main();
