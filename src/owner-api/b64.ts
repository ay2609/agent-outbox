// base64url (no padding) helpers. Every base64 column in the schema uses this form.
import { createHash, randomBytes } from "node:crypto";

export const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString("base64url");
export const fromB64u = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, "base64url"));
export const isB64u = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]*$/.test(s);
export const sha256Buf = (s: string | Uint8Array): Buffer => createHash("sha256").update(s).digest();
export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
export const randomToken = (): string => b64u(randomBytes(32));
