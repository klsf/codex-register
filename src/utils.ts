import { createHash, randomBytes } from "node:crypto";

export function randomUrlSafeString(length: number): string {
  const size = length > 0 ? length : 32;
  return randomBytes(size).toString("base64url");
}

export function pkceCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}
