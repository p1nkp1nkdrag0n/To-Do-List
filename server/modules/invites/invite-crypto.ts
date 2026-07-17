import { createHmac } from "node:crypto";

export function projectInviteDigest(secret: string, code: string): string {
  return createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

export function isSixDigitProjectCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}
