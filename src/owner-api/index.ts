// Dashboard app: serves the SPA (web/dist) and /api. Binds only to 127.0.0.1 (server.ts does the Bun.serve) and is
// opened at http://localhost:<port>, the origin its passkeys are bound to.
//
// Gate summary: the Host header must be localhost:<port> or 127.0.0.1:<port> (DNS rebinding); page loads on 127.0.0.1 are
// redirected to localhost; every /api route except /api/auth/* needs a session cookie; every non-GET /api request needs
// the `X-Outbox: 1` header (and an Origin, when the browser sends one, equal to this server's origin).
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { z } from "zod";
import { audit } from "../core/store";
import { SESSION_COOKIE, allowedHosts, cookieSecure, resolveConfig, type OwnerConfig } from "./config";
import { ApiError, forbidden, unauthorized } from "./errors";
import {
  LimiterSet, createSession, destroySession, loginOptions, passkeyCount, registerOptions, registerVerify, sessionValid,
  verifyLoginAssertion,
} from "./auth";
import { registerApi } from "./api";
import { assertionSchema, attestationSchema, readJson, readJsonOptional } from "./schemas";

export function createOwnerApp(over: Partial<OwnerConfig> = {}): Hono {
  const cfg = resolveConfig(over);
  const db = () => cfg.db();
  // One limiter per (route, session): a local agent spamming bad sign-in assertions must not lock the owner out of approving.
  const limiters = new LimiterSet(cfg.loginMaxFailures, cfg.loginWindowMs);
  const limiterFor = (c: Context, route: string) => {
    const t = getCookie(c, SESSION_COOKIE);
    return limiters.for(route, sessionValid(db(), t) ? t : undefined);
  };
  const app = new Hono();
  const hosts = allowedHosts(cfg);
  const secureCookie = cookieSecure(cfg.origin);

  // Host allowlist first, before anything else sees the request. A page that resolves its own hostname to 127.0.0.1
  // (DNS rebinding) arrives with a foreign Host and gets nothing. A missing Host is refused too.
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").toLowerCase();
    if (!hosts.has(host)) return c.json({ error: "bad_host", message: `Open the dashboard at ${cfg.origin}.` }, 403);
    // Passkeys are bound to "localhost", so a page load on 127.0.0.1 moves to the localhost origin (the API stays reachable on both).
    if (host.startsWith("127.0.0.1:") && !c.req.path.startsWith("/api") && (c.req.method === "GET" || c.req.method === "HEAD")) {
      const u = new URL(c.req.url);
      return c.redirect(`${cfg.origin}${u.pathname}${u.search}`, 302);
    }
    await next();
  });

  // Security headers on everything.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (c.req.path.startsWith("/api")) c.header("Cache-Control", "no-store");
  });

  // CSRF + session gate for /api.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = c.req.header("origin");
      if (origin && origin !== cfg.origin) throw forbidden("bad_origin", "Request came from an unexpected origin.");
      if (c.req.header("x-outbox") !== "1") throw forbidden("csrf", "Missing X-Outbox header.");
    }
    if (!c.req.path.startsWith("/api/auth/")) {
      if (!sessionValid(db(), getCookie(c, SESSION_COOKIE))) throw unauthorized();
    }
    await next();
  });

  const startSession = (c: any): void => {
    const { token, expires } = createSession(cfg, db(), c.req.header("user-agent") ?? "");
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: secureCookie, sameSite: "Strict", path: "/", expires });
  };

  // ---------- /api/auth ----------
  app.get("/api/auth/state", (c) => c.json({
    registered: passkeyCount(db(), "login") > 0,
    /** Setup progress: the sign-in key comes first, then the approval key. */
    setup: { login: passkeyCount(db(), "login") > 0, approve: passkeyCount(db(), "approve") > 0 },
    authenticated: sessionValid(db(), getCookie(c, SESSION_COOKIE)),
    rp_id: cfg.rpId, origin: cfg.origin,
  }));

  // First-run setup, no session: open for a purpose only while there are zero keys of that purpose (and, for the approval
  // key, no sign-in key yet). The first approval key is enrolled right after the sign-in key, with that key's session, via
  // POST /api/passkeys/options. Adding more later needs a session plus a fresh assertion.
  app.post("/api/auth/register/options", async (c) => {
    const body = await readJsonOptional(c, z.object({ label: z.string().max(60).optional(), purpose: z.enum(["login", "approve"]).default("login") }));
    limiterFor(c, "register").check();
    return c.json(await registerOptions(cfg, db(), { label: body.label ?? "", purpose: body.purpose, kind: "open" }));
  });
  app.post("/api/auth/register/verify", async (c) => {
    const body = await readJson(c, z.object({ challenge_id: z.string().max(100), response: attestationSchema, label: z.string().max(60).optional() }));
    const r = await registerVerify(cfg, db(), limiterFor(c, "register"), { challenge_id: body.challenge_id, response: body.response as any, sessionOk: false, label: body.label });
    startSession(c);
    return c.json({ ok: true, ...r });
  });

  app.post("/api/auth/login/options", async (c) => {
    limiterFor(c, "login").check();
    return c.json(await loginOptions(cfg, db()));
  });
  app.post("/api/auth/login/verify", async (c) => {
    const body = await readJson(c, z.object({ challenge_id: z.string().max(100), response: assertionSchema }));
    const credential_id = await verifyLoginAssertion(cfg, db(), limiterFor(c, "login"), body.challenge_id, body.response as any);
    startSession(c);
    audit(db(), "owner", "login", credential_id);
    return c.json({ ok: true });
  });

  // A fresh assertion for a sensitive change (going live, adding a passkey). Needs the session.
  app.post("/api/auth/reauth/options", async (c) => {
    if (!sessionValid(db(), getCookie(c, SESSION_COOKIE))) throw unauthorized();
    limiterFor(c, "reauth").check();
    return c.json(await loginOptions(cfg, db()));
  });

  app.post("/api/auth/logout", (c) => {
    destroySession(db(), getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  registerApi(app, cfg, limiterFor);

  // ---------- errors: JSON only, never a stack ----------
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.status === 429 && typeof err.extra.retry_after_s === "number") c.header("Retry-After", String(err.extra.retry_after_s));
      return c.json({ error: err.code, message: err.message, ...err.extra }, err.status as any);
    }
    console.error("[owner-api]", err instanceof Error ? err.message : String(err));
    return c.json({ error: "internal", message: "Something went wrong on the server." }, 500);
  });
  app.notFound((c) => {
    if (c.req.path.startsWith("/api")) return c.json({ error: "not_found", message: "No such route." }, 404);
    return serveSpa(cfg, c.req.path);
  });

  return app;
}

// ---------- static SPA with fallback ----------
function serveSpa(cfg: OwnerConfig, pathname: string): Response {
  const root = cfg.webDist;
  const index = join(root, "index.html");
  if (!existsSync(index)) {
    return new Response("The dashboard isn't built yet. Run: bunx vite build --config web/vite.config.ts", { status: 503, headers: { "content-type": "text/plain" } });
  }
  let rel = "";
  try { rel = decodeURIComponent(pathname); } catch { return new Response("Bad path", { status: 400 }); }
  const abs = normalize(join(root, rel));
  const inside = abs === root || abs.startsWith(root + sep);
  if (inside && rel !== "/" && existsSync(abs) && statSync(abs).isFile()) {
    const hashed = rel.startsWith("/assets/");
    return new Response(Bun.file(abs), { headers: { "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  return new Response(Bun.file(index), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

export const ownerApp = createOwnerApp();
export { createOwnerApp as default };
