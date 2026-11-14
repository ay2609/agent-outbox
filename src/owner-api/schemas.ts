// zod schemas for request bodies at the edge. Everything below the routes trusts these shapes.
import { z } from "zod";
import type { Context } from "hono";
import { badRequest } from "./errors";

export const assertionSchema = z.object({
  id: z.string().min(1).max(2048),
  rawId: z.string().min(1).max(2048),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1).max(8192),
    authenticatorData: z.string().min(1).max(8192),
    signature: z.string().min(1).max(8192),
    userHandle: z.string().max(2048).optional().nullable().transform((v) => v ?? undefined),
  }).passthrough(),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export const attestationSchema = z.object({
  id: z.string().min(1).max(2048),
  rawId: z.string().min(1).max(2048),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1).max(8192),
    attestationObject: z.string().min(1).max(65536),
    transports: z.array(z.string()).optional(),
  }).passthrough(),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export const reauthSchema = z.object({ challenge_id: z.string().min(1).max(100), response: assertionSchema });

export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw badRequest("Expected a JSON body."); }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw badRequest("Invalid request.", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}
/** Like readJson, but an absent or empty body counts as {}. */
export async function readJsonOptional<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) { try { raw = JSON.parse(text); } catch { throw badRequest("Expected a JSON body."); } }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw badRequest("Invalid request.", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  return r.data;
}
