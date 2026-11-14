// The import-path allowlist (security): an agent must not be able to make outboxd or the MCP/CLI read ~/.ssh and friends.
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { allowedRoots, checkImportPath, FileProblemError, IMPORT_EXTENSIONS, PathRefusedError, readUpload } from "../src/core/upload";
import { tmpDir } from "./helpers";

/** A throwaway "home" with ordinary folders, a hidden .ssh and a folder outside every allowed root. */
function fakeHome() {
  const home = realpathSync(tmpDir("outbox-home-"));
  for (const d of ["Documents", "Downloads", "code", ".ssh", "Secrets", "Documents/.hidden", "Documents/sub"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".ssh/id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n");
  writeFileSync(join(home, "Documents/people.csv"), "Name,Phone\nJane Smith,301-555-0123\n");
  writeFileSync(join(home, "Secrets/real.csv"), "Name,Phone\nX,1\n");
  const policy = { home, roots: [join(home, "Documents"), join(home, "Downloads"), join(home, "code")] };
  return { home, policy };
}
const refused = (fn: () => unknown): PathRefusedError => { try { fn(); } catch (e) { if (e instanceof PathRefusedError) return e; throw e; } throw new Error("was allowed"); };

describe("allowed", () => {
  test("an ordinary data file under an allowed folder, by absolute, ~/ and symlink-to-inside paths", () => {
    const { home, policy } = fakeHome();
    const p = join(home, "Documents/people.csv");
    expect(checkImportPath(p, policy)).toBe(p);
    expect(checkImportPath("~/Documents/people.csv", policy)).toBe(p);
    symlinkSync(p, join(home, "Documents/link.csv"));
    expect(checkImportPath(join(home, "Documents/link.csv"), policy)).toBe(p); // inside the root after realpath
    expect(readUpload(p, policy)).toEqual({ base64: Buffer.from("Name,Phone\nJane Smith,301-555-0123\n").toString("base64"), filename: "people.csv" });
  });

  test("every listed extension, any case", () => {
    const { home, policy } = fakeHome();
    for (const ext of IMPORT_EXTENSIONS) {
      writeFileSync(join(home, `Documents/x.${ext}`), "a");
      writeFileSync(join(home, `Documents/Y.${ext.toUpperCase()}`), "a");
      expect(() => checkImportPath(join(home, `Documents/x.${ext}`), policy)).not.toThrow();
      expect(() => checkImportPath(join(home, `Documents/Y.${ext.toUpperCase()}`), policy)).not.toThrow();
    }
    expect(IMPORT_EXTENSIONS.sort()).toEqual(["csv", "json", "jsonl", "md", "numbers", "ods", "tsv", "txt", "vcf", "xls", "xlsx"].sort());
  });

  test("the default roots are ~/code, ~/workspaces, ~/Downloads, ~/Desktop, ~/Documents (when they exist) and the system temp dirs", () => {
    const { home } = fakeHome();
    mkdirSync(join(home, "workspaces"));
    mkdirSync(join(home, "Desktop"));
    const roots = allowedRoots({ home });
    for (const d of ["code", "workspaces", "Downloads", "Desktop", "Documents"]) expect(roots).toContain(join(home, d));
    expect(roots).toContain(realpathSync(process.env.TMPDIR ?? "/tmp"));
    // a temp file is importable with the default policy
    const t = join(tmpDir(), "paste.csv");
    writeFileSync(t, "a,b\n1,2\n");
    expect(checkImportPath(t)).toBe(realpathSync(t));
  });
});

describe("refused", () => {
  test("~/.ssh/id_ed25519: refused whether or not it exists, by the hidden-folder rule", () => {
    const { home, policy } = fakeHome();
    expect(refused(() => checkImportPath(join(home, ".ssh/id_ed25519"), policy)).message).toContain("hidden");
    expect(refused(() => checkImportPath("~/.ssh/id_ed25519", policy)).code).toBe("path_not_allowed");
    expect(() => checkImportPath(join(home, ".ssh/nope"), policy)).toThrow(PathRefusedError); // refused before existence is even checked
    // and with the real home directory string nothing is read at all
    expect(() => checkImportPath(`${homedir()}/.ssh/id_ed25519`)).toThrow(PathRefusedError);
    expect(() => checkImportPath("~/.ssh/id_ed25519")).toThrow(PathRefusedError);
  });

  test("a symlink out of an allowed root (to a plain folder, to ~/.ssh, to /etc)", () => {
    const { home, policy } = fakeHome();
    symlinkSync(join(home, "Secrets/real.csv"), join(home, "Documents/looks-fine.csv"));
    expect(refused(() => checkImportPath(join(home, "Documents/looks-fine.csv"), policy)).message).toContain("only files under");
    symlinkSync(join(home, ".ssh/id_ed25519"), join(home, "Documents/notes.txt"));
    expect(() => checkImportPath(join(home, "Documents/notes.txt"), policy)).toThrow(PathRefusedError);
    symlinkSync("/etc/hosts", join(home, "Documents/hosts.txt"));
    expect(() => checkImportPath(join(home, "Documents/hosts.txt"), policy)).toThrow(PathRefusedError);
    // a symlinked FOLDER too
    symlinkSync(join(home, ".ssh"), join(home, "Documents/sub/keys"));
    expect(() => checkImportPath(join(home, "Documents/sub/keys/id_ed25519"), policy)).toThrow(PathRefusedError);
  });

  test("a symlink out of the default temp roots", () => {
    const d = tmpDir();
    symlinkSync("/etc/hosts", join(d, "list.csv"));
    expect(() => checkImportPath(join(d, "list.csv"))).toThrow(PathRefusedError);
  });

  test(".env files, certificates and key files", () => {
    const { home, policy } = fakeHome();
    const bad = [".env", ".env.local", "server.pem", "api-keys.csv", "my_KEY.json", "private.key.txt", "monkey.csv"];
    for (const n of bad) {
      writeFileSync(join(home, "Documents", n), "x");
      expect(() => checkImportPath(join(home, "Documents", n), policy)).toThrow(PathRefusedError);
    }
    writeFileSync(join(home, ".env"), "SECRET=1");
    expect(() => checkImportPath("~/.env", policy)).toThrow(PathRefusedError);
    const t = join(tmpDir(), ".env");
    writeFileSync(t, "SECRET=1");
    expect(() => checkImportPath(t)).toThrow(PathRefusedError); // also in a temp dir, with the default policy
  });

  test("any hidden path segment, even inside an allowed root", () => {
    const { home, policy } = fakeHome();
    writeFileSync(join(home, "Documents/.hidden/people.csv"), "a");
    expect(() => checkImportPath(join(home, "Documents/.hidden/people.csv"), policy)).toThrow(/hidden/);
    writeFileSync(join(home, "Documents/.people.csv"), "a");
    expect(() => checkImportPath(join(home, "Documents/.people.csv"), policy)).toThrow(PathRefusedError);
  });

  test("outside the allowed folders", () => {
    const { home, policy } = fakeHome();
    expect(() => checkImportPath(join(home, "Secrets/real.csv"), policy)).toThrow(/only files under/);
    expect(() => checkImportPath("/etc/hosts", policy)).toThrow(PathRefusedError);
    expect(() => checkImportPath("/etc/passwd")).toThrow(PathRefusedError);
    // a sibling that merely shares a prefix with an allowed root
    mkdirSync(join(home, "Documents-old"));
    writeFileSync(join(home, "Documents-old/p.csv"), "a");
    expect(() => checkImportPath(join(home, "Documents-old/p.csv"), policy)).toThrow(PathRefusedError);
  });

  test("other file types", () => {
    const { home, policy } = fakeHome();
    for (const n of ["photo.png", "archive.zip", "run.sh", "noext", "db.sqlite", "doc.pdf"]) {
      writeFileSync(join(home, "Documents", n), "x");
      expect(refused(() => checkImportPath(join(home, "Documents", n), policy)).message).toContain("can't be imported by path");
    }
  });

  test("over 25 MB, a directory, a missing file", () => {
    const { home, policy } = fakeHome();
    const big = join(home, "Documents/big.csv");
    writeFileSync(big, "a");
    truncateSync(big, 25 * 1024 * 1024 + 1);
    try { checkImportPath(big, policy); throw new Error("allowed"); } catch (e) { expect(e).toBeInstanceOf(FileProblemError); expect((e as FileProblemError).code).toBe("too_large"); }
    truncateSync(big, 25 * 1024 * 1024);
    expect(() => checkImportPath(big, policy)).not.toThrow(); // exactly 25 MB is fine
    try { checkImportPath(join(home, "Documents/sub"), policy); throw new Error("allowed"); } catch (e) { expect((e as FileProblemError).code).toBe("not_a_file"); }
    try { checkImportPath(join(home, "Documents/missing.csv"), policy); throw new Error("allowed"); } catch (e) { expect((e as FileProblemError).code).toBe("file_not_found"); }
  });

  test("readUpload applies the same rules", () => {
    const { home, policy } = fakeHome();
    expect(() => readUpload(join(home, ".ssh/id_ed25519"), policy)).toThrow(PathRefusedError);
    expect(() => readUpload("~/.ssh/id_ed25519")).toThrow(PathRefusedError);
  });
});
