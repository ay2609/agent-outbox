#!/usr/bin/env bun
// outbox MCP server (stdio). Launched per Claude session: `bun run <abs path>/src/mcp/index.ts`.
// Env: OUTBOX_CLIENT (label shown as agent:<label>), OUTBOX_AGENT_SOCKET.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOutboxMcpServer } from "./server";

export { createOutboxMcpServer } from "./server";

if (import.meta.main) {
  const server = createOutboxMcpServer();
  await server.connect(new StdioServerTransport());
}
