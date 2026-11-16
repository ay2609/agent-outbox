import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, ROOT_PIN_FILE, configFilePath, defaultStateDir, loadConfig, resolveStateDir } from "./config";

const dir = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-config-"));
const load = (d: string, env: Record<string, string | undefined> = {}) => {
  const warnings: string[] = [];
  return { cfg: loadConfig(d, env, (m) => warnings.push(m)), warnings };
};

describe("config.json", () => {
  test("no file: defaults (port 7477)", () => {
    const { cfg, warnings } = load(dir());
    expect(cfg).toEqual({ port: 7477 });
    expect(DEFAULT_PORT).toBe(7477);
    expect(warnings).toEqual([]);
  });
  test("reads port; unknown keys are ignored, including the old compose and claude_path", () => {
    const d = dir();
    writeFileSync(configFilePath(d), JSON.stringify({ port: 7600, compose: "off", claude_path: "/opt/claude/bin/claude", theme: "dark", extra: { a: 1 } }));
    const { cfg, warnings } = load(d);
    expect(cfg).toEqual({ port: 7600 });
    expect(warnings).toEqual([]);
  });
  test("every key is optional", () => {
    const d = dir();
    writeFileSync(configFilePath(d), JSON.stringify({ compose: "off" }));
    expect(load(d).cfg).toEqual({ port: 7477 });
  });
  test("OUTBOX_PORT beats config.json; a bad OUTBOX_PORT is ignored with a warning", () => {
    const d = dir();
    writeFileSync(configFilePath(d), JSON.stringify({ port: 7600 }));
    expect(load(d, { OUTBOX_PORT: "7788" }).cfg.port).toBe(7788);
    const bad = load(d, { OUTBOX_PORT: "http" });
    expect(bad.cfg.port).toBe(7600);
    expect(bad.warnings.join(" ")).toContain("OUTBOX_PORT");
  });
  test("bad JSON: a warning and the defaults, never a throw", () => {
    const d = dir();
    writeFileSync(configFilePath(d), "{ port: nope");
    const { cfg, warnings } = load(d);
    expect(cfg).toEqual({ port: 7477 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("isn't valid JSON");
  });
  test("wrong shapes and bad values fall back with a warning", () => {
    const d = dir();
    writeFileSync(configFilePath(d), JSON.stringify({ port: 99999 }));
    const { cfg, warnings } = load(d);
    expect(cfg).toEqual({ port: 7477 });
    expect(warnings).toHaveLength(1);
    const arr = dir();
    writeFileSync(configFilePath(arr), "[1,2]");
    expect(load(arr).warnings).toHaveLength(1);
  });
});

describe("state dir and fixed paths", () => {
  test("default state dir is ~/Library/Application Support/agent-outbox; OUTBOX_HOME overrides it", () => {
    expect(defaultStateDir().endsWith("/Library/Application Support/agent-outbox")).toBe(true);
    expect(resolveStateDir({})).toBe(defaultStateDir());
    expect(resolveStateDir({ OUTBOX_HOME: "/tmp/ao" })).toBe("/tmp/ao");
  });
  test("the root pin path is a constant", () => { expect(ROOT_PIN_FILE).toBe("/Library/Application Support/agent-outbox/passkeys.json"); });
});
