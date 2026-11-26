// The owner API: served ONLY on <state>/run/owner.sock (server.ts does the Bun.serve), only when the server was started with
// --app-auth-fd. There is no TCP listener, no SPA, no cookie and no Host/Origin logic: the one client is Agent Outbox.app.
//
// Request rules, in this order:
//  1. the path must start with /api/ (else 404 not_found);
//  2. any Origin / Sec-Fetch-Site / Sec-Fetch-Mode header means a browser: 403 browser_refused (defence in depth);
//  3. X-Outbox-App must match the per-launch token (constant time, on sha256) else 401 app_auth;
//  4. body limits: JSON <= 1 MB, POST /api/imports <= 36 MB, else 413 too_large.
// A valid token is a session, not an owner proof: routes that need a proof still need an `se_reauth` (Touch ID).
import { Hono, type Context } from "hono";
import { resolveConfig, type OwnerConfig } from "./config";
import { ApiError } from "./errors";
import { LimiterSet } from "./auth";
import { registerNativeApi } from "./native";
import { registerApi } from "./api";

const JSON_LIMIT = 1024 * 1024;
const IMPORT_LIMIT = 36 * 1024 * 1024;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createOwnerApp(over: Partial<OwnerConfig> = {}): Hono {
  const cfg = resolveConfig(over);
  // One limiter per route: the owner is the only client, and a failing route must not lock the others.
  const limiters = new LimiterSet(cfg.loginMaxFailures, cfg.loginWindowMs);
  const limiterFor = (_c: Context, route: string) => limiters.for(route);
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!c.req.path.startsWith("/api/")) throw new ApiError(404, "not_found", "No such route.");
    if (c.req.header("origin") !== undefined || c.req.header("sec-fetch-site") !== undefined || c.req.header("sec-fetch-mode") !== undefined) {
      throw new ApiError(403, "browser_refused", "Browsers aren't served here.");
    }
    if (!cfg.appAuth.matches(c.req.header("x-outbox-app"))) throw new ApiError(401, "app_auth", "The app token is missing or wrong.");
    if (BODY_METHODS.has(c.req.method)) {
      const limit = c.req.method === "POST" && c.req.path === "/api/imports" ? IMPORT_LIMIT : JSON_LIMIT;
      const declared = c.req.header("content-length");
      let size = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
      if (size === null && c.req.raw.body) size = (await c.req.raw.clone().arrayBuffer()).byteLength; // chunked: measure it
      if (size !== null && size > limit) throw new ApiError(413, "too_large", "That request is too large.");
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  registerApi(app, cfg, limiterFor);
  registerNativeApi(app, cfg, limiterFor);

  // ---------- errors: JSON only, never a stack ----------
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.status === 429 && typeof err.extra.retry_after_s === "number") c.header("Retry-After", String(err.extra.retry_after_s));
      return c.json({ error: err.code, message: err.message, ...err.extra }, err.status as any);
    }
    console.error("[owner-api]", err instanceof Error ? err.message : String(err));
    return c.json({ error: "internal", message: "Something went wrong on the server." }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found", message: "No such route." }, 404));

  return app;
}

export const ownerApp = createOwnerApp();
export { createOwnerApp as default };
