// "Compose" lets the dashboard ask a headless `claude -p` to draft a batch. The child gets ONLY the outbox MCP
// tools (no Bash, no file tools), so it can draft but never send. Jobs live in memory; logs go under paths.logs.
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, newId, nowIso } from "../db";
import { composeAvailability } from "./config";
import { config, paths } from "./paths";

export interface ComposeInput {
  instructions: string;
  contact_ids?: string[];
  import_id?: string;
  tag?: string;
  title?: string;
}

export type ComposeStatus = "running" | "done" | "failed";
export interface ComposeJob {
  job_id: string;
  status: ComposeStatus;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  title: string | null;
  client_label: string;
  batch_ids: string[];
  result_text: string | null;
  error: string | null;
  log_path: string;
}

export interface SpawnedProc {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}
export type Spawner = (argv: string[], opts: { env: Record<string, string>; cwd: string }) => SpawnedProc;

export interface ComposeDeps {
  spawn?: Spawner;
  db?: () => Database;
  claudePath?: string;
  timeoutMs?: number;
  projectRoot?: string;
  logDir?: string;
  /** Parent of the fresh empty working directory the child runs in (tests). Defaults to the system temp dir. */
  scratchParent?: string;
  /** Environment the child's own is built from (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Pass --safe-mode. Default OFF: verified 2026-11-10 that --safe-mode drops --mcp-config servers (the child sees no
   *  outbox tools) and --bare skips the keychain login. Isolation instead comes from --setting-sources project in an empty
   *  temp cwd, --strict-mcp-config, --tools "", --allowedTools mcp__outbox__* and --permission-mode dontAsk. */
  safeMode?: boolean;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The claude binary to run: config claude_path, else PATH, else ~/.local/bin/claude; null when compose is off or none exists. */
export function resolveClaude(): string | null { return composeAvailability(config).path; }

export const COMPOSE_SYSTEM_PROMPT = `You are the drafting assistant inside the user's iMessage outbox. You can only use the mcp__outbox__* tools. You cannot send messages; the user reviews every draft in their dashboard and approves it with their passkey (Touch ID).
Do exactly this: (1) find the recipients you need with outbox_search_contacts / outbox_get_contact; (2) create exactly ONE batch with outbox_create_batch (or outbox_batch_from_import when an import id is given), with a short title; (3) submit that batch with outbox_submit_batch. Do not create more than one batch, and never claim a message was sent.
Write like a person texting: short, natural, personalised to each recipient, no placeholders left in the text, no invented facts. Merge syntax if you use a template: {{first_name|there}}.
Finish with one or two sentences saying what you drafted and for whom.`;

export function buildPrompt(input: ComposeInput): string {
  const parts = [`The user's instructions:\n${input.instructions.trim()}`];
  if (input.title) parts.push(`Use this batch title: ${input.title}`);
  if (input.contact_ids?.length) parts.push(`Draft for these contact ids (look each up with outbox_get_contact): ${input.contact_ids.join(", ")}`);
  if (input.tag) parts.push(`Draft for the contacts tagged "${input.tag}" (find them with outbox_search_contacts, query "${input.tag}", and check each result's tags).`);
  if (input.import_id) parts.push(`Use the already-ingested import ${input.import_id}: use outbox_set_mapping if a column mapping needs fixing, then outbox_batch_from_import, then personalise the drafts.`);
  parts.push("Create exactly one batch and submit it.");
  return parts.join("\n\n");
}

export function buildMcpConfig(label: string, o: { projectRoot?: string; bunPath?: string } = {}): { mcpServers: { outbox: { command: string; args: string[]; env: Record<string, string> } } } {
  const root = o.projectRoot ?? PROJECT_ROOT;
  const env: Record<string, string> = { OUTBOX_CLIENT: label, OUTBOX_SOURCE: "compose" };
  if (process.env.OUTBOX_HOME) env.OUTBOX_HOME = process.env.OUTBOX_HOME;
  if (process.env.OUTBOX_AGENT_SOCKET) env.OUTBOX_AGENT_SOCKET = process.env.OUTBOX_AGENT_SOCKET;
  return { mcpServers: { outbox: { command: o.bunPath ?? process.execPath, args: ["run", join(root, "src/mcp/index.ts")], env } } };
}

/** Environment variables the child may inherit. Nothing else (in particular no ANTHROPIC_API_KEY, so the Max plan is
 *  used, and none of the user's tokens or shell state). The OAuth token is only there if outboxd itself has one. */
export const COMPOSE_ENV_ALLOWLIST = ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];

export function buildComposeEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of COMPOSE_ENV_ALLOWLIST) { const v = source[k]; if (v !== undefined && v !== "") env[k] = v; }
  return env;
}

/** Pure: the argv and env for the child. Hardened (docs/ARCHITECTURE.md §2, L2): no prompts (dontAsk), only the outbox MCP
 *  server, no built-in tools, no user hooks / plugins / CLAUDE.md (safe mode, and settings from the empty cwd only), and a
 *  minimal environment. The caller runs it in a fresh empty directory. */
export function buildComposeCommand(input: ComposeInput, label: string, o: { claudePath?: string; projectRoot?: string; bunPath?: string; env?: Record<string, string | undefined>; safeMode?: boolean } = {}) {
  const mcpConfig = buildMcpConfig(label, o);
  const argv = [
    o.claudePath ?? "claude",
    "-p", buildPrompt(input),
    "--model", "sonnet",
    "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--mcp-config", JSON.stringify(mcpConfig),
    ...(o.safeMode === true ? ["--safe-mode"] : []),
    "--setting-sources", "project", // not the user's own settings (hooks, plugins, allow rules); cwd is an empty temp dir
    "--tools", "",
    "--allowedTools", "mcp__outbox__*",
    "--append-system-prompt", COMPOSE_SYSTEM_PROMPT,
    "--output-format", "json",
  ];
  return { argv, env: buildComposeEnv(o.env ?? process.env), mcpConfig };
}

const jobs = new Map<string, ComposeJob>();
const MAX_RUNNING = 2;

const defaultSpawn: Spawner = (argv, o) => {
  const p = Bun.spawn(argv, { env: o.env, cwd: o.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { stdout: p.stdout, stderr: p.stderr, exited: p.exited, kill: () => p.kill() };
};

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? await new Response(stream).text() : "";
}

export function startCompose(input: ComposeInput, deps: ComposeDeps = {}): { job_id: string } {
  if (!input.instructions?.trim()) throw new Error("instructions are required");
  const claudePath = deps.claudePath ?? resolveClaude();
  if (!claudePath) throw new Error("compose is unavailable: no claude command was found (or compose is off in config.json)");
  if ([...jobs.values()].filter((j) => j.status === "running").length >= MAX_RUNNING) throw new Error("two compose jobs are already running; wait for one to finish");
  const job_id = newId();
  const label = `compose-${job_id.slice(-8)}`;
  const logDir = deps.logDir ?? paths.logs;
  mkdirSync(logDir, { recursive: true });
  const log_path = join(logDir, `compose-${job_id}.log`);
  const job: ComposeJob = {
    job_id, status: "running", started_at: nowIso(), finished_at: null, exit_code: null, title: input.title ?? null,
    client_label: label, batch_ids: [], result_text: null, error: null, log_path,
  };
  jobs.set(job_id, job);
  const log = (s: string) => { try { appendFileSync(log_path, s); } catch { /* logging must never break a job */ } };

  const cmd = buildComposeCommand(input, label, {
    claudePath, projectRoot: deps.projectRoot, env: deps.env,
    safeMode: deps.safeMode ?? (process.env.OUTBOX_COMPOSE_SAFE_MODE === "1"),
  });
  log(`[${job.started_at}] compose ${job_id}\nargv (prompt and mcp config elided): ${cmd.argv.filter((a) => a.startsWith("--") || a === "sonnet").join(" ")}\n\n`);

  void (async () => {
    let proc: SpawnedProc | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let scratch: string | null = null;
    try {
      // A fresh empty directory: no project files, CLAUDE.md or settings for the child to pick up.
      scratch = mkdtempSync(join(deps.scratchParent ?? tmpdir(), "outbox-compose-"));
      proc = (deps.spawn ?? defaultSpawn)(cmd.argv, { env: cmd.env, cwd: scratch });
      timer = setTimeout(() => { job.error = "timed out"; proc?.kill(); }, deps.timeoutMs ?? 10 * 60_000);
      const [out, err, code] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.exited]);
      job.exit_code = code;
      log(`--- stdout ---\n${out}\n--- stderr ---\n${err}\n`);
      job.result_text = extractResult(out);
      if (code !== 0 && !job.error) job.error = (err.trim() || out.trim() || `claude exited with ${code}`).slice(0, 2000);
    } catch (e) {
      job.error = (e as Error).message;
      log(`spawn failed: ${job.error}\n`);
    } finally {
      if (timer) clearTimeout(timer);
      if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } }
      try {
        const db = (deps.db ?? getDb)();
        job.batch_ids = (db.query("SELECT id FROM batches WHERE created_by = ? ORDER BY created_at").all(`agent:${label}`) as { id: string }[]).map((r) => r.id);
      } catch { /* db unavailable in tests */ }
      job.status = job.error ? "failed" : "done";
      if (job.status === "done" && job.batch_ids.length === 0) { job.status = "failed"; job.error = "claude finished but no batch was created"; }
      job.finished_at = nowIso();
    }
  })();
  return { job_id };
}

function extractResult(stdout: string): string | null {
  const t = stdout.trim();
  if (!t) return null;
  try { const j = JSON.parse(t); return typeof j.result === "string" ? j.result : t; } catch { return t.slice(0, 4000); }
}

export function getComposeJob(job_id: string, deps: Pick<ComposeDeps, "db"> = {}): ComposeJob | null {
  const job = jobs.get(job_id);
  if (!job) return null;
  if (job.status === "running") {
    try {
      const db = (deps.db ?? getDb)();
      job.batch_ids = (db.query("SELECT id FROM batches WHERE created_by = ? ORDER BY created_at").all(`agent:${job.client_label}`) as { id: string }[]).map((r) => r.id);
    } catch { /* ignore */ }
  }
  return { ...job, batch_ids: [...job.batch_ids] };
}

/** Test helper. */
export function _resetComposeJobs(): void { jobs.clear(); }
