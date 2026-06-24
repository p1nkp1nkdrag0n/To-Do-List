import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const AUTH_SECRET = process.env.AUTH_SECRET || "local-development-secret";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(value).digest("base64url");
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function createToken(user) {
  const payload = base64url(JSON.stringify({
    userId: user.id,
    username: user.username,
    expiresAt: Date.now() + TOKEN_TTL_MS
  }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  try {
    if (!token || !token.includes(".")) {
      return null;
    }
    const [payload, signature] = token.split(".");
    const expected = sign(payload);
    if (signature.length !== expected.length) {
      return null;
    }
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return null;
    }
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.expiresAt || parsed.expiresAt < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
