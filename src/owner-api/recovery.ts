// STUB from track A (packaging). Track C replaces this file with the real recovery / setup-link logic.
// bin.ts dispatches `agent-outbox recover` and `agent-outbox setup-link` here. Each returns the process exit code.
export async function runRecover(_args: string[] = []): Promise<number> {
  console.error("agent-outbox recover: not implemented yet (stub from the packaging track)");
  return 1;
}

export async function runSetupLink(_args: string[] = []): Promise<number> {
  console.error("agent-outbox setup-link: not implemented yet (stub from the packaging track)");
  return 1;
}
