import { createAgentApp } from "./app";
export { createAgentApp, ApiError, type AgentAppOptions } from "./app";

/** The agent API: draft-only, served on the unix socket. Lazy: touches the DB and ingest modules on first request. */
export const agentApp = createAgentApp();
