// Unit tests for compose: argv/env construction and the job lifecycle with a fake spawner. `claude` is never run.
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  buildComposeCommand, buildComposeEnv, buildMcpConfig, buildPrompt, COMPOSE_SYSTEM_PROMPT, getComposeJob, startCompose, _resetComposeJobs,
  type Spawner,
} from "../src/core/compose";
import { createBatch } from "../src/core/store";
import { memDb, tmpDir } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const FAKE_CLAUDE = "/nonexistent/claude"; // the spawner is faked, so no real claude is needed (CI has none)
const stream = (s: string) => new Response(s).body;

describe("buildComposeCommand", () => {
  const cmd = buildComposeCommand({ instructions: "Invite the climbing crew to dinner Friday", tag: "climbing", title: "Dinner" }, "compose-abc12345", {
    claudePath: "/home/x/.local/bin/claude", projectRoot: ROOT, bunPath: "/opt/homebrew/bin/bun",
    env: { PATH: "/usr/bin", HOME: "/Users/x", ANTHROPIC_API_KEY: "sk-secret", CLAUDE_CODE_OAUTH_TOKEN: "keep-me" },
  });
  const a = cmd.argv;
  const after = (flag: string) => a[a.indexOf(flag) + 1];

  test("argv: print mode, sonnet, only the outbox MCP server, only mcp__outbox__* tools, no built-in tools", () => {
    expect(a[0]).toBe("/home/x/.local/bin/claude");
    expect(a[1]).toBe("-p");
    expect(a[2]).toContain("Invite the climbing crew to dinner Friday");
    expect(after("--model")).toBe("sonnet");
    expect(a).toContain("--strict-mcp-config");
    expect(after("--allowedTools")).toBe("mcp__outbox__*");
    expect(after("--tools")).toBe("");            // disables every built-in tool (Bash, Edit, ...)
    expect(a.indexOf("--tools")).toBeGreaterThan(-1);
    expect(after("--append-system-prompt")).toBe(COMPOSE_SYSTEM_PROMPT);
    expect(a).not.toContain("--dangerously-skip-permissions");
  });

  test("hardening: dontAsk, strict MCP, no safe mode, settings only from the (empty) cwd, no built-in tools", () => {
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(a).toContain("--strict-mcp-config");
    expect(a).not.toContain("--safe-mode");           // verified: --safe-mode drops the --mcp-config outbox server
    expect(after("--setting-sources")).toBe("project"); // never the user's user settings
    expect(after("--tools")).toBe("");
    expect(after("--allowedTools")).toBe("mcp__outbox__*");
    expect(a).not.toContain("--bare");                // --bare would stop reading the Max-plan OAuth login
    // every flag is placed so a variadic option can't swallow the next one
    expect(a.indexOf("--tools") + 2).toBe(a.indexOf("--allowedTools"));
  });

  test("safe mode is opt-in (a future claude build may keep --mcp-config servers under it)", () => {
    const on = buildComposeCommand({ instructions: "x" }, "l", { safeMode: true, env: {} });
    expect(on.argv).toContain("--safe-mode");
    expect(on.argv).toContain("--strict-mcp-config");
  });

  test("mcp config launches `bun run <abs>/src/mcp/index.ts` as server name `outbox`", () => {
    const cfg = JSON.parse(after("--mcp-config")!);
    expect(Object.keys(cfg.mcpServers)).toEqual(["outbox"]);
    const s = cfg.mcpServers.outbox;
    expect(s.command).toBe("/opt/homebrew/bin/bun");
    expect(s.args[0]).toBe("run");
    expect(isAbsolute(s.args[1])).toBe(true);
    expect(s.args[1]).toBe(join(ROOT, "src/mcp/index.ts"));
    expect(s.env.OUTBOX_CLIENT).toBe("compose-abc12345");
    expect(s.env.OUTBOX_SOURCE).toBe("compose");
    expect(cmd.mcpConfig).toEqual(cfg);
  });

  test("env is minimal: HOME, PATH, USER, LANG, TMPDIR and the OAuth login; never ANTHROPIC_API_KEY or anything else", () => {
    expect(cmd.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cmd.env.PATH).toBe("/usr/bin");
    expect(cmd.env.HOME).toBe("/Users/x");
    expect(cmd.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("keep-me");
    const noisy = buildComposeCommand({ instructions: "x" }, "l", { env: {
      PATH: "/usr/bin", HOME: "/h", USER: "u", LANG: "en_US.UTF-8", TMPDIR: "/t", ANTHROPIC_API_KEY: "sk", ANTHROPIC_AUTH_TOKEN: "t",
      GITHUB_TOKEN: "gh", AWS_SECRET_ACCESS_KEY: "aws", SSH_AUTH_SOCK: "/s", OUTBOX_HOME: "/o", NODE_OPTIONS: "--require x", CLAUDE_CODE_OAUTH_TOKEN: "ok",
    } }).env;
    expect(Object.keys(noisy).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "LANG", "PATH", "TMPDIR", "USER"]);
    expect(buildComposeEnv({}).ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("system prompt says: exactly one batch, submit it, cannot send", () => {
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/exactly ONE batch/);
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/outbox_submit_batch/);
    expect(COMPOSE_SYSTEM_PROMPT).toMatch(/cannot send/);
  });

  test("prompt carries contact ids, tag, import id and title", () => {
    const p = buildPrompt({ instructions: "x", contact_ids: ["c1", "c2"], import_id: "imp9", tag: "family", title: "Hello" });
    for (const s of ["c1, c2", "family", "imp9", "Hello"]) expect(p).toContain(s);
  });

  test("default mcp config uses this project and the running bun", () => {
    const c = buildMcpConfig("l");
    expect(c.mcpServers.outbox.args[1]).toBe(join(ROOT, "src/mcp/index.ts"));
    expect(c.mcpServers.outbox.command).toBe(process.execPath);
  });
});

describe("job lifecycle (fake spawner)", () => {
  beforeEach(() => _resetComposeJobs());
  const labelOf = (argv: string[]) => JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!).mcpServers.outbox.env.OUTBOX_CLIENT as string;

  test("success: collects result text and the batch the child created", async () => {
    const db = memDb();
    let seen: string[] = [];
    const spawn: Spawner = (argv, o) => {
      seen = argv;
      expect(o.env.ANTHROPIC_API_KEY).toBeUndefined();
      createBatch(db, { title: "Dinner", created_by: `agent:${labelOf(argv)}`, source: "compose", status: "review" });
      return { stdout: stream(JSON.stringify({ type: "result", result: "Drafted 3 messages." })), stderr: stream(""), exited: Promise.resolve(0), kill() {} };
    };
    const { job_id } = startCompose({ instructions: "dinner invites" }, { claudePath: FAKE_CLAUDE, spawn, db: () => db, logDir: tmpDir(), projectRoot: ROOT });
    expect(getComposeJob(job_id, { db: () => db })?.status).toBe("running");
    await Bun.sleep(30);
    const job = getComposeJob(job_id, { db: () => db })!;
    expect(job.status).toBe("done");
    expect(job.result_text).toBe("Drafted 3 messages.");
    expect(job.batch_ids).toHaveLength(1);
    expect(job.exit_code).toBe(0);
    expect(seen[0]).toContain("claude");
    expect(await Bun.file(job.log_path).text()).toContain("Drafted 3 messages.");
  });

  test("the child runs in a fresh empty directory with a minimal env, and the directory is removed afterwards", async () => {
    const db = memDb();
    const parent = tmpDir();
    let cwd = ""; let env: Record<string, string> = {};
    let listing: string[] = ["unset"];
    const spawn: Spawner = (argv, o) => {
      cwd = o.cwd; env = o.env; listing = readdirSync(o.cwd);
      createBatch(db, { title: "t", created_by: `agent:${labelOf(argv)}`, source: "compose", status: "review" });
      return { stdout: stream("{}"), stderr: stream(""), exited: Promise.resolve(0), kill() {} };
    };
    const { job_id } = startCompose({ instructions: "x" }, { claudePath: FAKE_CLAUDE, spawn, db: () => db, logDir: tmpDir(), scratchParent: parent, env: { PATH: "/usr/bin", HOME: "/Users/x", ANTHROPIC_API_KEY: "sk-secret", GITHUB_TOKEN: "gh" } });
    await Bun.sleep(40);
    expect(getComposeJob(job_id, { db: () => db })?.status).toBe("done");
    expect(cwd.startsWith(parent)).toBe(true);
    expect(cwd).not.toBe(ROOT);
    expect(listing).toEqual([]);                  // empty: no project files, CLAUDE.md or settings to load
    expect(existsSync(cwd)).toBe(false);          // cleaned up
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
  });

  test("failure: non-zero exit surfaces stderr; no batch created is a failure too", async () => {
    const db = memDb();
    const dir = tmpDir();
    const bad: Spawner = () => ({ stdout: stream(""), stderr: stream("login required"), exited: Promise.resolve(1), kill() {} });
    const a = startCompose({ instructions: "x" }, { claudePath: FAKE_CLAUDE, spawn: bad, db: () => db, logDir: dir });
    await Bun.sleep(30);
    expect(getComposeJob(a.job_id)?.status).toBe("failed");
    expect(getComposeJob(a.job_id)?.error).toContain("login required");

    const nobatch: Spawner = () => ({ stdout: stream("{\"result\":\"done\"}"), stderr: stream(""), exited: Promise.resolve(0), kill() {} });
    const b = startCompose({ instructions: "x" }, { claudePath: FAKE_CLAUDE, spawn: nobatch, db: () => db, logDir: dir });
    await Bun.sleep(30);
    expect(getComposeJob(b.job_id)?.status).toBe("failed");
    expect(getComposeJob(b.job_id)?.error).toContain("no batch was created");

    const boom: Spawner = () => { throw new Error("ENOENT claude"); };
    const c = startCompose({ instructions: "x" }, { claudePath: FAKE_CLAUDE, spawn: boom, db: () => db, logDir: dir });
    await Bun.sleep(30);
    expect(getComposeJob(c.job_id)?.error).toBe("ENOENT claude");
  });

  test("timeout kills the child", async () => {
    let killed = false; let release!: (n: number) => void;
    const spawn: Spawner = () => ({ stdout: stream(""), stderr: stream(""), exited: new Promise<number>((r) => { release = r; }), kill() { killed = true; release(143); } });
    const { job_id } = startCompose({ instructions: "x" }, { claudePath: FAKE_CLAUDE, spawn, db: () => memDb(), logDir: tmpDir(), timeoutMs: 20 });
    await Bun.sleep(80);
    expect(killed).toBe(true);
    expect(getComposeJob(job_id)?.status).toBe("failed");
    expect(getComposeJob(job_id)?.error).toBe("timed out");
  });

  test("validation and concurrency cap; unknown job is null", async () => {
    expect(() => startCompose({ instructions: "   " })).toThrow("instructions are required");
    const hang: Spawner = () => ({ stdout: stream(""), stderr: stream(""), exited: new Promise<number>(() => {}), kill() {} });
    const o = { claudePath: FAKE_CLAUDE, spawn: hang, db: () => memDb(), logDir: tmpDir(), timeoutMs: 60_000 };
    startCompose({ instructions: "a" }, o); startCompose({ instructions: "b" }, o);
    expect(() => startCompose({ instructions: "c" }, o)).toThrow("two compose jobs");
    expect(getComposeJob("nope")).toBeNull();
  });
});
