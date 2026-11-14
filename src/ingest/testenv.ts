// Side-effect module: points OUTBOX_HOME at a throwaway directory. Must be imported before anything that loads src/core/paths.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OUTBOX_HOME) process.env.OUTBOX_HOME = mkdtempSync(join(tmpdir(), "outbox-b-"));
