import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiErr, post } from "./api";

export type Purpose = "login" | "approve";

/** Browser errors from the passkey sheet, in plain words. */
export function passkeyError(e: unknown): string {
  const name = (e as any)?.name as string | undefined;
  if (name === "NotAllowedError" || name === "AbortError") return "Cancelled, or Touch ID didn't match.";
  if (name === "InvalidStateError") return "That passkey is already registered.";
  if (name === "SecurityError") return "This page's address doesn't match the passkey's site. Open the dashboard at http://localhost (the address printed when the server starts).";
  return e instanceof Error ? e.message : String(e);
}

// The one-time setup token (from the link the installer prints: #/setup?token=...). Kept in memory and sessionStorage,
// and removed from the address bar at once so it isn't left in the URL, history or screenshots.
const TOKEN_KEY = "outbox:setup-token";
let setupToken: string | null = null;
export function captureSetupToken(): void {
  const m = /^#\/setup\?(.*)$/.exec(location.hash);
  if (!m) return;
  const t = new URLSearchParams(m[1]).get("token");
  if (t) { setupToken = t; try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* private mode: memory only */ } }
  history.replaceState(null, "", location.pathname + location.search + "#/setup");
}
export function getSetupToken(): string | null {
  if (setupToken) return setupToken;
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function forgetSetupToken(): void {
  setupToken = null;
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
}

/** Setup step 1: the sign-in key. No session needed; the server opens this only while no sign-in key exists, and only with the setup token. */
export async function registerLogin(label: string) {
  const setup_token = getSetupToken() ?? undefined;
  const { challenge_id, options } = await post("/api/auth/register/options", { label, purpose: "login", setup_token });
  const response = await startRegistration({ optionsJSON: options });
  const r = await post("/api/auth/register/verify", { challenge_id, response, label, setup_token });
  forgetSetupToken();
  return r;
}
/** The first sign-in key of a Mac whose setup was done in the app: a browser-link session (see #/link) may register it without the setup token. */
export async function registerLoginViaLink(label: string) {
  const { challenge_id, options } = await post("/api/passkeys/options", { label, purpose: "login" });
  const response = await startRegistration({ optionsJSON: options });
  return post("/api/passkeys/verify", { challenge_id, response, label });
}
export async function login() {
  const { challenge_id, options } = await post("/api/auth/login/options");
  const response = await startAuthentication({ optionsJSON: options });
  return post("/api/auth/login/verify", { challenge_id, response });
}
/** A fresh SIGN-IN assertion for a sensitive change (going live, adding a passkey). */
export async function reauth(): Promise<{ challenge_id: string; response: unknown }> {
  const { challenge_id, options } = await post("/api/auth/reauth/options");
  const response = await startAuthentication({ optionsJSON: options });
  return { challenge_id, response };
}
async function enrol(purpose: Purpose, label: string, withReauth: boolean) {
  const re = withReauth ? await reauth() : undefined;
  const { challenge_id, options } = await post("/api/passkeys/options", { label, purpose, ...(re ? { reauth: re } : {}) });
  const response = await startRegistration({ optionsJSON: options });
  return post("/api/passkeys/verify", { challenge_id, response, label });
}
/** Setup step 2: the first approval key, right after step 1. The server allows it without a second Touch ID while the
 *  session is fresh; an older session gets reauth_required and we retry with a sign-in assertion. */
export async function registerApprove(label: string) {
  try { return await enrol("approve", label, false); }
  catch (e) { if (e instanceof ApiErr && e.code === "reauth_required") return enrol("approve", label, true); throw e; }
}
/** Any later key (another device): needs a fresh sign-in assertion first. */
export const addPasskey = (label: string, purpose: Purpose) => enrol(purpose, label, true);
