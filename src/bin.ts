// The single compiled entry: `bun build --compile src/bin.ts` -> `agent-outbox`.
//   agent-outbox server [--app-auth-fd N]   the daemon (agent API, dashboard, owner API)
//   agent-outbox mcp                        the MCP server over stdio
//   agent-outbox cli <args…>                the `outbox` command-line client
//   agent-outbox recover | setup-link       owner-API recovery helpers (src/owner-api/recovery.ts)
// Everything is imported lazily so `mcp` and `cli` never open the database or bind a port.
import "reflect-metadata"; // tsyringe (via @simplewebauthn) needs it first; `bun run` gets it by luck, the compiled binary does not
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const USAGE = `agent-outbox: draft iMessages for you to approve (nothing here sends).

  agent-outbox server [--app-auth-fd N]   run the daemon
  agent-outbox mcp                        MCP server over stdio (for Claude Code, Claude Desktop, Cursor …)
  agent-outbox cli <command>              command-line client ("agent-outbox cli --help")
  agent-outbox recover                    recover access to the dashboard
  agent-outbox setup-link                 print a fresh first-run setup link
  agent-outbox --version
`;

/** True inside a `bun build --compile` binary (module paths live under /$bunfs). */
const compiled = import.meta.url.includes("/$bunfs/") || import.meta.dir.startsWith("/$bunfs");

/** In the app bundle the dashboard lives at Contents/Resources/web (binary is Contents/MacOS/agent-outbox). */
function pointAtBundledWeb(): void {
  if (process.env.OUTBOX_WEB_DIST || !compiled) return;
  const candidates = [
    join(dirname(process.execPath), "..", "Resources", "web"), // inside Agent Outbox.app
    join(dirname(process.execPath), "web"), // a bare binary next to a web/ folder
  ];
  const hit = candidates.find((d) => existsSync(join(d, "index.html")));
  if (hit) process.env.OUTBOX_WEB_DIST = hit;
}

async function run(argv: string[]): Promise<number | undefined> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "server": {
      pointAtBundledWeb();
      // server.ts parses its own flags (`--app-auth-fd N`); import.meta.main is false here, so start it explicitly.
      const { main } = await import("./server");
      await main(rest);
      return undefined; // keep running: Bun stays alive on the listeners
    }
    case "mcp": {
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { createOutboxMcpServer } = await import("./mcp/server");
      await createOutboxMcpServer().connect(new StdioServerTransport());
      return undefined;
    }
    case "cli": {
      const { main } = await import("./cli/index");
      return main(rest);
    }
    case "recover": {
      const { runRecover } = await import("./owner-api/recovery");
      return runRecover();
    }
    case "setup-link": {
      const { runSetupLink } = await import("./owner-api/recovery");
      return runSetupLink();
    }
    case "--version":
    case "version": {
      const pkg = (await import("../package.json")).default as { version: string };
      console.log(pkg.version);
      return 0;
    }
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return cmd ? 0 : 2;
    default:
      console.error(`agent-outbox: unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

const code = await run(process.argv.slice(2));
if (code !== undefined) process.exit(code);
