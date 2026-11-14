// Thin client of the agent API, shared by the MCP server and the CLI. Talks to the unix socket, or to any
// fetch-compatible function (tests call the Hono app in-process).
import { paths } from "../core/paths";

export interface ClientOptions {
  socketPath?: string;
  client: string;                         // X-Outbox-Client label
  source?: "mcp" | "cli" | "compose";     // X-Outbox-Source
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export class OutboxDownError extends Error {
  constructor(socketPath: string) {
    super(`outboxd isn't running (no agent socket at ${socketPath}). Start it with: launchctl kickstart -k gui/$(id -u)/io.github.ay2609.agent-outbox, or run "bun run src/server.ts" in the agent-outbox project.`);
  }
}

export class OutboxApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export type Json = Record<string, any>;

export function createAgentClient(o: ClientOptions) {
  const socketPath = o.socketPath ?? process.env.OUTBOX_AGENT_SOCKET ?? paths.agentSocket;
  const headers: Record<string, string> = {
    "X-Outbox-Client": o.client, "X-Outbox-Source": o.source ?? "mcp", "Content-Type": "application/json",
  };
  async function request(method: string, path: string, body?: unknown): Promise<Json> {
    const url = `http://outbox${path}`;
    const init: any = { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    let res: Response;
    try {
      res = o.fetchImpl ? await o.fetchImpl(url, init) : await fetch(url, { ...init, unix: socketPath });
    } catch (e) {
      // Over the real socket any fetch failure means no one is serving it (missing, refused, stale file).
      if (!o.fetchImpl) throw new OutboxDownError(socketPath);
      throw e;
    }
    const text = await res.text();
    let json: Json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = json.error ?? {};
      throw new OutboxApiError(res.status, err.code ?? "http_error", err.message ?? `HTTP ${res.status}`, err.details);
    }
    return json;
  }
  return {
    socketPath,
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown) => request("POST", path, body ?? {}),
    put: (path: string, body?: unknown) => request("PUT", path, body ?? {}),
    patch: (path: string, body?: unknown) => request("PATCH", path, body ?? {}),
  };
}
export type AgentClient = ReturnType<typeof createAgentClient>;

export const qs = (params: Record<string, string | number | undefined>): string => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};
