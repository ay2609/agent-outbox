// Errors that become JSON responses. Messages are written for the owner; stack traces never leave the process.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export const badRequest = (msg: string, extra?: Record<string, unknown>) => new ApiError(400, "bad_request", msg, extra);
export const unauthorized = (msg = "Sign in required.") => new ApiError(401, "unauthorized", msg);
export const forbidden = (code: string, msg: string) => new ApiError(403, code, msg);
export const notFound = (what = "Not found.") => new ApiError(404, "not_found", what);
export const conflict = (code: string, msg: string, extra?: Record<string, unknown>) => new ApiError(409, code, msg, extra);
