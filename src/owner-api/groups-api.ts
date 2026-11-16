// /api/groups: the owner's view of saved groups (Agent Outbox's own lists of people, not Contacts-app groups). Same session +
// CSRF middleware as every /api route (index.ts); every write is audited by the core module. Deleting a group is only here:
// the agent API has no delete.
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  GroupError, MAX_DESCRIPTION, MAX_NAME, addMembers, createGroup, deleteGroup, getGroup, listGroups, membersFromContactIds,
  membersFromImport, removeMembers, updateGroup, type MemberInput,
} from "../core/groups";
import type { OwnerConfig } from "./config";
import { ApiError, notFound } from "./errors";
import { loadB } from "./integrations";
import { readJson } from "./schemas";

const OWNER = "owner";
const MAX_PER_CALL = 1000;
const vars = z.record(z.string().max(100), z.union([z.string().max(500), z.number(), z.boolean()]));
const memberS = z.object({
  to: z.string().min(1).max(320).optional(), contact_id: z.string().min(1).max(100).optional(), name: z.string().max(200).optional(), vars: vars.optional(),
}).strict();
const createS = z.object({ name: z.string().min(1).max(MAX_NAME * 2), description: z.string().max(MAX_DESCRIPTION * 2).optional() }).strict();
const patchS = z.object({ name: z.string().min(1).max(MAX_NAME * 2).optional(), description: z.string().max(MAX_DESCRIPTION * 2).optional() }).strict();
const addS = z.object({
  contact_ids: z.array(z.string().min(1).max(100)).max(MAX_PER_CALL).optional(),
  members: z.array(memberS).max(MAX_PER_CALL).optional(),
  from_import: z.object({ import_id: z.string().min(1).max(100), rows: z.array(z.number().int().min(0)).optional() }).strict().optional(),
}).strict();
const removeS = z.object({
  handles: z.array(z.string().min(1).max(320)).max(MAX_PER_CALL).optional(),
  contact_ids: z.array(z.string().min(1).max(100)).max(MAX_PER_CALL).optional(),
}).strict();

/** Core errors become the owner API's error shape (status, code, message, extra). */
function wrap<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof GroupError) {
      if (e.status === 404) throw notFound("That group doesn't exist.");
      throw new ApiError(e.status, e.code, e.message, (e.details && typeof e.details === "object" ? e.details : {}) as Record<string, unknown>);
    }
    throw e;
  }
}

export function registerGroupsApi(app: Hono, cfg: OwnerConfig): void {
  const db = (): Database => cfg.db();

  app.get("/api/groups", (c) => c.json({ groups: listGroups(db()) }));

  app.post("/api/groups", async (c) => {
    const body = await readJson(c, createS);
    return c.json({ group: wrap(() => createGroup(db(), { name: body.name, description: body.description, actor: OWNER })) }, 201);
  });

  app.get("/api/groups/:id", (c) => c.json(wrap(() => getGroup(db(), c.req.param("id")))));

  app.patch("/api/groups/:id", async (c) => {
    const body = await readJson(c, patchS);
    if (body.name === undefined && body.description === undefined) throw new ApiError(400, "bad_request", "Give a name or a description.");
    return c.json({ group: wrap(() => updateGroup(db(), c.req.param("id"), { ...body, actor: OWNER })) });
  });

  // Contact ids (from the address book), members by phone or email, or the rows of an import.
  app.post("/api/groups/:id/members", async (c) => {
    const body = await readJson(c, addS);
    const lib = await loadB();
    const inputs: MemberInput[] = [...(body.members ?? []), ...membersFromContactIds(body.contact_ids ?? [])];
    let skipped: ReturnType<typeof membersFromImport>["invalid"] = [];
    if (body.from_import) {
      let imp: any;
      try { imp = lib.getImport(db(), body.from_import.import_id); } catch { imp = null; }
      if (!imp) throw notFound("That import doesn't exist.");
      const fi = membersFromImport(imp, body.from_import.rows);
      inputs.push(...fi.members); skipped = fi.invalid;
    }
    if (!inputs.length && !skipped.length) throw new ApiError(400, "bad_request", "Give people to add.");
    const r = wrap(() => addMembers(db(), lib, c.req.param("id"), inputs, {
      actor: OWNER, lenient: !!body.from_import, ...(body.from_import ? { source: `import ${body.from_import.import_id}` } : {}),
    }));
    return c.json({ ...r, invalid: [...r.invalid, ...skipped] });
  });

  app.post("/api/groups/:id/remove", async (c) => {
    const body = await readJson(c, removeS);
    if (!body.handles?.length && !body.contact_ids?.length) throw new ApiError(400, "bad_request", "Give who to remove.");
    const lib = await loadB();
    return c.json(wrap(() => removeMembers(db(), lib, c.req.param("id"), { ...body, actor: OWNER })));
  });

  app.delete("/api/groups/:id", (c) => c.json({ ok: true, deleted: wrap(() => deleteGroup(db(), c.req.param("id"), OWNER)) }));
}
