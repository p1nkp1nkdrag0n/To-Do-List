import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isSixDigitProjectCode,
  projectInviteDigest,
} from "../../../server/modules/invites/invite-crypto.js";

describe("project invite cryptography", () => {
  it("uses HMAC-SHA256 with the session secret and code as input", () => {
    const secret = "session-secret";
    const code = "012345";
    expect(projectInviteDigest(secret, code)).toBe(
      createHmac("sha256", secret).update(code, "utf8").digest("hex"),
    );
  });

  it("recognizes exactly six numeric digits including leading zeroes", () => {
    expect(isSixDigitProjectCode("000001")).toBe(true);
    expect(isSixDigitProjectCode("12345")).toBe(false);
    expect(isSixDigitProjectCode("1234567")).toBe(false);
    expect(isSixDigitProjectCode("12345a")).toBe(false);
  });
});
