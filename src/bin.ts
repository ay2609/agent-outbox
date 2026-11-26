// The single compiled entry: `bun build --compile src/bin.ts` -> `agent-outbox`.
//   agent-outbox server [--app-auth-fd N]   the daemon (agent API; owner API on a unix socket for the app)
//   agent-outbox mcp                        the MCP server over stdio
//   agent-outbox cli <args…>                the `outbox` command-line client
//   agent-outbox recover                    open a 30-minute window to set up Touch ID again (src/owner-api/recovery.ts)
// Everything is imported lazily so `mcp` and `cli` never open the database or bind a socket.
export {};

const USAGE = `agent-outbox: draft iMessages for you to approve (nothing here sends).

  agent-outbox server [--app-auth-fd N]   run the daemon (Agent Outbox.app does this for you)
  agent-outbox mcp                        MCP server over stdio (for Claude Code, Claude Desktop, Cursor …)
  agent-outbox cli <command>              command-line client ("agent-outbox cli --help")
  agent-outbox recover                    set up Touch ID again (lost Mac, changed fingerprints, or an older install)
  agent-outbox --version
`;

async function run(argv: string[]): Promise<number | undefined> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "server": {
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
