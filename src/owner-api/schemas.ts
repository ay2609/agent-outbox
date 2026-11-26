// zod schemas for request bodies at the edge. Everything below the routes trusts these shapes.
import { z } from "zod";
import type { Context } from "hono";
import { badRequest } from "./errors";

async function parse<T>(raw: unknown, schema: z.ZodType<T>): Promise<T> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw badRequest("Invalid request.", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}
export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw badRequest("Expected a JSON body."); }
  return parse(raw, schema);
}
/** Like readJson, but an absent or empty body counts as {}. */
export async function readJsonOptional<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) { try { raw = JSON.parse(text); } catch { throw badRequest("Expected a JSON body."); } }
  return parse(raw, schema);
}
