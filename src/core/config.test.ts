import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_PIN_FILE, configFilePath, defaultStateDir, legacySettings, resolveStateDir } from "./config";

const dir = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "outbox-config-"));

describe("retired settings", () => {
  test("nothing present: nothing reported", () => {
    expect(legacySettings(dir(), {})).toEqual([]);
  });
  test("a port in config.json and the old env variables are reported, other keys are not", () => {
    const d = dir();
    writeFileSync(configFilePath(d), JSON.stringify({ port: 7600, compose: "off" }));
    expect(legacySettings(d, { OUTBOX_PORT: "7788", OUTBOX_RP_ID: "x", OUTBOX_ORIGIN: "" })).toEqual(["port", "OUTBOX_PORT", "OUTBOX_RP_ID"]);
  });
  test("bad JSON or a non-object file never throws", () => {
    const d = dir();
    writeFileSync(configFilePath(d), "{ port: nope");
    expect(legacySettings(d, {})).toEqual([]);
    writeFileSync(configFilePath(d), "[1,2]");
    expect(legacySettings(d, {})).toEqual([]);
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
