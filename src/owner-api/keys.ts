// The Secure Enclave signature format and key helpers (no routes, no database).
//
// Signature format: ECDSA P-256/SHA-256, DER, over
//   M = utf8("agent-outbox/se/v1") || 0x00 || utf8(TAG) || 0x00 || DIGEST     (DIGEST = 32 raw bytes)
//   send     sha256(manifest bytes)          contacts  sha256(manifest bytes)
//   reauth   sha256(challenge)               enroll    sha256(challenge || x963)
// The executor only ever checks send/contacts signatures, against keys in the PIN FILE. The server verifies everything before it
// writes a row, but the server is not the security boundary: the executor's pin-file check is.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { b64u, isB64u, sha256Buf } from "./b64";

export const SE_PREFIX = Buffer.from("agent-outbox/se/v1", "utf8");
export type SeTag = "send" | "contacts" | "reauth" | "enroll";
/** M(tag, digest): exact bytes the Secure Enclave signs and the executor re-derives. `digest` must be 32 raw bytes. */
export function seMessage(tag: SeTag, digest: Uint8Array): Buffer {
  if (digest.length !== 32) throw new Error("digest must be 32 bytes");
  return Buffer.concat([SE_PREFIX, Buffer.from([0]), Buffer.from(tag, "utf8"), Buffer.from([0]), Buffer.from(digest)]);
}

/** A 65-byte uncompressed P-256 point (0x04 || x || y) that is really on the curve; otherwise null. */
export function parseX963(b64: string): Buffer | null {
  if (!isB64u(b64) || b64.length !== 87) return null;
  const raw = Buffer.from(b64, "base64url");
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  try { publicKeyOf(raw); } catch { return null; }
  return raw;
}
function publicKeyOf(x963: Buffer) {
  return createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: x963.subarray(1, 33).toString("base64url"), y: x963.subarray(33, 65).toString("base64url") } });
}
/** ECDSA P-256/SHA-256 over `message`, DER signature. Never throws: anything malformed is just false. */
export function verifySe(x963: Buffer, message: Buffer, sigDer: Uint8Array): boolean {
  try { return cryptoVerify("sha256", message, { key: publicKeyOf(x963), dsaEncoding: "der" }, Buffer.from(sigDer)); } catch { return false; }
}
export const nativeKeyId = (x963: Buffer): string => b64u(sha256Buf(x963));
/** First 10 bytes of sha256(x963) as 5 groups of 4 uppercase hex digits, e.g. 0F5A-1C22-9B07-44DE-A3F1. */
export function fingerprint(x963: Buffer): string {
  return sha256Buf(x963).subarray(0, 10).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
}
