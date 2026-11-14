// Fetch wrapper. Every mutation carries X-Outbox: 1 (the server's CSRF check). A redirect or a 401
// on a non-auth route means the session is gone: do a full reload so the app boots into the sign-in screen.
export class ApiErr extends Error {
  constructor(public status: number, public code: string, message: string, public data: any = {}) { super(message); }
}

function reloadOnce(): void {
  const k = "outbox:reload", last = Number(sessionStorage.getItem(k) ?? 0);
  if (Date.now() - last > 5000) { sessionStorage.setItem(k, String(Date.now())); location.reload(); }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  if (method !== "GET") headers["x-outbox"] = "1";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: "same-origin", redirect: "manual" });
  } catch {
    throw new ApiErr(0, "network", "Can't reach the server. Check your connection.");
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) { reloadOnce(); throw new ApiErr(401, "redirect", "Signing in again…"); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.status === 401 && !path.startsWith("/api/auth/")) { reloadOnce(); throw new ApiErr(401, "unauthorized", "Signing in again…"); }
  if (!res.ok) throw new ApiErr(res.status, data?.error ?? "error", data?.message ?? `Request failed (${res.status}).`, data ?? {});
  return data as T;
}
export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>("PUT", p, b);

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
